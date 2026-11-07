import copy
import io
import json
import pathlib
import plistlib
import sqlite3
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import mac_worker as w

NOW = 1700000000000
IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
       '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
URI = 'x-coredata://' + IDS[3] + '/ICNote/p7'

def request(mode='inspect'):
    return dict(mode=mode, scope=dict(zip(('noteId','attachmentId','folderId','storeUuid'),IDS),
                macBuild='25G83', remoteUser='tester'), expected=dict(noteTagSha256=w.digest(b'n'),
                attachmentTagSha256=w.digest(b'a'), localDocumentSha256=w.digest(b'body')),
                expectedUserTitle='Title', targetTitle='Title', expectedNativeTitle='Old', deadlineMs=NOW+30000)

def snapshot(title='Old'):
    return dict(scriptingId=URI, persistedTitle=title, userTitle='Title',
                localDocumentSha256=w.digest(b'body'), noteTagSha256=w.digest(b'n'),
                attachmentTagSha256=w.digest(b'a'), scopeSha256=w.digest(b'scope'))

class Fake:
    def __init__(self):
        self.states=[snapshot(),snapshot(),snapshot('Title')]; self.calls=[]; self.running=True
    def identity(self): return dict(user='tester',build='25G83',architecture='arm64')
    def notes_running(self): return self.running
    def read_snapshot(self,scope): return self.states.pop(0)
    def run_jxa(self,payload,timeout):
        self.calls.append(payload.copy())
        return dict(scriptingId=URI,previousTitle='Old',nativeTitle='Title' if payload['mode']=='apply' else 'Old',assigned=payload['mode']=='apply')

class WorkerTests(unittest.TestCase):
    def run_worker(self,r=None,f=None): return w.execute(r or request(),f or Fake(),lambda:NOW)
    def test_inspect(self):
        f=Fake(); out=self.run_worker(f=f)
        self.assertEqual(out['status'],'ready'); self.assertFalse(out['writeMayHaveOccurred'])
        self.assertEqual([c['mode'] for c in f.calls],['inspect'])
    def test_apply(self):
        f=Fake(); out=self.run_worker(request('apply'),f)
        self.assertEqual(out['status'],'assigned'); self.assertTrue(out['writeMayHaveOccurred'])
        self.assertEqual([c['mode'] for c in f.calls],['inspect','apply'])
    def test_exact_schema(self):
        for change in [lambda r:r.update(program='evil'),lambda r:r['scope'].update(extra=1),lambda r:r['expected'].update(extra=1),lambda r:r.pop('targetTitle'),lambda r:r.update(mode='read')]:
            r=request(); change(r); f=Fake(); self.assertEqual(self.run_worker(r,f)['status'],'error'); self.assertEqual(f.calls,[])
    def test_scope_validation(self):
        for key,value in [('noteId','bad'),('attachmentId',IDS[0]),('macBuild','25G84'),('remoteUser','a/b'),('folderId','{'+IDS[2]+'}')]:
            r=request(); r['scope'][key]=value; self.assertEqual(self.run_worker(r)['status'],'error')
    def test_identity(self):
        for key in ('user','build','architecture'):
            f=Fake(); identity=f.identity(); identity[key]='wrong'; f.identity=lambda:identity
            self.assertEqual(self.run_worker(f=f)['status'],'error'); self.assertEqual(f.calls,[])
    def test_deadline_and_titles(self):
        for key,value in [('deadlineMs',NOW),('deadlineMs',NOW+60001),('deadlineMs',True),('deadlineMs',float('inf')),('targetTitle',4),('targetTitle','\ud800'),('expectedNativeTitle',None)]:
            r=request('apply'); r[key]=value; self.assertEqual(self.run_worker(r)['status'],'error')
        r=request('apply'); r.pop('expectedNativeTitle'); self.assertEqual(self.run_worker(r)['status'],'error')
    def test_hashes_and_user_title(self):
        for key in ('noteTagSha256','attachmentTagSha256','localDocumentSha256'):
            r=request(); r['expected'][key]='0'*64; self.assertEqual(self.run_worker(r)['status'],'error')
        r=request(); r['expectedUserTitle']='different'; self.assertEqual(self.run_worker(r)['status'],'error')
        r=request(); r['expected'].pop('localDocumentSha256'); self.assertEqual(self.run_worker(r)['status'],'ready')
    def test_closed_and_pending(self):
        f=Fake(); f.running=False; self.assertEqual(self.run_worker(f=f)['status'],'error'); self.assertEqual(f.calls,[])
        f=Fake(); f.read_snapshot=lambda s: (_ for _ in ()).throw(w.Rejected('fetch-pending'))
        self.assertEqual(self.run_worker(f=f)['status'],'pending')
    def test_read_stability(self):
        for key in snapshot():
            f=Fake(); f.states[1][key]='changed'; out=self.run_worker(request('apply'),f)
            self.assertEqual(out['status'],'error'); self.assertFalse(out['writeMayHaveOccurred'])
    def test_native_mismatch(self):
        for key,value in [('scriptingId','wrong'),('assigned',True),('previousTitle','different'),('nativeTitle','different')]:
            f=Fake(); original=f.run_jxa
            def bad(p,t):
                result=original(p,t); result[key]=value; return result
            f.run_jxa=bad; self.assertEqual(self.run_worker(request('apply'),f)['status'],'error')
    def test_already_target(self):
        f=Fake(); f.states=[snapshot('Title'),snapshot('Title')]; r=request('apply'); r['expectedNativeTitle']='Title'
        f.run_jxa=lambda p,t: dict(scriptingId=URI,previousTitle='Title',nativeTitle='Title',assigned=False)
        out=self.run_worker(r,f); self.assertEqual(out['status'],'assigned'); self.assertFalse(out['writeMayHaveOccurred'])
    def test_post_tags_allowed_pending_title(self):
        f=Fake(); f.states[2].update(noteTagSha256=w.digest(b'new'),attachmentTagSha256=w.digest(b'new2'),persistedTitle='Old')
        self.assertEqual(self.run_worker(request('apply'),f)['status'],'persistence-pending')
    def test_post_preservation(self):
        for key in ('localDocumentSha256','scopeSha256','userTitle','persistedTitle'):
            f=Fake(); f.states[2][key]='changed'; out=self.run_worker(request('apply'),f)
            self.assertEqual(out['status'],'ambiguous'); self.assertTrue(out['writeMayHaveOccurred'])
    def test_apply_failure_redacted(self):
        f=Fake(); original=f.run_jxa
        def bad(p,t):
            if p['mode']=='apply': raise RuntimeError('credential-secret')
            return original(p,t)
        f.run_jxa=bad; out=self.run_worker(request('apply'),f)
        self.assertEqual(out['status'],'ambiguous'); self.assertNotIn('secret',str(out)); self.assertEqual(len(f.calls),1)
    def test_deadline_before_write(self):
        f=Fake(); times=iter([NOW,NOW,NOW+31000])
        out=w.execute(request('apply'),f,lambda:next(times)); self.assertFalse(out['writeMayHaveOccurred'])
    def test_bounded_json(self):
        for raw in (b'{',b' '*32769,b'[]',b'{"mode":"inspect","mode":"apply"}',b'{"x":NaN}'):
            out=io.StringIO(); w.main(io.BytesIO(raw),out,Fake(),lambda:NOW)
            self.assertEqual(json.loads(out.getvalue())['status'],'error')
    def test_argv_and_embedded_source(self):
        payload={'targetTitle':'"; evil(); // ${data} `'}
        with patch.object(w.subprocess,'run') as run:
            run.return_value.returncode=0; run.return_value.stdout='{}'
            w.MacAdapter().run_jxa(payload,2)
            argv=run.call_args.args[0]; self.assertEqual(argv[-1],json.dumps(payload,separators=(',',':')))
            self.assertEqual(argv[4],w.JXA); self.assertNotIn('shell',run.call_args.kwargs)
        self.assertEqual(w.JXA.count('note.name ='),1)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for the offline JXA double')
    def test_embedded_jxa_public_setter_guards(self):
        harness = r'''
const vm = require('vm');
const input = JSON.parse(process.argv[1]);
let title = input.current, writes = 0, getters = 0;
const note = {id: () => input.id, get name() { return () => { getters++; return title; }; },
              set name(value) { writes++; title = value; }};
const context = {Application: () => ({running: () => input.running,
  notes: {byId: id => { if (id !== input.id) throw Error('wrong exact URI'); return note; }}})};
vm.createContext(context);
vm.runInContext(input.source, context);
try { console.log(JSON.stringify({result: JSON.parse(context.run([JSON.stringify(input.payload)])), writes, getters, title})); }
catch (_) { console.log(JSON.stringify({error: true, writes, getters, title})); }
'''
        weird = '"; injected(); // ' + chr(96) + '$' + '{value}'
        cases = [('inspect','Old',True,'Old',0,False), ('apply','Old',True,weird,1,False),
                 ('apply',weird,True,weird,0,False), ('apply','Other',True,weird,0,True),
                 ('apply','Old',False,weird,0,True)]
        for mode,current,running,target,count,error in cases:
            payload=dict(mode=mode,scriptingId=URI,expectedNativeTitle='Old' if current != weird else weird,
                         targetTitle=target,deadlineMs=__import__('time').time()*1000+30000)
            data=dict(source=w.JXA,payload=payload,id=URI,current=current,running=running)
            output=subprocess.run(['node','-e',harness,json.dumps(data)],capture_output=True,text=True,check=True)
            value=json.loads(output.stdout)
            self.assertEqual(value['writes'],count); self.assertEqual(value.get('error',False),error)
            if count: self.assertEqual(value['title'],weird)

class SQLiteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path=pathlib.Path(self.tmp.name)/'store.sqlite'
        c=sqlite3.connect(self.path)
        c.executescript('''CREATE TABLE Z_METADATA (Z_UUID TEXT);
        CREATE TABLE ZICNOTEDATA (ZNOTE INTEGER,ZDATA BLOB);
        CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER,ZIDENTIFIER TEXT,ZTITLE1 TEXT,
        ZTITLESOURCEATTACHMENT INTEGER,ZNOTE INTEGER,ZUSERTITLE TEXT,ZTYPEUTI TEXT,ZFOLDER INTEGER,
        ZNEEDSINITIALFETCHFROMCLOUD INTEGER,ZNEEDSTOBEFETCHEDFROMCLOUD INTEGER,
        ZNEEDSINITIALRELATIONSHIPSETUP INTEGER,ZUNAPPLIEDENCRYPTEDRECORDDATA BLOB,ZSERVERRECORDDATA BLOB);''')
        def archive(tag): return plistlib.dumps({'$objects':['$null',{'ETag':plistlib.UID(2)},tag],'$top':{'root':plistlib.UID(1)}},fmt=plistlib.FMT_BINARY)
        c.execute('INSERT INTO Z_METADATA VALUES (?)',(IDS[3],)); c.execute('INSERT INTO ZICNOTEDATA VALUES (7,?)',(b'body',))
        c.executemany('INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[
            (7,IDS[0],'Old',8,None,None,None,9,0,None,None,None,archive('n')),
            (8,IDS[1],None,None,7,'Title','com.apple.paper',None,0,None,0,None,archive('a')),
            (9,IDS[2],'Folder',None,None,None,None,None,None,None,None,None,None)])
        c.commit(); c.close()
    def test_read_only(self):
        before=self.path.read_bytes(); result=w.read_snapshot(self.path,request()['scope'])
        self.assertEqual(result['scriptingId'],URI); self.assertEqual(result['localDocumentSha256'],w.digest(b'body'))
        self.assertEqual(before,self.path.read_bytes())
    def test_scope_flags_archive(self):
        original=self.path.read_bytes()
        for sql in ["UPDATE Z_METADATA SET Z_UUID='bad'","UPDATE ZICCLOUDSYNCINGOBJECT SET ZNOTE=6 WHERE Z_PK=8",
                    "UPDATE ZICCLOUDSYNCINGOBJECT SET ZTYPEUTI='wrong' WHERE Z_PK=8",
                    "UPDATE ZICCLOUDSYNCINGOBJECT SET ZIDENTIFIER='bad' WHERE Z_PK=9",
                    'UPDATE ZICCLOUDSYNCINGOBJECT SET ZNEEDSTOBEFETCHEDFROMCLOUD=1 WHERE Z_PK=7',
                    "UPDATE ZICCLOUDSYNCINGOBJECT SET ZUNAPPLIEDENCRYPTEDRECORDDATA=X'00' WHERE Z_PK=8",
                    "UPDATE ZICCLOUDSYNCINGOBJECT SET ZSERVERRECORDDATA=X'00' WHERE Z_PK=7",
                    'INSERT INTO ZICCLOUDSYNCINGOBJECT SELECT * FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK=8']:
            self.path.write_bytes(original); c=sqlite3.connect(self.path); c.execute(sql); c.commit(); c.close()
            with self.subTest(sql=sql),self.assertRaises(w.Rejected): w.read_snapshot(self.path,request()['scope'])
    def test_archive_rejects_malformed(self):
        for value in (None,b'bad',plistlib.dumps({'$objects':[],'$top':{}})):
            with self.assertRaises(w.Rejected): w.etag_hash(value)

if __name__=='__main__': unittest.main()
