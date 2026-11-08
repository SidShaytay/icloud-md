import assert from "node:assert/strict";
import { test } from "node:test";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { buildInitialNoteDocument, encodeNoteDocument } from "../src/notes/noteDocument.js";
import { AttachmentInfoSchema, CharIDSchema, StringSchema, SubstringSchema, VectorTimestamp_ClockSchema, VectorTimestamp_Clock_ReplicaClockSchema, AttributeRunSchema } from "../src/notes/gen/topotext_pb.js";
import { DocumentSchema } from "../src/notes/gen/versioned_document_pb.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";
import { buildAttachmentRankRepair } from "./attachmentRankRepair.js";
const operation = "a".repeat(64);
function actor() { const id = createHash("sha256").update("icloud-md/trailing-tombstone-v1\0").update(operation).digest().subarray(0, 16); id[6] = (id[6]! & 15) | 64; id[8] = (id[8]! & 63) | 128; return id; }
const hex = (id: Uint8Array) => Buffer.from(id).toString("hex");
function unpack(bytes: Uint8Array) { const root = fromBinary(DocumentSchema, decompressNoteDocument(Buffer.from(bytes))); return { root, str: fromBinary(StringSchema, root.version[0]!.data) }; }
function pack(value: ReturnType<typeof unpack>) { value.root.version[0]!.data = toBinary(StringSchema, value.str); return compressNoteDocument(toBinary(DocumentSchema, value.root)); }
function fixture() {
    const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(0xfe));
    doc.runs[1]!.anchor.clock = 1;
    doc.replicas[0]!.counters = [1, 2];
    doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { typeUTI: "com.apple.paper", attachmentIdentifier: "11111111-1111-4111-8111-111111111111" });
    const original = compressNoteDocument(encodeNoteDocument(doc)), bad = unpack(original), last = clone(SubstringSchema, bad.str.substring[2]!);
    bad.str.substring[1]!.child = [2];
    bad.str.substring = [bad.str.substring[0]!, bad.str.substring[1]!, create(SubstringSchema, { charID: create(CharIDSchema, { replicaID: 2, clock: 1 }), length: 1, timestamp: create(CharIDSchema, { replicaID: 2, clock: 8 }), tombstone: 1, child: [3] }), last];
    bad.str.timestamp!.clock.push(create(VectorTimestamp_ClockSchema, { replicaUUID: actor(), replicaClock: [2, 9].map(clock => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock })) }));
    return { original, bad: pack(bad) };
}
// Independent of the domain codec: Apple interprets both CharID fields by raw
// UUID byte rank, even when timestamp rows remain in append order.
function identities(bytes: Uint8Array) {
    const { str } = unpack(bytes), ids = str.timestamp!.clock.map(row => row.replicaUUID).sort(Buffer.compare), uuid = (rank: number) => rank === 0 ? "zero" : hex(ids[rank - 1]!);
    const atoms = str.substring.map(run => ({ id: uuid(run.charID!.replicaID), clock: run.charID!.clock, length: run.length, anchor: uuid(run.timestamp!.replicaID), style: run.timestamp!.clock, dead: run.tombstone === 1, children: [] as string[] }));
    atoms.forEach((atom, i) => { atom.children = str.substring[i]!.child.map(index => `${atoms[index]!.id}:${atoms[index]!.clock}`); });
    return { atoms, str, rows: str.timestamp!.clock.map(row => ({ id: hex(row.replicaUUID), clocks: row.replicaClock.map(clock => clock.clock) })) };
}
test("forward repair targets only the unintended physical UUID and retains original drawing plus bad history", () => {
    const { original, bad } = fixture(), source = identities(original), broken = identities(bad), result = buildAttachmentRankRepair(original, bad, operation), fixed = identities(result.compressed);
    assert.notEqual(broken.atoms[1]!.id, source.atoms[1]!.id, "fixture independently reproduces actual identity reassignment");
    assert.equal(fixed.atoms.length, 5);
    assert.equal(fixed.rows.length, 2);
    assert.deepEqual(fixed.atoms.find(a => a.id === source.atoms[1]!.id && a.clock === 0), source.atoms[1]);
    assert.deepEqual(fixed.atoms.find(a => a.id === broken.atoms[2]!.id && a.clock === 1), broken.atoms[2]);
    assert.deepEqual(fixed.atoms.find(a => a.id === hex(actor()) && a.clock === 0), { ...broken.atoms[1], dead: true, style: 9 });
    assert.deepEqual(fixed.atoms.filter(a => a.length && !a.dead), [source.atoms[1]]);
    assert.deepEqual(fixed.atoms[0]!.children, [`${hex(actor())}:0`, `${source.atoms[1]!.id}:0`]);
    assert.deepEqual(fixed.rows.find(r => r.id === source.atoms[1]!.id)!.clocks, [2, 9]);
    assert.deepEqual(fixed.rows.find(r => r.id === hex(actor()))!.clocks, [2, 10]);
    assert.equal(fixed.str.string, "\uFFFC");
    assert.deepEqual(fixed.str.attributeRun.map(a => toBinary(AttributeRunSchema, a)), source.str.attributeRun.map(a => toBinary(AttributeRunSchema, a)));
    assert.deepEqual(buildAttachmentRankRepair(original, bad, operation), result, "deterministic preview/apply payload");
    assert.equal(result.summary.deletionStyleClock, 9);
    assert.equal(result.summary.retainedPhantomTombstones, 1);
});
for (const field of ["clock", "style", "edge", "counter", "attribute", "text", "extra-atom", "unknown"] as const)
    test(`refuses altered ${field} instead of general normalization`, () => {
        const { original, bad } = fixture(), changed = unpack(bad);
        switch (field) {
            case "clock":
                changed.str.substring[2]!.charID!.clock = 2;
                break;
            case "style":
                changed.str.substring[2]!.timestamp!.clock = 7;
                break;
            case "edge":
                changed.str.substring[1]!.child = [3];
                break;
            case "counter":
                changed.str.timestamp!.clock[0]!.replicaClock[0]!.clock = 2;
                break;
            case "attribute":
                changed.str.attributeRun[0]!.fontHints = 2;
                break;
            case "text":
                changed.str.string = "x";
                break;
            case "extra-atom":
                changed.str.substring.push(clone(SubstringSchema, changed.str.substring[3]!));
                break;
            case "unknown":
                changed.str.$unknown = [{ no: 30, wireType: 0, data: Uint8Array.of(1) }];
                break;
        }
        assert.throws(() => buildAttachmentRankRepair(original, pack(changed), operation));
    });
test("refuses unrelated operation and already repaired document", () => {
    const { original, bad } = fixture();
    assert.throws(() => buildAttachmentRankRepair(original, bad, "b".repeat(64)));
    assert.throws(() => buildAttachmentRankRepair(original, bad, "bad"));
    const result = buildAttachmentRankRepair(original, bad, operation);
    assert.throws(() => buildAttachmentRankRepair(original, result.compressed, operation));
});
test("refuses original clock changes even when repeated in bad payload", () => {
    const { original, bad } = fixture(), old = unpack(original), broken = unpack(bad);
    old.str.timestamp!.clock[0]!.replicaClock[1]!.clock = 3;
    broken.str.timestamp!.clock[0]!.replicaClock[1]!.clock = 3;
    assert.throws(() => buildAttachmentRankRepair(pack(old), pack(broken), operation));
});

test("refuses unknown original fields even if copied into the known bad envelope", () => {
    const { original, bad } = fixture(), old = unpack(original), broken = unpack(bad);
    old.str.$unknown = [{ no: 30, wireType: 0, data: Uint8Array.of(1) }];
    broken.str.$unknown = [{ no: 30, wireType: 0, data: Uint8Array.of(1) }];
    assert.throws(() => buildAttachmentRankRepair(pack(old), pack(broken), operation));
});
test("refuses compressed and inflated size overflow before interpreting a repair", () => {
    const { original, bad } = fixture();
    assert.throws(() => buildAttachmentRankRepair(new Uint8Array(1024 * 1024 + 1), bad, operation));
    assert.throws(() => buildAttachmentRankRepair(compressNoteDocument(new Uint8Array(1024 * 1024 + 1)), bad, operation));
    assert.throws(() => buildAttachmentRankRepair(original, new Uint8Array(), operation));
});
