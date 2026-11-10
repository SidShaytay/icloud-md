import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDrawingTitleLedger, drawingTitleLedgerDurability, type DrawingTitleLeaseRegistration, type DrawingTitleLeaseObservation } from "./drawingTitleLedger.js";
const noteId = "11111111-1111-4111-8111-111111111111", attachmentId = "22222222-2222-4222-8222-222222222222", folderId = "33333333-3333-4333-8333-333333333333";
const intent: DrawingTitleLeaseRegistration = {
  noteId, attachmentId, folderId, targetTitle: "New drawing", file: "TEST/New drawing.md", fileSha256: "1".repeat(64), localBodySha256: "2".repeat(64), protectedSha256: "5".repeat(64), initialNoteTitle: "Old drawing", initialAttachmentTitle: "Old drawing", initialNoteTag: "note-1", initialAttachmentTag: "attachment-1", initialModificationDate: 100, noteModificationDate: 200
};
function observation(overrides: Partial<DrawingTitleLeaseObservation> = {}): DrawingTitleLeaseObservation {
  return {
    file: intent.file, fileSha256: intent.fileSha256, localBodySha256: intent.localBodySha256, protectedSha256: intent.protectedSha256, noteTag: "note-1", attachmentTag: "attachment-1", noteTitle: "Old drawing", attachmentTitle: "Old drawing", modificationDate: 100, ...overrides
  };
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, writer = true) {
  const f = await setup();
  try {
    if (writer) await f.ledger.withWriter(() => run(f)); else await run(f);
  }
  finally {
    await rm(f.root, {
      recursive: true, force: true
    });
  }
}
const unscopedFixture = (run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) => fixture(run, false);
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "drawing-ledger-")), vault = path.join(root, "vault"), journalDirectory = path.join(root, "private-journal");
  await mkdir(path.join(vault, ".icloud-md"), {
    recursive: true
  });
  let now = 1000;
  const options = {
    vault, journalDirectory, accountDsidSha256: "a".repeat(64)
  }, ports = {
    now: () => now
  };
  const ledger = await openDrawingTitleLedger(options, ports);
  return {
    root, vault, options, ports, ledger, setNow: (value: number) => {
      now = value;
    }
  };
}
async function active(f: Awaited<ReturnType<typeof setup>>) {
  let entry = await f.ledger.register(intent);
  let claim = await f.ledger.claim(noteId, {
    expectedRevision: entry.revision, observation: observation()
  });
  assert(claim.dispatch);
  entry = await f.ledger.acknowledge(noteId, {
    expectedRevision: claim.entry.revision, token: claim.dispatch.token, observation: observation({
      attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle
    })
  });
  claim = await f.ledger.claim(noteId, {
    expectedRevision: entry.revision, observation: observation({
      attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle
    })
  });
  assert.equal(claim.dispatch?.phase, "B");
  entry = await f.ledger.acknowledge(noteId, {
    expectedRevision: claim.entry.revision, token: claim.dispatch!.token, observation: observation({
      noteTag: "note-2", attachmentTag: "attachment-2", noteTitle: intent.targetTitle, attachmentTitle: intent.targetTitle, modificationDate: 200
    })
  });
  return entry;
}
const current = () => observation({
  noteTag: "note-2", attachmentTag: "attachment-2", noteTitle: intent.targetTitle, attachmentTitle: intent.targetTitle, modificationDate: 200
});
test("A then B become an active bounded title-only due lease", () => fixture(async (f) => {
  const entry = await active(f);
  assert.equal(entry.stage, "active");
  assert.equal(entry.nextDue, 301000);
  assert.equal(entry.pending, undefined);
  const persisted = JSON.parse(await readFile(await storedLedgerFile(f), "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), ["intent", "nextDue", "revision", "stage", "tags", "version"]);
  assert.deepEqual(await f.ledger.listNoteIds(), [
    noteId.toUpperCase()
  ]);
  f.setNow(300999);
  assert.equal((await f.ledger.claim(noteId, {
    expectedRevision: entry.revision, observation: current()
  })).dispatch, undefined);
  f.setNow(301000);
  const claim = await f.ledger.claim(noteId, {
    expectedRevision: entry.revision, observation: current()
  });
  assert.equal(claim.dispatch?.phase, "refresh");
  assert.equal(claim.dispatch?.recordChangeTag, "note-2");
  assert.equal(claim.dispatch?.modificationDate, undefined);
  assert.equal((await f.ledger.read(noteId))?.pending?.token, claim.dispatch?.token);
}));
test("concurrent claims persist once; a fresh writer waits for an advanced server version", () => unscopedFixture(async f => {
  let claimed!: Awaited<ReturnType<typeof f.ledger.claim>>;
  await f.ledger.withWriter(async () => {
    const entry = await f.ledger.register(intent);
    const results = await Promise.allSettled([
      f.ledger.claim(noteId, { expectedRevision: entry.revision, observation: observation() }),
      f.ledger.claim(noteId, { expectedRevision: entry.revision, observation: observation() }),
    ]);
    const claims = results.flatMap(result => result.status === "fulfilled" && result.value.dispatch ? [result.value] : []);
    assert.equal(claims.length, 1);
    claimed = claims[0]!;
  });
  const reopened = await openDrawingTitleLedger(f.options, f.ports), pending = await reopened.read(noteId);
  assert(pending?.pending);
  assert.equal(pending.revision, claimed.entry.revision);
  assert.deepEqual(pending.pending, { token: claimed.dispatch!.token, phase: "A", issuedAt: 1000,
    beforeTags: { note: "note-1", attachment: "attachment-1" } });
  await reopened.withWriter(async () => {
    const unchanged = await reopened.resolvePending(noteId, { expectedRevision: pending.revision, observation: observation() });
    assert.equal(unchanged.revision, pending.revision);
    assert.deepEqual(unchanged.pending, pending.pending);
    const result = await reopened.claim(noteId, { expectedRevision: unchanged.revision, observation: observation() });
    assert.equal(result.dispatch, undefined);
    assert.deepEqual(result.entry.pending, pending.pending);
    const advanced = await reopened.resolvePending(noteId, { expectedRevision: result.entry.revision,
      observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) });
    assert.equal(advanced.stage, "note");
    assert.equal(advanced.pending, undefined);
    assert.equal(advanced.tags.attachment, "attachment-2");
  });
}));
test("an unchanged server version keeps the initial request pending", () => fixture(async (f) => {
  let e = await f.ledger.register({
    ...intent, initialAttachmentTitle: intent.targetTitle
  });
  const claim = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation({
      attachmentTitle: intent.targetTitle
    })
  });
  e = await f.ledger.resolvePending(noteId, {
    expectedRevision: claim.entry.revision, observation: observation({
      attachmentTitle: intent.targetTitle
    })
  });
  assert(e.pending);
  assert.equal(e.stage, "attachment");
  assert.equal(e.pending?.token, claim.dispatch?.token);
}));
test("lost same-value refresh permits a fresh distinct bounded attempt only after five minutes", () => fixture(async (f) => {
  let e = await active(f);
  f.setNow(301000);
  let c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: current()
  });
  const old = c.dispatch!.token;
  e = c.entry;
  f.setNow(600999);
  assert.equal((await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: current()
  })).dispatch, undefined);
  f.setNow(601000);
  c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: current()
  });
  assert(c.dispatch);
  assert.notEqual(c.dispatch.token, old);
  assert.equal(c.entry.pending?.token, c.dispatch.token);
  assert.equal(c.entry.pending?.issuedAt, 601000);
  await assert.rejects(f.ledger.register({
    ...intent, targetTitle: "Newer drawing", file: "TEST/Newer drawing.md"
  }, {
    expectedRevision: c.entry.revision
  }), /pending/i);
}));
for (const field of [
  "file", "fileSha256", "localBodySha256", "protectedSha256", "noteTitle", "attachmentTitle", "modificationDate"
] as const)
  test(`foreign ${field} cancels lease before a due dispatch`, () => fixture(async (f) => {
    const e = await active(f);
    f.setNow(301000);
    const obs = current();
    (obs as unknown as Record<string, unknown>)[field] = field === "modificationDate" ? 201 : field.endsWith("Sha256") ? "f".repeat(64) : field === "file" ? "TEST/Changed.md" : "changed";
    const c = await f.ledger.claim(noteId, {
      expectedRevision: e.revision, observation: obs
    });
    assert.equal(c.entry.stage, "cancelled");
    assert.equal(c.dispatch, undefined);
  }));
test("newer intent cannot discard an unresolved request; foreign advanced CAS can safely cancel it", () => fixture(async (f) => {
  const e = await f.ledger.register(intent), c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation()
  });
  await assert.rejects(f.ledger.register({
    ...intent, targetTitle: "Newer", file: "TEST/Newer.md"
  }, {
    expectedRevision: c.entry.revision
  }), /pending/i);
  const cancelled = await f.ledger.resolvePending(noteId, {
    expectedRevision: c.entry.revision, observation: observation({
      attachmentTag: "foreign-version", attachmentTitle: "Foreign"
    })
  });
  assert.equal(cancelled.stage, "cancelled");
  assert.equal(cancelled.pending, undefined);
  const newer = await f.ledger.register({
    ...intent, targetTitle: "Newer", file: "TEST/Newer.md"
  }, {
    expectedRevision: cancelled.revision
  });
  assert.equal(newer.stage, "attachment");
}));
test("completing a request requires its token and an advanced valid server version", () => fixture(async (f) => {
  const e = await f.ledger.register(intent), c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation()
  });
  await assert.rejects(f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: "wrong", observation: observation()
  }));
  await assert.rejects(f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: undefined as unknown as string, observation: observation()
  }), /token/);
  const still = await f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: c.dispatch!.token, observation: observation()
  });
  assert(still.pending);
  assert.equal(still.pending?.token, c.dispatch?.token);
}));
test("clock rollback or a forward jump cannot cause a catch-up burst", () => fixture(async (f) => {
  let e = await active(f);
  f.setNow(10);
  assert.equal((await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: current()
  })).dispatch, undefined);
  f.setNow(10000000);
  const c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: current()
  });
  e = await f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: c.dispatch!.token, observation: {
      ...current(), noteTag: "note-3"
    }
  });
  assert.equal(e.nextDue, 10300000);
  assert.equal((await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: {
      ...current(), noteTag: "note-3"
    }
  })).dispatch, undefined);
}));
test("durability failure never returns dispatch and leaves the previous stage readable", () => fixture(async (f) => {
  const e = await f.ledger.register(intent), sync = drawingTitleLedgerDurability.sync;
  drawingTitleLedgerDurability.sync = async () => {
    throw Error("fsync failed");
  };
  try {
    await assert.rejects(f.ledger.claim(noteId, {
      expectedRevision: e.revision, observation: observation()
    }));
  }
  finally {
    drawingTitleLedgerDurability.sync = sync;
  }
  const reopened = await openDrawingTitleLedger(f.options, f.ports), entry = await reopened.read(noteId);
  assert.equal(entry?.stage, "attachment");
  assert.equal(entry?.pending, undefined);
}));
test("record storage is bounded across repeated refreshes and contains no raw records or asset URLs", () => fixture(async (f) => {
  let e = await active(f);
  for (let i = 0; i < 12; i++) {
    f.setNow(301000 + i * 300000);
    e = (await f.ledger.claim(noteId, {
      expectedRevision: e.revision, observation: current()
    })).entry;
  }
  assert.equal(e.pending?.phase, "refresh");
  assert.equal((await f.ledger.listNoteIds()).length, 1);
  assert(JSON.stringify(e).length < 16384);
  assert(!JSON.stringify(e).includes("downloadURL"));
}));
test("changed ownership, a symlink store and stale revisions fail closed", () => fixture(async (f) => {
  const e = await f.ledger.register(intent);
  await assert.rejects(f.ledger.claim(noteId, {
    expectedRevision: e.revision - 1, observation: observation()
  }));
  const owner = path.join(path.dirname(await storedLedgerFile(f)), "writer.lockdir", "owner"), token = await readFile(owner, "utf8");
  try {
    await writeFile(owner, "changed-owner");
    await assert.rejects(f.ledger.claim(noteId, { expectedRevision: e.revision, observation: observation() }), /ownership/);
  } finally { await writeFile(owner, token); }
  const other = path.join(f.root, "link");
  await symlink(f.options.journalDirectory, other, "junction");
  await assert.rejects(openDrawingTitleLedger({
    ...f.options, journalDirectory: other
  }, f.ports));
}));
test("registering the same filename intent cannot reset cadence through fresh metadata", () => fixture(async (f) => {
  const e = await active(f);
  const repeated = await f.ledger.register({
    ...intent, initialNoteTag: "note-2", initialAttachmentTag: "attachment-2", initialNoteTitle: intent.targetTitle, initialAttachmentTitle: intent.targetTitle, noteModificationDate: 999
  }, {
    expectedRevision: e.revision
  });
  assert.equal(repeated.stage, "active");
  assert.equal(repeated.revision, e.revision);
  assert.equal(repeated.nextDue, e.nextDue);
}));
test("title is bound to its local filename rather than an independent writer value", () => fixture(async (f) => {
  await assert.rejects(f.ledger.register({
    ...intent, targetTitle: "A different title"
  }), /filename/i);
}));

test("status reads do not create storage or pin; account and root permissions stay bound",()=>unscopedFixture(async f=>{
 assert.equal(await f.ledger.read(noteId),undefined);assert.deepEqual(await f.ledger.listNoteIds(),[]);
 await assert.rejects(lstat(f.options.journalDirectory),{code:"ENOENT"});
 await assert.rejects(lstat(path.join(f.vault,".icloud-md","attachment-title-journal.json")),{code:"ENOENT"});
 await f.ledger.withWriter(async () => { await f.ledger.register(intent); });
 await assert.rejects(openDrawingTitleLedger({...f.options,accountDsidSha256:"b".repeat(64)},f.ports));
 if (process.platform !== "win32") { await chmod(f.options.journalDirectory,0o755);await assert.rejects(f.ledger.read(noteId),/private journal/i); }
}));
test("malformed, oversized and symlink lease files fail closed",()=>fixture(async f=>{
 await f.ledger.register(intent);const base=path.join(f.options.journalDirectory,"drawing-title-leases-v1"),dir=path.join(base,(await readdir(base))[0]!),name=(await readdir(dir)).find(name=>name.endsWith(".json"))!,file=path.join(dir,name),original=await readFile(file,"utf8");
 const corrupt=JSON.parse(original);corrupt.tags.rawRecords=[];await writeFile(file,JSON.stringify(corrupt));await assert.rejects(f.ledger.read(noteId));
 await writeFile(file," ".repeat(16385));await assert.rejects(f.ledger.read(noteId),/Unsafe|Oversized/);
 if (process.platform !== "win32") { await rm(file);await symlink(path.join(f.root,"outside"),file);await assert.rejects(f.ledger.read(noteId)); }
}));
test("a failed completion save stays pending and a fresh scope resolves exact observed state", () => unscopedFixture(async f => {
  await f.ledger.withWriter(async () => {
    const entry = await f.ledger.register(intent), claim = await f.ledger.claim(noteId, { expectedRevision: entry.revision, observation: observation() });
    const sync = drawingTitleLedgerDurability.sync;
    drawingTitleLedgerDurability.sync = async () => { throw Error("completion fsync failed"); };
    try {
      await assert.rejects(f.ledger.acknowledge(noteId, { expectedRevision: claim.entry.revision, token: claim.dispatch!.token,
        observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) }));
    } finally { drawingTitleLedgerDurability.sync = sync; }
  });
  const reopened = await openDrawingTitleLedger(f.options, f.ports), pending = await reopened.read(noteId);
  assert(pending?.pending);
  await reopened.withWriter(async () => {
    const resolved = await reopened.resolvePending(noteId, { expectedRevision: pending.revision,
      observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) });
    assert.equal(resolved.stage, "note"); assert.equal(resolved.pending, undefined); assert.equal(resolved.tags.attachment, "attachment-2");
  });
}));
test("failure after atomic rename never dispatches and preserves the pending claim across scopes", { skip: process.platform === "win32" }, () => unscopedFixture(async f => {
  await f.ledger.withWriter(async () => {
    const entry = await f.ledger.register(intent), sync = drawingTitleLedgerDurability.sync; let calls = 0;
    drawingTitleLedgerDurability.sync = async file => { await sync(file); if (++calls === 2) throw Error("directory fsync failed"); };
    try { await assert.rejects(f.ledger.claim(noteId, { expectedRevision: entry.revision, observation: observation() })); }
    finally { drawingTitleLedgerDurability.sync = sync; }
  });
  const reopened = await openDrawingTitleLedger(f.options, f.ports), pending = await reopened.read(noteId); assert(pending?.pending);
  await reopened.withWriter(async () => {
    const claim = await reopened.claim(noteId, { expectedRevision: pending.revision, observation: observation() });
    assert.equal(claim.dispatch, undefined); assert.deepEqual(claim.entry.pending, pending.pending);
  });
}));

test("vault/account namespaces sharing an evidence root list only their own notes",()=>fixture(async f=>{
 await f.ledger.register(intent);const otherVault=path.join(f.root,"other-vault");await mkdir(path.join(otherVault,".icloud-md"),{recursive:true});
 const other=await openDrawingTitleLedger({...f.options,vault:otherVault,accountDsidSha256:"b".repeat(64)},f.ports);
 const otherNote="44444444-4444-4444-8444-444444444444";await other.withWriter(async () => { await other.register({...intent,noteId:otherNote}); });
 assert.deepEqual(await f.ledger.listNoteIds(),[noteId.toUpperCase()]);assert.deepEqual(await other.listNoteIds(),[otherNote.toUpperCase()]);assert.equal(await f.ledger.read(otherNote),undefined);
}));
test("a paused superseded claim cannot dispatch and overlapping operations refuse",()=>fixture(async f=>{
 let e=await active(f);f.setNow(301000);const old=await f.ledger.claim(noteId,{expectedRevision:e.revision,observation:current()});let sends=0;f.setNow(601001);await assert.rejects(f.ledger.withDispatch(noteId,{expectedRevision:old.entry.revision,token:old.dispatch!.token},async()=>{sends++;}),/Expired/i);f.setNow(601000);const newer=await f.ledger.claim(noteId,{expectedRevision:old.entry.revision,observation:current()});
 await assert.rejects(f.ledger.withDispatch(noteId,{expectedRevision:old.entry.revision,token:old.dispatch!.token},async()=>{sends++;}));assert.equal(sends,0);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
 const running=f.ledger.withDispatch(noteId,{expectedRevision:newer.entry.revision,token:newer.dispatch!.token},async()=>{sends++;started();await gate;return "sent-once";});await entered;f.setNow(901000);
 try{await assert.rejects(f.ledger.claim(noteId,{expectedRevision:newer.entry.revision,observation:current()}),/operation/i);}finally{release();}
 assert.equal(await running,"sent-once");assert.equal(sends,1);
}));

test("title writer excludes sibling feature runs through state bookkeeping and permits nested note operations",()=>unscopedFixture(async f=>{
 const worker=await import(new URL("./drawingTitleLedger.ts?vault-worker",import.meta.url).href) as typeof import("./drawingTitleLedger.js"),other=await worker.openDrawingTitleLedger(f.options,f.ports);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});let cloneStateWrites=0;
 const running=f.ledger.withWriter(async()=>{const e=await f.ledger.register(intent),claim=await f.ledger.claim(noteId,{expectedRevision:e.revision,observation:observation()});await f.ledger.withDispatch(noteId,{expectedRevision:claim.entry.revision,token:claim.dispatch!.token},async()=>"SDK");started();await gate;cloneStateWrites++;});
 await entered;try{await assert.rejects(other.withWriter(async()=>{cloneStateWrites++;}),/writer|lock/i);assert.equal(cloneStateWrites,0);}finally{release();}
 await running;assert.equal(cloneStateWrites,1);assert.deepEqual(await f.ledger.listNoteIds(),[noteId.toUpperCase()]);
}));


test("ledger keys compare UUIDs case-insensitively while dispatch preserves observed CloudKit record names", () => fixture(async f => {
  const lowerNote = "aaaaaaaa-1111-4111-8111-111111111111", lowerAttachment = "bbbbbbbb-2222-4222-8222-222222222222", lowerFolder = "cccccccc-3333-4333-8333-333333333333";
  let entry = await f.ledger.register({ ...intent, noteId: lowerNote, attachmentId: lowerAttachment, folderId: lowerFolder });
  assert.equal(entry.intent.noteId, lowerNote); assert.equal(entry.intent.attachmentId, lowerAttachment); assert.equal(entry.intent.folderId, lowerFolder);
  assert.deepEqual(await f.ledger.read(lowerNote.toUpperCase()), entry);
  assert.deepEqual(await f.ledger.listNoteIds(), [lowerNote]);
  const first = await f.ledger.claim(lowerNote.toUpperCase(), { expectedRevision: entry.revision, observation: observation() });
  assert.equal(first.dispatch!.recordName, lowerAttachment);
  entry = await f.ledger.acknowledge(lowerNote, { expectedRevision: first.entry.revision, token: first.dispatch!.token,
    observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) });
  const second = await f.ledger.claim(lowerNote, { expectedRevision: entry.revision,
    observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) });
  assert.equal(second.dispatch!.recordName, lowerNote);
}));

test("identities differing only in UUID casing cannot overlap note and attachment roles", () => fixture(async f => {
  const lowerNote = "aaaaaaaa-1111-4111-8111-111111111111";
  await assert.rejects(f.ledger.register({ ...intent, noteId: lowerNote, attachmentId: lowerNote.toUpperCase() }), /Overlapping/);
}));


test("alternate UUID spelling cannot restart the same acknowledged rename phase", () => fixture(async f => {
  const lower = { ...intent, noteId: "aaaaaaaa-1111-4111-8111-111111111111", attachmentId: "bbbbbbbb-2222-4222-8222-222222222222", folderId: "cccccccc-3333-4333-8333-333333333333" };
  let entry = await f.ledger.register(lower);
  const claim = await f.ledger.claim(lower.noteId, { expectedRevision: entry.revision, observation: observation() });
  entry = await f.ledger.acknowledge(lower.noteId, { expectedRevision: claim.entry.revision, token: claim.dispatch!.token,
    observation: observation({ attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle }) });
  assert.equal(entry.stage, "note");
  const same = await f.ledger.register({ ...lower, noteId: lower.noteId.toUpperCase(), attachmentId: lower.attachmentId.toUpperCase(), folderId: lower.folderId.toUpperCase() }, { expectedRevision: entry.revision });
  assert.deepEqual(same, entry);
}));


test("canonical parent aliases reopen the same pinned store", () => unscopedFixture(async f => {
  const actual = path.join(f.root, "actual"), alias = path.join(f.root, "alias");
  await mkdir(actual); await symlink(actual, alias, "junction");
  const journalDirectory = path.join(alias, "new", "private");
  const ledger = await openDrawingTitleLedger({ ...f.options, journalDirectory }, f.ports);
  await ledger.withWriter(async () => { await ledger.register(intent); });
  const reopened = await openDrawingTitleLedger({ ...f.options, journalDirectory: path.join(actual, "new", "private") }, f.ports);
  assert.equal((await reopened.read(noteId))?.intent.targetTitle, intent.targetTitle);
}));

for (const [problem, patch, error] of [
  ["unsupported older version", { version: 1 }, /Unsupported.*version/i],
  ["unsupported future version", { version: 99 }, /Unsupported.*version/i],
  ["unknown field", { unexpected: true }, /Unknown ledger fields/],
] as const) for (const access of ["read", "list", "dispatch"] as const) {
  test(`${access} rejects ${problem} without rewriting pending state`, () => fixture(async f => {
    const registered = await f.ledger.register(intent);
    const claim = await f.ledger.claim(noteId, { expectedRevision: registered.revision, observation: observation() });
    const file = await storedLedgerFile(f), before = JSON.stringify({ ...claim.entry, ...patch });
    const files = await readdir(path.dirname(file));
    await writeFile(file, before);
    let dispatched = 0;
    const operation = access === "read" ? () => f.ledger.read(noteId) : access === "list" ? () => f.ledger.listNoteIds() :
      () => f.ledger.withDispatch(noteId, { expectedRevision: claim.entry.revision, token: claim.dispatch!.token }, async () => { dispatched++; });
    await assert.rejects(operation(), error);
    assert.equal(dispatched, 0);
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(await readdir(path.dirname(file)), files);
  }));
}

async function storedLedgerFile(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const root = path.join(f.options.journalDirectory, "drawing-title-leases-v1");
  const directory = path.join(root, (await readdir(root))[0]!);
  return path.join(directory, (await readdir(directory)).find(name => name.endsWith(".json"))!);
}
test("unknown storage files are refused instead of interpreted or silently removed", () => fixture(async f => {
  await f.ledger.register(intent); const directory = path.dirname(await storedLedgerFile(f));
  const unknown = path.join(directory, "unexpected.bin"); await writeFile(unknown, "preserve", { mode: 0o600 });
  await assert.rejects(f.ledger.listNoteIds(), /Unknown lease storage file/);
  assert.equal(await readFile(unknown, "utf8"), "preserve");
}));
