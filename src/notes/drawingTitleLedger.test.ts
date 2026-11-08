import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDrawingTitleLedger, drawingTitleLedgerDurability, type DrawingTitleLeaseIntent, type DrawingTitleLeaseObservation } from "./drawingTitleLedger.js";
const noteId = "11111111-1111-4111-8111-111111111111", attachmentId = "22222222-2222-4222-8222-222222222222", folderId = "33333333-3333-4333-8333-333333333333";
const intent: DrawingTitleLeaseIntent = {
  noteId, attachmentId, folderId, targetTitle: "New drawing", file: "TEST/New drawing.md", fileSha256: "1".repeat(64), localBodySha256: "2".repeat(64), documentSha256: "3".repeat(64), assetRefsSha256: "4".repeat(64), protectedSha256: "5".repeat(64), initialNoteTitle: "Old drawing", initialAttachmentTitle: "Old drawing", initialNoteTag: "note-1", initialAttachmentTag: "attachment-1", initialModificationDate: 100, noteModificationDate: 200
};
function observation(overrides: Partial<DrawingTitleLeaseObservation> = {}): DrawingTitleLeaseObservation {
  return {
    file: intent.file, fileSha256: intent.fileSha256, localBodySha256: intent.localBodySha256, documentSha256: intent.documentSha256, assetRefsSha256: intent.assetRefsSha256, protectedSha256: intent.protectedSha256, noteTag: "note-1", attachmentTag: "attachment-1", noteTitle: "Old drawing", attachmentTitle: "Old drawing", modificationDate: 100, ...overrides
  };
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try {
    await run(f);
  }
  finally {
    await rm(f.root, {
      recursive: true, force: true
    });
  }
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "drawing-ledger-")), vault = path.join(root, "vault"), journalDirectory = path.join(root, "private-journal");
  await mkdir(path.join(vault, ".icloud-md"), {
    recursive: true
  });
  let now = 1000;
  let held = true;
  const options = {
    vault, journalDirectory, accountDsidSha256: "a".repeat(64)
  }, ports = {
    now: () => now, lockAuthority: async () => {
      assert(held, "No lock");
      return {
        path: "/fixture/sync.lock", dev: "1", ino: "2"
      };
    }
  };
  const ledger = await openDrawingTitleLedger(options, ports);
  return {
    root, vault, options, ports, ledger, setNow: (value: number) => {
      now = value;
    }, loseLock: () => {
      held = false;
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
test("pending precedes dispatch and survives reopening; concurrent claims dispatch only once", () => fixture(async (f) => {
  const entry = await f.ledger.register(intent);
  const result = await Promise.allSettled([
    f.ledger.claim(noteId, {
      expectedRevision: entry.revision, observation: observation()
    }), f.ledger.claim(noteId, {
      expectedRevision: entry.revision, observation: observation()
    })
  ]);
  assert.equal(result.filter(r => r.status === "fulfilled" && r.value.dispatch).length, 1);
  const reopened = await openDrawingTitleLedger(f.options, f.ports);
  const pending = await reopened.read(noteId);
  assert(pending?.pending);
  assert.equal((await reopened.claim(noteId, {
    expectedRevision: pending.revision, observation: observation()
  })).dispatch, undefined);
}));
test("fresh same-value unchanged tag never claims initial ACK", () => fixture(async (f) => {
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
  assert.equal(e.lastReceipt, undefined);
}));
test("lost reply can advance via observed postcondition without labelling old request acknowledged", () => fixture(async (f) => {
  const e = await f.ledger.register(intent), c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation()
  });
  const resolved = await f.ledger.resolvePending(noteId, {
    expectedRevision: c.entry.revision, observation: observation({
      attachmentTag: "attachment-2", attachmentTitle: intent.targetTitle
    })
  });
  assert.equal(resolved.stage, "note");
  assert.equal(resolved.lastReceipt?.outcome, "postcondition-observed");
  assert.equal(resolved.recentUncertain.at(-1)?.token, c.dispatch?.token);
  assert.equal(resolved.pending, undefined);
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
  assert.equal(c.entry.recentUncertain.at(-1)?.token, old);
  assert.equal(c.entry.recentUncertain.at(-1)?.outcome, "uncertain");
  await assert.rejects(f.ledger.register({
    ...intent, targetTitle: "Newer drawing", file: "TEST/Newer drawing.md"
  }, {
    expectedRevision: c.entry.revision
  }), /pending/i);
}));
for (const field of [
  "file", "fileSha256", "localBodySha256", "documentSha256", "assetRefsSha256", "protectedSha256", "noteTitle", "attachmentTitle", "modificationDate"
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
test("SDK ACK requires advanced version and valid immutable state", () => fixture(async (f) => {
  const e = await f.ledger.register(intent), c = await f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation()
  });
  await assert.rejects(f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: "wrong", observation: observation()
  }));
  const still = await f.ledger.acknowledge(noteId, {
    expectedRevision: c.entry.revision, token: c.dispatch!.token, observation: observation()
  });
  assert(still.pending);
  assert.equal(still.lastReceipt, undefined);
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
test("durability failure never returns dispatch; restart remains conservative", () => fixture(async (f) => {
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
  assert.equal(entry?.lastReceipt, undefined);
}));
test("record storage is bounded across repeated refreshes and contains no raw records or asset URLs", () => fixture(async (f) => {
  let e = await active(f);
  for (let i = 0; i < 12; i++) {
    f.setNow(301000 + i * 300000);
    e = (await f.ledger.claim(noteId, {
      expectedRevision: e.revision, observation: current()
    })).entry;
  }
  assert(e.recentUncertain.length <= 4);
  assert.equal((await f.ledger.listNoteIds()).length, 1);
  assert(JSON.stringify(e).length < 16384);
  assert(!JSON.stringify(e).includes("downloadURL"));
}));
test("lock loss, a symlink root, malformed state and stale revisions fail closed", () => fixture(async (f) => {
  const e = await f.ledger.register(intent);
  await assert.rejects(f.ledger.claim(noteId, {
    expectedRevision: e.revision - 1, observation: observation()
  }));
  f.loseLock();
  await assert.rejects(f.ledger.claim(noteId, {
    expectedRevision: e.revision, observation: observation()
  }));
  const other = path.join(f.root, "link");
  await symlink(f.options.journalDirectory, other);
  await assert.rejects(openDrawingTitleLedger({
    ...f.options, journalDirectory: other
  }, f.ports));
}));
test("independent workers sharing normal lock cannot substitute another pending token", () => fixture(async (f) => {
  const worker = await import(new URL("./drawingTitleLedger.ts?independent-worker", import.meta.url).href) as typeof import("./drawingTitleLedger.js");
  const other = await worker.openDrawingTitleLedger(f.options, f.ports), e = await f.ledger.register(intent);
  let releaseFirst!: () => void, releaseSecond!: () => void, firstStarted!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(r => {
    releaseFirst = r;
  }), secondGate = new Promise<void>(r => {
    releaseSecond = r;
  });
  const firstReached = new Promise<void>(r => {
    firstStarted = r;
  }), secondReached = new Promise<void>(r => {
    secondStarted = r;
  });
  const sync = drawingTitleLedgerDurability.sync, otherSync = worker.drawingTitleLedgerDurability.sync;
  drawingTitleLedgerDurability.sync = async (file) => {
    await sync(file);
    firstStarted();
    await firstGate;
  };
  worker.drawingTitleLedgerDurability.sync = async (file) => {
    await otherSync(file);
    secondStarted();
    await secondGate;
  };
  try {
    const first = Promise.allSettled([
      f.ledger.claim(noteId, {
        expectedRevision: e.revision, observation: observation()
      })
    ]);
    await firstReached;
    const second = Promise.allSettled([
      other.claim(noteId, {
        expectedRevision: e.revision, observation: observation()
      })
    ]);
    await Promise.race([
      secondReached, second
    ]);
    releaseFirst();
    const a = await first;
    releaseSecond();
    const b = await second;
    const persisted = await f.ledger.read(noteId);
    const dispatched = [
      ...a, ...b
    ].flatMap(r => r.status === "fulfilled" && r.value.dispatch ? [
      r.value.dispatch
    ] : []);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.token, persisted!.pending!.token, "returned dispatch must match its own durable pending token");
  }
  finally {
    releaseFirst();
    releaseSecond();
    drawingTitleLedgerDurability.sync = sync;
    worker.drawingTitleLedgerDurability.sync = otherSync;
  }
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

test("status reads do not create storage or pin; account and root permissions stay bound",()=>fixture(async f=>{
 assert.equal(await f.ledger.read(noteId),undefined);assert.deepEqual(await f.ledger.listNoteIds(),[]);
 await assert.rejects(lstat(f.options.journalDirectory),{code:"ENOENT"});
 await assert.rejects(lstat(path.join(f.vault,".icloud-md","attachment-title-journal.json")),{code:"ENOENT"});
 await f.ledger.register(intent);
 await assert.rejects(openDrawingTitleLedger({...f.options,accountDsidSha256:"b".repeat(64)},f.ports));
 await chmod(f.options.journalDirectory,0o755);await assert.rejects(f.ledger.read(noteId),/private journal/i);
}));
test("malformed, oversized and symlink lease files fail closed",()=>fixture(async f=>{
 await f.ledger.register(intent);const base=path.join(f.options.journalDirectory,"drawing-title-leases-v1"),dir=path.join(base,(await readdir(base))[0]!),name=(await readdir(dir)).find(name=>name.endsWith(".json"))!,file=path.join(dir,name),original=await readFile(file,"utf8");
 const corrupt=JSON.parse(original);corrupt.tags.rawRecords=[];await writeFile(file,JSON.stringify(corrupt));await assert.rejects(f.ledger.read(noteId));
 await writeFile(file," ".repeat(16385));await assert.rejects(f.ledger.read(noteId),/Unsafe|Oversized/);
 await rm(file);await symlink(path.join(f.root,"outside"),file);await assert.rejects(f.ledger.read(noteId));
}));
test("lost ACK durability is resolved as observed state, never relabelled an SDK receipt",()=>fixture(async f=>{
 const e=await f.ledger.register(intent),c=await f.ledger.claim(noteId,{expectedRevision:e.revision,observation:observation()}),sync=drawingTitleLedgerDurability.sync;
 drawingTitleLedgerDurability.sync=async()=>{throw Error("ACK fsync failed");};
 try{await assert.rejects(f.ledger.acknowledge(noteId,{expectedRevision:c.entry.revision,token:c.dispatch!.token,observation:observation({attachmentTag:"attachment-2",attachmentTitle:intent.targetTitle})}));}finally{drawingTitleLedgerDurability.sync=sync;}
 const reopened=await openDrawingTitleLedger(f.options,f.ports),pending=await reopened.read(noteId);assert(pending?.pending);
 const resolved=await reopened.resolvePending(noteId,{expectedRevision:pending.revision,observation:observation({attachmentTag:"attachment-2",attachmentTitle:intent.targetTitle})});
 assert.equal(resolved.lastReceipt?.outcome,"postcondition-observed");assert.equal(resolved.recentUncertain.at(-1)?.outcome,"uncertain");
}));
test("failure after atomic rename never dispatches and preserves the one-shot pending claim",()=>fixture(async f=>{
 const e=await f.ledger.register(intent),sync=drawingTitleLedgerDurability.sync;let calls=0;
 drawingTitleLedgerDurability.sync=async file=>{await sync(file);if(++calls===2)throw Error("directory fsync failed");};
 try{await assert.rejects(f.ledger.claim(noteId,{expectedRevision:e.revision,observation:observation()}));}finally{drawingTitleLedgerDurability.sync=sync;}
 const reopened=await openDrawingTitleLedger(f.options,f.ports),pending=await reopened.read(noteId);assert(pending?.pending);
 assert.equal((await reopened.claim(noteId,{expectedRevision:pending.revision,observation:observation()})).dispatch,undefined);
}));

test("vault/account namespaces sharing an evidence root list only their own notes",()=>fixture(async f=>{
 await f.ledger.register(intent);const otherVault=path.join(f.root,"other-vault");await mkdir(path.join(otherVault,".icloud-md"),{recursive:true});
 const other=await openDrawingTitleLedger({...f.options,vault:otherVault,accountDsidSha256:"b".repeat(64)},f.ports);
 const otherNote="44444444-4444-4444-8444-444444444444";await other.register({...intent,noteId:otherNote});
 assert.deepEqual(await f.ledger.listNoteIds(),[noteId.toUpperCase()]);assert.deepEqual(await other.listNoteIds(),[otherNote.toUpperCase()]);assert.equal(await f.ledger.read(otherNote),undefined);
}));
test("a paused superseded claim cannot dispatch and an executing owner excludes a second worker",()=>fixture(async f=>{
 let e=await active(f);f.setNow(301000);const old=await f.ledger.claim(noteId,{expectedRevision:e.revision,observation:current()});let sends=0;f.setNow(601001);await assert.rejects(f.ledger.withDispatch(noteId,{expectedRevision:old.entry.revision,token:old.dispatch!.token},async()=>{sends++;}),/Expired/i);f.setNow(601000);const newer=await f.ledger.claim(noteId,{expectedRevision:old.entry.revision,observation:current()});
 await assert.rejects(f.ledger.withDispatch(noteId,{expectedRevision:old.entry.revision,token:old.dispatch!.token},async()=>{sends++;}));assert.equal(sends,0);
 const worker=await import(new URL("./drawingTitleLedger.ts?dispatch-worker",import.meta.url).href) as typeof import("./drawingTitleLedger.js"),other=await worker.openDrawingTitleLedger(f.options,f.ports);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
 const running=f.ledger.withDispatch(noteId,{expectedRevision:newer.entry.revision,token:newer.dispatch!.token},async()=>{sends++;started();await gate;return "sent-once";});await entered;f.setNow(901000);
 try{await assert.rejects(other.claim(noteId,{expectedRevision:newer.entry.revision,observation:current()}),/worker|lock/i);}finally{release();}
 assert.equal(await running,"sent-once");assert.equal(sends,1);
}));

test("vault writer excludes inherited-lock siblings through state bookkeeping and permits nested note operations",()=>fixture(async f=>{
 const worker=await import(new URL("./drawingTitleLedger.ts?vault-worker",import.meta.url).href) as typeof import("./drawingTitleLedger.js"),other=await worker.openDrawingTitleLedger(f.options,f.ports);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});let cloneStateWrites=0;
 const running=f.ledger.withVaultWriter(async()=>{const e=await f.ledger.register(intent),claim=await f.ledger.claim(noteId,{expectedRevision:e.revision,observation:observation()});await f.ledger.withDispatch(noteId,{expectedRevision:claim.entry.revision,token:claim.dispatch!.token},async()=>"SDK");started();await gate;cloneStateWrites++;});
 await entered;try{await assert.rejects(other.withVaultWriter(async()=>{cloneStateWrites++;}),/writer|lock/i);assert.equal(cloneStateWrites,0);}finally{release();}
 await running;assert.equal(cloneStateWrites,1);assert.deepEqual(await f.ledger.listNoteIds(),[noteId.toUpperCase()]);
}));
