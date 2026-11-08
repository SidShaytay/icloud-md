/** Offline builder for an explicitly disclosed causal-history experiment.
 * Only the final insert-then-delete history is returned; no visible intermediate
 * text is uploaded, and no existing formatting stamp is rewritten. */
import assert from "node:assert/strict";
import { toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import { AttributeRunSchema } from "./gen/topotext_pb.js";
import { applyTextEdit, encodeNoteDocument, isSentinel, noteDocumentRoundTrips, parseNoteDocument, validateDocumentInvariants, type NoteDocument, type TextRun } from "./noteDocument.js";
import { isNoteId } from "./noteIdFrontmatter.js";
import { compressNoteDocument } from "./noteText.js";

export interface DocumentRevisionSummary {
  strategy: "trailing-tombstone-v1" | "replace-drawing-v1";
  previousDocumentSha256: string;
  documentSha256: string;
  replicaIdSha256: string;
}
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const coord = (run: TextRun) => `${run.coord.replica}:${run.coord.clock}`;
const MAX_CLOCK = 0xffffffff - 16, MAX_BYTES = 1024 * 1024;

function assertConnected(doc: NoteDocument) {
  const reached = new Set<number>(), pending = [0];
  while (pending.length) { const index = pending.pop()!; if (reached.has(index)) continue; reached.add(index); pending.push(...doc.runs[index]!.sequence); }
  assert.ok(reached.size === doc.runs.length, "Disconnected causal graph");
}

function checkOriginal(doc: NoteDocument) {
  assert.ok(new Set(doc.runs.map(coord)).size === doc.runs.length, "Duplicate atom coordinate identity");
  assert.ok(doc.text === "\uFFFC", "Only one visible drawing without prose is supported");
  const spans = doc.attributeRuns.filter(run => run.attachmentInfo !== undefined);
  assert.ok(spans.length === 1 && spans[0]!.length === 1 && spans[0]!.attachmentInfo!.typeUTI === "com.apple.paper" && isNoteId(spans[0]!.attachmentInfo!.attachmentIdentifier), "Unsupported drawing attributes");
  assert.ok(doc.replicas.length > 0 && doc.replicas.length < 64 && new Set(doc.replicas.map(entry => Buffer.from(entry.id).toString("hex"))).size === doc.replicas.length, "Invalid original replica identities");
  for (const entry of doc.replicas) assert.ok(entry.id.length === 16 && entry.counters.length >= 1 && entry.counters.every(clock => Number.isInteger(clock) && clock >= 0 && clock <= MAX_CLOCK), "Insufficient replica clock headroom");
  for (const run of doc.runs) {
    if (run.coord.replica === 0) {
      assert.ok((run.coord.clock === 0 || isSentinel(run)) && run.length === 0 && !run.tombstone && run.anchor.replica === 0 && run.anchor.clock === run.coord.clock, "Pseudo-replica is reserved for exact origin/sentinel atoms");
    } else {
      assert.ok(run.anchor.replica >= 1 && run.anchor.replica <= doc.replicas.length, "Original style anchor references an unknown replica");
      assert.ok(run.coord.clock <= MAX_CLOCK && run.anchor.clock <= MAX_CLOCK, "Insufficient atom clock headroom");
    }
  }
  validateDocumentInvariants(doc);
  assert.ok(doc.runs[0]?.coord.replica === 0 && doc.runs[0]?.coord.clock === 0 && doc.runs[0]?.length === 0 && !doc.runs[0]?.tombstone && isSentinel(doc.runs.at(-1)!) && doc.runs.filter(isSentinel).length === 1, "Unsupported origin/sentinel graph");
  assertConnected(doc);
  for (let replica = 1; replica <= doc.replicas.length; replica++) {
    const atoms = doc.runs.filter(run => run.coord.replica === replica && run.length > 0).sort((a, b) => a.coord.clock - b.coord.clock);
    for (let index = 1; index < atoms.length; index++) assert.ok(atoms[index - 1]!.coord.clock + atoms[index - 1]!.length <= atoms[index]!.coord.clock, "Overlapping original atom coordinates");
  }
}

function assertNeutral(before: NoteDocument, after: NoteDocument, replica: Uint8Array) {
  assert.equal(after.text, before.text, "Visible text changed");
  assert.deepEqual(after.attributeRuns.map(run => toBinary(AttributeRunSchema, run)), before.attributeRuns.map(run => toBinary(AttributeRunSchema, run)), "Original attribute bytes changed");
  assert.deepEqual(after.replicas.slice(0, before.replicas.length), before.replicas, "Original replica counters or identities changed");
  assert.ok(after.replicas.length === before.replicas.length + 1 && Buffer.from(after.replicas.at(-1)!.id).equals(Buffer.from(replica)), "Expected exactly one fresh replica");
  for (const key of ["rootSerializationVersion", "versionSerializationVersion", "minimumSupportedVersion"] as const) assert.equal(after[key], before[key], "Document version marker changed");
  const oldKeys = new Set(before.runs.map(coord)), added = after.runs.filter(run => !oldKeys.has(coord(run)));
  assert.ok(after.runs.length === before.runs.length + 1 && new Set(after.runs.map(coord)).size === after.runs.length && added.length === 1, "Expected one new atom and a bijective original history");
  const dead = added[0]!;
  assert.ok(dead.tombstone && dead.length === 1 && dead.coord.replica === after.replicas.length && dead.anchor.replica === after.replicas.length && dead.sequence.length === 1 && isSentinel(after.runs[dead.sequence[0]!]!), "Only the new trailing atom may be tombstoned");
  const deadIndex = after.runs.indexOf(dead);
  assert.ok(after.runs.reduce((count, run) => count + run.sequence.filter(index => index === deadIndex).length, 0) === 1, "The new dead atom requires one incoming edge");
  for (const previous of before.runs) {
    const current = after.runs.find(run => coord(run) === coord(previous)); assert.ok(current, "Original atom disappeared");
    const { sequence: priorChildren, ...priorCore } = previous, { sequence: nextChildren, ...nextCore } = current;
    assert.deepEqual(nextCore, priorCore, "Original atom coordinate/length/style/tombstone changed");
    const contracted = nextChildren.flatMap(index => after.runs[index] === dead ? dead.sequence : [index]);
    assert.deepEqual(contracted.map(index => coord(after.runs[index]!)), priorChildren.map(index => coord(before.runs[index]!)), "Causal graph contraction changed original edges");
  }
  validateDocumentInvariants(after);
  assertConnected(after);
}

// Pure contract seam for offline negative tests; no arbitrary payload writer.
export { assertNeutral as validateAttachmentTitleRevision };

export function buildAttachmentTitleRevision(input: Uint8Array, operationIdentity: string): { compressed: Buffer; summary: DocumentRevisionSummary } {
  assert.ok(/^[a-f0-9]{64}$/.test(operationIdentity), "Invalid revision operation identity");
  const compressed = Buffer.from(input); assert.ok(compressed.length > 0 && compressed.length <= MAX_BYTES, "Unsupported compressed document size");
  let raw: Buffer;
  try { raw = (compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync : inflateSync)(compressed, { maxOutputLength: MAX_BYTES }); }
  catch { throw Error("Invalid or oversized drawing document"); }
  assert.ok(noteDocumentRoundTrips(raw), "Original document must round-trip exactly");
  const before = parseNoteDocument(raw), after = parseNoteDocument(raw); checkOriginal(before);
  const replica = createHash("sha256").update("icloud-md/trailing-tombstone-v1\0").update(operationIdentity).digest().subarray(0, 16);
  replica[6] = (replica[6]! & 0x0f) | 0x40; replica[8] = (replica[8]! & 0x3f) | 0x80;
  assert.ok(!before.replicas.some(entry => Buffer.from(entry.id).equals(replica)), "Deterministic replica collision; a fresh replica is required");
  assert.ok(applyTextEdit(after, before.text + "x", { replicaId: replica }));
  assert.ok(applyTextEdit(after, before.text, { replicaId: replica }));
  assertNeutral(before, after, replica);
  const encoded = encodeNoteDocument(after); assert.ok(noteDocumentRoundTrips(encoded), "Revised document failed round-trip");
  const result = compressNoteDocument(encoded);
  assert.ok(!result.equals(compressed), "Causal revision did not change document bytes");
  return { compressed: result, summary: { strategy: "trailing-tombstone-v1", previousDocumentSha256: sha(compressed), documentSha256: sha(result), replicaIdSha256: sha(replica) } };
}
