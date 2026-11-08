/** Pure bounded diagnostic: replace a paper placeholder's physical CRDT
 * character while preserving its attachment identity and exact formatting.
 * No intermediate empty document is returned or uploaded. Native title
 * invalidation is a hypothesis; this builder makes no cloud/native calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import { clone, toBinary } from "@bufbuild/protobuf";
import { AttributeRunSchema } from "./gen/topotext_pb.js";
import { applyTextEdit, encodeNoteDocument, isSentinel, noteDocumentRoundTrips, parseNoteDocument, validateDocumentInvariants, type NoteDocument, type TextRun } from "./noteDocument.js";
import { isNoteId } from "./noteIdFrontmatter.js";
import { compressNoteDocument } from "./noteText.js";

export interface AttachmentTitleReplacementSummary {
  strategy: "replace-drawing-v1";
  previousDocumentSha256: string;
  documentSha256: string;
  replicaIdSha256: string;
}
const MAX_BYTES = 1024 * 1024, MAX_CLOCK = 0xffffffff - 16;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const coord = (run: TextRun) => `${run.coord.replica}:${run.coord.clock}`;
const attributes = (doc: NoteDocument) => doc.attributeRuns.map(run => toBinary(AttributeRunSchema, run));
function connected(doc: NoteDocument) {
  const found = new Set<number>(), pending = [0];
  while (pending.length) {
    const index = pending.pop()!; if (found.has(index)) continue;
    found.add(index); pending.push(...doc.runs[index]!.sequence);
  }
  assert.equal(found.size, doc.runs.length, "Disconnected replacement graph");
}
function checkedOriginal(doc: NoteDocument): TextRun {
  assert.ok(doc.runs.length <= 4096, "Drawing history exceeds the supported run limit");
  assert.equal(doc.text, "\uFFFC", "Only one paper placeholder without prose is supported");
  const spans = doc.attributeRuns.filter(run => run.attachmentInfo !== undefined);
  assert.ok(spans.length === 1 && spans[0]!.length === 1 && spans[0]!.attachmentInfo!.typeUTI === "com.apple.paper" && isNoteId(spans[0]!.attachmentInfo!.attachmentIdentifier), "Unsupported paper attachment attributes");
  assert.ok(doc.replicas.length > 0 && doc.replicas.length < 64, "Unsupported replica table");
  assert.equal(new Set(doc.replicas.map(entry => Buffer.from(entry.id).toString("hex"))).size, doc.replicas.length, "Duplicate replica identity");
  for (const entry of doc.replicas) assert.ok(entry.id.length === 16 && entry.id.some(byte => byte !== 0) && entry.counters.length === 2 && entry.counters.every(clock => Number.isInteger(clock) && clock >= 0 && clock <= MAX_CLOCK), "Invalid replica identity or insufficient clock headroom");
  assert.equal(new Set(doc.runs.map(coord)).size, doc.runs.length, "Duplicate physical atom identity");
  for (const run of doc.runs) {
    if (run.coord.replica === 0) {
      assert.ok((run.coord.clock === 0 || isSentinel(run)) && run.length === 0 && !run.tombstone && run.anchor.replica === 0 && run.anchor.clock === run.coord.clock, "Invalid origin/sentinel atom");
    } else {
      assert.ok(run.length > 0 && run.anchor.replica > 0 && run.anchor.replica <= doc.replicas.length && run.coord.clock <= MAX_CLOCK && run.anchor.clock <= MAX_CLOCK, "Invalid physical atom or style anchor");
      assert.ok(run.anchor.clock < doc.replicas[run.anchor.replica - 1]!.counters[1]!, "Original style counter does not cover its timestamp");
    }
  }
  validateDocumentInvariants(doc);
  assert.ok(doc.runs[0]?.coord.replica === 0 && doc.runs[0]?.coord.clock === 0 && isSentinel(doc.runs.at(-1)!) && doc.runs.filter(isSentinel).length === 1, "Unsupported origin/sentinel layout");
  connected(doc);
  for (let replica = 1; replica <= doc.replicas.length; replica++) {
    const runs = doc.runs.filter(run => run.coord.replica === replica).sort((a, b) => a.coord.clock - b.coord.clock);
    for (let index = 1; index < runs.length; index++) assert.ok(runs[index - 1]!.coord.clock + runs[index - 1]!.length <= runs[index]!.coord.clock, "Overlapping physical atom intervals");
  }
  const live = doc.runs.filter(run => run.length > 0 && !run.tombstone);
  assert.ok(live.length === 1 && live[0]!.length === 1, "Exactly one physical drawing is required");
  return live[0]!;
}

export function buildAttachmentTitleReplacement(input: Uint8Array, operationIdentity: string): { compressed: Buffer; summary: AttachmentTitleReplacementSummary } {
  assert.match(operationIdentity, /^[a-f0-9]{64}$/, "Invalid replacement operation identity");
  const compressed = Buffer.from(input); assert.ok(compressed.length > 0 && compressed.length <= MAX_BYTES, "Unsupported document size");
  let raw: Buffer;
  try { raw = (compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync : inflateSync)(compressed, { maxOutputLength: MAX_BYTES }); }
  catch { throw Error("Invalid or oversized drawing document"); }
  assert.ok(noteDocumentRoundTrips(raw), "Original document must round-trip exactly");
  const before = parseNoteDocument(raw), after = parseNoteDocument(raw), original = checkedOriginal(before);
  const actor = createHash("sha256").update("icloud-md/replace-drawing-v1\0").update(operationIdentity).digest().subarray(0, 16);
  actor[6] = (actor[6]! & 0x0f) | 0x40; actor[8] = (actor[8]! & 0x3f) | 0x80;
  assert.ok(!before.replicas.some(entry => Buffer.from(entry.id).equals(actor)), "Fresh replacement replica collision");
  // Use the ordinary editor to mint both the winning deletion timestamp and
  // the replacement character. Never fabricate clocks or reuse old lineage.
  assert.ok(applyTextEdit(after, "", { replicaId: actor }));
  const deleted = structuredClone(after.runs.find(run => coord(run) === coord(original))!);
  assert.ok(deleted.tombstone && deleted.anchor.replica === after.replicas.length && deleted.anchor.clock >= original.anchor.clock + 8, "Ordinary deletion did not dominate original style");
  assert.deepEqual({ ...deleted, anchor: original.anchor, tombstone: original.tombstone, sequence: original.sequence }, original, "Ordinary deletion changed the original character identity or length");
  assert.ok(applyTextEdit(after, "\uFFFC", { replicaId: actor }));
  after.attributeRuns = before.attributeRuns.map(run => clone(AttributeRunSchema, run));
  const oldKeys = new Set(before.runs.map(coord)), fresh = after.runs.filter(run => !oldKeys.has(coord(run)));
  assert.ok(fresh.length === 1 && !fresh[0]!.tombstone && fresh[0]!.length === 1 && fresh[0]!.coord.replica === after.replicas.length, "Expected exactly one fresh live placeholder");
  const added = fresh[0]!, generatedIndex = after.runs.indexOf(added);
  // First prove the ordinary tail insertion contracts to the unchanged DAG.
  const edges = new Map<string, string[]>();
  for (const previous of before.runs) {
    const current = after.runs.find(run => coord(run) === coord(previous)); assert.ok(current, "Original atom disappeared");
    const children = current.sequence.flatMap(index => index === generatedIndex ? added.sequence : [index]).map(index => coord(after.runs[index]!));
    assert.deepEqual(children, previous.sequence.map(index => coord(before.runs[index]!)), "Generated insertion changed original graph");
    edges.set(coord(previous), children.map(child => child === coord(original) ? coord(added) : child));
  }
  // Move that same generated node before the old drawing, retaining the old
  // drawing as its tombstoned descendant. Unseen native children of the old
  // drawing therefore remain after the new live placeholder under any valid
  // merged topological order. Contracting the new node recovers every old edge.
  const ordered = after.runs.filter(run => run !== added), at = ordered.findIndex(run => coord(run) === coord(original));
  assert.ok(at > 0); ordered.splice(at, 0, added);
  edges.set(coord(added), [coord(original)]);
  const indexes = new Map(ordered.map((run, index) => [coord(run), index]));
  for (const run of ordered) run.sequence = edges.get(coord(run))!.map(child => { const index = indexes.get(child); assert.ok(index !== undefined); return index; });
  after.runs = ordered;

  assert.equal(after.text, before.text); assert.deepEqual(attributes(after), attributes(before), "Original attribute bytes changed");
  for (const field of ["rootSerializationVersion", "versionSerializationVersion", "minimumSupportedVersion"] as const) assert.equal(after[field], before[field], "Document version marker changed");
  assert.deepEqual(after.replicas.slice(0, before.replicas.length), before.replicas, "Original replica counters or identities changed");
  assert.ok(after.replicas.length === before.replicas.length + 1 && Buffer.from(after.replicas.at(-1)!.id).equals(actor), "Unexpected replacement lineage");
  assert.equal(after.runs.length, before.runs.length + 1); assert.equal(new Set(after.runs.map(coord)).size, after.runs.length);
  const newIndex = after.runs.indexOf(added);
  assert.deepEqual(added.sequence, [after.runs.findIndex(run => coord(run) === coord(original))]);
  assert.ok(after.runs.some(run => run !== added && run.sequence.includes(newIndex)), "Orphan replacement character");
  for (const previous of before.runs) {
    const current = after.runs.find(run => coord(run) === coord(previous))!;
    const { sequence: oldEdges, ...oldCore } = previous, { sequence: nextEdges, ...nextCore } = current;
    const { sequence: _, ...deletedCore } = deleted;
    assert.deepEqual(nextCore, previous === original ? deletedCore : oldCore, "Non-replaced physical atom changed");
    const contracted = nextEdges.flatMap(index => index === newIndex ? added.sequence : [index]);
    assert.deepEqual(contracted.map(index => coord(after.runs[index]!)), oldEdges.map(index => coord(before.runs[index]!)), "Replacement contraction changed original DAG");
  }
  const active = after.runs.filter(run => run.length && !run.tombstone);
  assert.deepEqual(active, [added], "Replacement must retain exactly one live drawing");
  const clock = after.replicas.at(-1)!;
  assert.ok(added.anchor.replica === after.replicas.length && added.anchor.clock === 0 && added.coord.clock === Math.max(...before.replicas.map(entry => entry.counters[0]!)) && clock.counters[0] === added.coord.clock + 1 && clock.counters[1]! > deleted.anchor.clock, "Replacement clocks do not cover generated history");
  validateDocumentInvariants(after); connected(after);
  const encoded = encodeNoteDocument(after); assert.ok(noteDocumentRoundTrips(encoded), "Replacement failed exact round-trip");
  const result = compressNoteDocument(encoded); assert.ok(!result.equals(compressed));
  return { compressed: result, summary: { strategy: "replace-drawing-v1", previousDocumentSha256: sha(compressed), documentSha256: sha(result), replicaIdSha256: sha(actor) } };
}
