/** Checked Linux-only caller for a separately approved title experiment.
 * Never settles the filename/index or treats cloud success as native proof. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudKitRecord } from "../src/cloudkit/databaseClient.js";
import { isEnoent } from "../src/fsUtil.js";
import { readBaseCopy } from "../src/notes/baseCopy.js";
import { readCloneState, type CloneStateFolderEntry } from "../src/notes/cloneState.js";
import { classifyNoteRecord } from "../src/notes/decodeNoteRecord.js";
import { decodeFolderRecord } from "../src/notes/folderTree.js";
import { readLocalNote } from "../src/notes/localFileState.js";
import { renderPlaceholders } from "../src/notes/noteAttachments.js";
import { isNoteId, readNoteId, readNoteTitleKey } from "../src/notes/noteIdFrontmatter.js";
import { titleFromNoteFileName } from "../src/notes/noteTitleParagraph.js";
import { titleIsRepresentable } from "../src/notes/titleFilename.js";
import { indexUntrackedNoteIds } from "../src/notes/untrackedFiles.js";
import { formatEmbedMarker } from "../src/notes/unknownContent.js";
import { assertAttachmentTitleLockHeld } from "./attachmentTitleLock.js";
import { createAttachmentTitleProbeIO, runAttachmentTitleProbe, type TitleProbeIO, type TitleProbeRequest } from "./attachmentTitleProbe.js";
import { createProbeJournal, privateProbeDirectory, readProbeJournal } from "./attachmentTitleProbeJournal.js";
import type { DrawingCapture } from "./attachmentTitleCapture.js";
import { resolveHarnessAccount } from "./harnessAccount.js";

export interface TitleRunnerOptions {
  vault: string; file: string; noteId: string; attachmentId: string; folderId: string;
  journalDirectory: string; phase: "A" | "B"; modificationDate: number; deadline: number;
  apply?: boolean; expectedPlanSha256?: string;
}
export interface TitleRunnerPorts {
  connect(vault: string): Promise<TitleProbeIO>;
  capture(scope: { noteId: string; attachmentId: string; folderId: string }, lookup: TitleProbeIO["lookup"], options?: { directory?: string }): Promise<DrawingCapture>;
  assertLock(): Promise<void>;
  lockAuthority(): Promise<{ path: string; dev: string; ino: string }>;
  now(): number;
  codeIdentity?(): Promise<string>;
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sameId = (left: string, right: string) => left.toUpperCase() === right.toUpperCase();
const outside = (root: string, file: string) => { const relative = path.relative(root, file); return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative); };
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const equal = (left: unknown, right: unknown, message: string) => assert.ok(json(left) === json(right), message);

/** Bind approval to executable source closures, including the lock/transport. */
async function codeIdentity(): Promise<string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = ["package.json", "package-lock.json"];
  if (!(await absent(path.join(root, "integration/runAttachmentTitleProbe")))) files.push("integration/runAttachmentTitleProbe");
  async function walk(directory: string) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "scratch") await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(file);
    }
  }
  await walk("src"); await walk("integration");
  const digests = await Promise.all(files.sort().map(async file => [file, sha(await readFile(path.join(root, file)))]));
  return sha(json(digests));
}
const defaults: TitleRunnerPorts = {
  connect: async vault => createAttachmentTitleProbeIO(await resolveHarnessAccount(vault)),
  capture: async (...args) => (await import("./attachmentTitleCapture.js")).captureDrawingSnapshot(...args),
  assertLock: assertAttachmentTitleLockHeld,
  lockAuthority: async () => (await import("./attachmentTitleLock.js")).getAttachmentTitleLockAuthority(),
  now: Date.now, codeIdentity,
};

interface LocalIntent {
  vault: string; file: string; previousFile: string; targetTitle: string; noteId: string;
  fileSha256: string; baseSha256: string; stateSha256: string; accountDsidSha256: string;
  folders: Array<{ id: string; parent?: string }>;
}
interface SavedBaseline { version: 1; local: LocalIntent; scope: TitleProbeRequest["scope"]; capture: DrawingCapture; folders: CloudKitRecord[]; codeSha256: string; lockAuthority: Awaited<ReturnType<TitleRunnerPorts["lockAuthority"]>>; }
interface RunnerResult {
  status: "preview" | "cloud-applied-native-unverified" | "ambiguous";
  phase: "A" | "B"; planSha256: string; fieldMask: string[]; file: string; targetTitle: string;
  noteId: string; attachmentId: string; folderId: string; deadline: number; modificationDate: number; syncLockPath: string; captureSha256?: string;
}
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if (isEnoent(error)) return true; throw error; } }
function safeRelative(file: string) {
  assert.ok(file && !path.isAbsolute(file) && !file.includes("\\") && !file.split("/").some(part => !part || part === "." || part === ".."), "Unsafe note path");
}
async function localIntent(options: TitleRunnerOptions): Promise<LocalIntent> {
  const vault = await realpath(options.vault), state = await readCloneState(vault);
  assert.ok(state?.account?.dsid && state.titleMode === "filename", "A bound filename-title vault is required");
  const matches = Object.entries(state.notes).filter(([id]) => sameId(id, options.noteId));
  assert.ok(matches.length === 1, "Ambiguous tracked note identity");
  const [noteId, entry] = matches[0]!;
  assert.ok(entry.folderRecordName && sameId(entry.folderRecordName, options.folderId) && !entry.sharedZoneOwner && !entry.pendingRename && entry.frontmatterTitle === undefined, "Unsupported note state/folder");
  safeRelative(options.file); safeRelative(entry.file);
  assert.ok(options.file.endsWith(".md") && options.file !== entry.file && path.posix.dirname(options.file) === path.posix.dirname(entry.file), "Only a same-folder filename rename qualifies");
  assert.ok(await absent(path.join(vault, entry.file)), "Original note path reappeared; rename is ambiguous");
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
async function folderSnapshot(local: LocalIntent, io: TitleProbeIO) {
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
function preserved(capture: DrawingCapture) { return { documentSha256: capture.documentSha256, assets: capture.assets }; }
function versions(capture: DrawingCapture) { return capture.records.map(record => ({ id: record.recordName, tag: record.recordChangeTag })); }

export async function runAttachmentTitleRunner(input: TitleRunnerOptions, overrides: Partial<TitleRunnerPorts> = {}): Promise<RunnerResult> {
  const options = structuredClone(input), ports = { ...defaults, ...overrides };
  assert.ok([options.noteId, options.attachmentId, options.folderId].every(isNoteId) && (options.phase === "A" || options.phase === "B"), "Invalid runner identity/phase");
  const checkDeadline = () => assert.ok(Number.isSafeInteger(options.deadline) && options.deadline > ports.now() && options.deadline - ports.now() <= 30 * 60_000, "Approval deadline expired or invalid");
  assert.ok(Number.isSafeInteger(options.modificationDate) && options.modificationDate > 0 && path.isAbsolute(options.journalDirectory), "Invalid date/journal");
  if (options.apply) { assert.ok(options.expectedPlanSha256 && /^[a-f0-9]{64}$/.test(options.expectedPlanSha256), "Apply requires an approved preview plan"); await ports.assertLock(); }
  checkDeadline();
  const lockAuthority = await ports.lockAuthority();
  const local = await localIntent(options), codeSha256 = await ports.codeIdentity!();
  const journal = path.resolve(options.journalDirectory);
  // Resolve the nearest existing ancestor, including symlinked parent paths.
  let ancestor = journal;
  while (await absent(ancestor)) ancestor = path.dirname(ancestor);
  const authority = await realpath(ancestor), canonicalJournal = path.resolve(authority, path.relative(ancestor, journal));
  assert.ok(outside(local.vault, journal) && outside(local.vault, canonicalJournal), "Journal must remain outside the vault");
  const baselineFile = path.join(journal, "baseline.json"), requestFile = path.join(journal, `${options.phase}.request.json`), resultFile = path.join(journal, `${options.phase}.result.json`);
  const oldRequest = await readProbeJournal(requestFile);
  if (oldRequest !== undefined) throw Error("Existing recorded phase intent; do not replay or replace an ambiguous experiment");
  const savedText = await readProbeJournal(baselineFile);
  const saved = savedText === undefined ? undefined : JSON.parse(savedText) as SavedBaseline;
  if (saved) { assert.ok(saved.version === 1 && saved.codeSha256 === codeSha256, "Existing baseline/code changed"); equal(saved.local, local, "Existing local intent changed"); equal(saved.lockAuthority, lockAuthority, "Existing sync lock authority changed"); }
  if (options.phase === "B") {
    assert.ok(saved, "Phase A baseline is required");
    const a = await readProbeJournal(path.join(journal, "A.result.json"));
    assert.ok(a && JSON.parse(a).status === "cloud-applied-native-unverified", "Phase A has no complete acknowledgement");
    const evidence = await readProbeJournal(path.join(journal, "after-A/complete.json"));
    const aRequest = await readProbeJournal(path.join(journal, "A.request.json"));
    assert.ok(evidence && aRequest, "Phase A capture evidence is missing");
    const recorded = JSON.parse(a) as RunnerResult, captured = JSON.parse(evidence) as DrawingCapture;
    assert.ok(recorded.captureSha256 === sha(json(captured)) && recorded.planSha256 === JSON.parse(aRequest).planSha256 && recorded.phase === "A" && recorded.file === local.file && recorded.targetTitle === local.targetTitle, "Phase A capture evidence changed");
    equal(preserved(captured), preserved(saved.capture), "Phase A capture evidence changed");
  }
  const io = await ports.connect(local.vault);
  assert.ok(io.accountDsidSha256 === local.accountDsidSha256, "Wrong cloud account");
  const folders = await folderSnapshot(local, io);
  if (saved) equal(saved.folders, folders, "Cloud folder ancestry changed");
  const scope = { noteId: local.noteId, attachmentId: options.attachmentId, folderId: options.folderId, accountDsidSha256: local.accountDsidSha256 };
  const before = await ports.capture(scope, io.lookup);
  checkDeadline(); equal(await localIntent(options), local, "Local intent changed during capture");
  const note = before.records.find(record => sameId(record.recordName, local.noteId));
  const decoded = note && classifyNoteRecord(note, { titleMode: "filename" });
  assert.ok(decoded?.status === "ok" && decoded.attachments.length === 1 && sameId(decoded.attachments[0]!.attachmentIdentifier, options.attachmentId), "Unsupported cloud drawing");
  const localBody = await readBaseCopy(local.vault, local.noteId);
  assert.ok(localBody === renderPlaceholders(decoded.markdownText, [formatEmbedMarker(decoded.attachments[0]!)]), "Local base body differs from current cloud drawing");
  if (!saved) {
    const state = (await readCloneState(local.vault))!;
    assert.ok(note!.recordChangeTag === state.notes[local.noteId]!.recordChangeTag, "Cloud note version differs from tracked state");
  } else equal(preserved(saved.capture), preserved(before), "Drawing/document bytes or references changed");
  const baseline: SavedBaseline = saved ?? { version: 1, local, scope, capture: before, folders, codeSha256, lockAuthority };
  const fieldMask = options.phase === "A" ? ["UserTitle"] : ["TitleEncrypted", "ModificationDate"];
  const planSha256 = sha(json({ local, scope, journal, canonicalJournal, lockAuthority, codeSha256, phase: options.phase, fieldMask, deadline: options.deadline, modificationDate: options.modificationDate,
    baseline: { data: preserved(baseline.capture), versions: versions(baseline.capture) }, current: { data: preserved(before), versions: versions(before) }, folders }));
  const result = { phase: options.phase, planSha256, fieldMask, file: local.file, targetTitle: local.targetTitle, noteId: scope.noteId, attachmentId: scope.attachmentId, folderId: scope.folderId, deadline: options.deadline, modificationDate: options.modificationDate, syncLockPath: lockAuthority.path };
  const request: TitleProbeRequest = { scope, baseline: baseline.capture.records, expected: before.records, phase: options.phase, targetTitle: local.targetTitle, modificationDate: options.modificationDate, journalDirectory: path.join(journal, "phases") };
  await runAttachmentTitleProbe(request); // Pure structural/field-mask validation.
  if (!options.apply) return { ...result, status: "preview" };
  assert.ok(planSha256 === options.expectedPlanSha256, "Reviewed plan changed; apply refused");
  await ports.assertLock(); checkDeadline();
  await privateProbeDirectory(journal);
  assert.ok(outside(local.vault, await realpath(journal)), "Journal must remain outside vault");
  if (!saved) await createProbeJournal(baselineFile, json(baseline));
  await createProbeJournal(requestFile, json({ planSha256, request, deadline: options.deadline }));
  try {
    const captured = await ports.capture(scope, io.lookup, { directory: path.join(journal, `before-${options.phase}`) });
    equal(preserved(captured), preserved(before), "Pre-dispatch drawing bytes changed"); equal(versions(captured), versions(before), "Pre-dispatch cloud versions changed");
    const checkedIO: TitleProbeIO = { ...io, update: async update => {
      await ports.assertLock(); checkDeadline();
      assert.ok(await ports.codeIdentity!() === codeSha256, "Executable code changed before dispatch");
      equal(await folderSnapshot(local, io), folders, "Private folder scope changed before dispatch");
      equal(await ports.lockAuthority(), lockAuthority, "Sync lock authority changed before dispatch");
      equal(await localIntent(options), local, "Local intent changed before dispatch");
      checkDeadline();
      await io.update(update);
      equal(await localIntent(options), local, "Local intent changed after dispatch");
    } };
    const applied = await runAttachmentTitleProbe(request, { apply: true }, checkedIO);
    assert.ok(applied.status === "cloud-applied-native-unverified", "Phase result is uncertain; no replay");
    const after = await ports.capture(scope, io.lookup, { directory: path.join(journal, `after-${options.phase}`) });
    equal(preserved(after), preserved(baseline.capture), "Post-dispatch drawing bytes or references changed");
    equal(await localIntent(options), local, "Local intent changed after capture");
    const complete = { ...result, status: "cloud-applied-native-unverified" as const, captureSha256: sha(json(after)) };
    await createProbeJournal(resultFile, json(complete));
    return complete;
  } catch { return { ...result, status: "ambiguous" }; }
}

/** Parse only; the separate CLI and flock wrapper provide execution. */
export function parseAttachmentTitleRunnerArgs(args: string[]): TitleRunnerOptions {
  const values: Record<string, string> = {}; let apply = false;
  const names = ["vault", "file", "note", "attachment", "folder", "journal", "phase", "modification-date", "deadline", "expected-plan"];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--apply") { assert.ok(!apply, "Duplicate apply flag"); apply = true; continue; }
    assert.ok(flag.startsWith("--") && names.includes(flag.slice(2)), "Unknown runner argument");
    const key = flag.slice(2), value = args[++index]; assert.ok(value && !value.startsWith("--") && values[key] === undefined, "Missing/duplicate runner value"); values[key] = value;
  }
  assert.ok(names.filter(name => name !== "expected-plan").every(name => values[name]), "Missing runner argument");
  assert.ok(!apply || /^[a-f0-9]{64}$/.test(values["expected-plan"] ?? ""), "Apply requires approved preview plan");
  assert.ok(values.phase === "A" || values.phase === "B", "Invalid runner phase");
  return { vault: values.vault!, file: values.file!, noteId: values.note!, attachmentId: values.attachment!, folderId: values.folder!, journalDirectory: values.journal!, phase: values.phase,
    modificationDate: Number(values["modification-date"]), deadline: Number(values.deadline), apply, ...(values["expected-plan"] ? { expectedPlanSha256: values["expected-plan"] } : {}) };
}
