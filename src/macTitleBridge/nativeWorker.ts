// Trusted remote program; only request DATA is accepted on stdin.
export const nativeWorkerPython = String.raw`"""Offline-testable, single-note public Notes name worker. No retry or rollback.
The SSH caller owns authorization and its allowlist; requests contain data only.
"""
import os
import pwd
import hashlib
import json
import math
import pathlib
import platform
import plistlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse

LIMIT = 32768
FIELDS = ('scriptingId', 'nativeTitle', 'persistedTitle', 'localDocumentSha256',
          'noteTagSha256', 'attachmentTagSha256')
JXA = r'''function run(argv) {
    if (argv.length !== 1) throw new Error('argument-invalid');
    var p = JSON.parse(argv[0]);
    if (p.mode !== 'inspect' && p.mode !== 'apply') throw new Error('mode-invalid');
    if (!/^x-coredata:\/\/[0-9A-F-]{36}\/ICNote\/p[1-9][0-9]*$/.test(p.scriptingId)) throw new Error('id-invalid');
    var app = Application('Notes');
    if (!app.running()) throw new Error('notes-not-running');
    var note = app.notes.byId(p.scriptingId);
    if (note.id() !== p.scriptingId) throw new Error('id-mismatch');
    var previous = note.name();
    var assigned = false;
    if (p.mode === 'apply') {
        if (previous !== p.expectedNativeTitle) throw new Error('title-mismatch');
        if (typeof p.deadlineMs !== 'number' || p.deadlineMs <= Date.now() || p.deadlineMs > Date.now()+60000) throw new Error('expired');
        if (previous !== p.targetTitle) {
            note.name = p.targetTitle;
            assigned = true;
        }
        if (note.id() !== p.scriptingId) throw new Error('id-changed');
    }
    var actual = note.name();
    if (p.mode === 'apply' && actual !== p.targetTitle) throw new Error('outcome-unclear');
    return JSON.stringify({scriptingId:p.scriptingId, previousTitle:previous, nativeTitle:actual, assigned:assigned});
}'''

class Rejected(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Rejected(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def etag_hash(archive):
    """Resolve keyed archive references as data, never instantiate native classes."""
    require(isinstance(archive, bytes) and len(archive) <= 1048576, 'archive-invalid')
    try:
        doc = plistlib.loads(archive)
        objects, found, seen = doc['$objects'], [], set()
        def walk(value, depth=0):
            require(depth < 100, 'archive-invalid')
            if isinstance(value, plistlib.UID):
                index = value.data
                require(0 <= index < len(objects), 'archive-invalid')
                if index not in seen:
                    seen.add(index)
                    walk(objects[index], depth+1)
            elif isinstance(value, dict):
                for key, item in value.items():
                    if key == 'ETag':
                        if isinstance(item, plistlib.UID):
                            require(0 <= item.data < len(objects), 'archive-invalid')
                            item = objects[item.data]
                        require(isinstance(item, str), 'archive-invalid')
                        found.append(item)
                    else:
                        walk(item, depth+1)
            elif isinstance(value, list):
                for item in value:
                    walk(item, depth+1)
        walk(doc['$top'])
        require(len(found) == 1, 'archive-etag-not-unique')
        return digest(found[0].encode('utf-8'))
    except Rejected:
        raise
    except Exception:
        raise Rejected('archive-invalid') from None

def read_snapshot(path, scope):
    """Fresh read-only transaction; raw archives and document never leave here."""
    conn = sqlite3.connect('file:' + urllib.parse.quote(str(path)) + '?mode=ro', uri=True)
    try:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        rows = conn.execute('''SELECT Z_PK,ZIDENTIFIER,ZTITLE1,ZTITLESOURCEATTACHMENT,
            ZNOTE,ZUSERTITLE,ZTYPEUTI,ZFOLDER,ZNEEDSINITIALFETCHFROMCLOUD,
            ZNEEDSTOBEFETCHEDFROMCLOUD,ZNEEDSINITIALRELATIONSHIPSETUP,
            ZUNAPPLIEDENCRYPTEDRECORDDATA,ZSERVERRECORDDATA FROM ZICCLOUDSYNCINGOBJECT
            WHERE upper(ZIDENTIFIER) IN (?,?,?)''',
            tuple(scope[k].upper() for k in ('noteId','attachmentId','folderId'))).fetchall()
        require(len(rows) == 3, 'mapping-not-unique')
        by_id = {r[1].upper(): r for r in rows}
        require(len(by_id) == 3, 'mapping-not-unique')
        n, a, f = (by_id[scope[k].upper()] for k in ('noteId','attachmentId','folderId'))
        require(all(type(r[0]) is int and r[0] > 0 for r in rows) and len({r[0] for r in rows}) == 3, 'pk-invalid')
        require(n[3] == a[0] and a[4] == n[0] and n[7] == f[0], 'relationships-changed')
        require(a[6] == 'com.apple.paper', 'uti-changed')
        stores = conn.execute('SELECT Z_UUID FROM Z_METADATA').fetchall()
        require(len(stores) == 1 and stores[0][0].upper() == scope['storeUuid'].upper(), 'store-changed')
        for r in (n, a):
            require(all(v is None or (type(v) is int and v == 0) for v in r[8:11]), 'fetch-pending')
            require(r[11] is None or r[11] == b'', 'encrypted-data-pending')
        data = conn.execute('SELECT ZDATA FROM ZICNOTEDATA WHERE ZNOTE=?', (n[0],)).fetchall()
        require(len(data) == 1 and isinstance(data[0][0], bytes), 'note-data-invalid')
        require(isinstance(n[2], str) and isinstance(a[5], str), 'titles-invalid')
        # Preserve identity, reciprocal relationships, folder and pending state,
        # but not title/tag fields which a legitimate native rename can change.
        stable = [[r[i].hex() if isinstance(r[i], bytes) else r[i]
                   for i in (0,1,3,4,6,7,8,9,10,11)] for r in (n,a)] + [[f[0], f[1]]]
        return dict(scriptingId='x-coredata://' + scope['storeUuid'].upper() + '/ICNote/p' + str(n[0]),
                    persistedTitle=n[2], userTitle=a[5], localDocumentSha256=digest(data[0][0]),
                    noteTagSha256=etag_hash(n[12]), attachmentTagSha256=etag_hash(a[12]),
                    scopeSha256=digest(json.dumps(stable, separators=(',', ':')).encode()))
    finally:
        conn.rollback()
        conn.close()

class MacAdapter:
    def identity(self):
        require(platform.system() == 'Darwin', 'platform-unsupported')
        build = subprocess.run(['/usr/bin/sw_vers', '-buildVersion'], capture_output=True,
                               text=True, timeout=3, check=True).stdout.strip()
        return dict(user=pwd.getpwuid(os.getuid()).pw_name, build=build, architecture=platform.machine())
    def read_snapshot(self, scope):
        return read_snapshot(pathlib.Path.home() / 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite', scope)
    def notes_running(self):
        return subprocess.run(['/usr/bin/pgrep', '-u', str(os.getuid()), '-x', 'Notes'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3).returncode == 0
    def run_jxa(self, payload, timeout):
        result = subprocess.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', JXA,
                                 json.dumps(payload, separators=(',', ':'))],
                                capture_output=True, text=True, timeout=timeout, check=False)
        require(result.returncode == 0, 'native-call-failed')
        require(len(result.stdout.encode()) <= LIMIT, 'native-output-invalid')
        try:
            value = json.loads(result.stdout)
        except Exception:
            raise Rejected('native-output-invalid') from None
        require(isinstance(value, dict), 'native-output-invalid')
        return value

def title(value):
    require(isinstance(value, str) and '\x00' not in value, 'title-invalid')
    require(len(value.encode('utf-8')) <= 8192, 'title-invalid')

def validate(r, now):
    required = {'mode','scope','expected','expectedUserTitle','targetTitle','deadlineMs'}
    require(type(r) is dict and required <= r.keys() and r.keys() <= required | {'expectedNativeTitle'}, 'request-schema')
    require(r['mode'] in ('inspect','apply'), 'mode-invalid')
    s, e = r['scope'], r['expected']
    require(type(s) is dict and set(s) == {'noteId','attachmentId','folderId','storeUuid','macBuild','remoteUser'}, 'scope-schema')
    for k in ('noteId','attachmentId','folderId','storeUuid'):
        require(isinstance(s[k], str) and re.fullmatch('[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', s[k]), 'uuid-invalid')
    require(len({s[k].upper() for k in ('noteId','attachmentId','folderId')}) == 3, 'scope-overlap')
    require(s['macBuild'] == '25G83', 'build-unsupported')
    require(isinstance(s['remoteUser'], str) and re.fullmatch('[a-zA-Z_][a-zA-Z0-9_.-]{0,63}', s['remoteUser']), 'user-invalid')
    hashes = {'noteTagSha256','attachmentTagSha256'}
    require(type(e) is dict and hashes <= e.keys() and e.keys() <= hashes | {'localDocumentSha256'}, 'expected-schema')
    for v in e.values():
        require(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v), 'hash-invalid')
    for k in ('expectedUserTitle','targetTitle'):
        title(r[k])
    require(r['mode'] != 'apply' or 'expectedNativeTitle' in r, 'native-expectation-required')
    if 'expectedNativeTitle' in r:
        title(r['expectedNativeTitle'])
    d = r['deadlineMs']
    require(type(d) in (int,float) and math.isfinite(d) and now < d <= now+60000, 'deadline-invalid')

def baseline(state, r):
    require(state['userTitle'] == r['expectedUserTitle'], 'user-title-mismatch')
    for k, v in r['expected'].items():
        require(state[k] == v, 'baseline-hash-mismatch')

def execute(request, adapter, now_ms=lambda: time.time()*1000):
    """Adapter effects are injected; the write boundary is conservative and terminal."""
    wrote, result = False, dict.fromkeys(FIELDS)
    def output(status):
        return dict(result, status=status, writeMayHaveOccurred=wrote)
    try:
        validate(request, now_ms())
        s = request['scope']
        require(adapter.identity() == dict(user=s['remoteUser'], build=s['macBuild'], architecture='arm64'), 'remote-identity-changed')
        require(adapter.notes_running(), 'notes-not-running')
        before = adapter.read_snapshot(s)
        baseline(before, request)
        result.update({k: before[k] for k in FIELDS if k in before})
        payload = dict(mode='inspect', scriptingId=before['scriptingId'])
        def native_call():
            remaining = (request['deadlineMs']-now_ms())/1000
            require(0 < remaining <= 60, 'deadline-invalid')
            return adapter.run_jxa(payload, min(35, remaining))
        native = native_call()
        require(native.get('scriptingId') == before['scriptingId'] and native.get('assigned') is False
                and isinstance(native.get('nativeTitle'), str) and native.get('previousTitle') == native['nativeTitle'], 'native-result-mismatch')
        result['nativeTitle'] = native['nativeTitle']
        if 'expectedNativeTitle' in request:
            require(native['nativeTitle'] == request['expectedNativeTitle'], 'native-title-mismatch')
        stable = adapter.read_snapshot(s)
        baseline(stable, request)
        require(before == stable, 'read-race')
        if request['mode'] == 'inspect':
            return output('ready')
        if native['nativeTitle'] == request['targetTitle']:
            return output('assigned' if stable['persistedTitle'] == request['targetTitle'] else 'persistence-pending')
        require(adapter.notes_running(), 'notes-not-running')
        require(0 < request['deadlineMs']-now_ms() <= 60000, 'deadline-invalid')
        payload.update(mode='apply', expectedNativeTitle=request['expectedNativeTitle'],
                       targetTitle=request['targetTitle'], deadlineMs=request['deadlineMs'])
        wrote = True
        after_native = native_call()
        require(after_native.get('scriptingId') == before['scriptingId'] and after_native.get('assigned') is True
                and after_native.get('previousTitle') == native['nativeTitle']
                and after_native.get('nativeTitle') == request['targetTitle'], 'native-result-mismatch')
        result['nativeTitle'] = after_native['nativeTitle']
        after = adapter.read_snapshot(s)
        require(after['scopeSha256'] == before['scopeSha256'] and after['scriptingId'] == before['scriptingId'], 'post-scope-changed')
        require(after['localDocumentSha256'] == before['localDocumentSha256'], 'post-body-changed')
        require(after['userTitle'] == request['expectedUserTitle'], 'post-user-title-changed')
        require(after['persistedTitle'] in (before['persistedTitle'], request['targetTitle']), 'post-title-unexpected')
        result.update({k: after[k] for k in FIELDS if k in after})
        return output('assigned' if after['persistedTitle'] == request['targetTitle'] else 'persistence-pending')
    except Exception as error:
        # Only fixed internal error codes are returned, never exception/adapter text.
        pending = type(error) is Rejected and error.args[0] in ('fetch-pending','encrypted-data-pending')
        return output('ambiguous' if wrote else 'pending' if pending else 'error')

def main(stdin=None, stdout=None, adapter=None, now_ms=lambda: time.time()*1000):
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    try:
        raw = stdin.read(LIMIT+1)
        require(len(raw) <= LIMIT, 'request-too-large')
        def invalid_constant(value):
            raise Rejected('request-invalid')
        def unique_keys(pairs):
            result = {}
            for k, v in pairs:
                require(k not in result, 'duplicate-key')
                result[k] = v
            return result
        request = json.loads(raw, parse_constant=invalid_constant, object_pairs_hook=unique_keys)
        result = execute(request, MacAdapter() if adapter is None else adapter, now_ms)
    except Exception:
        result = dict.fromkeys(FIELDS)
        result.update(status='error', writeMayHaveOccurred=False)
    stdout.write(json.dumps(result, separators=(',', ':'))+'\n')
    return result

if __name__ == '__main__':
    main()
`;
