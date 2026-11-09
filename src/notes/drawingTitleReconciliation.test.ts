import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import { writeBaseCopy } from "./baseCopy.js";
import { writeCloneState } from "./cloneState.js";
import { AttachmentInfoSchema } from "./gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "./noteDocument.js";
import { composeNoteFile } from "./noteIdFrontmatter.js";
import { compressNoteDocument } from "./noteText.js";
import { formatEmbedMarker } from "./unknownContent.js";
import type { DrawingTitleIO } from "./drawingTitleCloud.js";
import { openDrawingTitleLedger } from "./drawingTitleLedger.js";
import { prepareDrawingTitleReconciliation, drawingTitleInScope, type DrawingReconciliationPorts } from "./drawingTitleReconciliation.js";
const noteId = "AAAA1111-1111-4111-8111-111111111111";
const attachmentId = "BBBB2222-2222-4222-8222-222222222222";
const folderId = "CCCC3333-3333-4333-8333-333333333333";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const encoded = (value: string) => Buffer.from(value).toString("base64");

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "title-runner-")), vault = path.join(root, "vault");
  await mkdir(path.join(vault, "TEST"), { recursive: true });
  const body = formatEmbedMarker({ attachmentIdentifier: attachmentId, typeUti: "com.apple.paper" });
  const file = "TEST/New drawing.md", local = composeNoteFile("", body, noteId);
  await writeFile(path.join(vault, file), local);
  const account = { appleId: "fixture@example.invalid", dsid: "fixture" };
  const state = { account, titleMode: "filename" as const, syncToken: "", replicaId: Buffer.alloc(16, 7).toString("base64"),
    folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
    notes: { [noteId]: { file: "TEST/Old drawing.md", recordChangeTag: "note-tag", modificationDate: 100, folderRecordName: folderId } } };
  await writeCloneState(vault, state); await writeBaseCopy(vault, noteId, body);
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" });
  const cloud: CloudKitRecord[] = [
    { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId, fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") }, TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } }, Deleted: { type: "INT64", value: 0 }, ModificationDate: { type: "TIMESTAMP", value: 100 },
    } },
    { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId, fields: {
      UTI: { type: "STRING", value: "com.apple.paper" }, Deleted: { type: "INT64", value: 0 }, Note: { type: "REFERENCE", value: { recordName: noteId } }, UserTitle: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") },
      PaperDatabase: { type: "ASSETID", value: { fileChecksum: "pixels", size: 3, referenceChecksum: "reference", wrappingKey: "key", downloadURL: "https://cvws.icloud-content.com/fixture" } },
    } },
    { recordName: folderId, recordType: "Folder", recordChangeTag: "folder-tag", fields: { Deleted: { type: "INT64", value: 0 } } },
  ];
  let now = 1_000;
  const options = { vault, file, noteId, attachmentId, folderId, journalDirectory: path.join(root, "journal") };
  const writes: RecordUpdate[] = [];
  const io: DrawingTitleIO = { accountDsidSha256: sha(account.dsid), lookup: async (ids: string[]) => structuredClone(cloud.filter(r => ids.includes(r.recordName))), update: async (update: RecordUpdate) => {
    writes.push(structuredClone(update)); const record = cloud.find(r => r.recordName === update.recordName)!;
    assert.equal(record.recordChangeTag, update.recordChangeTag);
    for (const [key, field] of Object.entries(update.fields)) record.fields[key] = { ...field, type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES" };
    record.recordChangeTag += "+";
  } };
  const ports: DrawingReconciliationPorts = { now: () => now,
    capture: async (scope, lookup) => {
      const records = await lookup([scope.noteId, scope.attachmentId]);
      const result = { records, documentSha256: sha(Buffer.from(records[0]!.fields.TextDataEncrypted!.value as string, "base64")), assets: [{ field: "Attachment.PaperDatabase", size: 3, sha256: "a".repeat(64), contentIdentityHash: "b".repeat(64), referenceIdentityHash: "c".repeat(64) }] };
      return result;
    },
  };
  const ledger = await openDrawingTitleLedger({ vault, journalDirectory: options.journalDirectory, accountDsidSha256: io.accountDsidSha256 }, { assertWriter: async () => {}, now: ports.now });
  return { ledger, root, vault, body, file, local, state, cloud, options: { ...options, baseline: structuredClone(cloud.slice(0, 2)), expectedNoteTag: cloud[0]!.recordChangeTag!, io, ledger, kind: "rename" as const }, writes, ports, io, advance: (milliseconds = 300_001) => { now += milliseconds; } };
}


test("initial rename sends metadata A then B and creates an ongoing lease without revising the document", () => fixture(async f => {
  const before = f.cloud[0]!.fields.TextDataEncrypted!.value;
  const plan = await prepareDrawingTitleReconciliation(f.options, f.ports);
  assert.equal(f.writes.length, 0);
  const result = await plan.execute();
  assert.equal(result.status, "active-native-unverified");
  assert.deepEqual(f.writes.map(update => Object.keys(update.fields)), [["UserTitle"], ["TitleEncrypted", "ModificationDate"]]);
  assert.equal(f.cloud[0]!.fields.TextDataEncrypted!.value, before);
  assert.equal((await f.ledger.read(noteId))?.stage, "active");
}));

test("SDK success without a new B version remains uncertain and never settles local intent", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => {
    if (update.recordType === "Attachment") await f.io.update(update);
    else f.writes.push(structuredClone(update));
  } };
  const plan = await prepareDrawingTitleReconciliation({ ...f.options, io }, f.ports);
  assert.equal((await plan.execute()).status, "uncertain");
  const entry = await f.ledger.read(noteId);
  assert.equal(entry?.stage, "note"); assert.equal(entry?.pending?.phase, "B");
}));

async function settle(f: Awaited<ReturnType<typeof setup>>) {
  f.state.notes[noteId]!.file = f.file;
  f.state.notes[noteId]!.recordChangeTag = f.cloud[0]!.recordChangeTag!;
  f.state.notes[noteId]!.modificationDate = f.cloud[0]!.fields.ModificationDate!.value as number;
  await writeCloneState(f.vault, f.state);
}
async function active(f: Awaited<ReturnType<typeof setup>>) {
  assert.equal((await (await prepareDrawingTitleReconciliation(f.options, f.ports)).execute()).status, "active-native-unverified");
  await settle(f);
}
test("not-due leases send nothing; a due refresh sends only Note title and preserves date/document/assets", () => fixture(async f => {
  await active(f); const before = structuredClone(f.cloud), refresh = { ...f.options, kind: "refresh" as const };
  assert.equal((await (await prepareDrawingTitleReconciliation(refresh, f.ports)).execute()).status, "not-due"); assert.equal(f.writes.length, 2);
  f.advance();
  assert.equal((await (await prepareDrawingTitleReconciliation(refresh, f.ports)).execute()).status, "active-native-unverified");
  assert.equal(f.writes.length, 3); assert.deepEqual(Object.keys(f.writes[2]!.fields), ["TitleEncrypted"]);
  assert.equal(f.cloud[0]!.fields.ModificationDate!.value, before[0]!.fields.ModificationDate!.value);
  assert.equal(f.cloud[0]!.fields.TextDataEncrypted!.value, before[0]!.fields.TextDataEncrypted!.value);
  assert.deepEqual(f.cloud[1], before[1]);
}));
test("valid local body change after prepare durably cancels eligibility", () => fixture(async f => {
  await active(f); f.advance();
  const plan = await prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh" }, f.ports);
  await writeFile(path.join(f.vault, f.file), f.local + "\nuser edit");
  assert.equal((await plan.execute()).status, "cancelled"); assert.equal((await f.ledger.read(noteId))?.stage, "cancelled"); assert.equal(f.writes.length, 2);
}));
for (const change of ["delete", "share", "owner", "asset-reference", "document"] as const) test(`foreign ${change} durably cancels an existing lease`, () => fixture(async f => {
  await active(f); f.advance();
  if (change === "delete") f.cloud[0]!.deleted = true;
  if (change === "share") f.cloud[0]!.shareRecordName = "foreign-share";
  if (change === "owner") f.cloud[1]!.parentRecordName = folderId;
  if (change === "asset-reference") (f.cloud[1]!.fields.PaperDatabase!.value as Record<string, unknown>).referenceChecksum = "foreign";
  if (change === "document") f.cloud[0]!.fields.TextDataEncrypted!.value = compressNoteDocument(encodeNoteDocument(buildInitialNoteDocument("prose", new Uint8Array(16).fill(7)))).toString("base64");
  const plan = await prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh" }, f.ports);
  assert.equal((await plan.execute()).status, "cancelled"); assert.equal((await f.ledger.read(noteId))?.stage, "cancelled"); assert.equal(f.writes.length, 2);
}));
test("future initial cloud modification date refuses before A", () => fixture(async f => {
  f.cloud[0]!.fields.ModificationDate!.value = 2000;
  await assert.rejects(prepareDrawingTitleReconciliation(f.options, f.ports), /clock|modification date/i);
  assert.equal(f.writes.length, 0); assert.equal(await f.ledger.read(noteId), undefined);
}));
test("full post-B preservation failure cancels before a successful active receipt", () => fixture(async f => {
  const capture = f.ports.capture;
  const plan = await prepareDrawingTitleReconciliation(f.options, { ...f.ports, capture: async (...args) => {
    const result = await capture(...args); if (f.writes.length === 2) result.assets[0]!.sha256 = "foreign"; return result;
  } });
  assert.equal((await plan.execute()).status, "cancelled"); const entry = await f.ledger.read(noteId);
  assert.equal(entry?.stage, "cancelled"); assert.notEqual(entry?.lastReceipt?.phase, "B");
}));
test("late foreign title/tag after execute blocks local bookkeeping", () => fixture(async f => {
  const plan = await prepareDrawingTitleReconciliation(f.options, f.ports);
  assert.equal((await plan.execute()).status, "active-native-unverified");
  f.cloud[0]!.fields.TitleEncrypted!.value = encoded("foreign"); f.cloud[0]!.recordChangeTag += "foreign";
  await assert.rejects(plan.verifyLocalIntent(), /bookkeeping/i);
}));
for (const committed of [true, false]) test(`a new filename after uncertain B ${committed ? "uses advanced CAS to supersede" : "stays blocked at the unchanged CAS"}`, () => fixture(async f => {
  let attempts = 0;
  const io = { ...f.io, update: async (update: RecordUpdate) => { attempts++; if (update.recordType === "Attachment" || committed) await f.io.update(update); if (update.recordType === "Note") throw Error("response lost"); } };
  assert.equal((await (await prepareDrawingTitleReconciliation({ ...f.options, io }, f.ports)).execute()).status, "uncertain");
  const file = "TEST/Second drawing.md"; await rename(path.join(f.vault, f.file), path.join(f.vault, file)); f.advance(1000);
  const result = await (await prepareDrawingTitleReconciliation({ ...f.options, file }, f.ports)).execute();
  assert.equal(result.status, committed ? "active-native-unverified" : "uncertain");
  assert.equal(f.writes.length, committed ? 4 : 1);
  if (!committed) assert.equal(attempts, 2);
}));
test("later fresh read of committed refresh is observed state, never a false SDK acknowledgement", () => fixture(async f => {
  await active(f); f.advance();
  const io = { ...f.io, update: async (update: RecordUpdate) => { await f.io.update(update); throw Error("response lost"); } };
  assert.equal((await (await prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh", io }, f.ports)).execute()).status, "uncertain");
  const result = await (await prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh" }, f.ports)).execute();
  assert.equal(result.status, "not-due"); assert.equal(f.writes.length, 3);
  const entry = await f.ledger.read(noteId); assert.equal(entry?.lastReceipt?.outcome, "postcondition-observed"); assert.ok(entry!.recentUncertain.length >= 1);
}));

test("lowercase CloudKit note names remain exact in metadata writes despite canonical ledger UUIDs", () => fixture(async f => {
  const lower = noteId.toLowerCase(), entry = f.state.notes[noteId]!;
  const notes = f.state.notes as Record<string, typeof entry>; delete notes[noteId]; notes[lower] = entry;
  await writeCloneState(f.vault, f.state); await writeBaseCopy(f.vault, lower, f.body);
  f.cloud[0]!.recordName = lower;
  f.cloud[1]!.parentRecordName = lower; f.cloud[1]!.fields.Note!.value = { recordName: lower };
  const result = await (await prepareDrawingTitleReconciliation({ ...f.options, noteId: lower }, f.ports)).execute();
  assert.equal(result.status, "active-native-unverified"); assert.equal(f.writes[1]!.recordName, lower);
}));

test("folder and note scope filters intersect, with case-insensitive UUID matching", () => {
  const scope = { journalDirectory: "/private", folderIds: [folderId.toLowerCase()], noteIds: [noteId.toLowerCase()] };
  assert.equal(drawingTitleInScope(scope, noteId, folderId), true);
  assert.equal(drawingTitleInScope(scope, attachmentId, folderId), false);
  assert.equal(drawingTitleInScope(scope, noteId, attachmentId), false);
  assert.equal(drawingTitleInScope(scope, attachmentId, attachmentId), false);
});
test("transient lookup failure preserves an eligible lease for a later normal sync", () => fixture(async f => {
  await active(f); f.advance();
  const io = { ...f.io, lookup: async () => { throw Error("offline"); } };
  await assert.rejects(prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh", io }, f.ports), /temporarily unavailable/i);
  assert.equal((await f.ledger.read(noteId))?.stage, "active"); assert.equal(f.writes.length, 2);
}));

for (const persistent of [false, true]) test(`folder ${persistent ? "persistent field drift cancels" : "server version drift retains"} an ongoing lease`, () => fixture(async f => {
  await active(f); f.advance();
  f.cloud[2]!.recordChangeTag += "+";
  if (persistent) f.cloud[2]!.fields.TitleEncrypted = { type: "ENCRYPTED_BYTES", value: encoded("Other folder name") };
  const result = await (await prepareDrawingTitleReconciliation({ ...f.options, kind: "refresh" }, f.ports)).execute();
  assert.equal(result.status, persistent ? "cancelled" : "active-native-unverified");
  assert.equal(f.writes.length, persistent ? 2 : 3);
  assert.equal((await f.ledger.read(noteId))?.stage, persistent ? "cancelled" : "active");
}));

test("a lost durable dispatch owner never reaches the SDK", () => fixture(async f => {
  const ledger = { ...f.ledger, withDispatch: async () => { throw new Error("Ownership lost"); } };
  const result = await (await prepareDrawingTitleReconciliation({ ...f.options, ledger }, f.ports)).execute();
  assert.equal(result.status, "uncertain"); assert.equal(f.writes.length, 0);
  assert.equal((await f.ledger.read(noteId))?.pending?.phase, "A");
}));


test("preview and prior-run plans cannot dispatch during a later writer scope", () => fixture(async f => {
  const ledger = await openDrawingTitleLedger({ vault: f.vault, journalDirectory: f.options.journalDirectory, accountDsidSha256: f.io.accountDsidSha256 }, { now: f.ports.now });
  const request = { ...f.options, ledger };
  const preview = await prepareDrawingTitleReconciliation(request, f.ports);
  let old!: Awaited<ReturnType<typeof prepareDrawingTitleReconciliation>>;
  await ledger.withWriter(async () => { old = await prepareDrawingTitleReconciliation(request, f.ports); });
  await ledger.withWriter(async () => {
    assert.equal((await preview.execute()).status, "uncertain");
    assert.equal((await old.execute()).status, "uncertain");
    assert.equal(f.writes.length, 0);
    assert.equal(await ledger.read(noteId), undefined);
  });
}));

test("an escaped execution paused in lookup cannot send after its scope closes", () => fixture(async f => {
  const ledger = await openDrawingTitleLedger({ vault: f.vault, journalDirectory: f.options.journalDirectory, accountDsidSha256: f.io.accountDsidSha256 }, { now: f.ports.now });
  let pause = false, resume!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  const io = { ...f.io, lookup: async (ids: string[]) => {
    if (pause && (await ledger.read(noteId))?.pending) { pause = false; reached(); await gate; }
    return f.io.lookup(ids);
  } };
  let executing!: Promise<Awaited<ReturnType<Awaited<ReturnType<typeof prepareDrawingTitleReconciliation>>["execute"]>>>;
  await ledger.withWriter(async () => {
    const plan = await prepareDrawingTitleReconciliation({ ...f.options, ledger, io }, f.ports);
    pause = true; executing = plan.execute(); await entered;
  });
  resume();
  assert.equal((await executing).status, "uncertain");
  assert.equal(f.writes.length, 0);
}));


test("preview and prior-run cancellation plans cannot mutate a later writer scope", () => fixture(async f => {
  const ledger = await openDrawingTitleLedger({ vault: f.vault, journalDirectory: f.options.journalDirectory, accountDsidSha256: f.io.accountDsidSha256 }, { now: f.ports.now });
  const request = { ...f.options, ledger };
  await ledger.withWriter(async () => { assert.equal((await (await prepareDrawingTitleReconciliation(request, f.ports)).execute()).status, "active-native-unverified"); });
  await writeFile(path.join(f.vault, f.file), f.local + "Typed text");
  const preview = await prepareDrawingTitleReconciliation(request, f.ports);
  let old!: Awaited<ReturnType<typeof prepareDrawingTitleReconciliation>>;
  await ledger.withWriter(async () => { old = await prepareDrawingTitleReconciliation(request, f.ports); });
  await ledger.withWriter(async () => {
    await assert.rejects(preview.execute(), /writer scope/);
    await assert.rejects(old.execute(), /closed/);
    assert.equal((await ledger.read(noteId))?.stage, "active");
    assert.equal(f.writes.length, 2);
  });
}));
