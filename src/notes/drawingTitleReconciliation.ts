/** Metadata-only ongoing reconciliation. Cloud intent can settle while a
 * device remains offline; later normal sync cycles reassert due titles. No
 * native device is contacted and no all-device completion is claimed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import { captureDrawingSnapshot, inspectDrawingRecords, type DrawingCapture } from "./attachmentTitleCapture.js";
import { readAttachmentTitleFolders, readAttachmentTitleIntent, type LocalIntent } from "./attachmentTitleIntent.js";
import type { DrawingTitleIO } from "./drawingTitleCloud.js";
import { openDrawingTitleLedger, type DrawingTitleLeaseIntent, type DrawingTitleLeaseObservation, type DrawingTitleLeaseEntry } from "./drawingTitleLedger.js";

export interface DrawingTitleReconciliationConfig { journalDirectory: string; folderIds?: string[]; noteIds?: string[]; }
export type DrawingTitleLedger = Awaited<ReturnType<typeof openDrawingTitleLedger>>;
export interface DrawingReconciliationPorts { capture: typeof captureDrawingSnapshot; now(): number; }
export interface DrawingReconciliationRequest {
  vault: string; file: string; noteId: string; attachmentId: string; folderId: string;
  expectedNoteTag: string; io: DrawingTitleIO; ledger: DrawingTitleLedger; kind: "rename" | "refresh";
}
export class DrawingTitleReconciliationUnavailable extends Error {}
class DrawingTitleReconciliationConflict extends Error {}
export type DrawingReconciliationResult = { status: "active-native-unverified" | "not-due"; note: CloudKitRecord } | { status: "uncertain" | "cancelled" };
const defaults: DrawingReconciliationPorts = { capture: captureDrawingSnapshot, now: Date.now };
const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: unknown, right: unknown, reason: string) => { if (json(left) !== json(right)) throw new DrawingTitleReconciliationConflict(reason); };
export function drawingTitleInScope(config: DrawingTitleReconciliationConfig, noteId: string, folderId: string): boolean {
  return (!config.noteIds?.length || config.noteIds.some(id => sameId(id, noteId))) && (!config.folderIds?.length || config.folderIds.some(id => sameId(id, folderId)));
}
function title(record: CloudKitRecord, key: string): string {
  const field = record.fields[key]; if (field === undefined && key === "UserTitle") return "";
  assert.ok(field?.type === "ENCRYPTED_BYTES" && typeof field.value === "string", "Invalid drawing title encoding");
  const bytes = Buffer.from(field.value, "base64"), value = bytes.toString("utf8");
  assert.ok(bytes.toString("base64") === field.value && Buffer.from(value).equals(bytes), "Invalid drawing title bytes");
  return value;
}
function observe(local: LocalIntent, records: CloudKitRecord[], request: DrawingReconciliationRequest, folders: CloudKitRecord[]): DrawingTitleLeaseObservation {
  const captured = inspectDrawingRecords(records, request), note = captured.records[0]!, attachment = captured.records[1]!;
  const modificationDate = note.fields.ModificationDate;
  assert.ok(modificationDate?.type === "TIMESTAMP" && typeof modificationDate.value === "number" && Number.isSafeInteger(modificationDate.value) && modificationDate.value >= 0, "Invalid note modification date");
  return { file: local.file, fileSha256: local.fileSha256, localBodySha256: local.baseSha256,
    documentSha256: captured.documentSha256, assetRefsSha256: captured.assetRefsSha256,
    protectedSha256: sha(json([captured.protectedSha256, folders.map(({ recordChangeTag, modified, ...record }) => record)])), noteTag: note.recordChangeTag!, attachmentTag: attachment.recordChangeTag!,
    noteTitle: title(note, "TitleEncrypted"), attachmentTitle: title(attachment, "UserTitle"), modificationDate: modificationDate.value,
  };
}
function matchesIntent(entry: DrawingTitleLeaseEntry, local: LocalIntent) {
  return entry.intent.file === local.file && entry.intent.targetTitle === local.targetTitle && entry.intent.fileSha256 === local.fileSha256 && entry.intent.localBodySha256 === local.baseSha256;
}

/** Preparing performs reads only. Each dispatched metadata operation has its
 * own durable ledger token and fresh conditional record tag. */
export async function prepareDrawingTitleReconciliation(input: DrawingReconciliationRequest, overrides: Partial<DrawingReconciliationPorts> = {}) {
  const request = { ...input }, { io, ledger } = request, ports = { ...defaults, ...overrides };
  const scope = { noteId: request.noteId, attachmentId: request.attachmentId, folderId: request.folderId };
  const localOptions = { vault: request.vault, file: request.file, noteId: request.noteId, folderId: request.folderId };
  const assertWriter = ledger.writerGuard();
  let existing = await ledger.read(request.noteId);
  const cancelPlan = () => ({ localOnly: true, verifyLocalIntent: async () => {}, execute: async (): Promise<DrawingReconciliationResult> => {
    await assertWriter();
    if (existing) await ledger.cancel(request.noteId, { expectedRevision: existing.revision, reason: "Local or cloud drawing intent changed" });
    return { status: "cancelled" };
  } });
  const lookupIds = async (ids: string[]) => { try { return await io.lookup(ids); } catch { throw new DrawingTitleReconciliationUnavailable("Drawing title validation is temporarily unavailable"); } };
  const guardedIO = { ...io, lookup: lookupIds };
  const lookup = () => lookupIds([request.noteId, request.attachmentId]);
  const readLocal = async () => { try { return await readAttachmentTitleIntent(localOptions, { allowTracked: request.kind === "refresh" }); } catch { throw new DrawingTitleReconciliationConflict("Local drawing intent changed"); } };
  let local: LocalIntent, folders: CloudKitRecord[], initial: DrawingTitleLeaseObservation, initialRecords: CloudKitRecord[];
  try {
    local = await readLocal();
    if (io.accountDsidSha256 !== local.accountDsidSha256) throw new DrawingTitleReconciliationConflict("Drawing account changed");
    folders = await readAttachmentTitleFolders(local, guardedIO);
    initialRecords = await lookup();
    initial = observe(local, initialRecords, request, folders);
  } catch (error) { if (error instanceof DrawingTitleReconciliationUnavailable || !existing) throw error; return cancelPlan(); }
  const same = existing !== undefined && matchesIntent(existing, local);
  const pending = existing?.pending;
  const priorCloudEffect = !!(pending && initial.documentSha256 === existing!.intent.documentSha256 && initial.assetRefsSha256 === existing!.intent.assetRefsSha256 && initial.protectedSha256 === existing!.intent.protectedSha256 &&
    (pending.phase === "A" ? initial.attachmentTag !== pending.beforeTags.attachment && initial.noteTag === pending.beforeTags.note && initial.noteTitle === existing!.intent.initialNoteTitle && initial.attachmentTitle === existing!.intent.targetTitle && initial.modificationDate === existing!.intent.initialModificationDate
      : initial.noteTag !== pending.beforeTags.note && initial.attachmentTag === pending.beforeTags.attachment && initial.noteTitle === existing!.intent.targetTitle && initial.attachmentTitle === existing!.intent.targetTitle && initial.modificationDate === existing!.intent.noteModificationDate));
  if (!same && request.kind === "rename" && !priorCloudEffect) assert.equal(initial.noteTag, request.expectedNoteTag, "Changed remotely since the last pull");
  const initialDate = ports.now();
  if (!same) assert.ok(Number.isSafeInteger(initialDate) && initialDate > initial.modificationDate, "Local clock must advance past the note modification date before renaming");
  const intent: DrawingTitleLeaseIntent = same ? existing!.intent : {
    noteId: request.noteId, attachmentId: request.attachmentId, folderId: request.folderId, targetTitle: local.targetTitle,
    file: local.file, fileSha256: local.fileSha256, localBodySha256: local.baseSha256,
    documentSha256: initial.documentSha256, assetRefsSha256: initial.assetRefsSha256, protectedSha256: initial.protectedSha256,
    initialNoteTitle: initial.noteTitle, initialAttachmentTitle: initial.attachmentTitle,
    initialNoteTag: initial.noteTag, initialAttachmentTag: initial.attachmentTag,
    initialModificationDate: initial.modificationDate, noteModificationDate: initialDate,
  };
  async function checked() {
    await assertWriter();
    try { equal(await readAttachmentTitleFolders(local, guardedIO), folders, "Private folder state changed"); }
    catch (error) { if (error instanceof DrawingTitleReconciliationUnavailable) throw error; throw new DrawingTitleReconciliationConflict("Private folder state changed"); }
    const currentLocal = await readLocal(); equal(currentLocal, local, "Local drawing intent changed");
    const records = await lookup();
    // The local read follows network awaits immediately before dispatch.
    equal(await readLocal(), local, "Local drawing intent changed during lookup");
    try { return { records, observation: observe(currentLocal, records, request, folders) }; }
    catch { throw new DrawingTitleReconciliationConflict("Cloud drawing scope or content changed"); }
  }
  const localOnly = request.kind === "rename" && same && existing!.stage === "active" && !existing!.pending && (existing!.nextDue ?? 0) > ports.now();
  let completedObservation: DrawingTitleLeaseObservation | undefined;
  let executingEntry = existing;
  return { localOnly, verifyLocalIntent: async () => {
    const current = await checked(); assert.ok(completedObservation, "No completed metadata observation");
    equal(current.observation, completedObservation, "Cloud changed before local bookkeeping");
  }, execute: async (): Promise<DrawingReconciliationResult> => {
    try {
      let current = await checked();
      if (existing?.pending) existing = await ledger.resolvePending(request.noteId, { expectedRevision: existing.revision, observation: current.observation });
      executingEntry = existing;
      if (!existing || !same || existing.stage === "cancelled") {
        if (request.kind !== "rename") return { status: "cancelled" };
        if (existing?.pending) { await ledger.cancel(request.noteId, { expectedRevision: existing.revision, reason: "New local intent while a prior request remains uncertain" }); return { status: "uncertain" }; }
        existing = await ledger.register(intent, existing ? { expectedRevision: existing.revision } : {});
      }
      let entry = existing; executingEntry = entry;
      if (entry.stage === "cancelled") return { status: entry.pending ? "uncertain" : "cancelled" };
      let before: DrawingCapture | undefined;
      if (request.kind === "rename" && entry.stage !== "active") {
        before = await ports.capture(scope, lookup);
        equal(observe(local, before.records, request, folders), current.observation, "Drawing changed during initial capture");
      }
      for (let count = 0; count < 2; count++) {
        current = await checked();
        const claimed = await ledger.claim(request.noteId, { expectedRevision: entry.revision, observation: current.observation });
        entry = claimed.entry; executingEntry = entry;
        if (!claimed.dispatch) {
          if (entry.stage === "cancelled") return { status: "cancelled" };
          if (entry.pending) return { status: "uncertain" };
          completedObservation = current.observation;
          return { status: request.kind === "rename" && entry.stage === "active" ? "active-native-unverified" : "not-due", note: current.records.find(record => sameId(record.recordName, request.noteId))! };
        }
        const dispatch = claimed.dispatch;
        const note = current.records.find(record => sameId(record.recordName, request.noteId))!, attachment = current.records.find(record => sameId(record.recordName, request.attachmentId))!;
        const targeted = dispatch.phase === "A" ? attachment : note;
        assert.ok(sameId(targeted.recordName, dispatch.recordName), "Wrong metadata dispatch identity");
        const update: RecordUpdate = { recordName: targeted.recordName, recordType: dispatch.phase === "A" ? "Attachment" : "Note", recordChangeTag: dispatch.recordChangeTag,
          parentRecordName: dispatch.phase === "A" ? attachment.parentRecordName : note.parentRecordName,
          fields: dispatch.phase === "A" ? { UserTitle: { value: Buffer.from(dispatch.targetTitle).toString("base64") } } : { TitleEncrypted: { value: Buffer.from(dispatch.targetTitle).toString("base64") } },
        };
        if (dispatch.phase === "B") update.fields.ModificationDate = { value: dispatch.modificationDate };
        await ledger.withDispatch(request.noteId, { expectedRevision: entry.revision, token: dispatch.token }, async () => {
          const immediate = await checked(); equal(immediate.observation, current.observation, "Drawing changed after durable intent");
          assert.ok(entry.pending && ports.now() >= entry.pending.issuedAt && ports.now() - entry.pending.issuedAt < 300_000, "Metadata dispatch expired");
          await assertWriter();
          await io.update(update);
        });
        const after = await checked();
        if (dispatch.phase !== "A") {
          if (before) {
            try {
              const captured = await ports.capture(scope, lookup);
              equal({ document: captured.documentSha256, assets: captured.assets }, { document: before.documentSha256, assets: before.assets }, "Drawing bytes changed during metadata rename");
              equal(observe(local, captured.records, request, folders), after.observation, "Drawing changed after metadata write");
            } catch {
              await ledger.cancel(request.noteId, { expectedRevision: entry.revision, reason: "Metadata rename preservation check failed" });
              return { status: "cancelled" };
            }
          }
          const final = await checked(); equal(final.observation, after.observation, "Drawing changed before local settlement");
          entry = await ledger.acknowledge(request.noteId, { expectedRevision: entry.revision, token: dispatch.token, observation: final.observation });
          if (entry.stage === "cancelled") return { status: "cancelled" };
          executingEntry = entry;
          if (entry.stage !== "active" || entry.pending) return { status: "uncertain" };
          completedObservation = final.observation;
          return { status: "active-native-unverified", note: final.records.find(record => sameId(record.recordName, request.noteId))! };
        }
        entry = await ledger.acknowledge(request.noteId, { expectedRevision: entry.revision, token: dispatch.token, observation: after.observation }); executingEntry = entry;
        if (entry.stage === "cancelled") return { status: "cancelled" };
      }
      return { status: "uncertain" };
    } catch (error) {
      if (error instanceof DrawingTitleReconciliationConflict && executingEntry) {
        try { await ledger.cancel(request.noteId, { expectedRevision: executingEntry.revision, reason: "Local or cloud drawing intent changed" }); } catch { /* Concurrent ownership stays unresolved. */ }
        return { status: "cancelled" };
      }
      // Pending tokens remain durable; later fresh observations may establish a
      // postcondition, but an uncertain SDK request is never called an ACK.
      return { status: "uncertain" };
    }
  } };
}
