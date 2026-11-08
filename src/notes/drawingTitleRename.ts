/** Guarded Linux-only coordinator. Default push does not enable this workflow.
 * All operations remain native-unverified; no native device is contacted. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { isEnoent } from "../fsUtil.js";
import { captureDrawingSnapshot, type DrawingCapture } from "./attachmentTitleCapture.js";
import { readAttachmentTitleFolders, readAttachmentTitleIntent } from "./attachmentTitleIntent.js";
import { getAttachmentTitleLockAuthority } from "./attachmentTitleLock.js";
import { runAttachmentTitleProbe, type TitleProbeIO } from "./attachmentTitleProbe.js";
import { createProbeJournal, privateProbeDirectory, readProbeJournal } from "./attachmentTitleProbeJournal.js";
import type { DocumentRevisionSummary } from "./attachmentTitleRevision.js";

export interface DrawingTitleRenameOptions {
  vault: string; file: string; noteId: string; attachmentId: string; folderId: string;
  journalDirectory: string; baseline: CloudKitRecord[]; expectedNoteTag: string; io: TitleProbeIO;
}
export interface DrawingTitleRenamePorts {
  capture: typeof captureDrawingSnapshot;
  lockAuthority: typeof getAttachmentTitleLockAuthority;
  now(): number;
}
const defaults: DrawingTitleRenamePorts = { capture: captureDrawingSnapshot, lockAuthority: getAttachmentTitleLockAuthority, now: Date.now };
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined && key !== "downloadURL").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: unknown, right: unknown, message: string) => assert.equal(json(left), json(right), message);
const records = (capture: DrawingCapture) => [...capture.records].sort((a, b) => a.recordName.localeCompare(b.recordName));
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
async function safeJournal(directory: string, vault: string) {
  assert.ok(path.isAbsolute(directory) && !inside(vault, path.resolve(directory)), "Title evidence must stay outside the vault");
  let current = path.parse(directory).root;
  for (const part of path.resolve(directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { assert.ok(!(await lstat(current)).isSymbolicLink(), "Symlink in title journal path"); }
    catch (error) { if (isEnoent(error)) break; throw error; }
  }
}
interface Complete { identitySha256: string; captureSha256: string; documentRevision: DocumentRevisionSummary; operationId: string; }
interface Completion { status: "cloud-applied-native-unverified"; note: CloudKitRecord; documentRevision: DocumentRevisionSummary; }
type Outcome = Completion | { status: "ambiguous" };

/** Prepare without persistent writes; execute alone claims a durable attempt.
 * A failed or uncertain attempt blocks all later filename requests for this
 * note. A completed attempt is recovered by exact readback, never replayed. */
export async function prepareDrawingTitleRename(input: DrawingTitleRenameOptions, overrides: Partial<DrawingTitleRenamePorts> = {}) {
  const { io } = input, options = structuredClone({ ...input, io: undefined }), ports = { ...defaults, ...overrides };
  const localOptions = { vault: options.vault, file: options.file, noteId: options.noteId, folderId: options.folderId };
  const local = await readAttachmentTitleIntent(localOptions);
  assert.equal(io.accountDsidSha256, local.accountDsidSha256, "Wrong title account");
  await safeJournal(options.journalDirectory, local.vault);
  const journalRoot = path.resolve(options.journalDirectory), scope = { noteId: local.noteId, attachmentId: options.attachmentId, folderId: options.folderId, accountDsidSha256: local.accountDsidSha256 };
  const directory = path.join(journalRoot, sha(json([local.vault, scope.accountDsidSha256, scope.noteId.toUpperCase()])));
  const pin = path.join(local.vault, ".icloud-md", "attachment-title-journal.json");
  const journalIdentity = async () => {
    const stat = await lstat(journalRoot, { bigint: true });
    return json({ directory: journalRoot, accountDsidSha256: local.accountDsidSha256, dev: stat.dev.toString(), ino: stat.ino.toString() });
  };
  const lock = await ports.lockAuthority(), folders = await readAttachmentTitleFolders(local, io);
  const check = async () => {
    await safeJournal(journalRoot, local.vault);
    const authority = await readProbeJournal(pin);
    if (authority !== undefined) assert.equal(authority, await journalIdentity(), "Title journal authority changed");
    equal(await ports.lockAuthority(), lock, "Sync lock authority changed");
    equal(await readAttachmentTitleFolders(local, io), folders, "Private folder state changed");
    equal(await readAttachmentTitleIntent(localOptions), local, "Local rename intent changed");
  };
  async function attempts() {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      assert.ok(entries.every(entry => entry.isDirectory() && /^attempt-\d{8}$/.test(entry.name)), "Invalid title attempt history");
      return entries.map(entry => entry.name).sort();
    } catch (error) { if (isEnoent(error)) return []; throw error; }
  }
  const previous = await attempts(), last = previous.at(-1);
  const saved = last ? await readProbeJournal(path.join(directory, last, "complete.json")) : undefined;
  const started = last ? await readProbeJournal(path.join(directory, last, "begin.json")) : undefined;
  async function verifyCapture(capture: DrawingCapture, kind: "A" | "BD", operationId: string, attempt: string,
    original: CloudKitRecord[], targetTitle: string, date: number, revision: DocumentRevisionSummary) {
    const marker = path.join(attempt, "phases", operationId, `${kind}.ack.json`);
    const rawAck = await readProbeJournal(marker), intent = await readProbeJournal(marker.replace(".ack.json", ".intent.json"));
    assert.ok(rawAck && intent, "Missing phase acknowledgement");
    const ack = JSON.parse(rawAck) as { operationId?: unknown; identity?: unknown; tags?: unknown };
    assert.ok(ack.operationId === operationId && ack.identity === intent, "Phase acknowledgement identity changed");
    equal(Object.fromEntries(capture.records.map(record => [record.recordName, record.recordChangeTag])), ack.tags, "Cloud changed after phase acknowledgement");
    const expected = structuredClone(original), encoded = Buffer.from(targetTitle).toString("base64");
    const drawing = expected.find(record => record.recordType === "Attachment"), note = expected.find(record => record.recordType === "Note");
    assert.ok(note && drawing, "Missing expected phase records");
    drawing.fields.UserTitle = { type: "ENCRYPTED_BYTES", value: encoded };
    if (kind === "BD") {
      assert.equal(capture.documentSha256, revision.documentSha256, "Unexpected causal document revision");
      const capturedNote = capture.records.find(record => record.recordType === "Note");
      assert.ok(capturedNote?.fields.TextDataEncrypted?.type === "ENCRYPTED_BYTES", "Missing causal document");
      note.fields.TitleEncrypted = { type: "ENCRYPTED_BYTES", value: encoded };
      note.fields.ModificationDate = { type: "TIMESTAMP", value: date };
      note.fields.TextDataEncrypted = capturedNote.fields.TextDataEncrypted;
    }
    const persistent = (items: CloudKitRecord[]) => items.map(({ recordChangeTag, modified, ...record }) => record).sort((a, b) => a.recordName.localeCompare(b.recordName));
    equal(persistent(capture.records), persistent(expected), "Phase capture title or protected record changed");
  }
  async function recover(): Promise<Completion | undefined> {
    if (!saved || !started || !last) return undefined;
    const completion = JSON.parse(saved) as Complete, begin = JSON.parse(started) as { local?: { targetTitle?: unknown }; documentRevision?: unknown; baseline?: unknown; modificationDate?: unknown };
    assert.equal(completion.identitySha256, sha(started), "Title completion identity changed");
    equal(completion.documentRevision, begin.documentRevision, "Title completion revision changed");
    const raw = await readProbeJournal(path.join(directory, last, "after-BD", "complete.json"));
    assert.ok(raw && sha(raw) === completion.captureSha256, "Incomplete title preservation evidence");
    const capture = JSON.parse(raw) as DrawingCapture;
    assert.ok(Array.isArray(begin.baseline) && typeof begin.local?.targetTitle === "string" && Number.isSafeInteger(begin.modificationDate), "Invalid completed title intent");
    await verifyCapture(capture, "BD", completion.operationId, path.join(directory, last), begin.baseline, begin.local.targetTitle, begin.modificationDate as number, completion.documentRevision);
    if (json(begin.local) !== json(local)) return undefined;
    equal([...await io.lookup([scope.noteId, scope.attachmentId])].sort((a, b) => a.recordName.localeCompare(b.recordName)), records(capture), "Completed title cloud state changed");
    await check();
    const note = capture.records.find(record => record.recordName === scope.noteId); assert.ok(note, "Missing completed title note");
    return { status: "cloud-applied-native-unverified", note, documentRevision: completion.documentRevision };
  }
  const recovered = await recover();
  if (!recovered) {
    const note = options.baseline.find(record => record.recordName.toUpperCase() === scope.noteId.toUpperCase());
    assert.equal(note?.recordChangeTag, options.expectedNoteTag, "Changed remotely since the last pull");
  }
  const modificationDate = ports.now();
  const baseline = structuredClone(options.baseline);
  let documentRevision: DocumentRevisionSummary;
  if (recovered) documentRevision = recovered.documentRevision;
  else {
    const expected = structuredClone(baseline), drawing = expected.find(record => record.recordName.toUpperCase() === scope.attachmentId.toUpperCase());
    assert.ok(drawing, "Missing drawing record");
    drawing.fields.UserTitle = { type: "ENCRYPTED_BYTES", value: Buffer.from(local.targetTitle).toString("base64") };
    const preview = await runAttachmentTitleProbe({ scope, baseline, expected, phase: "BD", targetTitle: local.targetTitle, modificationDate, journalDirectory: directory });
    assert.ok(preview.documentRevision, "Missing guarded document revision"); documentRevision = preview.documentRevision;
  }
  return { documentRevision, verifyLocalIntent: check, execute: async (): Promise<Outcome> => {
    try {
      await check();
      if (recovered) { const completed = await recover(); assert.ok(completed); return completed; }
      if (last && !saved) return { status: "ambiguous" };
      if (last) {
        assert.ok(started && saved, "Incomplete prior title attempt");
        const prior = JSON.parse(started) as { local?: { file?: unknown } }, completion = JSON.parse(saved) as Complete;
        assert.ok(completion.identitySha256 === sha(started) && prior.local?.file === local.previousFile, "Prior title attempt was not settled");
      }
      await safeJournal(journalRoot, local.vault); await privateProbeDirectory(journalRoot); await privateProbeDirectory(directory);
      // Pin the external evidence root in vault metadata: changing configuration
      // must never open a retry route around an uncertain attempt.
      const identity = await journalIdentity();
      const existing = await readProbeJournal(pin);
      if (existing === undefined) await createProbeJournal(pin, identity); else assert.equal(existing, identity, "Title journal authority changed");
      const attempt = path.join(directory, `attempt-${String(previous.length + 1).padStart(8, "0")}`);
      await mkdir(attempt, { mode: 0o700 }); await privateProbeDirectory(attempt);
      const begin = json({ local, scope, lock, folders, baseline, documentRevision, modificationDate });
      await createProbeJournal(path.join(attempt, "begin.json"), begin);
      await check();
      const before = await ports.capture(scope, io.lookup, { directory: path.join(attempt, "before-A") });
      equal(records(before), [...baseline].sort((a, b) => a.recordName.localeCompare(b.recordName)), "Planned cloud versions changed");
      const checkedIO: TitleProbeIO = { ...io,
        update: async update => { await check(); await io.update(update); await check(); },
        updateBatch: async () => { throw Error("Production title workflow never sends batches"); },
      };
      const phase = async (kind: "A" | "BD", expected: CloudKitRecord[]) => {
        const result = await runAttachmentTitleProbe({ scope, baseline, expected, phase: kind, targetTitle: local.targetTitle, modificationDate, journalDirectory: path.join(attempt, "phases") }, { apply: true }, checkedIO);
        assert.equal(result.status, "cloud-applied-native-unverified", "Uncertain title phase");
        return result;
      };
      const a = await phase("A", before.records);
      const afterA = await ports.capture(scope, io.lookup, { directory: path.join(attempt, "after-A") });
      await verifyCapture(afterA, "A", a.operationId, attempt, baseline, local.targetTitle, modificationDate, documentRevision);
      equal({ doc: afterA.documentSha256, assets: afterA.assets }, { doc: before.documentSha256, assets: before.assets }, "A preservation changed");
      await check();
      const beforeBD = await ports.capture(scope, io.lookup, { directory: path.join(attempt, "before-BD") });
      equal(beforeBD, afterA, "Cloud changed between title phases");
      const bd = await phase("BD", beforeBD.records);
      const after = await ports.capture(scope, io.lookup, { directory: path.join(attempt, "after-BD") });
      await verifyCapture(after, "BD", bd.operationId, attempt, baseline, local.targetTitle, modificationDate, documentRevision);
      equal(after.assets, before.assets, "Drawing asset preservation changed");
      assert.equal(after.documentSha256, documentRevision.documentSha256, "Exact guarded document revision changed");
      await check();
      const raw = await readProbeJournal(path.join(attempt, "after-BD", "complete.json")); assert.ok(raw, "Missing final title capture");
      await createProbeJournal(path.join(attempt, "complete.json"), JSON.stringify({ identitySha256: sha(begin), captureSha256: sha(raw), documentRevision, operationId: bd.operationId } satisfies Complete));
      const note = after.records.find(record => record.recordName === scope.noteId); assert.ok(note);
      return { status: "cloud-applied-native-unverified", note, documentRevision };
    } catch { return { status: "ambiguous" }; }
  } };
}
