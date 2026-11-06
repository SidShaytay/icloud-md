import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { buildNoteUpdateFields } from "../notes/encodeNoteRecord.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { compressNoteDocument } from "../notes/noteText.js";
import { prepareRetitle, requestedRetitle, restoreStrippedTitle } from "./push.js";

const replica = new Uint8Array(16).fill(7);
const entry = { file: "Notes/Old scan.md", recordChangeTag: "tag", modificationDate: 100 };

function scanRecord(): CloudKitRecord {
  // Synthetic opaque body: title changes must not decode/re-encode or splice it.
  const doc = buildInitialNoteDocument("\uFFFC\nOriginal body", replica);
  return {
    recordName: "SYNTHETIC-NOTE", recordType: "Note", recordChangeTag: "tag",
    fields: {
      TitleEncrypted: { value: Buffer.from("Old scan").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataEncrypted: { value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64"), type: "ENCRYPTED_BYTES" },
      FirstAttachmentThumbnail: { value: { fileChecksum: "unchanged-thumbnail" }, type: "ASSETID" },
      FirstAttachmentUTIEncrypted: { value: "unchanged-uti", type: "ENCRYPTED_BYTES" },
      SnippetEncrypted: { value: "unchanged-snippet", type: "ENCRYPTED_BYTES" },
      ModificationDate: { value: 100, type: "TIMESTAMP" },
    },
  };
}

test("renaming an embed-first note is refused without changing its document or assets", () => {
  const record = scanRecord();
  const before = structuredClone(record);
  const prepared = prepareRetitle(record, { entry, toFile: "Notes/New scan.md", newTitle: "New scan" }, replica, "filename");
  assert.equal(prepared.ok, false);
  if (prepared.ok) return;
  assert.equal(prepared.resolution, "refused");
  assert.match(prepared.reason, /native.*title|independent.*title/i);
  assert.match(prepared.reason, /retitle the note in Notes/);
  assert.deepEqual(record, before);
});

test("a title-only metadata request on an embed-first note is not silently considered satisfied", () => {
  const classified = classifyNoteRecord(scanRecord(), { titleMode: "filename" });
  assert.equal(classified.status, "ok");
  if (classified.status !== "ok") return;
  assert.equal(requestedRetitle(classified, "New scan"), "New scan");
  assert.equal(requestedRetitle(classified, "Old scan"), undefined);
});

test("an embed-first rename equal to its current display title needs no remote write", () => {
  const prepared = prepareRetitle(scanRecord(), { entry, toFile: "Notes/Old scan.md", newTitle: "Old scan" }, replica, "filename");
  assert.equal(prepared.ok, true);
  if (prepared.ok) assert.equal(prepared.retitle, undefined);
});

for (const text of ["\uFFFC\nOriginal body", "changed body"]) {
  test(`an independent-title request is refused with ${text === "changed body" ? "a changed" : "an unchanged"} body`, () => {
    const classified = classifyNoteRecord(scanRecord(), { titleMode: "filename" });
    assert.equal(classified.status, "ok");
    if (classified.status !== "ok") return;
    const summary = { conflicts: [] as string[], refused: [] as string[] };
    assert.equal(restoreStrippedTitle(classified, { text, paragraphs: [] }, entry, summary, "New scan"), undefined);
    assert.match(summary.refused[0] ?? "", /retitle it in Notes/);
  });
}

test("a permitted prose edit after an opaque first-line embed preserves its independent title", () => {
  const fields = buildNoteUpdateFields(scanRecord(), "new-document-bytes", "\uFFFC\nEdited prose", 200);
  assert.equal(Buffer.from(fields.TitleEncrypted?.value as string, "base64").toString(), "Old scan");
});

test("adding a real text first line makes that text authoritative again", () => {
  const fields = buildNoteUpdateFields(scanRecord(), "new-document-bytes", "Real first line\n\uFFFC", 200);
  assert.equal(Buffer.from(fields.TitleEncrypted?.value as string, "base64").toString(), "Real first line");
});

test("an independent-title request still respects the unsupported text-as-asset gate", () => {
  const record = scanRecord();
  record.fields.TextDataAsset = { value: { fileChecksum: "separate-body" }, type: "ASSETID" };
  const prepared = prepareRetitle(record, { entry, toFile: "Notes/New scan.md", newTitle: "New scan" }, replica, "filename");
  assert.equal(prepared.ok, false);
  if (!prepared.ok) assert.match(prepared.reason, /separate file/);
});
