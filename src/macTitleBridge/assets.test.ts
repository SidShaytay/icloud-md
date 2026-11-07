import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { downloadAsset, snapshotAssets } from "./assets.js";

const url = 'https://cvws.icloud-content.com/asset?token=private';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const asset = (extra = {}) => ({ downloadURL: url, size: 3, fileChecksum: 'content', referenceChecksum: 'reference', wrappingKey: 'secret', ...extra });
const record = (recordType: string, values: { [key: string]: unknown }): CloudKitRecord => ({ recordName: 'arbitrary', recordType, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, type: 'ASSET' }])) });
const fake = (body = 'abc', headers: { [key: string]: string } = {}): typeof fetch => (async () => new Response(body, { headers })) as typeof fetch;

test('forbidden hosts, credentials, fragments, ports and malformed URLs fail without fetch or URL disclosure', async () => {
 let calls = 0;
 const request = (async () => { calls++; throw Error('unexpected'); }) as typeof fetch;
 for (const address of ['http://cvws.icloud-content.com/a', 'https://example.com/private', 'https://cvws.icloud-content.com.evil/a', 'https://u:p@cvws.icloud-content.com/a', `${url}#private`, 'https://cvws.icloud-content.com:443/private', 'https://cvws.icloud-content.com:8443/a', 'not a URL private']) {
  await assert.rejects(downloadAsset(address, 3, request), error => error instanceof Error && !error.message.includes(address) && !error.message.includes('private'));
 }
 assert.equal(calls, 0);
});

test('GET uses redirect:error and a 30 second abort signal; redirect and network failures are sanitized', async () => {
 const original = AbortSignal.timeout;
 const durations: number[] = [];
 AbortSignal.timeout = ms => { durations.push(ms); return original(ms); };
 try {
  const request = (async (_address, options) => {
   assert.equal(options?.method, 'GET');
   assert.equal(options?.redirect, 'error');
   assert.ok(options?.signal instanceof AbortSignal);
   return new Response('abc');
  }) as typeof fetch;
  assert.equal((await downloadAsset(url, 3, request)).toString(), 'abc');
  assert.deepEqual(durations, [30000]);
 } finally { AbortSignal.timeout = original; }
 await assert.rejects(downloadAsset(url, 3, (async () => new Response(null, { status: 302 })) as typeof fetch));
 await assert.rejects(downloadAsset(url, 3, (async () => { throw Error(url); }) as typeof fetch), error => error instanceof Error && !error.message.includes(url));
});

test('oversize and malformed declared sizes are rejected before fetch', async () => {
 let calls = 0;
 const request = (async () => { calls++; return new Response('abc'); }) as typeof fetch;
 for (const size of [-1, 0.5, NaN, Infinity, 16 * 1024 * 1024 + 1, '3', null, undefined]) {
  await assert.rejects(downloadAsset(url, size as number, request));
 }
 assert.equal(calls, 0);
});

test('bounded stream rejects excess bytes, short bytes and misleading content length', async () => {
 for (const [body, headers] of [['abcd', {}], ['ab', {}], ['abc', { 'content-length': '4' }], ['abc', { 'content-length': 'garbage' }], ['abc', { 'content-length': '2' }]] as const) {
  await assert.rejects(downloadAsset(url, 3, fake(body, headers)));
 }
 let cancelled = false;
 const request = (async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); },
  cancel() { cancelled = true; },
 }))) as typeof fetch;
 await assert.rejects(downloadAsset(url, 3, request));
 assert.equal(cancelled, true);
 assert.equal((await downloadAsset(url, 0, fake(''))).length, 0);
});

test('field descriptor paths cover only permitted record types and fields; hashes contain no secrets', async () => {
 const records = [record('Note', { FirstAttachmentThumbnail: asset(), PaperDatabase: asset() }), record('Attachment', { PaperDatabase: asset(), FallbackImage: asset(), PreviewImages: [asset(), asset()], PaperAssets: [asset()] }), record('Other', { PaperAssets: asset() })];
 const result = await snapshotAssets(records, fake());
 assert.deepEqual(result.map(item => item.field), ['Note.FirstAttachmentThumbnail', 'Attachment.PaperDatabase', 'Attachment.FallbackImage', 'Attachment.PreviewImages[0]', 'Attachment.PreviewImages[1]', 'Attachment.PaperAssets[0]']);
 assert.deepEqual(result[0], { field: 'Note.FirstAttachmentThumbnail', size: 3, sha256: sha('abc'), contentIdentityHash: sha(JSON.stringify(['content', 3])), referenceIdentityHash: sha(JSON.stringify(['reference', 'secret'])) });
 assert.ok(!JSON.stringify(result).includes('private'));
 assert.ok(!JSON.stringify(result).includes('secret'));
});

test('actual bytes change the digest independently of descriptor identities', async () => {
 const records = [record('Attachment', { PaperDatabase: asset() })];
 const [before] = await snapshotAssets(records, fake('abc'));
 const [after] = await snapshotAssets(records, fake('xyz'));
 assert.ok(before && after);
 assert.notEqual(before.sha256, after.sha256);
 assert.equal(before.contentIdentityHash, after.contentIdentityHash);
 assert.equal(before.referenceIdentityHash, after.referenceIdentityHash);
});

test('one to eight assets only, with all descriptors preflighted before downloads', async () => {
 let calls = 0;
 const request = (async () => { calls++; return new Response('abc'); }) as typeof fetch;
 for (const records of [[], [record('Attachment', { PaperAssets: Array.from({ length: 9 }, () => asset()) })], [record('Attachment', { PaperAssets: [asset(), asset({ size: '3' })] })], [record('Attachment', { PaperDatabase: 'bad' })]]) {
  await assert.rejects(snapshotAssets(records, request));
 }
 assert.equal(calls, 0);
 assert.equal((await snapshotAssets([record('Attachment', { PaperAssets: Array.from({ length: 8 }, () => asset()) })], request)).length, 8);
});
