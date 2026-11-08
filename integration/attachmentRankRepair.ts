/** Pure, integration-only forward repair for the precise lower-UUID rank failure.
 * Inputs are the immutable pre-experiment CloudKit document, its exact known bad
 * submission, and the operation identity that derived the experiment's replica.
 * No native cache, network access, old-record restore, or generic repair mode.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { isNoteId } from '../src/notes/noteIdFrontmatter.js';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { StringSchema, CharIDSchema, SubstringSchema, VectorTimestampSchema, VectorTimestamp_ClockSchema, VectorTimestamp_Clock_ReplicaClockSchema, AttributeRunSchema } from '../src/notes/gen/topotext_pb.js';
import { DocumentSchema } from '../src/notes/gen/versioned_document_pb.js';
import { compressNoteDocument } from '../src/notes/noteText.js';
import { parseNoteDocument, noteDocumentRoundTrips, validateDocumentInvariants } from '../src/notes/noteDocument.js';
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const ZERO = 'pseudo', END = 0xffffffff;
type Atom = {
    id: string;
    clock: number;
    length: number;
    anchorId: string;
    anchorClock: number;
    dead: boolean;
    children: string[];
};
const key = (a: Pick<Atom, 'id' | 'clock'>) => `${a.id}:${a.clock}`;
function decode(compressed: Uint8Array) {
    assert.ok(compressed.length > 0 && compressed.length <= 1024 * 1024, 'Unsupported compressed size');
    const bytes = Buffer.from(compressed);
    const raw = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync : inflateSync)(bytes, { maxOutputLength: 1024 * 1024 });
    const wrapper = fromBinary(DocumentSchema, raw);
    assert.equal(wrapper.version.length, 1);
    assert.deepEqual(Buffer.from(toBinary(DocumentSchema, wrapper)), raw, 'Unsupported root wire representation');
    const str = fromBinary(StringSchema, wrapper.version[0]!.data);
    assert.deepEqual(Buffer.from(toBinary(StringSchema, str)), Buffer.from(wrapper.version[0]!.data), 'Unsupported string wire representation');
    const rows = str.timestamp!.clock.map(r => ({ id: Buffer.from(r.replicaUUID).toString('hex'), clocks: r.replicaClock.map(c => c.clock) }));
    assert(rows.every(r => r.id.length === 32 && r.clocks.length === 2));
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
    const sorted = rows.map(r => r.id).sort((a, b) => Buffer.compare(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')));
    const uuid = (rank: number) => rank === 0 ? ZERO : sorted[rank - 1]!;
    const atoms = str.substring.map(r => ({ id: uuid(r.charID!.replicaID), clock: r.charID!.clock, length: r.length, anchorId: uuid(r.timestamp!.replicaID), anchorClock: r.timestamp!.clock, dead: r.tombstone === 1, children: [] as string[] }));
    atoms.forEach((a, i) => { a.children = str.substring[i]!.child.map(index => key(atoms[index]!)); });
    return { wrapper, str, rows, atoms, raw };
}
// Inputs are exclusively the original CloudKit document and the known submitted
// bad document, with the owned offending replica bound by the trial's digest.
export function buildAttachmentRankRepair(originalBytes: Uint8Array, badBytes: Uint8Array, operationIdentity: string) {
    assert.ok(/^[a-f0-9]{64}$/.test(operationIdentity), 'Invalid operation identity');
    const replica = createHash('sha256').update('icloud-md/trailing-tombstone-v1\0').update(operationIdentity).digest().subarray(0, 16);
    replica[6] = (replica[6]! & 15) | 64;
    replica[8] = (replica[8]! & 63) | 128;
    const ownedReplicaHash = sha(replica);
    const original = decode(originalBytes), bad = decode(badBytes);
    assert.equal(original.str.string, '\uFFFC');
    assert.equal(bad.str.string, '\uFFFC');
    assert.equal(original.atoms.length, 3);
    assert.equal(original.rows.length, 1);
    assert.equal(bad.atoms.length, 4);
    assert.equal(bad.rows.length, 2);
    assert.deepEqual(bad.str.attributeRun.map(a => toBinary(AttributeRunSchema, a)), original.str.attributeRun.map(a => toBinary(AttributeRunSchema, a)));
    assert.ok(noteDocumentRoundTrips(original.raw), 'Original document is not fully understood');
    validateDocumentInvariants(parseNoteDocument(original.raw));
    assert.deepEqual(original.rows[0]!.clocks, [1, 2], 'Unexpected original clocks');
    assert.ok(original.str.attributeRun.length === 1 && original.str.attributeRun[0]!.length === 1 && original.str.attributeRun[0]!.attachmentInfo?.typeUTI === 'com.apple.paper' && isNoteId(original.str.attributeRun[0]!.attachmentInfo!.attachmentIdentifier ?? ''), 'Unsupported original drawing');
    const good = original.atoms[1]!, wrong = bad.atoms[1]!, phantom = bad.atoms[2]!;
    assert.equal(good.id, original.rows[0]!.id);
    assert.equal(good.clock, 0);
    assert.equal(good.length, 1);
    assert.equal(good.dead, false);
    assert.equal(good.anchorId, good.id);
    assert.equal(good.anchorClock, 1);
    assert.equal(sha(Buffer.from(wrong.id, 'hex')), ownedReplicaHash);
    assert.notEqual(wrong.id, good.id);
    assert.equal(wrong.clock, 0);
    assert.equal(wrong.length, 1);
    assert.equal(wrong.dead, false);
    assert.equal(wrong.anchorId, wrong.id);
    assert.equal(wrong.anchorClock, 1);
    assert.equal(phantom.id, good.id);
    assert.equal(phantom.clock, 1);
    assert.equal(phantom.length, 1);
    assert.equal(phantom.dead, true);
    assert.equal(phantom.anchorId, good.id);
    assert.equal(phantom.anchorClock, 8);
    const root = original.atoms[0]!, end = original.atoms[2]!;
    assert.equal(key(root), `${ZERO}:0`);
    assert.equal(key(end), `${ZERO}:${END}`);
    assert.deepEqual(root, { id: ZERO, clock: 0, length: 0, anchorId: ZERO, anchorClock: 0, dead: false, children: [key(good)] });
    assert.deepEqual(end, { id: ZERO, clock: END, length: 0, anchorId: ZERO, anchorClock: END, dead: false, children: [] });
    assert.deepEqual(bad.atoms[0], { ...root, children: [key(wrong)] });
    assert.deepEqual(bad.atoms[3], end);
    assert.deepEqual(good.children, [key(end)]);
    assert.deepEqual(wrong.children, [key(phantom)]);
    assert.deepEqual(phantom.children, [key(end)]);
    // Reconstruct the exact known erroneous submission from the verified original.
    // This refuses arbitrary malformed inputs, unknown fields and normalized variants;
    // the general parser's clock checks remain unchanged.
    const expected = clone(StringSchema, original.str);
    const last = clone(SubstringSchema, expected.substring[2]!);
    expected.substring[1]!.child = [2];
    expected.substring = [expected.substring[0]!, expected.substring[1]!, create(SubstringSchema, {
            charID: create(CharIDSchema, { replicaID: 2, clock: 1 }), length: 1,
            timestamp: create(CharIDSchema, { replicaID: 2, clock: 8 }), tombstone: 1, child: [3]
        }), last];
    expected.timestamp!.clock.push(create(VectorTimestamp_ClockSchema, { replicaUUID: replica, replicaClock: [2, 9].map(clock => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock })) }));
    const expectedWrapper = clone(DocumentSchema, original.wrapper);
    expectedWrapper.version[0]!.data = toBinary(StringSchema, expected);
    assert.deepEqual(Buffer.from(toBinary(DocumentSchema, expectedWrapper)), bad.raw, 'Not the exact known bad submission');
    const rows = new Map<string, number[]>();
    for (const r of [...original.rows, ...bad.rows]) {
        const old = rows.get(r.id) ?? [0, 0];
        rows.set(r.id, old.map((v, i) => Math.max(v, r.clocks[i]!)));
    }
    // Both root branches are retained. The original branch also leaves unseen
    // native descendants free to merge; it is never replaced by the duplicate.
    const union = [
        { ...root, children: [key(wrong), key(good)] },
        { ...wrong, children: [...wrong.children] },
        { ...phantom, children: [...phantom.children] },
        { ...good, children: [...good.children] },
        { ...end },
    ];
    // Normalize only proven per-UUID lower bounds, just as native persistence does.
    for (const atom of union) {
        if (atom.id !== ZERO)
            rows.get(atom.id)![0] = Math.max(rows.get(atom.id)![0]!, atom.clock + atom.length);
        if (atom.anchorId !== ZERO)
            rows.get(atom.anchorId)![1] = Math.max(rows.get(atom.anchorId)![1]!, atom.anchorClock + 1);
    }
    const actor = wrong.id, styleFloor = Math.max(...[...rows.values()].map(c => c[1]!));
    // Apple's deletion bias is eight style ticks. The next owned style clock
    // is already nine; stamping only this actor's coordinate at nine dominates
    // its previous live style without touching the original drawing's style.
    const deletionClock = Math.max(wrong.anchorClock + 8, styleFloor);
    union[1]!.dead = true;
    union[1]!.anchorId = actor;
    union[1]!.anchorClock = deletionClock;
    rows.get(actor)![1] = deletionClock + 1;
    assert.deepEqual(rows.get(good.id), [2, 9]);
    assert.deepEqual(rows.get(actor), [2, 10]);
    assert.equal(deletionClock, 9);
    const ids = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))), rank = (id: string) => id === ZERO ? 0 : ids.indexOf(id) + 1;
    const index = new Map(union.map((a, i) => [key(a), i]));
    const str = clone(StringSchema, original.str);
    str.string = original.str.string;
    str.attributeRun = original.str.attributeRun;
    str.timestamp = create(VectorTimestampSchema, { clock: ids.map(id => create(VectorTimestamp_ClockSchema, { replicaUUID: Buffer.from(id, 'hex'), replicaClock: rows.get(id)!.map(clock => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock })) })) });
    str.substring = union.map(a => create(SubstringSchema, { charID: create(CharIDSchema, { replicaID: rank(a.id), clock: a.clock }), length: a.length, timestamp: create(CharIDSchema, { replicaID: rank(a.anchorId), clock: a.anchorClock }), ...(a.dead ? { tombstone: 1 } : {}), child: a.children.map(k => index.get(k)!) }));
    const wrapper = clone(DocumentSchema, original.wrapper);
    wrapper.version[0]!.data = toBinary(StringSchema, str);
    const raw = toBinary(DocumentSchema, wrapper), compressed = compressNoteDocument(raw);
    assert(noteDocumentRoundTrips(raw));
    validateDocumentInvariants(parseNoteDocument(raw));
    const out = decode(compressed);
    assert.equal(out.str.string, '\uFFFC');
    assert.equal(out.atoms.filter(a => a.length && !a.dead).length, 1);
    assert.equal(out.atoms.find(a => a.length && !a.dead)!.id, good.id);
    assert.deepEqual(out.atoms.find(a => a.id === good.id && a.clock === 0), good);
    assert.deepEqual(out.atoms.find(a => a.id === phantom.id && a.clock === 1), phantom);
    assert.deepEqual(out.atoms.find(a => a.id === wrong.id && a.clock === 0), { ...wrong, dead: true, anchorId: actor, anchorClock: 9 });
    return { compressed, summary: { originalSha256: sha(originalBytes), badSha256: sha(badBytes), repairedSha256: sha(compressed), repairActorSha256: ownedReplicaHash, targetCoordinateClock: 0 as const, deletionStyleClock: deletionClock, retainedOriginalDrawings: 1 as const, retainedPhantomTombstones: 1 as const } };
}
