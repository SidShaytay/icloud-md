import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const isObject = (value: unknown): value is { [key: string]: unknown } =>
 typeof value === 'object' && value !== null && !Array.isArray(value);
function validateAsset(address: unknown, size: unknown): URL {
 assert.ok(typeof address === 'string' && /^https:\/\/cvws\.icloud-content\.com(?:\/|\?|$)/.test(address) && !address.includes('#'), 'Unexpected asset origin');
 let url: URL;
 try { url = new URL(address); } catch { throw new Error('Invalid asset URL'); }
 assert.ok(url.origin === 'https://cvws.icloud-content.com' && !url.username && !url.password && !url.hash && !url.port, 'Unexpected asset origin');
 assert.ok(typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= 16 * 1024 * 1024, 'Unsupported asset size');
 return url;
}

export async function downloadAsset(address: string, size: number, request: typeof fetch = fetch): Promise<Buffer> {
 const url = validateAsset(address, size);
 try {
  const response = await request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || response.redirected) {
   await response.body?.cancel();
   throw new Error('Asset download failed');
  }
  if (response.headers.has('content-length')) {
   const header = response.headers.get('content-length')!;
   const length = Number(header);
   if (!/^\d+$/.test(header) || !Number.isSafeInteger(length) || length !== size) {
    await response.body?.cancel();
    throw new Error('Asset size mismatch');
   }
  }
  assert.ok(response.body, 'Asset response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
   for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > size) {
     await reader.cancel();
     throw new Error('Asset exceeds declared size');
    }
    chunks.push(value);
   }
  } finally { reader.releaseLock(); }
  assert.equal(total, size, 'Asset size mismatch');
  return Buffer.concat(chunks, total);
 } catch {
  // Fetch and stream errors can include signed URLs; never propagate their text.
  throw new Error('Asset download failed or size mismatch');
 }
}

export async function snapshotAssets(records: CloudKitRecord[], request: typeof fetch = fetch): Promise<Array<{
 field: string; size: number; sha256: string; contentIdentityHash: string; referenceIdentityHash: string;
}>> {
 const assets: Array<{ field: string; value: { [key: string]: unknown } }> = [];
 for (const record of records) {
  const keys = record.recordType === 'Note' ? ['FirstAttachmentThumbnail'] :
   record.recordType === 'Attachment' ? ['PaperDatabase', 'FallbackImage', 'PreviewImages', 'PaperAssets'] : [];
  for (const key of keys) {
   const value = record.fields[key]?.value;
   if (value === undefined || value === null) continue;
   for (const [index, item] of (Array.isArray(value) ? value : [value]).entries()) {
    assert.ok(isObject(item), 'Malformed asset');
    validateAsset(item.downloadURL, item.size);
    assets.push({ field: `${record.recordType}.${key}${Array.isArray(value) ? `[${index}]` : ''}`, value: item });
    assert.ok(assets.length <= 8, 'Unsupported asset count');
   }
  }
 }
 assert.ok(assets.length > 0, 'Unsupported asset count');
 const inventory = [];
 for (const { field, value } of assets) {
  const bytes = await downloadAsset(value.downloadURL as string, value.size as number, request);
  inventory.push({ field, size: bytes.length, sha256: sha(bytes),
   contentIdentityHash: sha(JSON.stringify([value.fileChecksum, value.size])),
   referenceIdentityHash: sha(JSON.stringify([value.referenceChecksum, value.wrappingKey])) });
 }
 return inventory;
}
