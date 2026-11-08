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
import { probeJournalDurability } from "./attachmentTitleProbeJournal.js";
import type { TitleProbeIO } from "./attachmentTitleProbe.js";
import { prepareDrawingTitleRename, type DrawingTitleRenameOptions, type DrawingTitleRenamePorts } from "./drawingTitleRename.js";
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
      PaperDatabase: { type: "ASSETID", value: { fileChecksum: "pixels", size: 3, referenceChecksum: "reference", wrappingKey: "key", downloadURL: "https://example.invalid/signed" } },
    } },
    { recordName: folderId, recordType: "Folder", recordChangeTag: "folder-tag", fields: { Deleted: { type: "INT64", value: 0 } } },
  ];
  let now = 1_000;
  const options = { vault, file, noteId, attachmentId, folderId, journalDirectory: path.join(root, "journal") };
  const writes: RecordUpdate[] = [], batches: RecordUpdate[][] = [], captures: string[] = [];
  const io: TitleProbeIO = { accountDsidSha256: sha(account.dsid), lookup: async (ids: string[]) => structuredClone(cloud.filter(r => ids.includes(r.recordName))), update: async (update: RecordUpdate) => {
    writes.push(structuredClone(update)); const record = cloud.find(r => r.recordName === update.recordName)!;
    assert.equal(record.recordChangeTag, update.recordChangeTag);
    for (const [key, field] of Object.entries(update.fields)) record.fields[key] = { ...field, type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES" };
    record.recordChangeTag += "+";
  }, updateBatch: async updates => { batches.push(structuredClone(updates)); for (const update of updates) await io.update(update); } };
  const ports: DrawingTitleRenamePorts = { lockAuthority: async () => ({ path: "/fixture/sync.lock", dev: "1", ino: "2" }), now: () => now,
    capture: async (scope, lookup, opts) => {
      const records = await lookup([scope.noteId, scope.attachmentId]);
      const result = { records, documentSha256: sha(Buffer.from(records[0]!.fields.TextDataEncrypted!.value as string, "base64")), assets: [{ field: "Attachment.PaperDatabase", size: 3, sha256: "a".repeat(64), contentIdentityHash: "b".repeat(64), referenceIdentityHash: "c".repeat(64) }] };
      if (opts?.directory) { captures.push(opts.directory); await mkdir(opts.directory, { recursive: true, mode: 0o700 }); await writeFile(path.join(opts.directory, "complete.json"), JSON.stringify(result), { mode: 0o600 }); }
      return result;
    },
  };
  return { root, vault, body, file, local, state, cloud, options: { ...options, baseline: structuredClone(cloud.slice(0, 2)), expectedNoteTag: cloud[0]!.recordChangeTag!, io }, writes, batches, captures, ports, io, expire: () => { now = 20_000; } };
}

test("drawing rename preview is read-only; execution captures assets and sends only A then BD", () => fixture(async f => {
  const plan = await prepareDrawingTitleRename(f.options, f.ports);
  assert.equal(f.writes.length, 0); assert.equal(f.captures.length, 0);
  assert.equal(plan.documentRevision.strategy, "trailing-tombstone-v1");
  const result = await plan.execute();
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.deepEqual(f.writes.map(w => Object.keys(w.fields)), [["UserTitle"], ["TitleEncrypted", "ModificationDate", "TextDataEncrypted"]]);
  assert.equal(f.captures.length, 4);
  assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.local);
}));
test("uncertain A blocks a new filename and baseline rather than creating a retry route", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => { await f.io.update(update); throw Error("lost response"); } };
  const first = await prepareDrawingTitleRename({ ...f.options, io }, f.ports);
  assert.equal((await first.execute()).status, "ambiguous");
  const changedFile = "TEST/Second title.md"; await rename(path.join(f.vault, f.file), path.join(f.vault, changedFile));
  const second = await prepareDrawingTitleRename({ ...f.options, file: changedFile, baseline: structuredClone(f.cloud.slice(0, 2)) }, f.ports);
  assert.equal((await second.execute()).status, "ambiguous");
  assert.equal(f.writes.length, 1);
}));
test("local edit during durable intent prevents dispatch and permanently blocks the attempt", () => fixture(async f => {
  const plan = await prepareDrawingTitleRename(f.options, f.ports), sync = probeJournalDurability.sync;
  let changed = false;
  probeJournalDurability.sync = async file => { await sync(file); if (!changed) { changed = true; await writeFile(path.join(f.vault, f.file), f.local + "edit"); } };
  try { assert.equal((await plan.execute()).status, "ambiguous"); } finally { probeJournalDurability.sync = sync; }
  assert.equal(f.writes.length, 0);
}));
test("completed cloud write recovers read-only after bookkeeping interruption", () => fixture(async f => {
  const plan = await prepareDrawingTitleRename(f.options, f.ports), completed = await plan.execute();
  assert.equal(completed.status, "cloud-applied-native-unverified");
  const retry = await prepareDrawingTitleRename({ ...f.options, baseline: structuredClone(f.cloud.slice(0, 2)) }, f.ports);
  assert.equal((await retry.execute()).status, "cloud-applied-native-unverified");
  assert.equal(f.writes.length, 2);
}));

test("a changed remote note is refused before an unowned metadata overwrite", () => fixture(async f => {
  const baseline = structuredClone(f.options.baseline); baseline[0]!.recordChangeTag += "external";
  await assert.rejects(prepareDrawingTitleRename({ ...f.options, baseline }, f.ports), /changed remotely/i);
  assert.equal(f.writes.length, 0);
}));
test("changing the evidence root cannot bypass an ambiguous attempt", () => fixture(async f => {
  const first = await prepareDrawingTitleRename(f.options, { ...f.ports, capture: async () => { throw Error("failed capture"); } });
  assert.equal((await first.execute()).status, "ambiguous");
  const second = await prepareDrawingTitleRename({ ...f.options, journalDirectory: path.join(f.root, "new-journal") }, f.ports);
  assert.equal((await second.execute()).status, "ambiguous"); assert.equal(f.writes.length, 0);
}));
test("postwrite asset drift never produces a completed attempt", () => fixture(async f => {
  const capture = f.ports.capture;
  const plan = await prepareDrawingTitleRename(f.options, { ...f.ports, capture: async (...args) => {
    const result = await capture(...args); if (f.writes.length === 2) result.assets[0]!.sha256 = "changed"; return result;
  } });
  assert.equal((await plan.execute()).status, "ambiguous"); assert.equal(f.writes.length, 2);
  const retry = await prepareDrawingTitleRename(f.options, f.ports);
  assert.equal((await retry.execute()).status, "ambiguous"); assert.equal(f.writes.length, 2);
}));

for (const mutation of ["note-title", "drawing-title", "protected-field"] as const) test(`foreign ${mutation} after BD acknowledgement blocks completion`, () => fixture(async f => {
  const capture = f.ports.capture;
  const plan = await prepareDrawingTitleRename(f.options, { ...f.ports, capture: async (...args) => {
    if (f.writes.length === 2) {
      const record = f.cloud[mutation === "drawing-title" ? 1 : 0]!;
      record.fields[mutation === "protected-field" ? "ForeignField" : mutation === "drawing-title" ? "UserTitle" : "TitleEncrypted"] = { type: "ENCRYPTED_BYTES", value: encoded("foreign") };
      if (mutation !== "protected-field") record.recordChangeTag += "foreign";
    }
    return capture(...args);
  } });
  assert.equal((await plan.execute()).status, "ambiguous"); assert.equal(f.writes.length, 2);
}));

test("recreating the evidence directory cannot erase an uncertain attempt", () => fixture(async f => {
  const plan = await prepareDrawingTitleRename(f.options, { ...f.ports, capture: async () => { throw Error("capture failed"); } });
  assert.equal((await plan.execute()).status, "ambiguous");
  await rename(f.options.journalDirectory, f.options.journalDirectory + "-retained");
  await mkdir(f.options.journalDirectory, { mode: 0o700 });
  const retry = await prepareDrawingTitleRename(f.options, f.ports);
  assert.equal((await retry.execute()).status, "ambiguous"); assert.equal(f.writes.length, 0);
}));
