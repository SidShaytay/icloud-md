/** Experimental CloudKit-only title phases. Not imported by the shipped CLI.
 * A cloud readback is not proof that native note lists have refreshed.
 * Before live use, the caller must independently verify private-note scope,
 * capture asset bytes, preserve the unchanged local rename intent and exclude
 * competing sync writers. This helper checks supplied records/document bytes
 * and asset references; it does not inspect local files or download assets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdate } from "../src/cloudkit/databaseClient.js";
import { classifyNoteRecord, storesTextAsAsset } from "../src/notes/decodeNoteRecord.js";
import { isNoteId } from "../src/notes/noteIdFrontmatter.js";
import { titleIsRepresentable } from "../src/notes/titleFilename.js";
import type { HarnessAccount } from "./harnessAccount.js";
import { createProbeJournal, privateProbeDirectory, readProbeJournal } from "./attachmentTitleProbeJournal.js";

interface ProbeScope { noteId: string; attachmentId: string; folderId: string; accountDsidSha256: string; }
export type TitleProbePhase = "A" | "B" | "BA";
export interface TitleProbeRequest {
  scope: ProbeScope;
  /** Original snapshots before either phase; keep the same baseline for B. */
  baseline: CloudKitRecord[];
  /** Independently captured current versions, explicitly reviewed for this phase. */
  expected: CloudKitRecord[];
  phase: TitleProbePhase;
  targetTitle: string;
  modificationDate: number;
  journalDirectory: string;
}
export interface TitleProbeIO {
  accountDsidSha256: string;
  lookup(ids: string[]): Promise<CloudKitRecord[]>;
  update(update: RecordUpdate): Promise<void>;
  updateBatch(updates: RecordUpdate[]): Promise<void>;
}
interface ProbeResult {
  status: "preview" | "cloud-applied-native-unverified" | "already-recorded-native-unverified" | "ambiguous";
  phase: TitleProbePhase;
  operationId: string;
  fields: string[];
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameId = (a: unknown, b: string) => typeof a === "string" && a.toUpperCase() === b.toUpperCase();
const reference = (record: CloudKitRecord, key: string) => (record.fields[key]?.value as { recordName?: unknown } | undefined)?.recordName;
const title = (record: CloudKitRecord, key: string) => record.fields[key]?.value;

/** Normalize key order and expiring asset URLs, never checksum/reference identity. */
function stable(value: unknown, asset = false): unknown {
  if (Array.isArray(value)) return value.map(item => stable(item, asset));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => item !== undefined && !(asset && key === "downloadURL"))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, asset)]));
  return value;
}
function snapshot(records: CloudKitRecord[], preserveOnly = false): string {
  return JSON.stringify(records.map(record => {
    const fields = Object.fromEntries(Object.entries(record.fields).filter(([key]) => !preserveOnly || !(record.recordType === "Note" ? ["TitleEncrypted", "ModificationDate"] : ["UserTitle"]).includes(key))
      .map(([key, field]) => [key, { ...field, value: stable(field.value, field.type === "ASSETID" || field.type === "ASSETID_LIST") }]));
    const { recordChangeTag, modified, ...persistent } = record;
    return stable({ ...persistent, fields, ...(!preserveOnly ? { recordChangeTag, modified } : {}) });
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function checkedScope(records: CloudKitRecord[], scope: ProbeScope) {
  assert.ok([scope.noteId, scope.attachmentId, scope.folderId].every(isNoteId) && /^[a-f0-9]{64}$/.test(scope.accountDsidSha256), "Invalid probe identity");
  assert.ok(records.length === 2, "Expected exactly one note and drawing");
  const note = records.find(record => sameId(record.recordName, scope.noteId));
  const attachment = records.find(record => sameId(record.recordName, scope.attachmentId));
  assert.ok(note && attachment && note !== attachment && note.recordType === "Note" && attachment.recordType === "Attachment", "Wrong probe record identity");
  assert.ok(records.every(record => record.recordChangeTag && !record.deleted && record.fields.Deleted?.value === 0 && !record.shareRecordName), "Deleted, shared or unversioned record");
  assert.ok(sameId(reference(note, "Folder"), scope.folderId) && sameId(note.parentRecordName, scope.folderId), "Wrong note folder");
  assert.ok(sameId(reference(attachment, "Note"), scope.noteId) && sameId(attachment.parentRecordName, scope.noteId), "Wrong drawing owner");
  assert.ok(attachment.fields.UTI?.value === "com.apple.paper" && !storesTextAsAsset(note), "Unsupported drawing type");
  const decoded = classifyNoteRecord(note, { titleMode: "filename" });
  assert.ok(decoded.status === "ok" && decoded.publishable && decoded.titleInMetadata && decoded.bodyText.replace(/\uFFFC/g, "").trim() === "" && (decoded.bodyText.match(/\uFFFC/g) ?? []).length === 1 && decoded.attachments.length === 1 && sameId(decoded.attachments[0]!.attachmentIdentifier, scope.attachmentId), "Expected exactly one drawing and no prose");
  return { note, attachment };
}
function tags(records: CloudKitRecord[]) {
  return Object.fromEntries(records.map(record => [record.recordName, record.recordChangeTag]));
}

/** B or BA is a separate invocation using only Linux journals and current CloudKit
 * state. Neither phase calls or waits for any native device. Live use requires
 * a separately approved experiment; an acknowledged phase is never replayed.
 * BA tests native-shaped Note-before-Attachment order in one atomic request;
 * server write order does not guarantee a device's import callback order. */
export async function runAttachmentTitleProbe(request: TitleProbeRequest, options: { apply?: boolean } = {}, io?: TitleProbeIO): Promise<ProbeResult> {
  // Detach caller objects before any await; later mutation cannot change intent.
  const r = structuredClone(request);
  assert.ok(r.phase === "A" || r.phase === "B" || r.phase === "BA", "Invalid probe phase");
  assert.ok(r.targetTitle && titleIsRepresentable(r.targetTitle) && !/[\r\n\0]/.test(r.targetTitle), "Unsupported filename title");
  assert.ok(Number.isSafeInteger(r.modificationDate) && r.modificationDate > 0 && path.isAbsolute(r.journalDirectory), "Invalid probe journal/date");
  const baseline = checkedScope(r.baseline, r.scope), expected = checkedScope(r.expected, r.scope);
  assert.ok(snapshot(r.baseline, true) === snapshot(r.expected, true), "Document, drawing, assets or relationships changed");
  const encoded = Buffer.from(r.targetTitle).toString("base64");
  assert.ok(typeof title(baseline.note, "TitleEncrypted") === "string" && title(baseline.note, "TitleEncrypted") !== encoded, "Baseline already has this note title");
  if (r.phase === "A") assert.ok(snapshot(r.baseline) === snapshot(r.expected), "Phase A baseline changed");
  else assert.ok(title(expected.attachment, "UserTitle") === encoded && title(expected.note, "TitleEncrypted") === title(baseline.note, "TitleEncrypted"), "Terminal phase title baseline changed");
  const record = r.phase === "A" ? expected.attachment : expected.note;
  const update: RecordUpdate = { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag!, parentRecordName: record.parentRecordName,
    fields: r.phase === "A" ? { UserTitle: { value: encoded } } : { TitleEncrypted: { value: encoded }, ModificationDate: { value: r.modificationDate } } };
  const updates = r.phase === "BA" ? [update, { recordName: expected.attachment.recordName, recordType: "Attachment", recordChangeTag: expected.attachment.recordChangeTag!, parentRecordName: expected.attachment.parentRecordName, fields: { UserTitle: { value: encoded } } }] : [update];
  const operationId = sha256(JSON.stringify([stable(r.scope), snapshot(r.baseline), r.targetTitle]));
  const base = { phase: r.phase, operationId, fields: r.phase === "BA" ? updates.flatMap(item => Object.keys(item.fields).map(key => `${item.recordType}.${key}`)) : Object.keys(update.fields) };
  if (options.apply !== true) return { ...base, status: "preview" };
  assert.ok(io && io.accountDsidSha256 === r.scope.accountDsidSha256, "Wrong probe account");
  const directory = path.join(r.journalDirectory, operationId);
  const marker = path.join(directory, `${r.phase}.intent.json`), ack = path.join(directory, `${r.phase}.ack.json`);
  const identity = JSON.stringify({ operationId, phase: r.phase, ...(r.phase === "BA" ? { updates } : { update }) });
  const previous = await readProbeJournal(marker), acknowledged = await readProbeJournal(ack);
  if (previous !== undefined || acknowledged !== undefined) {
    let matches = false;
    try { matches = previous === identity && acknowledged !== undefined && JSON.parse(acknowledged).identity === identity; } catch { /* A corrupt journal is never replayed. */ }
    return { ...base, status: matches ? "already-recorded-native-unverified" : "ambiguous" };
  }
  if (r.phase !== "A") {
    const alternate = r.phase === "B" ? "BA" : "B";
    const terminal = await readProbeJournal(path.join(directory, "terminal.intent.json"));
    // A crash may leave the shared claim without its phase-specific marker.
    if (terminal === identity) return { ...base, status: "ambiguous" };
    assert.ok(terminal === undefined && await readProbeJournal(path.join(directory, `${alternate}.intent.json`)) === undefined && await readProbeJournal(path.join(directory, `${alternate}.ack.json`)) === undefined, "Another terminal phase exists; never retry through an alternate");
    const a = await readProbeJournal(path.join(directory, "A.ack.json"));
    const aIntent = await readProbeJournal(path.join(directory, "A.intent.json"));
    assert.ok(a && aIntent, "Phase B requires this operation's A acknowledgement");
    let observed: { operationId?: unknown; identity?: unknown; tags?: unknown };
    try { observed = JSON.parse(a); } catch { throw Error("Invalid A acknowledgement"); }
    assert.ok(observed.operationId === operationId && observed.identity === aIntent && JSON.stringify(stable(observed.tags)) === JSON.stringify(stable(tags(r.expected))), "A acknowledgement does not match current versions");
  }
  async function inspectExpected() {
    const current = await io!.lookup([r.scope.noteId, r.scope.attachmentId]);
    checkedScope(current, r.scope);
    assert.ok(JSON.stringify(stable(tags(current))) === JSON.stringify(stable(tags(r.expected))), "Cloud record version changed");
    assert.ok(snapshot(current) === snapshot(r.expected), "Cloud records changed");
  }
  await inspectExpected();
  try {
    await privateProbeDirectory(r.journalDirectory);
    await privateProbeDirectory(directory);
    // One exclusive durable choice also excludes simultaneous B versus BA.
    if (r.phase !== "A") await createProbeJournal(path.join(directory, "terminal.intent.json"), identity);
    await createProbeJournal(marker, identity);
    await inspectExpected();
    if (r.phase === "BA") await io.updateBatch(updates); else await io.update(update);
    const after = await io.lookup([r.scope.noteId, r.scope.attachmentId]);
    const checked = checkedScope(after, r.scope);
    assert.ok(snapshot(after, true) === snapshot(r.baseline, true), "Post-write preservation failure");
    if (r.phase === "BA") {
      assert.ok(checked.attachment.recordChangeTag !== expected.attachment.recordChangeTag && checked.attachment.fields.UserTitle?.type === "ENCRYPTED_BYTES" && title(checked.attachment, "UserTitle") === encoded, "Batch attachment event not observed");
    } else {
      const untouched = r.phase === "A" ? checked.note : checked.attachment;
      const oldUntouched = r.phase === "A" ? expected.note : expected.attachment;
      assert.ok(snapshot([untouched]) === snapshot([oldUntouched]), "Untargeted record changed");
    }
    const targeted = r.phase === "A" ? checked.attachment : checked.note;
    const titleKey = r.phase === "A" ? "UserTitle" : "TitleEncrypted";
    assert.ok(targeted.recordChangeTag !== record.recordChangeTag, "New cloud version not observed");
    assert.ok(title(targeted, titleKey) === encoded && targeted.fields[titleKey]?.type === "ENCRYPTED_BYTES", "Cloud title not observed");
    if (r.phase !== "A") assert.ok(checked.note.fields.ModificationDate?.value === r.modificationDate, "Note event not observed");
    await createProbeJournal(ack, JSON.stringify({ operationId, identity, tags: tags(after) }));
    return { ...base, status: "cloud-applied-native-unverified" };
  } catch {
    // The intent may exist even when dispatch did not occur. Never retry or rollback.
    return { ...base, status: "ambiguous" };
  }
}

/** Uses the existing private-zone SDK; no native APIs, asset uploads or retries. */
export function createAttachmentTitleProbeIO(account: HarnessAccount): TitleProbeIO {
  assert.ok(account.zone.database === "private", "Shared zones are unsupported");
  const { session, ckdatabasewsUrl, dsid } = account;
  const zoneID = structuredClone(account.zone.zoneID);
  return {
    accountDsidSha256: sha256(dsid),
    lookup: ids => lookupRecords(session, ckdatabasewsUrl, dsid, "private", zoneID, ids),
    update: async update => {
      const result = await updateRecords(session, ckdatabasewsUrl, dsid, "private", zoneID, [update], { redirect: "error", signal: AbortSignal.timeout(30_000) });
      assert.ok(result.length === 1 && result[0]!.ok && result[0]!.record.recordName === update.recordName && result[0]!.record.recordType === update.recordType, "Cloud update was rejected or unclear");
    },
    updateBatch: async updates => {
      assert.ok(updates.length === 2 && updates[0]!.recordType === "Note" && updates[1]!.recordType === "Attachment" && updates[0]!.recordName !== updates[1]!.recordName, "Expected one Note-before-Attachment batch");
      const result = await updateRecords(session, ckdatabasewsUrl, dsid, "private", zoneID, updates, { atomic: true, redirect: "error", signal: AbortSignal.timeout(30_000) });
      assert.ok(result.length === updates.length && updates.every(update => result.some(entry => entry.ok && entry.record.recordName === update.recordName && entry.record.recordType === update.recordType)), "Cloud batch was rejected or unclear");
    },
  };
}
