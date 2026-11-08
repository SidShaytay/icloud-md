import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { AttachmentInfoSchema, AttributeRunSchema, ParagraphStyleSchema, StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema } from "./gen/versioned_document_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument, noteDocumentRoundTrips, parseNoteDocument, validateDocumentInvariants, type NoteDocument, type TextRun } from "./noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "./noteText.js";
import { buildAttachmentTitleReplacement } from "./attachmentTitleReplacement.js";

const seed = "a".repeat(64), attachmentId = "11111111-1111-4111-8111-111111111111";
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (doc: NoteDocument, replica: number) => replica === 0 ? "zero" : Buffer.from(doc.replicas[replica - 1]!.id).toString("hex");
const key = (doc: NoteDocument, run: TextRun) => `${id(doc, run.coord.replica)}:${run.coord.clock}`;
const physical = (doc: NoteDocument, run: TextRun) => ({ id: key(doc, run), length: run.length, anchor: `${id(doc, run.anchor.replica)}:${run.anchor.clock}`, dead: run.tombstone, children: run.sequence.map(index => key(doc, doc.runs[index]!)) });
function fixture() {
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(0xfe));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { typeUTI: "com.apple.paper", attachmentIdentifier: attachmentId });
  doc.attributeRuns[0]!.paragraphStyle = create(ParagraphStyleSchema, { style: 3, uuid: new Uint8Array(16).fill(9) });
  return doc;
}
const compressed = (doc: NoteDocument) => compressNoteDocument(encodeNoteDocument(doc));
function wireAtoms(bytes: Uint8Array) {
  const str = fromBinary(StringSchema, fromBinary(DocumentSchema, decompressNoteDocument(Buffer.from(bytes))).version[0]!.data);
  const sorted = str.timestamp!.clock.map(row => row.replicaUUID).sort(Buffer.compare);
  const uuid = (rank: number) => rank === 0 ? "zero" : Buffer.from(sorted[rank - 1]!).toString("hex");
  return str.substring.map(run => ({ id: `${uuid(run.charID!.replicaID)}:${run.charID!.clock}`, anchor: `${uuid(run.timestamp!.replicaID)}:${run.timestamp!.clock}`, dead: run.tombstone === 1, length: run.length }));
}

test("replacement changes physical character identity while preserving one same drawing and exact formatting", () => {
  const input = compressed(fixture()), before = parseNoteDocument(decompressNoteDocument(input)), unchangedInput = Buffer.from(input);
  const result = buildAttachmentTitleReplacement(input, seed), afterRaw = decompressNoteDocument(result.compressed), after = parseNoteDocument(afterRaw);
  assert.deepEqual(input, unchangedInput); assert.ok(noteDocumentRoundTrips(afterRaw)); validateDocumentInvariants(after);
  assert.equal(after.text, "\uFFFC");
  assert.deepEqual(after.attributeRuns.map(run => toBinary(AttributeRunSchema, run)), before.attributeRuns.map(run => toBinary(AttributeRunSchema, run)));
  assert.deepEqual(after.replicas.slice(0, before.replicas.length), before.replicas);
  assert.equal(after.replicas.length, before.replicas.length + 1);
  const live = after.runs.filter(run => run.length && !run.tombstone);
  assert.equal(live.length, 1); const fresh = live[0]!;
  assert.equal(fresh.coord.replica, after.replicas.length); assert.equal(fresh.length, 1);
  const original = before.runs[1]!, replaced = after.runs.find(run => key(after, run) === key(before, original))!;
  assert.equal(replaced.tombstone, true); assert.equal(replaced.length, original.length);
  assert.equal(replaced.anchor.replica, fresh.coord.replica); assert.ok(replaced.anchor.clock >= original.anchor.clock + 8);
  assert.deepEqual(fresh.sequence.map(index => key(after, after.runs[index]!)), [key(before, original)]);
  assert.equal(result.summary.strategy, "replace-drawing-v1");
  assert.equal(result.summary.previousDocumentSha256, hash(input)); assert.equal(result.summary.documentSha256, hash(result.compressed));
  assert.equal(result.summary.replicaIdSha256, hash(after.replicas.at(-1)!.id));
  assert.deepEqual(buildAttachmentTitleReplacement(input, seed), result);
  const wire = wireAtoms(result.compressed), wireOriginal = wire.find(run => run.id === key(before, original))!;
  assert.equal(wireOriginal.dead, true); assert.equal(wire.find(run => run.id === key(after, fresh))!.dead, false);
  assert.ok(Buffer.compare(Buffer.from(after.replicas.at(-1)!.id), Buffer.from(before.replicas[0]!.id)) < 0, "exercise fresh UUID ranking before original");
});

test("contracting fresh live node recovers original ordered DAG and preserves unrelated dead history", () => {
  const first = buildAttachmentTitleReplacement(compressed(fixture()), seed), before = parseNoteDocument(decompressNoteDocument(first.compressed));
  const second = buildAttachmentTitleReplacement(first.compressed, "b".repeat(64)), after = parseNoteDocument(decompressNoteDocument(second.compressed));
  const oldKeys = new Set(before.runs.map(run => key(before, run))), added = after.runs.filter(run => !oldKeys.has(key(after, run)));
  assert.equal(added.length, 1); const fresh = added[0]!, oldLive = before.runs.find(run => run.length && !run.tombstone)!;
  for (const run of before.runs) {
    const next = after.runs.find(item => key(after, item) === key(before, run))!;
    const previous = physical(before, run), current = physical(after, next);
    if (run !== oldLive) { const { children: _, ...a } = previous, { children: __, ...b } = current; assert.deepEqual(b, a); }
    const contracted = next.sequence.flatMap(index => after.runs[index] === fresh ? fresh.sequence : [index]);
    assert.deepEqual(contracted.map(index => key(after, after.runs[index]!)), previous.children);
  }
  assert.deepEqual(after.replicas.slice(0, before.replicas.length), before.replicas);
});

test("original zero-length formatting messages are preserved verbatim", () => {
  const before = fixture(); before.attributeRuns.push(create(AttributeRunSchema, { length: 0, fontHints: 1 }));
  const after = parseNoteDocument(decompressNoteDocument(buildAttachmentTitleReplacement(compressed(before), seed).compressed));
  assert.deepEqual(after.attributeRuns.map(run => toBinary(AttributeRunSchema, run)), before.attributeRuns.map(run => toBinary(AttributeRunSchema, run)));
});

test("fresh live node must precede unseen native newline in every topological merge order", () => {
  const before = fixture(), after = parseNoteDocument(decompressNoteDocument(buildAttachmentTitleReplacement(compressed(before), seed).compressed));
  const originalId = key(before, before.runs[1]!), sentinel = "zero:4294967295", newline = "01010101010101010101010101010101:1";
  const merged = new Map(after.runs.map(run => [key(after, run), { children: new Set(run.sequence.map(index => key(after, after.runs[index]!))), text: run.length && !run.tombstone ? "\uFFFC" : "" }]));
  // Native keeps an extra old root edge and an unseen old-drawing descendant.
  merged.get("zero:0")!.children.add(originalId); merged.get(originalId)!.children.add(newline);
  merged.set(newline, { children: new Set([sentinel]), text: "\n" });
  const orders = new Set<string>();
  function visit(done: Set<string>, text: string) {
    if (done.size === merged.size) { orders.add(text); return; }
    for (const [nodeId, node] of merged) if (!done.has(nodeId) && [...merged].every(([parent, entry]) => !entry.children.has(nodeId) || done.has(parent))) visit(new Set([...done, nodeId]), text + node.text);
  }
  visit(new Set(), ""); assert.deepEqual([...orders], ["\uFFFC\n"]);
});

test("deterministic fresh actor collision is refused", () => {
  const before = fixture(), result = buildAttachmentTitleReplacement(compressed(before), seed);
  before.replicas.push(parseNoteDocument(decompressNoteDocument(result.compressed)).replicas.at(-1)!);
  assert.throws(() => buildAttachmentTitleReplacement(compressed(before), seed), /fresh|collision/i);
});

test("unsupported body, attachment kind and exhausted clock are refused", () => {
  const prose = fixture(); prose.text = "x"; assert.throws(() => buildAttachmentTitleReplacement(compressed(prose), seed));
  const image = fixture(); image.attributeRuns[0]!.attachmentInfo!.typeUTI = "public.jpeg"; assert.throws(() => buildAttachmentTitleReplacement(compressed(image), seed));
  const clock = fixture(); clock.replicas[0]!.counters[1] = 0xffffffff; assert.throws(() => buildAttachmentTitleReplacement(compressed(clock), seed), /clock|headroom/i);
});

test("deficient original style counter is refused rather than normalized by the native reader", () => {
  const before = fixture(); before.runs[1]!.anchor.clock = 5;
  validateDocumentInvariants(before);
  assert.throws(() => buildAttachmentTitleReplacement(compressed(before), seed), /style.*counter|counter.*style/i);
});

test("oversized dead history is refused before quadratic replacement work", () => {
  const before = fixture(), sentinel = before.runs.at(-1)!;
  before.runs = [...before.runs.slice(0, 2), ...Array.from({ length: 4094 }, (_, index): TextRun => ({
    coord: { replica: 1, clock: index + 1 }, length: 1, anchor: { replica: 1, clock: 0 }, tombstone: true, sequence: [],
  })), sentinel];
  for (let index = 0; index < before.runs.length - 1; index++) before.runs[index]!.sequence = [index + 1];
  before.replicas[0]!.counters[0] = 4095;
  validateDocumentInvariants(before);
  assert.throws(() => buildAttachmentTitleReplacement(compressed(before), seed), /history|run.*limit|too many/i);
});
