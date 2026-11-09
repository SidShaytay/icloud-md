/** Shared local/cloud authority checks for unchanged drawing filename renames. */
import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isEnoent } from "../fsUtil.js";
import { readBaseCopy } from "./baseCopy.js";
import { readCloneState, type CloneStateFolderEntry } from "./cloneState.js";
import { decodeFolderRecord } from "./folderTree.js";
import { readLocalNote } from "./localFileState.js";
import { readNoteId, readNoteTitleKey } from "./noteIdFrontmatter.js";
import { titleFromNoteFileName } from "./noteTitleParagraph.js";
import { titleIsRepresentable } from "./titleFilename.js";
import { indexUntrackedNoteIds } from "./untrackedFiles.js";
import type { DrawingTitleIO } from "./drawingTitleCloud.js";
const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const outside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative); };
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if (isEnoent(error)) return true; throw error; } }
export interface LocalIntent {
  vault: string; file: string; previousFile: string; targetTitle: string; noteId: string;
  fileSha256: string; baseSha256: string; stateSha256: string; accountDsidSha256: string;
  folders: Array<{ id: string; parent?: string }>;
}
function safeRelative(file: string) {
  assert.ok(file && !path.isAbsolute(file) && !file.includes("\\") && !file.split("/").some(part => !part || part === "." || part === ".."), "Unsafe note path");
}
export async function readAttachmentTitleIntent(options: { vault: string; file: string; noteId: string; folderId: string }, mode: { allowTracked?: boolean } = {}): Promise<LocalIntent> {
  const vault = await realpath(options.vault), state = await readCloneState(vault);
  assert.ok(state?.account?.dsid && state.titleMode === "filename", "A bound filename-title vault is required");
  const matches = Object.entries(state.notes).filter(([id]) => sameId(id, options.noteId));
  assert.ok(matches.length === 1, "Ambiguous tracked note identity");
  const [noteId, entry] = matches[0]!;
  assert.ok(entry.folderRecordName && sameId(entry.folderRecordName, options.folderId) && !entry.sharedZoneOwner && !entry.pendingRename && entry.frontmatterTitle === undefined, "Unsupported note state/folder");
  safeRelative(options.file); safeRelative(entry.file);
  assert.ok(options.file.endsWith(".md") && (mode.allowTracked || options.file !== entry.file) && path.posix.dirname(options.file) === path.posix.dirname(entry.file), "Only a same-folder filename rename qualifies");
  if (options.file !== entry.file) assert.ok(await absent(path.join(vault, entry.file)), "Original note path reappeared; rename is ambiguous");
  let current = vault;
  for (const part of options.file.split("/")) { current = path.join(current, part); const stat = await lstat(current); assert.ok(!stat.isSymbolicLink(), "Symlink in note path"); }
  assert.ok((await lstat(current)).isFile() && !outside(vault, await realpath(current)), "Note path leaves vault");
  const index = await indexUntrackedNoteIds(vault, {}, "filename");
  const claims = [...index.claims].filter(([id]) => sameId(id, noteId)).flatMap(([, files]) => files);
  assert.ok(index.unreadable.length === 0 && claims.length === 1 && claims[0] === options.file, "Ambiguous local note identity claims");
  const local = await readLocalNote(vault, { ...entry, file: options.file }, noteId, "filename");
  assert.ok(local.status === "clean" && readNoteId(local.frontmatter)?.toUpperCase() === noteId.toUpperCase() && readNoteTitleKey(local.frontmatter).kind === "absent", "Local drawing body/identity/title changed");
  const targetTitle = titleFromNoteFileName(options.file);
  assert.ok(targetTitle && titleIsRepresentable(targetTitle) && !/[\r\n\0]/.test(targetTitle), "Unsupported target title");
  const folders: LocalIntent["folders"] = [], definitions: CloneStateFolderEntry[] = [];
  let folder: string | undefined = entry.folderRecordName;
  while (folder) {
    assert.ok(folders.length < 32 && !folders.some(item => sameId(item.id, folder!)), "Invalid folder ancestry");
    const definition: CloneStateFolderEntry | undefined = state.folders?.[folder];
    assert.ok(definition && !definition.sharedZoneOwner, "Folder is not known private");
    safeRelative(definition.dirName);
    folders.push({ id: folder, ...(definition.parentRecordName ? { parent: definition.parentRecordName } : {}) });
    definitions.push(definition); folder = definition.parentRecordName;
  }
  assert.ok(definitions.reverse().map(item => item.dirName).join("/") === path.posix.dirname(entry.file), "Local folder path does not match state");
  const base = await readBaseCopy(vault, noteId); assert.ok(base !== undefined, "Missing local base copy");
  return { vault, file: options.file, previousFile: entry.file, targetTitle, noteId,
    fileSha256: sha(await readFile(current)), baseSha256: sha(base), stateSha256: sha(json({ account: state.account, entry, folders, definitions, titleMode: state.titleMode })), accountDsidSha256: sha(state.account.dsid), folders };
}
export async function readAttachmentTitleFolders(local: LocalIntent, io: DrawingTitleIO) {
  const records = await io.lookup(local.folders.map(folder => folder.id));
  assert.ok(records.length === local.folders.length, "Missing cloud folder");
  for (const folder of local.folders) {
    const record = records.find(item => sameId(item.recordName, folder.id));
    const decoded = record && decodeFolderRecord(record);
    // Native top-level Folder captures may carry only TitleEncrypted. An
    // explicit deletion field must still be a valid undeleted INT64.
    const deletion = record?.fields.Deleted;
    assert.ok(record && decoded && record.recordChangeTag && record.deleted !== true && (deletion === undefined || (deletion.type === "INT64" && deletion.value === 0)) && !record.shareRecordName && decoded.parentRecordName === folder.parent, "Shared/private folder ancestry changed");
  }
  return records.sort((a, b) => a.recordName.localeCompare(b.recordName));
}
