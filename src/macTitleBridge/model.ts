import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import type { CloneState } from "../notes/cloneState.js";
import { classifyNoteRecord, storesTextAsAsset } from "../notes/decodeNoteRecord.js";
import type { SerializedPlanEntry } from "../notes/pushPlan.js";
import { titleFromNoteFileName } from "../notes/noteTitleParagraph.js";
import { titleIsRepresentable } from "../notes/titleFilename.js";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export interface DrawingScope { noteId: string; attachmentId: string; folderId: string; }
export const encryptedTitle = (record: CloudKitRecord, key: string): string => {
  const value = record.fields[key]?.value;
  assert.equal(typeof value, "string", `Missing ${key}`);
  return Buffer.from(value as string, "base64").toString("utf8");
};
const sameId = (a: unknown, b: string): boolean => typeof a === "string" && a.toUpperCase() === b.toUpperCase();
const reference = (record: CloudKitRecord, key: string): unknown => (record.fields[key]?.value as {recordName?: string} | undefined)?.recordName;

/** Deliberately narrower than ordinary push: one drawing, no prose or heading. */
export function drawingScope(records: CloudKitRecord[], scope: DrawingScope): { note: CloudKitRecord; attachment: CloudKitRecord } {
  assert.equal(records.length, 2, "Expected exactly the note and drawing");
  const note = records.find(r => sameId(r.recordName, scope.noteId));
  const attachment = records.find(r => sameId(r.recordName, scope.attachmentId));
  assert.ok(note && attachment && note !== attachment, "Wrong record identity");
  assert.equal(note.recordType, "Note"); assert.equal(attachment.recordType, "Attachment");
  for (const record of records) assert.ok(record.recordChangeTag && record.deleted !== true && record.fields.Deleted?.value === 0, "Deleted or unversioned record");
  assert.ok(sameId(reference(note, "Folder"), scope.folderId) && sameId(note.parentRecordName, scope.folderId), "Wrong folder");
  assert.ok(sameId(reference(attachment, "Note"), scope.noteId) && sameId(attachment.parentRecordName, scope.noteId), "Wrong attachment owner");
  assert.equal(attachment.fields.UTI?.value, "com.apple.paper");
  assert.equal(storesTextAsAsset(note), false, "Asset-backed text is unsupported");
  const decoded = classifyNoteRecord(note, { titleMode: "filename" });
  assert.ok(decoded.status === "ok" && decoded.publishable && decoded.titleInMetadata, "Unsupported drawing structure");
  assert.equal(decoded.bodyText.replace(/\uFFFC/g, "").trim(), "", "Surrounding text is unsupported");
  assert.equal((decoded.bodyText.match(/\uFFFC/g) ?? []).length, 1, "Expected one drawing reference");
  assert.equal(decoded.attachments.length, 1);
  assert.ok(sameId(decoded.attachments[0]!.attachmentIdentifier, scope.attachmentId));
  return { note, attachment };
}

export function metadataUpdate(records: CloudKitRecord[], scope: DrawingScope, phase: "attachment" | "note", title: string, timestamp: number): RecordUpdate {
  assert.ok(title && titleIsRepresentable(title) && !/[\r\n\0]/.test(title), "Unsupported filename title");
  assert.ok(Number.isSafeInteger(timestamp) && timestamp > 0, "Invalid modification date");
  const { note, attachment } = drawingScope(records, scope);
  const record = phase === "attachment" ? attachment : note;
  const encoded = Buffer.from(title, "utf8").toString("base64");
  return { recordName: record.recordName, recordType: record.recordType, recordChangeTag: record.recordChangeTag!, parentRecordName: record.parentRecordName,
    fields: phase === "attachment" ? { UserTitle: { value: encoded } } : { TitleEncrypted: { value: encoded }, ModificationDate: { value: timestamp } },
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "downloadURL" && item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
/** System versions and the explicitly changed title metadata are not drawing data. */
export function preservationKey(records: CloudKitRecord[]): string {
  return sha256(JSON.stringify(records.map(record => ({ recordName: record.recordName, recordType: record.recordType, parentRecordName: record.parentRecordName,
    fields: stable(Object.fromEntries(Object.entries(record.fields).filter(([key]) => !(record.recordType === "Note" ? ["TitleEncrypted", "ModificationDate"] : ["UserTitle"]).includes(key)))),
  })).sort((a, b) => a.recordName.localeCompare(b.recordName))));
}

export interface LocalRename { noteId: string; folderId: string; file: string; previousFile: string; targetTitle: string; }
export function selectLocalRename(state: Pick<CloneState, "notes" | "titleMode">, preview: SerializedPlanEntry[], allowedNoteIds: string[]): LocalRename | undefined {
  if (state.titleMode !== "filename" || allowedNoteIds.length === 0) return undefined;
  const candidates: LocalRename[] = [];
  for (const action of preview) {
    if (action.kind !== "move" || !action.previousFile) continue;
    const pairs = Object.entries(state.notes).filter(([, entry]) => entry.file === action.previousFile);
    if (pairs.length !== 1) continue;
    const [noteId, entry] = pairs[0]!;
    if (!allowedNoteIds.some(id => sameId(id, noteId))) continue;
    assert.ok(action.resolution !== "conflict", "Rename conflicts with remote changes");
    assert.ok(entry.sharedZoneOwner === undefined && entry.folderRecordName && !entry.pendingRename && entry.frontmatterTitle === undefined, "Only private filename renames qualify");
    assert.equal(path.dirname(action.file), path.dirname(action.previousFile), "Folder moves are unsupported");
    assert.ok(!path.isAbsolute(action.file) && !action.file.split(/[\\/]/).includes(".."), "Unsafe note path");
    const targetTitle = titleFromNoteFileName(action.file);
    assert.ok(targetTitle && titleIsRepresentable(targetTitle) && !/[\r\n\0]/.test(targetTitle), "Unsupported filename title");
    candidates.push({ noteId, folderId: entry.folderRecordName, file: action.file, previousFile: action.previousFile, targetTitle });
  }
  assert.ok(candidates.length <= 1, "Only one drawing rename can be processed per cycle");
  return candidates[0];
}
