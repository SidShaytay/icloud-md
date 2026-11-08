import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AttachmentInfoSchema, AttributeRunSchema, ParagraphStyleSchema } from "../src/notes/gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument, noteDocumentRoundTrips, parseNoteDocument, validateDocumentInvariants } from "../src/notes/noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";
import { buildAttachmentTitleRevision, validateAttachmentTitleRevision } from "./attachmentTitleRevision.js";

const seed = "a".repeat(64), attachmentId = "11111111-1111-4111-8111-111111111111";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { typeUTI: "com.apple.paper", attachmentIdentifier: attachmentId });
  doc.attributeRuns[0]!.paragraphStyle = create(ParagraphStyleSchema, { style: 3, uuid: new Uint8Array(16).fill(9) });
  return doc;
}

test("neutral revision changes only one fresh dead atom/replica and required graph edges", () => {
  const raw = encodeNoteDocument(fixture()), before = parseNoteDocument(raw), compressed = compressNoteDocument(raw);
  const result = buildAttachmentTitleRevision(compressed, seed);
  const afterRaw = decompressNoteDocument(result.compressed), after = parseNoteDocument(afterRaw);
  assert.ok(noteDocumentRoundTrips(afterRaw)); validateDocumentInvariants(after);
  assert.equal(after.text, "\uFFFC");
  assert.deepEqual(after.attributeRuns.map(run => toBinary(AttributeRunSchema, run)), before.attributeRuns.map(run => toBinary(AttributeRunSchema, run)));
  const replicas = (entries: typeof before.replicas) => entries.map(entry => ({ id: [...entry.id], counters: entry.counters }));
  assert.deepEqual(replicas(after.replicas.slice(0, before.replicas.length)), replicas(before.replicas));
  assert.equal(after.replicas.length, before.replicas.length + 1);
  const key = (run: typeof before.runs[number]) => JSON.stringify(run.coord);
  const old = new Set(before.runs.map(key));
  const added = after.runs.filter(run => !old.has(key(run)));
  assert.equal(added.length, 1); assert.equal(added[0]!.tombstone, true); assert.equal(added[0]!.length, 1);
  assert.equal(added[0]!.coord.replica, after.replicas.length);
  for (const run of before.runs) {
    const current = after.runs.find(item => key(item) === key(run))!;
    const { sequence: oldChildren, ...oldCore } = run, { sequence: nextChildren, ...nextCore } = current;
    assert.deepEqual(nextCore, oldCore);
    const contracted = nextChildren.flatMap(index => after.runs[index] === added[0] ? added[0]!.sequence : [index]);
    assert.deepEqual(contracted.map(index => key(after.runs[index]!)), oldChildren.map(index => key(before.runs[index]!)));
  }
  assert.equal(result.summary.previousDocumentSha256, sha(compressed));
  assert.equal(result.summary.documentSha256, sha(result.compressed));
  assert.equal(result.summary.strategy, "trailing-tombstone-v1");
  assert.notEqual(result.summary.documentSha256, result.summary.previousDocumentSha256);
  assert.equal(result.summary.replicaIdSha256, sha(after.replicas.at(-1)!.id));
  assert.deepEqual(buildAttachmentTitleRevision(compressed, seed), result, "preview and apply must compute identical payload bytes");
});

test("a dropped original zero-length attribute is refused despite equal visible text", () => {
  const doc = fixture(); doc.attributeRuns.push(create(AttributeRunSchema, { length: 0, fontHints: 1 }));
  const raw = encodeNoteDocument(doc); assert.ok(noteDocumentRoundTrips(raw)); validateDocumentInvariants(doc);
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(raw), seed), /attribute|format/i);
});

test("a deterministic replica collision is refused rather than reusing lineage", () => {
  const before = fixture(), first = buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(before)), seed);
  const added = parseNoteDocument(decompressNoteDocument(first.compressed)).replicas.at(-1)!;
  before.replicas.push(added);
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(before)), seed), /fresh|replica|collision/i);
});

test("revision can extend existing dead history while preserving its atoms and counters", () => {
  const first = buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(fixture())), seed);
  const second = buildAttachmentTitleRevision(first.compressed, "b".repeat(64));
  const before = parseNoteDocument(decompressNoteDocument(first.compressed)), after = parseNoteDocument(decompressNoteDocument(second.compressed));
  assert.equal(after.text, before.text); assert.equal(after.runs.length, before.runs.length + 1);
  assert.deepEqual(after.replicas.slice(0, before.replicas.length), before.replicas);
});

test("prose, other attachment types and invalid operation identity stay refused", () => {
  const compressed = compressNoteDocument(encodeNoteDocument(fixture()));
  assert.throws(() => buildAttachmentTitleRevision(compressed, "not-an-operation"));
  const prose = fixture(); prose.text = "x"; prose.attributeRuns[0]!.attachmentInfo = undefined;
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(prose)), seed));
  const image = fixture(); image.attributeRuns[0]!.attachmentInfo!.typeUTI = "public.jpeg";
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(image)), seed));
});

test("duplicate coordinates and exhausted clocks cannot author a revision", () => {
  const duplicate = fixture();
  duplicate.runs.splice(1, 0, { ...duplicate.runs[0]!, sequence: [2] }); duplicate.runs[2]!.sequence = [3];
  validateDocumentInvariants(duplicate);
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(duplicate)), seed), /coordinate|identity/i);
  const exhausted = fixture(); exhausted.replicas[0]!.counters[1] = 0xffffffff;
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(exhausted)), seed), /clock|headroom/i);
});

test("invalid original style anchors and pseudo-replica content are refused", () => {
  const anchor = fixture(); anchor.runs[1]!.anchor.replica = 99;
  validateDocumentInvariants(anchor);
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(anchor)), seed), /anchor|replica/i);
  const pseudo = fixture(); pseudo.runs[1]!.coord = { replica: 0, clock: 2 };
  validateDocumentInvariants(pseudo);
  assert.throws(() => buildAttachmentTitleRevision(compressNoteDocument(encodeNoteDocument(pseudo)), seed), /origin|sentinel|replica/i);
});

test("an orphan dead atom cannot pass the causal revision contract", () => {
  const compressed = compressNoteDocument(encodeNoteDocument(fixture()));
  const result = buildAttachmentTitleRevision(compressed, seed);
  const before = parseNoteDocument(decompressNoteDocument(compressed)), after = parseNoteDocument(decompressNoteDocument(result.compressed));
  const sentinel = after.runs.length - 1;
  after.runs[1]!.sequence = [sentinel]; // Bypass the new dead atom, leaving it orphaned.
  validateDocumentInvariants(after);
  assert.throws(() => validateAttachmentTitleRevision(before, after, after.replicas.at(-1)!.id), /connected|incoming|edge/i);
});
