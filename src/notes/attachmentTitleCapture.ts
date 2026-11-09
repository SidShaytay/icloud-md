/** Read-only, bounded preservation checks for drawing-title metadata writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord, storesTextAsAsset } from "./decodeNoteRecord.js";
import { isNoteId } from "./noteIdFrontmatter.js";

export interface DrawingCaptureScope { noteId: string; attachmentId: string; folderId: string; }
export interface DrawingCapture {
  records: CloudKitRecord[];
  /** SHA-256 of the exact compressed TextDataEncrypted bytes. */
  documentSha256: string;
  assets: Array<{ field: string; size: number; sha256: string; contentIdentityHash: string; referenceIdentityHash: string }>;
}
interface Asset { field: string; value: Record<string, unknown>; url: URL; size: number; }
const MAX_ASSET_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sameId = (a: unknown, b: string) => typeof a === "string" && a.toUpperCase() === b.toUpperCase();
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const reference = (record: CloudKitRecord, key: string) => (record.fields[key]?.value as { recordName?: unknown } | undefined)?.recordName;

function checkRecords(records: CloudKitRecord[], scope: DrawingCaptureScope): { records: CloudKitRecord[]; document: Buffer } {
  assert.ok(records.length === 2, "Expected exactly the note and drawing");
  const note = records.find(r => sameId(r.recordName, scope.noteId)), attachment = records.find(r => sameId(r.recordName, scope.attachmentId));
  assert.ok(note && attachment && note !== attachment && note.recordType === "Note" && attachment.recordType === "Attachment", "Wrong drawing identity");
  assert.ok(records.every(r => typeof r.recordChangeTag === "string" && r.recordChangeTag && !r.deleted && !r.shareRecordName && r.fields.Deleted?.type === "INT64" && r.fields.Deleted.value === 0), "Deleted, shared or unversioned drawing");
  assert.ok(note.fields.Folder?.type === "REFERENCE" && sameId(reference(note, "Folder"), scope.folderId) && sameId(note.parentRecordName, scope.folderId), "Wrong note folder");
  assert.ok(attachment.fields.Note?.type === "REFERENCE" && sameId(reference(attachment, "Note"), scope.noteId) && sameId(attachment.parentRecordName, scope.noteId), "Wrong drawing owner");
  assert.ok(attachment.fields.UTI?.type === "STRING" && attachment.fields.UTI.value === "com.apple.paper" && !storesTextAsAsset(note), "Unsupported drawing type");
  const body = note.fields.TextDataEncrypted;
  assert.ok(body?.type === "ENCRYPTED_BYTES" && typeof body.value === "string" && body.value.length <= 2 * MAX_DOCUMENT_BYTES, "Unsupported drawing document");
  const document = Buffer.from(body.value, "base64");
  assert.ok(document.length > 0 && document.length <= MAX_DOCUMENT_BYTES && document.toString("base64") === body.value, "Invalid drawing document encoding");
  // Bound decompression before calling the ordinary classifier, which also decodes.
  try {
    const decompress = document[0] === 0x1f && document[1] === 0x8b ? gunzipSync : inflateSync;
    decompress(document, { maxOutputLength: MAX_DOCUMENT_BYTES });
  } catch { throw Error("Invalid or oversized drawing document"); }
  const decoded = classifyNoteRecord(note, { titleMode: "filename" });
  assert.ok(decoded.status === "ok" && decoded.publishable && decoded.titleInMetadata && decoded.bodyText.replace(/\uFFFC/g, "").trim() === "" && (decoded.bodyText.match(/\uFFFC/g) ?? []).length === 1 && decoded.attachments.length === 1 && sameId(decoded.attachments[0]!.attachmentIdentifier, scope.attachmentId) && decoded.attachments[0]!.typeUti === "com.apple.paper", "Expected one drawing without prose");
  return { records: [note, attachment], document };
}

function assetURL(address: unknown): URL {
  assert.ok(typeof address === "string" && /^https:\/\/cvws\.icloud-content\.com(?:\/|\?|$)/.test(address) && !address.includes("#"), "Unexpected asset origin");
  let url: URL;
  try { url = new URL(address); } catch { throw Error("Invalid asset URL"); }
  assert.ok(url.origin === "https://cvws.icloud-content.com" && !url.username && !url.password && !url.port && !url.hash, "Unexpected asset origin");
  return url;
}
function inventory(records: CloudKitRecord[]): Asset[] {
  const assets: Asset[] = [];
  let total = 0;
  for (const record of records) {
    const fields = record.recordType === "Note" ? ["FirstAttachmentThumbnail"] : ["PaperDatabase", "FallbackImage", "PreviewImages", "PaperAssets"];
    for (const [key, field] of Object.entries(record.fields)) {
      assert.ok(!["ASSETID", "ASSETID_LIST"].includes(field.type) || fields.includes(key), "Unknown drawing asset field");
    }
    for (const key of fields) {
      const field = record.fields[key];
      if (!field) continue;
      const list = key === "PreviewImages" || key === "PaperAssets";
      const emptyUnknown = key === "PaperAssets" && field.type === "UNKNOWN_LIST" && Array.isArray(field.value) && field.value.length === 0;
      assert.ok(emptyUnknown || field.type === (list ? "ASSETID_LIST" : "ASSETID"), "Unexpected asset field type");
      assert.ok(!list || Array.isArray(field.value), "Malformed drawing asset list");
      for (const [index, value] of (list ? field.value as unknown[] : [field.value]).entries()) {
        assert.ok(object(value), "Malformed drawing asset");
        const url = assetURL(value.downloadURL), size = value.size;
        assert.ok(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= MAX_ASSET_BYTES, "Unsupported asset size");
        assert.ok(["fileChecksum", "referenceChecksum", "wrappingKey"].every(k => typeof value[k] === "string" && value[k].length > 0), "Missing asset identity");
        total += size;
        assets.push({ field: `${record.recordType}.${key}${list ? `[${index}]` : ""}`, value, url, size });
        assert.ok(assets.length <= 8 && total <= MAX_TOTAL_BYTES, "Unsupported asset count or total size");
      }
    }
  }
  assert.ok(assets.some(a => a.field === "Attachment.PaperDatabase"), "Missing drawing database asset");
  return assets;
}

function stable(value: unknown, asset = false): unknown {
  if (Array.isArray(value)) return value.map(v => stable(v, asset));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== undefined && !(asset && k === "downloadURL")).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v, asset)]));
  return value;
}
function snapshot(records: CloudKitRecord[]): string {
  return JSON.stringify(records.map(record => stable({ ...record, fields: Object.fromEntries(Object.entries(record.fields).map(([key, field]) => [key, { ...field, value: stable(field.value, ["ASSETID", "ASSETID_LIST"].includes(field.type)) }])) })));
}

/** Bounded record validation and fingerprints without downloading asset bytes.
 * Titles/date are checked separately against the lease's phase-specific state. */
export function inspectDrawingRecords(records: CloudKitRecord[], scope: DrawingCaptureScope) {
  const checked = checkRecords(records, scope), assets = inventory(checked.records);
  const immutable = checked.records.map(({ recordChangeTag, modified, ...record }) => ({ ...record,
    fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => !(record.recordType === "Note" ? ["TitleEncrypted", "ModificationDate"] : ["UserTitle"]).includes(key))),
  }));
  return { records: checked.records, documentSha256: sha(checked.document),
    assetRefsSha256: sha(JSON.stringify(assets.map(asset => [asset.field, stable(asset.value, true)]))),
    protectedSha256: sha(snapshot(immutable)),
  };
}

async function download(asset: Asset, request: typeof fetch): Promise<Buffer> {
  try {
    const response = await request(asset.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw Error(); }
    const header = response.headers.get("content-length");
    if (header !== null && (!/^\d+$/.test(header) || Number(header) !== asset.size)) { await response.body?.cancel(); throw Error(); }
    assert.ok(response.body);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > asset.size) { await reader.cancel(); throw Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    assert.ok(total === asset.size);
    return Buffer.concat(chunks, total);
  } catch {
    // Fetch/stream errors may contain the signed URL. Never propagate their text.
    throw Error("Asset download failed or size mismatch");
  }
}
/** Brackets every asset read with full record snapshots and versions. The caller
 * supplies a private-zone lookup; this function writes neither cloud nor disk. */
export async function captureDrawingSnapshot(scope: DrawingCaptureScope, lookup: (ids: string[]) => Promise<CloudKitRecord[]>, options: { fetch?: typeof fetch } = {}): Promise<DrawingCapture> {
  const identity = structuredClone(scope), request = options.fetch ?? fetch;
  assert.ok([identity.noteId, identity.attachmentId, identity.folderId].every(isNoteId), "Invalid drawing scope");
  const read = async () => {
    try { return structuredClone(await lookup([identity.noteId, identity.attachmentId])); }
    catch { throw Error("Drawing record lookup failed"); }
  };
  const before = checkRecords(await read(), identity), assets = inventory(before.records);
  const captured: DrawingCapture = { records: before.records, documentSha256: sha(before.document), assets: [] };
  for (const asset of assets) {
    const bytes = await download(asset, request);
    captured.assets.push({ field: asset.field, size: bytes.length, sha256: sha(bytes), contentIdentityHash: sha(JSON.stringify([asset.value.fileChecksum, asset.size])), referenceIdentityHash: sha(JSON.stringify([asset.value.referenceChecksum, asset.value.wrappingKey])) });
  }
  const after = checkRecords(await read(), identity);
  inventory(after.records);
  assert.ok(snapshot(before.records) === snapshot(after.records), "Drawing records changed during capture");
  return captured;
}
