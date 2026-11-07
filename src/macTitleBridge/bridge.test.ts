import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge, durability, type BridgeIO, type RenameIntent } from './bridge.js';

const intent: RenameIntent = { id: 'rename-1', noteId: 'note-1', oldTitle: 'old', targetTitle: 'new', file: 'note.md', fileSha256: 'baseline' };
async function fixture(fn: (dir: string, io: BridgeIO, state: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'rename-bridge-'));
  const state = { attachment: 'old', note: 'old', native: 'old', persisted: 'old', ready: true, imported: true, writes: [] as string[], checks: 0 };
  const io: BridgeIO = {
    async checkLocal() { state.checks++; },
    async inspectCloud() { return { attachmentTitle: state.attachment, noteTitle: state.note }; },
    async inspectMac() { return { ready: state.ready && (state.attachment === 'old' || state.imported), nativeTitle: state.native, persistedTitle: state.persisted }; },
    async publishAttachmentTitle() { state.writes.push('A'); state.attachment = 'new'; },
    async assignNativeName() { state.writes.push('N'); state.native = 'new'; },
    async publishNoteTitle() { state.writes.push('B'); state.note = 'new'; },
    async verify() { return { macPersisted: state.persisted === 'new' }; },
  };
  try { await fn(dir, io, state); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Mac unavailable: no writes, then A/N/B and persisted verification', async () => fixture(async (dir, io, s) => {
  s.ready = false;
  assert.equal((await runBridge(dir, intent, io)).status, 'pending');
  assert.deepEqual(s.writes, []);
  s.ready = true;
  assert.equal((await runBridge(dir, intent, io)).status, 'pending');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
  s.persisted = 'new';
  assert.equal((await runBridge(dir, intent, io)).status, 'completed');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('restart waits read-only for A import', async () => fixture(async (dir, io, s) => {
  s.imported = false;
  assert.equal((await runBridge(dir, intent, io)).status, 'pending');
  assert.equal((await runBridge(dir, intent, io)).status, 'pending');
  assert.deepEqual(s.writes, ['A']);
  s.imported = true;
  await runBridge(dir, intent, io);
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('uncertain A never retries without proof', async () => fixture(async (dir, io, s) => {
  io.publishAttachmentTitle = async () => { s.writes.push('A'); throw Error('lost response'); };
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.deepEqual(s.writes, ['A']);
  s.attachment = 'new'; s.persisted = 'new';
  assert.equal((await runBridge(dir, intent, io)).status, 'completed');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('an equal title cannot prove an uncertain B heartbeat was dispatched', async () => fixture(async (dir, io, s) => {
  s.note = s.persisted = 'new';
  io.publishNoteTitle = async () => { s.writes.push('B'); throw Error('failed before dispatch'); };
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('preservation failure and changed target stop all dispatch', async () => fixture(async (dir, io, s) => {
  io.checkLocal = async () => { throw Error('baseline changed'); };
  await assert.rejects(runBridge(dir, intent, io), /baseline changed/);
  assert.deepEqual(s.writes, []);
  io.checkLocal = async () => {};
  s.ready = false;
  await runBridge(dir, intent, io);
  await assert.rejects(runBridge(dir, { ...intent, targetTitle: 'different' }, io), /intent mismatch/);
  assert.deepEqual(s.writes, []);
}));

test('fsync failure before dispatch never writes cloud', async () => fixture(async (dir, io, s) => {
  const original = durability.sync;
  durability.sync = async () => { throw Error('fsync failed'); };
  try { assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous'); }
  finally { durability.sync = original; }
  assert.deepEqual(s.writes, []);
}));

test('operation INTENT fsync failure cannot dispatch or retry', async () => fixture(async (dir, io, s) => {
  const original = durability.sync;
  durability.sync = async fd => {
    const entries = await readdir(dir);
    if (entries.length && (await readdir(join(dir, entries[0]!))).includes('A.INTENT.json')) {
      throw Error('intent fsync failed');
    }
    await original(fd);
  };
  try { assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous'); }
  finally { durability.sync = original; }
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.deepEqual(s.writes, []);
}));

test('ACK fsync failure is ambiguous and cannot redispatch', async () => fixture(async (dir, io, s) => {
  const original = durability.sync;
  durability.sync = async fd => {
    const entries = await readdir(dir);
    if (entries.length && (await readdir(join(dir, entries[0]!))).includes('A.ACK.json')) {
      throw Error('ACK fsync failed');
    }
    await original(fd);
  };
  try { assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous'); }
  finally { durability.sync = original; }
  await runBridge(dir, intent, io);
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('overlapping invocations cannot dispatch twice', async () => fixture(async (dir, io, s) => {
  const results = await Promise.all([runBridge(dir, intent, io), runBridge(dir, intent, io)]);
  assert.ok(results.some(result => result.stage === 'locked'));
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));

test('verification failure cannot claim completion', async () => fixture(async (dir, io) => {
  io.verify = async () => { throw Error('assets changed'); };
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
}));

test('N uncertain request never repeats, native proof still needs DB verification', async () => fixture(async (dir, io, s) => {
  io.assignNativeName = async () => { s.writes.push('N'); s.native = 'new'; throw Error('timeout'); };
  assert.equal((await runBridge(dir, intent, io)).status, 'ambiguous');
  assert.equal((await runBridge(dir, intent, io)).status, 'pending');
  assert.deepEqual(s.writes, ['A', 'N', 'B']);
}));
