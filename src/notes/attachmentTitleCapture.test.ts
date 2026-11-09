import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { test } from "node:test";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { AttachmentInfoSchema } from "./gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "./noteDocument.js";
import { compressNoteDocument } from "./noteText.js";
import { captureDrawingSnapshot } from "./attachmentTitleCapture.js";

const scope = { noteId: "11111111-1111-4111-8111-111111111111", attachmentId: "22222222-2222-4222-8222-222222222222", folderId: "33333333-3333-4333-8333-333333333333" };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: scope.attachmentId, typeUTI: "com.apple.paper" });
  const document = compressNoteDocument(encodeNoteDocument(doc));
  const bytes = Array.from({ length: 5 }, (_, i) => Buffer.from(`asset-${i}`));
  const asset = (i: number) => ({ downloadURL: `https://cvws.icloud-content.com/asset-${i}?signature=private`, size: bytes[i]!.length, fileChecksum: `content-${i}`, referenceChecksum: `reference-${i}`, wrappingKey: `key-${i}` });
  const records: CloudKitRecord[] = [
    { recordName: scope.noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: scope.folderId, fields: {
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: document.toString("base64") }, TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Drawing").toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: scope.folderId } }, Deleted: { type: "INT64", value: 0 }, FirstAttachmentThumbnail: { type: "ASSETID", value: asset(0) },
    } },
    { recordName: scope.attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: scope.noteId, fields: {
      Note: { type: "REFERENCE", value: { recordName: scope.noteId } }, Deleted: { type: "INT64", value: 0 }, UTI: { type: "STRING", value: "com.apple.paper" },
      PaperDatabase: { type: "ASSETID", value: asset(1) }, FallbackImage: { type: "ASSETID", value: asset(2) }, PreviewImages: { type: "ASSETID_LIST", value: [asset(3), asset(4)] }, PaperAssets: { type: "UNKNOWN_LIST", value: [] },
    } },
  ];
  let lookups = 0, requests = 0;
  const lookup = async (ids: string[]) => { assert.deepEqual(ids, [scope.noteId, scope.attachmentId]); lookups++; return structuredClone(records); };
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://cvws.icloud-content.com");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(bytes[Number(url.pathname.split("-").at(-1))]);
  };
  return { records, document, bytes, lookup, fetcher, counts: () => ({ lookups, requests }) };
}
test("captures exact document and all five asset bytes in deterministic order, bracketed by lookups", async () => {
  const f = fixture();
  const captured = await captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher });
  assert.equal(captured.documentSha256, sha(f.document));
  assert.deepEqual(captured.records, f.records);
  assert.deepEqual(captured.assets.map(a => a.field), ["Note.FirstAttachmentThumbnail", "Attachment.PaperDatabase", "Attachment.FallbackImage", "Attachment.PreviewImages[0]", "Attachment.PreviewImages[1]"]);
  captured.assets.forEach((a, i) => { assert.equal(a.sha256, sha(f.bytes[i]!)); assert.equal(a.size, f.bytes[i]!.length); });
  assert.deepEqual(f.counts(), { lookups: 2, requests: 5 });
});

for (const drift of ["version", "reference"]) {
  test(`rejects ${drift} drift during asset reads even when other fields remain valid`, async () => {
    const f = fixture();
    const fetcher: typeof fetch = async (...args) => {
      const response = await f.fetcher(...args);
      if (f.counts().requests === 5) {
        if (drift === "version") f.records[0]!.recordChangeTag = "new-version";
        else (f.records[1]!.fields.PaperDatabase!.value as Record<string, unknown>).referenceChecksum = "new-reference";
      }
      return response;
    };
    await assert.rejects(captureDrawingSnapshot(scope, f.lookup, { fetch: fetcher }), /changed|stable/i);
  });
}

test("allows signed URL rotation without changing content or reference fingerprints", async () => {
  const f = fixture();
  const first = await captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher });
  const lookup = async (ids: string[]) => {
    const records = await f.lookup(ids);
    (records[0]!.fields.FirstAttachmentThumbnail!.value as Record<string, unknown>).downloadURL += "&rotated=yes";
    return records;
  };
  const second = await captureDrawingSnapshot(scope, lookup, { fetch: f.fetcher });
  assert.deepEqual(first.assets, second.assets);
});

test("fingerprints distinguish content and reference changes without relying on asset bytes", async () => {
  const f = fixture(), first = await captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher });
  const value = f.records[1]!.fields.PaperDatabase!.value as Record<string, unknown>;
  value.fileChecksum = "different-content";
  const second = await captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher });
  assert.notEqual(first.assets[1]!.contentIdentityHash, second.assets[1]!.contentIdentityHash);
  assert.equal(first.assets[1]!.referenceIdentityHash, second.assets[1]!.referenceIdentityHash);
  value.wrappingKey = "different-key";
  const third = await captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher });
  assert.notEqual(second.assets[1]!.referenceIdentityHash, third.assets[1]!.referenceIdentityHash);
  assert.equal(second.assets[1]!.sha256, third.assets[1]!.sha256);
});

for (const invalid of ["origin", "type", "database-type", "unknown-field", "oversize", "total-size", "count", "no-assets", "missing-checksum", "shared", "duplicate", "owner"]) {
  test(`rejects ${invalid} before downloading any asset`, async () => {
    const f = fixture(), attachment = f.records[1]!, field = attachment.fields.PreviewImages!;
    const asset = (field.value as Record<string, unknown>[])[1]!;
    if (invalid === "origin") asset.downloadURL = "https://attacker.invalid/private?signature=secret";
    if (invalid === "type") field.type = "STRING_LIST";
    if (invalid === "database-type") attachment.fields.PaperDatabase!.type = "STRING";
    if (invalid === "unknown-field") attachment.fields.UnknownAsset = { type: "ASSETID", value: asset };
    if (invalid === "oversize") asset.size = 16 * 1024 * 1024 + 1;
    if (invalid === "total-size") {
      const thumbnail = f.records[0]!.fields.FirstAttachmentThumbnail!.value as Record<string, unknown>;
      const database = attachment.fields.PaperDatabase!.value as Record<string, unknown>;
      const fallback = attachment.fields.FallbackImage!.value as Record<string, unknown>;
      for (const value of [thumbnail, database, fallback, ...(field.value as Record<string, unknown>[])]) value.size = 16 * 1024 * 1024;
    }
    if (invalid === "count") field.value = Array.from({ length: 9 }, () => structuredClone(asset));
    if (invalid === "no-assets") {
      delete f.records[0]!.fields.FirstAttachmentThumbnail;
      for (const key of ["PaperDatabase", "FallbackImage", "PreviewImages", "PaperAssets"]) delete attachment.fields[key];
    }
    if (invalid === "missing-checksum") delete asset.referenceChecksum;
    if (invalid === "shared") attachment.shareRecordName = "share";
    if (invalid === "duplicate") f.records[1] = f.records[0]!;
    if (invalid === "owner") attachment.parentRecordName = scope.folderId;
    await assert.rejects(captureDrawingSnapshot(scope, f.lookup, { fetch: f.fetcher }));
    assert.equal(f.counts().requests, 0);
  });
}

for (const failure of ["content-length", "truncated", "growth", "redirect", "timeout"]) {
  test(`rejects ${failure} responses without leaking signed URLs`, async () => {
    const f = fixture();
    const fetcher: typeof fetch = async () => {
      if (failure === "timeout") throw Error("https://cvws.icloud-content.com/?signature=secret");
      const response = new Response(failure === "truncated" ? "a" : failure === "growth" ? "far-too-many-bytes" : f.bytes[0], failure === "content-length" ? { headers: { "content-length": "999" } } : undefined);
      if (failure === "redirect") Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    await assert.rejects(captureDrawingSnapshot(scope, f.lookup, { fetch: fetcher }), (error: unknown) => error instanceof Error && !error.message.includes("signature") && /download|size|asset/i.test(error.message));
  });
}

test("a chunked body that grows beyond its declared asset size is cancelled", async () => {
  const f = fixture();
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("asset-")); controller.enqueue(Buffer.from("too-long")); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(captureDrawingSnapshot(scope, f.lookup, { fetch: fetcher }), /download|size/i);
  assert.equal(cancelled, true);
});

test("the download timeout signal also aborts a stalled response body", async () => {
  const f = fixture(), original = AbortSignal.timeout, abort = new AbortController();
  AbortSignal.timeout = () => abort.signal;
  const fetcher: typeof fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      init!.signal!.addEventListener("abort", () => controller.error(Error("secret signed URL")), { once: true });
      queueMicrotask(() => abort.abort());
    },
  }));
  try {
    await assert.rejects(captureDrawingSnapshot(scope, f.lookup, { fetch: fetcher }), (error: unknown) => error instanceof Error && error.message === "Asset download failed or size mismatch");
  } finally { AbortSignal.timeout = original; }
});
