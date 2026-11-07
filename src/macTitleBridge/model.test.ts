import { test } from "node:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { AttachmentInfoSchema } from "../notes/gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { compressNoteDocument } from "../notes/noteText.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { drawingScope, metadataUpdate, preservationKey, selectLocalRename } from "./model.js";

export const noteId = "11111111-1111-4111-8111-111111111111";
export const attachmentId = "22222222-2222-4222-8222-222222222222";
export const folderId = "33333333-3333-4333-8333-333333333333";
export function records(): CloudKitRecord[] {
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" });
  return [
    { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId, fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Old drawing").toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } }, Deleted: { type: "INT64", value: 0 },
      ModificationDate: { type: "TIMESTAMP", value: 100 },
    } },
    { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId, fields: {
      UTI: { type: "STRING", value: "com.apple.paper" }, Deleted: { type: "INT64", value: 0 },
      Note: { type: "REFERENCE", value: { recordName: noteId } },
      UserTitle: { type: "ENCRYPTED_BYTES", value: Buffer.from("Old drawing").toString("base64") },
      PaperDatabase: { type: "ASSETID", value: { downloadURL: "https://cvws.icloud-content.com/old", size: 3, fileChecksum: "pixels", referenceChecksum: "reference", wrappingKey: "fixture" } },
    } },
  ];
}
const scope = { noteId, attachmentId, folderId };
test("only one drawing-only private note with reciprocal ownership qualifies", () => {
  assert.equal(drawingScope(records(), scope).attachment.recordName, attachmentId);
  for (const mutate of [
    (r: CloudKitRecord[]) => { r[0]!.fields.Deleted = { type: "INT64", value: 1 }; },
    (r: CloudKitRecord[]) => { r[1]!.parentRecordName = folderId; },
    (r: CloudKitRecord[]) => { r[1]!.fields.UTI = { type: "STRING", value: "public.jpeg" }; },
    (r: CloudKitRecord[]) => { r[0]!.fields.Folder = { type: "REFERENCE", value: { recordName: noteId } }; },
    (r: CloudKitRecord[]) => { r.push(structuredClone(r[0]!)); },
  ]) { const r = records(); mutate(r); assert.throws(() => drawingScope(r, scope)); }
});
test("each CloudKit phase writes only its intended title fields with the current version and parent", () => {
  const r = records();
  assert.deepEqual(metadataUpdate(r, scope, "attachment", "New drawing", 200), {
    recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId,
    fields: { UserTitle: { value: Buffer.from("New drawing").toString("base64") } },
  });
  assert.deepEqual(metadataUpdate(r, scope, "note", "New drawing", 200).fields, {
    TitleEncrypted: { value: Buffer.from("New drawing").toString("base64") }, ModificationDate: { value: 200 },
  });
  assert.throws(() => metadataUpdate(r, scope, "note", "", 200));
  assert.throws(() => metadataUpdate(r, scope, "note", "bad\nheading", 200));
});
test("preservation permits title metadata and expiring URLs, but detects document, assets and identity changes", () => {
  const before = records(); const after = structuredClone(before);
  after[0]!.fields.TitleEncrypted = { type: "ENCRYPTED_BYTES", value: "bmV3" };
  after[0]!.fields.ModificationDate = { type: "TIMESTAMP", value: 999 };
  after[1]!.fields.UserTitle = { type: "ENCRYPTED_BYTES", value: "bmV3" };
  (after[1]!.fields.PaperDatabase!.value as {downloadURL:string}).downloadURL = "https://cvws.icloud-content.com/new";
  assert.equal(preservationKey(before), preservationKey(after));
  for (const key of ["TextDataEncrypted", "Folder"]) {
    const changed = structuredClone(after); changed[0]!.fields[key] = { type: "ENCRYPTED_BYTES", value: "changed" };
    assert.notEqual(preservationKey(before), preservationKey(changed));
  }
  (after[1]!.fields.PaperDatabase!.value as {wrappingKey:string}).wrappingKey = "changed";
  assert.notEqual(preservationKey(before), preservationKey(after));
});
test("local selection requires explicit allowlist, same-folder filename move and private tracked identity", () => {
  const state = { titleMode: "filename" as const, notes: { [noteId]: { file: "TEST/Old drawing.md", recordChangeTag: "tag", modificationDate: 0, folderRecordName: folderId } } };
  const preview = [{ kind: "move" as const, resolution: "refused" as const, file: "TEST/New drawing.md", previousFile: "TEST/Old drawing.md" }];
  assert.equal(selectLocalRename(state, preview, []) , undefined);
  assert.deepEqual(selectLocalRename(state, preview, [noteId]), { noteId, folderId, file: "TEST/New drawing.md", previousFile: "TEST/Old drawing.md", targetTitle: "New drawing" });
  assert.throws(() => selectLocalRename(state, [{ ...preview[0]!, file: "OTHER/New drawing.md" }], [noteId]));
  assert.throws(() => selectLocalRename({ ...state, notes: { [noteId]: { ...state.notes[noteId]!, sharedZoneOwner: "other" } } }, preview, [noteId]));
  assert.throws(() => selectLocalRename(state, [...preview, preview[0]!], [noteId]));
});
