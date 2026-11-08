import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CloudKitRecord, RecordUpdate } from "../src/cloudkit/databaseClient.js";
import { AttachmentInfoSchema } from "../src/notes/gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../src/notes/noteDocument.js";
import { compressNoteDocument } from "../src/notes/noteText.js";
import { runAttachmentTitleProbe, type TitleProbeIO, type TitleProbeRequest } from "./attachmentTitleProbe.js";
import { probeJournalDurability } from "./attachmentTitleProbeJournal.js";
import { parseNoteDocument } from "../src/notes/noteDocument.js";
import { decompressNoteDocument } from "../src/notes/noteText.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const encoded = (text: string) => Buffer.from(text).toString("base64");

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.directory, { recursive: true, force: true }); }
}
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloud-title-probe-"));
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" });
  const cloud: CloudKitRecord[] = [
    { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId, fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } },
      Deleted: { type: "INT64", value: 0 }, ModificationDate: { type: "TIMESTAMP", value: 100 },
    } },
    { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId, fields: {
      UTI: { type: "STRING", value: "com.apple.paper" }, Deleted: { type: "INT64", value: 0 },
      Note: { type: "REFERENCE", value: { recordName: noteId } },
      UserTitle: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") },
      PaperDatabase: { type: "ASSETID", value: { downloadURL: "https://example.invalid/signed", fileChecksum: "pixels", size: 3, referenceChecksum: "reference", wrappingKey: "key" } },
    } },
  ];
  const request: TitleProbeRequest = {
    scope: { noteId, attachmentId, folderId, accountDsidSha256: "a".repeat(64) },
    baseline: structuredClone(cloud), expected: structuredClone(cloud),
    phase: "A", targetTitle: "New drawing", modificationDate: 200,
    journalDirectory: path.join(directory, "journal"),
  };
  const writes: RecordUpdate[] = [];
  const io: TitleProbeIO = {
    accountDsidSha256: request.scope.accountDsidSha256,
    lookup: async () => structuredClone(cloud),
    update: async update => {
      writes.push(structuredClone(update));
      const record = cloud.find(r => r.recordName === update.recordName)!;
      assert.equal(update.recordChangeTag, record.recordChangeTag);
      for (const [key, field] of Object.entries(update.fields)) record.fields[key] = { type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES", ...field };
      record.recordChangeTag += "+";
    },
    updateBatch: async updates => { for (const update of updates) await io.update(update); },
  };
  return { directory, cloud, request, writes, io };
}

test("probe preview is entirely offline and creates no journal", () => fixture(async f => {
  const result = await runAttachmentTitleProbe(f.request);
  assert.equal(result.status, "preview");
  assert.deepEqual(result.fields, ["UserTitle"]);
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.writes, []);
}));

test("phase A changes only UserTitle, preserving document and every asset reference", () => fixture(async f => {
  const before = structuredClone(f.cloud);
  const result = await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.deepEqual(f.writes, [{ recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId, fields: { UserTitle: { value: encoded("New drawing") } } }]);
  assert.deepEqual(f.cloud[0], before[0]);
  assert.deepEqual(f.cloud[1]!.fields.PaperDatabase, before[1]!.fields.PaperDatabase);
}));

test("phase B is separately invoked after A, using only Linux and cloud state", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const b = { ...f.request, phase: "B" as const, expected: structuredClone(f.cloud) };
  const result = await runAttachmentTitleProbe(b, { apply: true }, f.io);
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.deepEqual(f.writes[1]!.fields, { TitleEncrypted: { value: encoded("New drawing") }, ModificationDate: { value: 200 } });
  assert.deepEqual(f.cloud[0]!.fields.TextDataEncrypted, f.request.baseline[0]!.fields.TextDataEncrypted);
}));

test("B cannot run without this operation's durable A acknowledgement", () => fixture(async f => {
  f.cloud[1]!.fields.UserTitle!.value = encoded("New drawing");
  const b = { ...f.request, phase: "B" as const, expected: structuredClone(f.cloud) };
  await assert.rejects(runAttachmentTitleProbe(b, { apply: true }, f.io), /acknowledg/i);
  assert.equal(f.writes.length, 0);
}));

test("an acknowledged phase is never dispatched twice", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, f.io)).status, "already-recorded-native-unverified");
  assert.equal(f.writes.length, 1);
}));

test("a lost response stays ambiguous and is never retried even when the title matches", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => { await f.io.update(update); throw Error("lost response with private details"); } };
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
  assert.equal(f.writes.length, 1);
}));

test("simultaneous callers create at most one dispatch", () => fixture(async f => {
  await Promise.all([runAttachmentTitleProbe(f.request, { apply: true }, f.io), runAttachmentTitleProbe(f.request, { apply: true }, f.io)]);
  assert.equal(f.writes.length, 1);
}));

test("wrong account or changed versions are rejected before any mutation", () => fixture(async f => {
  await assert.rejects(runAttachmentTitleProbe(f.request, { apply: true }, { ...f.io, accountDsidSha256: "b".repeat(64) }), /account/i);
  f.cloud[0]!.recordChangeTag = "concurrent-tag";
  await assert.rejects(runAttachmentTitleProbe(f.request, { apply: true }, f.io), /version/i);
  assert.equal(f.writes.length, 0);
}));

for (const field of ["TextDataEncrypted", "PaperDatabase", "Note"]) {
  test(`changed ${field} is rejected even if the title matches`, () => fixture(async f => {
    const record = field === "TextDataEncrypted" ? f.cloud[0]! : f.cloud[1]!;
    record.fields[field] = { ...record.fields[field]!, value: "changed" };
    const request = { ...f.request, expected: structuredClone(f.cloud) };
    await assert.rejects(runAttachmentTitleProbe(request, { apply: true }, f.io));
    assert.equal(f.writes.length, 0);
  }));
}

test("a post-dispatch preservation failure is ambiguous and cannot be retried", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => {
    await f.io.update(update);
    f.cloud[0]!.fields.TextDataEncrypted!.value = "changed";
  } };
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
  assert.equal(f.writes.length, 1);
}));

test("intent fsync failure prevents dispatch", () => fixture(async f => {
  const sync = probeJournalDurability.sync;
  probeJournalDurability.sync = async file => {
    if ((await file.stat()).isFile()) throw Error("injected fsync failure");
    await sync(file);
  };
  try { assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, f.io)).status, "ambiguous"); }
  finally { probeJournalDurability.sync = sync; }
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, f.io)).status, "ambiguous");
  assert.equal(f.writes.length, 0);
}));

test("B rejects cloud versions not acknowledged by A", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  f.cloud[1]!.recordChangeTag = "changed-after-A";
  await assert.rejects(runAttachmentTitleProbe({ ...f.request, phase: "B", expected: structuredClone(f.cloud) }, { apply: true }, f.io), /acknowledg/i);
  assert.equal(f.writes.length, 1);
}));

test("a false success without a new record version remains ambiguous", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => {
    await f.io.update(update);
    f.cloud[1]!.recordChangeTag = "attachment-tag";
  } };
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
}));

test("phase A cannot acknowledge an unrelated note-title change", () => fixture(async f => {
  const io = { ...f.io, update: async (update: RecordUpdate) => {
    await f.io.update(update);
    f.cloud[0]!.fields.TitleEncrypted!.value = encoded("Concurrent title");
  } };
  assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
}));

test("a note change during intent durability stops A before dispatch", () => fixture(async f => {
  const sync = probeJournalDurability.sync;
  probeJournalDurability.sync = async file => {
    await sync(file);
    if ((await file.stat()).isFile()) f.cloud[0]!.recordChangeTag = "concurrent-note";
  };
  try { assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, f.io)).status, "ambiguous"); }
  finally { probeJournalDurability.sync = sync; }
  assert.equal(f.writes.length, 0);
}));

for (const corrupt of [false, true]) {
  test(`B refuses a ${corrupt ? "corrupt" : "missing"} A intent despite its ACK`, () => fixture(async f => {
    const a = await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
    const marker = path.join(f.request.journalDirectory, a.operationId, "A.intent.json");
    if (corrupt) await writeFile(marker, "corrupt"); else await rm(marker);
    await assert.rejects(runAttachmentTitleProbe({ ...f.request, phase: "B", expected: structuredClone(f.cloud) }, { apply: true }, f.io), /acknowledg/i);
    assert.equal(f.writes.length, 1);
  }));
}

for (const field of ["referenceChecksum", "wrappingKey"]) {
  test(`post-write ${field} drift is ambiguous and never retried`, () => fixture(async f => {
    const io = { ...f.io, update: async (update: RecordUpdate) => {
      await f.io.update(update);
      (f.cloud[1]!.fields.PaperDatabase!.value as Record<string, unknown>)[field] = "unexpected-reference";
    } };
    assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
    assert.equal((await runAttachmentTitleProbe(f.request, { apply: true }, io)).status, "ambiguous");
    assert.equal(f.writes.length, 1);
  }));
}

test("BA atomically requests Note title/date followed by already-set attachment title", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BA" as const, expected: structuredClone(f.cloud) };
  let batches = 0;
  const io = { ...f.io, updateBatch: async (updates: RecordUpdate[]) => { batches++; await f.io.updateBatch(updates); } };
  assert.equal((await runAttachmentTitleProbe(request)).status, "preview");
  const result = await runAttachmentTitleProbe(request, { apply: true }, io);
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.equal(batches, 1);
  assert.deepEqual(f.writes.slice(1).map(update => [update.recordType, update.recordChangeTag, Object.keys(update.fields)]), [
    ["Note", "note-tag", ["TitleEncrypted", "ModificationDate"]], ["Attachment", "attachment-tag+", ["UserTitle"]],
  ]);
  assert.equal(f.cloud[0]!.recordChangeTag, "note-tag+"); assert.equal(f.cloud[1]!.recordChangeTag, "attachment-tag++");
  assert.deepEqual(f.cloud[0]!.fields.TextDataEncrypted, f.request.baseline[0]!.fields.TextDataEncrypted);
  assert.deepEqual(f.cloud[1]!.fields.PaperDatabase, f.request.baseline[1]!.fields.PaperDatabase);
}));

test("BA requires the exact durable A history and matching fresh versions", () => fixture(async f => {
  f.cloud[1]!.fields.UserTitle!.value = encoded("New drawing");
  await assert.rejects(runAttachmentTitleProbe({ ...f.request, phase: "BA", expected: structuredClone(f.cloud) }, { apply: true }, f.io), /acknowledg/i);
  assert.equal(f.writes.length, 0);
}));

test("BA lost or partial response is terminal and never falls back to single writes", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BA" as const, expected: structuredClone(f.cloud) };
  let batches = 0;
  const io = { ...f.io, updateBatch: async (updates: RecordUpdate[]) => { batches++; await f.io.update(updates[0]!); throw Error("lost batch response"); } };
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, io)).status, "ambiguous");
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, io)).status, "ambiguous");
  assert.equal(batches, 1); assert.equal(f.writes.length, 2);
}));

for (const first of ["B", "BA"] as const) {
  test(`an ambiguous ${first} intent cannot be retried through its alternate terminal phase`, () => fixture(async f => {
    await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
    const expected = structuredClone(f.cloud);
    const stop = async () => { throw Error("simulated pre-dispatch uncertainty"); };
    const result = await runAttachmentTitleProbe({ ...f.request, phase: first, expected }, { apply: true }, { ...f.io, update: stop, updateBatch: stop });
    assert.equal(result.status, "ambiguous");
    const alternate = first === "B" ? "BA" : "B";
    await assert.rejects(runAttachmentTitleProbe({ ...f.request, phase: alternate, expected }, { apply: true }, f.io), /terminal|another|alternate/i);
    assert.equal(f.writes.length, 1);
  }));
}

test("BA requires both target ETags to advance and preserves every asset reference", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BA" as const, expected: structuredClone(f.cloud) };
  const io = { ...f.io, updateBatch: async (updates: RecordUpdate[]) => { await f.io.updateBatch(updates); f.cloud[1]!.recordChangeTag = request.expected[1]!.recordChangeTag; } };
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, io)).status, "ambiguous");
}));

test("simultaneous B and BA claim one shared terminal intent", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const expected = structuredClone(f.cloud); let terminalCalls = 0, lookups = 0;
  let releaseLookups!: () => void, releaseDispatch!: () => void;
  const bothPreflight = new Promise<void>(resolve => { releaseLookups = resolve; });
  const bothDispatch = new Promise<void>(resolve => { releaseDispatch = resolve; });
  const enter = async () => { if (++terminalCalls === 2) releaseDispatch(); await Promise.race([bothDispatch, new Promise(resolve => setTimeout(resolve, 200))]); };
  const io = { ...f.io, lookup: async (ids: string[]) => {
    const records = await f.io.lookup(ids);
    if (++lookups <= 2) { if (lookups === 2) releaseLookups(); await bothPreflight; }
    return records;
  }, update: async (update: RecordUpdate) => { await enter(); await f.io.update(update); }, updateBatch: async (updates: RecordUpdate[]) => { await enter(); await f.io.updateBatch(updates); } };
  await Promise.allSettled([runAttachmentTitleProbe({ ...f.request, phase: "B", expected }, { apply: true }, io), runAttachmentTitleProbe({ ...f.request, phase: "BA", expected }, { apply: true }, io)]);
  assert.equal(terminalCalls, 1);
}));

test("shared terminal durability failure cannot dispatch or replay BA", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BA" as const, expected: structuredClone(f.cloud) };
  const sync = probeJournalDurability.sync;
  probeJournalDurability.sync = async file => {
    if ((await file.stat()).isFile()) {
      const target = await import("node:fs/promises").then(fs => fs.readlink(`/proc/self/fd/${file.fd}`));
      if (target.endsWith("terminal.intent.json")) throw Error("injected terminal fsync failure");
    }
    await sync(file);
  };
  try { assert.equal((await runAttachmentTitleProbe(request, { apply: true }, f.io)).status, "ambiguous"); }
  finally { probeJournalDurability.sync = sync; }
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, f.io)).status, "ambiguous");
  await assert.rejects(runAttachmentTitleProbe({ ...request, phase: "B" }, { apply: true }, f.io), /terminal|another|alternate/i);
  assert.equal(f.writes.length, 1);
}));

test("BD discloses and writes only the internally computed neutral document revision", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BD" as const, expected: structuredClone(f.cloud) };
  const preview = await runAttachmentTitleProbe(request);
  assert.equal(preview.documentRevision?.strategy, "trailing-tombstone-v1");
  assert.notEqual(preview.documentRevision?.documentSha256, preview.documentRevision?.previousDocumentSha256);
  const result = await runAttachmentTitleProbe(request, { apply: true }, f.io);
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.deepEqual(result.documentRevision, preview.documentRevision);
  assert.deepEqual(Object.keys(f.writes[1]!.fields), ["TitleEncrypted", "ModificationDate", "TextDataEncrypted"]);
  const before = parseNoteDocument(decompressNoteDocument(Buffer.from(f.request.baseline[0]!.fields.TextDataEncrypted!.value as string, "base64")));
  const after = parseNoteDocument(decompressNoteDocument(Buffer.from(f.cloud[0]!.fields.TextDataEncrypted!.value as string, "base64")));
  assert.equal(after.text, before.text); assert.deepEqual(after.attributeRuns, before.attributeRuns);
  assert.equal(after.runs.length, before.runs.length + 1); assert.deepEqual(f.cloud[1], request.expected[1]);
}));

test("BD refuses any payload beyond its exact deterministic revision", () => fixture(async f => {
  await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
  const request = { ...f.request, phase: "BD" as const, expected: structuredClone(f.cloud) };
  const io = { ...f.io, update: async (update: RecordUpdate) => { await f.io.update(update); f.cloud[0]!.fields.TextDataEncrypted = structuredClone(f.request.baseline[0]!.fields.TextDataEncrypted!); } };
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, io)).status, "ambiguous");
  assert.equal((await runAttachmentTitleProbe(request, { apply: true }, io)).status, "ambiguous");
  assert.equal(f.writes.length, 2);
}));

for (const first of ["B", "BA", "BD"] as const) {
  test(`terminal ${first} history excludes every other document/batch alternative`, () => fixture(async f => {
    await runAttachmentTitleProbe(f.request, { apply: true }, f.io);
    const expected = structuredClone(f.cloud), fail = async () => { throw Error("uncertain terminal dispatch"); };
    assert.equal((await runAttachmentTitleProbe({ ...f.request, phase: first, expected }, { apply: true }, { ...f.io, update: fail, updateBatch: fail })).status, "ambiguous");
    for (const other of ["B", "BA", "BD"] as const) if (other !== first) await assert.rejects(runAttachmentTitleProbe({ ...f.request, phase: other, expected }, { apply: true }, f.io), /terminal|another|alternate/i);
    assert.equal(f.writes.length, 1);
  }));
}
