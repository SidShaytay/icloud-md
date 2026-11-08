/** Checked Linux-only caller for a separately approved title experiment.
 * Never settles the filename/index or treats cloud success as native proof. */
import { readAttachmentTitleIntent, readAttachmentTitleFolders, type LocalIntent } from "../src/notes/attachmentTitleIntent.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudKitRecord } from "../src/cloudkit/databaseClient.js";
import { isEnoent } from "../src/fsUtil.js";
import { readBaseCopy } from "../src/notes/baseCopy.js";
import { readCloneState } from "../src/notes/cloneState.js";
import { classifyNoteRecord } from "../src/notes/decodeNoteRecord.js";
import { renderPlaceholders } from "../src/notes/noteAttachments.js";
import { isNoteId } from "../src/notes/noteIdFrontmatter.js";
import { formatEmbedMarker } from "../src/notes/unknownContent.js";
import { assertAttachmentTitleLockHeld } from "./attachmentTitleLock.js";
import { createAttachmentTitleProbeIO, runAttachmentTitleProbe, type TitleProbeIO, type TitleProbeRequest, type TitleProbePhase } from "./attachmentTitleProbe.js";
import { createProbeJournal, privateProbeDirectory, readProbeJournal } from "./attachmentTitleProbeJournal.js";
import type { DocumentRevisionSummary } from "./attachmentTitleRevision.js";
import type { DrawingCapture } from "./attachmentTitleCapture.js";
import { resolveHarnessAccount } from "./harnessAccount.js";

export interface TitleRunnerOptions {
  vault: string; file: string; noteId: string; attachmentId: string; folderId: string;
  journalDirectory: string; phase: TitleProbePhase; modificationDate: number; deadline: number;
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

interface SavedBaseline { version: 1; local: LocalIntent; scope: TitleProbeRequest["scope"]; capture: DrawingCapture; folders: CloudKitRecord[]; codeSha256: string; lockAuthority: Awaited<ReturnType<TitleRunnerPorts["lockAuthority"]>>; }
interface RunnerResult {
  status: "preview" | "cloud-applied-native-unverified" | "ambiguous";
  phase: TitleProbePhase; planSha256: string; fieldMask: string[]; file: string; targetTitle: string;
  noteId: string; attachmentId: string; folderId: string; deadline: number; modificationDate: number; syncLockPath: string; captureSha256?: string;
  documentRevision?: DocumentRevisionSummary;
}
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if (isEnoent(error)) return true; throw error; } }
function preserved(capture: DrawingCapture) { return { documentSha256: capture.documentSha256, assets: capture.assets }; }
function versions(capture: DrawingCapture) { return capture.records.map(record => ({ id: record.recordName, tag: record.recordChangeTag })); }

export async function runAttachmentTitleRunner(input: TitleRunnerOptions, overrides: Partial<TitleRunnerPorts> = {}): Promise<RunnerResult> {
  const options = structuredClone(input), ports = { ...defaults, ...overrides };
  assert.ok([options.noteId, options.attachmentId, options.folderId].every(isNoteId) && (options.phase === "A" || options.phase === "B" || options.phase === "BA" || options.phase === "BD" || options.phase === "BR"), "Invalid runner identity/phase");
  const checkDeadline = () => assert.ok(Number.isSafeInteger(options.deadline) && options.deadline > ports.now() && options.deadline - ports.now() <= 30 * 60_000, "Approval deadline expired or invalid");
  assert.ok(Number.isSafeInteger(options.modificationDate) && options.modificationDate > 0 && path.isAbsolute(options.journalDirectory), "Invalid date/journal");
  if (options.apply) { assert.ok(options.expectedPlanSha256 && /^[a-f0-9]{64}$/.test(options.expectedPlanSha256), "Apply requires an approved preview plan"); await ports.assertLock(); }
  checkDeadline();
  const lockAuthority = await ports.lockAuthority();
  const local = await readAttachmentTitleIntent(options), codeSha256 = await ports.codeIdentity!();
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
  if (options.phase !== "A") {
    for (const alternate of ["B", "BA", "BD", "BR"]) if (alternate !== options.phase) assert.ok(await readProbeJournal(path.join(journal, `${alternate}.request.json`)) === undefined, "Another terminal caller intent exists; never retry through an alternate");
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
  const folders = await readAttachmentTitleFolders(local, io);
  if (saved) equal(saved.folders, folders, "Cloud folder ancestry changed");
  const scope = { noteId: local.noteId, attachmentId: options.attachmentId, folderId: options.folderId, accountDsidSha256: local.accountDsidSha256 };
  const before = await ports.capture(scope, io.lookup);
  checkDeadline(); equal(await readAttachmentTitleIntent(options), local, "Local intent changed during capture");
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
  const request: TitleProbeRequest = { scope, baseline: baseline.capture.records, expected: before.records, phase: options.phase, targetTitle: local.targetTitle, modificationDate: options.modificationDate, journalDirectory: path.join(journal, "phases") };
  const preview = await runAttachmentTitleProbe(request); // Pure structural and exact revision validation.
  const documentRevision = preview.documentRevision;
  const fieldMask = preview.fields;
  const planSha256 = sha(json({ local, scope, journal, canonicalJournal, lockAuthority, codeSha256, phase: options.phase, fieldMask, documentRevision, deadline: options.deadline, modificationDate: options.modificationDate,
    baseline: { data: preserved(baseline.capture), versions: versions(baseline.capture) }, current: { data: preserved(before), versions: versions(before) }, folders }));
  const result = { phase: options.phase, planSha256, fieldMask, file: local.file, targetTitle: local.targetTitle, noteId: scope.noteId, attachmentId: scope.attachmentId, folderId: scope.folderId, deadline: options.deadline, modificationDate: options.modificationDate, syncLockPath: lockAuthority.path, ...(documentRevision ? { documentRevision } : {}) };
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
    const beforeDispatch = async () => {
      await ports.assertLock(); checkDeadline();
      assert.ok(await ports.codeIdentity!() === codeSha256, "Executable code changed before dispatch");
      equal(await readAttachmentTitleFolders(local, io), folders, "Private folder scope changed before dispatch");
      equal(await ports.lockAuthority(), lockAuthority, "Sync lock authority changed before dispatch");
      equal(await readAttachmentTitleIntent(options), local, "Local intent changed before dispatch");
      checkDeadline();
    };
    const afterDispatch = async () => equal(await readAttachmentTitleIntent(options), local, "Local intent changed after dispatch");
    const checkedIO: TitleProbeIO = { ...io,
      update: async update => { await beforeDispatch(); await io.update(update); await afterDispatch(); },
      updateBatch: async updates => { await beforeDispatch(); await io.updateBatch(updates); await afterDispatch(); },
    };
    const applied = await runAttachmentTitleProbe(request, { apply: true }, checkedIO);
    assert.ok(applied.status === "cloud-applied-native-unverified", "Phase result is uncertain; no replay");
    const after = await ports.capture(scope, io.lookup, { directory: path.join(journal, `after-${options.phase}`) });
    const expectedData = { ...preserved(baseline.capture), ...(documentRevision ? { documentSha256: documentRevision.documentSha256 } : {}) };
    equal(preserved(after), expectedData, "Post-dispatch document revision/drawing bytes or references changed");
    equal(await readAttachmentTitleIntent(options), local, "Local intent changed after capture");
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
  assert.ok(values.phase === "A" || values.phase === "B" || values.phase === "BA" || values.phase === "BD" || values.phase === "BR", "Invalid runner phase");
  return { vault: values.vault!, file: values.file!, noteId: values.note!, attachmentId: values.attachment!, folderId: values.folder!, journalDirectory: values.journal!, phase: values.phase,
    modificationDate: Number(values["modification-date"]), deadline: Number(values.deadline), apply, ...(values["expected-plan"] ? { expectedPlanSha256: values["expected-plan"] } : {}) };
}
