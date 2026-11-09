/** Bounded, private metadata lease ledger. A dispatch is returned only
* after its unique intent is durable. Cloud postconditions are never SDK ACKs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isEnoent, lstatIfPresent } from "../fsUtil.js";
import { isNoteId } from "./noteIdFrontmatter.js";
import { titleIsRepresentable } from "./titleFilename.js";
import { titleFromNoteFileName } from "./noteTitleParagraph.js";
import { withDrawingTitleWriter } from "./drawingTitleLock.js";
import { createPrivateTitleState, privateTitleStateDirectory, syncTitleDirectory, titleStatePermissions } from "./drawingTitleStorage.js";
export const DRAWING_TITLE_REFRESH_INTERVAL_MS = 300000;
const MAX_BYTES = 16384, MAX_UNCERTAIN = 4;
export interface DrawingTitleLeaseIntent {
  noteId: string;
  attachmentId: string;
  folderId: string;
  targetTitle: string;
  file: string;
  fileSha256: string;
  localBodySha256: string;
  protectedSha256: string;
  initialNoteTitle: string;
  initialAttachmentTitle: string;
  initialModificationDate: number;
  noteModificationDate: number;
}
export interface DrawingTitleLeaseObservation {
  file: string;
  fileSha256: string;
  localBodySha256: string;
  protectedSha256: string;
  noteTag: string;
  attachmentTag: string;
  noteTitle: string;
  attachmentTitle: string;
  modificationDate: number;
}
type Phase = "A" | "B" | "refresh";
interface Tags {
  note: string;
  attachment: string;
}
export type DrawingTitleLeaseRegistration = DrawingTitleLeaseIntent & { initialNoteTag: string; initialAttachmentTag: string };
interface Pending {
  token: string;
  phase: Phase;
  beforeTags: Tags;
  issuedAt: number;
}
interface Receipt extends Pick<Pending, "token" | "phase"> {
  outcome: "sdk-acknowledged" | "postcondition-observed" | "uncertain";
}
export interface DrawingTitleLeaseEntry {
  version: 2;
  revision: number;
  intent: DrawingTitleLeaseIntent;
  stage: "attachment" | "note" | "active" | "cancelled";
  tags: Tags;
  pending?: Pending;
  nextDue?: number;
  lastReceipt?: Receipt;
  recentUncertain: Receipt[];
}
export interface DrawingTitleLeaseClaim {
  entry: DrawingTitleLeaseEntry;
  dispatch: DrawingTitleLeaseDispatch | undefined;
}
export interface DrawingTitleLeaseDispatch {
  token: string;
  phase: Phase;
  recordName: string;
  recordChangeTag: string;
  targetTitle: string;
  modificationDate?: number;
}
interface RevisionObservation { expectedRevision: number; observation: DrawingTitleLeaseObservation; }
interface Options {
  vault: string;
  journalDirectory: string;
  accountDsidSha256: string;
}
interface Ports {
  now(): number;
  assertWriter?: () => Promise<void>;
}
export const drawingTitleLedgerDurability = { sync: (file: Awaited<ReturnType<typeof open>>) => file.sync() };
const defaults: Ports = { now: Date.now };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const digestFields = ["fileSha256", "localBodySha256", "protectedSha256"] as const;
function tag(value: unknown): asserts value is string { assert.ok(typeof value === "string" && /^[A-Za-z0-9_.:+-]{1,512}$/.test(value), "Invalid cloud version"); }
function time(value: unknown): asserts value is number { assert.ok(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER - DRAWING_TITLE_REFRESH_INTERVAL_MS, "Invalid lease time"); }
function title(value: unknown) { assert.ok(typeof value === "string" && value.length <= 1024 && !/[\r\n\0]/.test(value), "Invalid title"); }
function file(value: unknown) { assert.ok(typeof value === "string" && value.length <= 4096 && value.endsWith(".md") && !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== ".."), "Invalid lease note path"); }
function hashes(value: Pick<DrawingTitleLeaseIntent, typeof digestFields[number]>) { for (const key of digestFields)
  assert.match(value[key], /^[a-f0-9]{64}$/, "Invalid lease fingerprint"); }
function validateIntent(value: DrawingTitleLeaseIntent): void {
  // UUID comparisons and storage keys fold case, but CloudKit record names
  // retain the exact observed spelling used by lookup and conditional writes.
  for (const field of ["noteId", "attachmentId", "folderId"] as const) {
    assert.ok(isNoteId(value[field]), "Invalid lease identity");
  }
  assert.ok(new Set([value.noteId, value.attachmentId, value.folderId].map(id => id.toUpperCase())).size === 3, "Overlapping lease identities");
  file(value.file);
  hashes(value);
  title(value.targetTitle);
  title(value.initialNoteTitle);
  title(value.initialAttachmentTitle);
  assert.ok(value.targetTitle && titleIsRepresentable(value.targetTitle), "Invalid target title");
  assert.equal(titleFromNoteFileName(value.file), value.targetTitle, "Target title does not match filename");
  time(value.initialModificationDate);
  time(value.noteModificationDate);
  const allowed = ["noteId", "attachmentId", "folderId", "targetTitle", "file", ...digestFields, "initialNoteTitle", "initialAttachmentTitle", "initialModificationDate", "noteModificationDate"];
  assert.ok(Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key)), "Unknown lease intent fields");
}
function observation(value: DrawingTitleLeaseObservation) { file(value.file); hashes(value); tag(value.noteTag); tag(value.attachmentTag); title(value.noteTitle); title(value.attachmentTitle); time(value.modificationDate); }
function tokenPhase(value: Pick<Pending, "token" | "phase">) {
  assert.match(value.token, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, "Invalid request token");
  assert.ok(["A", "B", "refresh"].includes(value.phase), "Invalid lease phase");
}
function pending(value: Pending) {
  tokenPhase(value);
  tag(value.beforeTags.note);
  tag(value.beforeTags.attachment);
  time(value.issuedAt);
  assert.ok(Object.keys(value.beforeTags).length === 2 && Object.keys(value.beforeTags).every(key => ["note", "attachment"].includes(key)), "Unknown request version fields");
  assert.ok(Object.keys(value).every(key => ["token", "phase", "beforeTags", "issuedAt"].includes(key)), "Unknown request fields");
}
function validEntry(value: DrawingTitleLeaseEntry) {
  assert.ok(value && value.version === 2, "Unsupported drawing title ledger version: expected 2");
  assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision < Number.MAX_SAFE_INTEGER, "Invalid lease revision");
  assert.ok(["attachment", "note", "active", "cancelled"].includes(value.stage), "Invalid lease stage");
  validateIntent(value.intent);
  tag(value.tags.note);
  tag(value.tags.attachment);
  assert.ok(Object.keys(value.tags).length === 2 && Object.keys(value.tags).every(key => ["note", "attachment"].includes(key)), "Unknown lease version fields");
  assert.ok(Array.isArray(value.recentUncertain) && value.recentUncertain.length <= MAX_UNCERTAIN, "Invalid bounded request history");
  for (const receipt of [...value.recentUncertain, ...(value.lastReceipt ? [value.lastReceipt] : [])]) {
    tokenPhase(receipt);
    assert.ok(Object.keys(receipt).every(key => ["token", "phase", "outcome"].includes(key)), "Unknown receipt fields");
    assert.ok(["sdk-acknowledged", "postcondition-observed", "uncertain"].includes(receipt.outcome), "Invalid receipt outcome");
  }
  assert.ok(value.recentUncertain.every(receipt => receipt.outcome === "uncertain"), "Uncertain attempts cannot become ACKs");
  if (value.pending !== undefined) {
    pending(value.pending);
    assert.ok(value.stage === "cancelled" || (value.stage === "attachment" ? value.pending.phase === "A" : value.stage === "note" ? value.pending.phase === "B" : value.pending.phase === "refresh"), "Pending phase does not match lease stage");
  }
  if (value.nextDue !== undefined)
    time(value.nextDue);
  assert.ok(value.lastReceipt === undefined || value.lastReceipt.outcome !== "uncertain", "Uncertain receipt cannot be the completed request");
  assert.ok(value.stage !== "active" || value.nextDue !== undefined, "Missing due deadline");
  const allowed = ["version", "revision", "intent", "stage", "tags", "pending", "nextDue", "lastReceipt", "recentUncertain"];
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), "Unknown ledger fields");
  assert.ok(Buffer.byteLength(json(value)) <= MAX_BYTES, "Oversized lease");
}
/** Does not compare local filename/body: a newer filename may supersede a pending request. */
export function drawingTitlePendingPostcondition(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation): boolean {
  const pending = entry.pending;
  return !!pending && current.protectedSha256 === entry.intent.protectedSha256 && current.attachmentTitle === entry.intent.targetTitle &&
    (pending.phase === "A" ? current.attachmentTag !== pending.beforeTags.attachment && current.noteTag === pending.beforeTags.note && current.noteTitle === entry.intent.initialNoteTitle && current.modificationDate === entry.intent.initialModificationDate
      : current.noteTag !== pending.beforeTags.note && current.attachmentTag === pending.beforeTags.attachment && current.noteTitle === entry.intent.targetTitle && current.modificationDate === entry.intent.noteModificationDate);
}
async function safeRead(name: string): Promise<string | undefined> {
  const before = await lstatIfPresent(name);
  if (!before) return undefined;
  assert.ok(before.isFile() && !before.isSymbolicLink() && titleStatePermissions(before), "Unsafe ledger file");
  let handle;
  try { handle = await open(name, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch (error) { if (isEnoent(error)) return undefined; throw error; }
  try {
    const stat = await handle.stat({ bigint: true });
    assert.ok(stat.dev === before.dev && stat.ino === before.ino, "Ledger file changed while opening");
    assert.ok(stat.isFile() && titleStatePermissions(stat) && stat.size <= BigInt(MAX_BYTES), "Unsafe ledger file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    assert.ok(offset <= MAX_BYTES, "Oversized ledger file");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}
async function canonicalStoreRoot(directory: string): Promise<string> {
  let parent = path.dirname(directory);
  const suffix = [path.basename(directory)];
  for (;;) {
    try { return path.join(await realpath(parent), ...suffix); }
    catch (error) {
      if (!isEnoent(error)) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}
export async function openDrawingTitleLedger(options: Options, overrides: Partial<Ports> = {}) {
  assert.match(options.accountDsidSha256, /^[a-f0-9]{64}$/);
  assert.ok(path.isAbsolute(options.journalDirectory), "Absolute external journal required");
  const vault = await realpath(options.vault), root = await canonicalStoreRoot(path.resolve(options.journalDirectory)), rel = path.relative(vault, root);
  assert.ok(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel), "Journal must be outside the vault");
  const ports = { ...defaults, ...overrides }, leasesRoot = path.join(root, "drawing-title-leases-v1"), directory = path.join(leasesRoot, sha(JSON.stringify([vault, options.accountDsidSha256]))), pin = path.join(vault, ".icloud-md", "attachment-title-journal.json");
  const identity = async () => { const stat = await lstat(root, { bigint: true }); return json({ directory: root, accountDsidSha256: options.accountDsidSha256, dev: stat.dev.toString(), ino: stat.ino.toString() }); };
  async function safePaths() {
    let current = path.parse(directory).root;
    for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await lstatIfPresent(current);
      if (!stat) break;
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe journal ancestry");
      if (current === root || current === leasesRoot || current === directory)
        assert.ok(titleStatePermissions(stat), "Unsafe private journal directory");
    }
    const metadata = await lstat(path.dirname(pin));
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && titleStatePermissions(metadata, false), "Unsafe vault metadata directory");
    const authority = await safeRead(pin);
    if (authority !== undefined)
      assert.equal(authority, await identity(), "Title journal authority changed");
  }
  await safePaths();
  let activeWriter: (() => Promise<void>) | undefined;
  const writerGuard = () => activeWriter ?? ports.assertWriter ?? (async () => { throw Error("A current drawing title writer scope is required"); });
  let operationActive = false;
  async function operation<T>(run: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
    const assertHeld = writerGuard(); await assertHeld();
    assert.ok(!operationActive, "Another drawing title operation is running");
    operationActive = true;
    try { return await run(assertHeld); } finally { operationActive = false; }
  }
  const name = (noteId: string) => { assert.ok(isNoteId(noteId)); return path.join(directory, sha(JSON.stringify([vault, options.accountDsidSha256, noteId.toUpperCase()])) + ".json"); };
  async function readUnlocked(noteId: string) {
    await safePaths(); const raw = await safeRead(name(noteId)); if (raw === undefined) return undefined;
    const entry = JSON.parse(raw) as DrawingTitleLeaseEntry;
    validEntry(entry);
    assert.equal(entry.intent.noteId.toUpperCase(), noteId.toUpperCase(), "Wrong ledger note");
    return entry;
  }
  async function storage() {
    await safePaths();
    await privateTitleStateDirectory(root);
    await privateTitleStateDirectory(directory);
    const wanted = await identity(), existing = await safeRead(pin);
    if (existing === undefined)
      await createPrivateTitleState(pin, wanted);
    else
      assert.equal(existing, wanted, "Title journal authority changed");
  }
  async function persist(noteId: string, entry: DrawingTitleLeaseEntry, assertHeld: () => Promise<void>) {
    validEntry(entry);
    await storage();
    const destination = name(noteId), temporary = destination + ".next";
    if (await safeRead(temporary) !== undefined)
      await unlink(temporary);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(json(entry));
      await drawingTitleLedgerDurability.sync(handle);
    }
    finally {
      await handle.close();
    }
    await assertHeld();
    await safePaths();
    await assertHeld();
    await rename(temporary, destination);
    await syncTitleDirectory(directory, drawingTitleLedgerDurability.sync);
    await syncTitleDirectory(root, drawingTitleLedgerDurability.sync);
  }
  async function change(noteId: string, expectedRevision: number | undefined, run: (entry: DrawingTitleLeaseEntry | undefined, now: number) => {
    entry: DrawingTitleLeaseEntry;
    dispatch?: DrawingTitleLeaseDispatch;
  }): Promise<DrawingTitleLeaseClaim> {
    return operation(async assertHeld => {
      const entry = await readUnlocked(noteId);
      assert.equal(entry?.revision, expectedRevision, "Stale lease revision");
      const now = ports.now(); time(now);
      const decision = run(entry && structuredClone(entry), now);
      if (!equal(entry, decision.entry)) {
        decision.entry.revision = (entry?.revision ?? 0) + 1;
        await persist(noteId, decision.entry, assertHeld);
      }
      return { entry: structuredClone(decision.entry), dispatch: decision.dispatch };
    });
  }
  function common(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation) { return current.file === entry.intent.file && current.fileSha256 === entry.intent.fileSha256 && current.localBodySha256 === entry.intent.localBodySha256 && current.protectedSha256 === entry.intent.protectedSha256; }
  function stateMatches(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation) {
    const phase = entry.pending?.phase ?? (entry.stage === "attachment" ? "A" : entry.stage === "note" ? "B" : "refresh"), wanted = entry.intent;
    const expectedNote = phase === "refresh" ? wanted.targetTitle : wanted.initialNoteTitle;
    const expectedDrawing = phase !== "A" ? wanted.targetTitle : wanted.initialAttachmentTitle;
    const expectedDate = phase === "refresh" ? wanted.noteModificationDate : wanted.initialModificationDate;
    return common(entry, current) && current.noteTitle === expectedNote && current.attachmentTitle === expectedDrawing && current.modificationDate === expectedDate;
  }
  function cancelEntry(entry: DrawingTitleLeaseEntry) { entry.stage = "cancelled"; delete entry.nextDue; }
  function archive(entry: DrawingTitleLeaseEntry, pending: Pending) { entry.recentUncertain = [...entry.recentUncertain, { token: pending.token, phase: pending.phase, outcome: "uncertain" as const }].slice(-MAX_UNCERTAIN); }
  function finish(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation, now: number, outcome: Receipt["outcome"]) {
    const pending = entry.pending!;
    if (outcome === "postcondition-observed")
      archive(entry, pending);
    entry.lastReceipt = { token: pending.token, phase: pending.phase, outcome };
    entry.tags = { note: current.noteTag, attachment: current.attachmentTag };
    delete entry.pending;
    if (pending.phase === "A")
      entry.stage = "note";
    else {
      entry.stage = "active";
      entry.nextDue = Math.max(now, pending.issuedAt) + DRAWING_TITLE_REFRESH_INTERVAL_MS;
    }
  }
  async function resolve(noteId: string, args: RevisionObservation & { token?: string }, acknowledged: boolean) {
    observation(args.observation);
    return (await change(noteId, args.expectedRevision, (entry, now) => {
      assert.ok(entry?.pending, "No pending title request");
      if (acknowledged)
        assert.equal(args.token, entry.pending.token, "Wrong request token");
      const pending = entry.pending, current = args.observation, targetChanged = pending.phase === "A" ? current.attachmentTag !== pending.beforeTags.attachment : current.noteTag !== pending.beforeTags.note;
      const untouchedSame = pending.phase === "A" ? current.noteTag === pending.beforeTags.note : current.attachmentTag === pending.beforeTags.attachment;
      if (entry.stage !== "cancelled" && common(entry, current) && drawingTitlePendingPostcondition(entry, current))
        finish(entry, current, now, acknowledged ? "sdk-acknowledged" : "postcondition-observed");
      else if (!stateMatches(entry, current) || !untouchedSame || entry.stage === "cancelled") {
        cancelEntry(entry);
        if (targetChanged) {
          archive(entry, pending);
          delete entry.pending;
        }
      }
      return { entry };
    })).entry;
  }
  return {
    /** Bind planning, dispatch and final bookkeeping to one participating run. */
    writerGuard,
    withWriter: async <T>(run: () => Promise<T>): Promise<T> => {
      await storage();
      return withDrawingTitleWriter(directory, async guard => {
        assert.ok(!activeWriter, "Drawing title writer already active");
        activeWriter = guard;
        try { return await run(); } finally { activeWriter = undefined; }
      });
    },
    /** Hold execution ownership through the final checks and single SDK call.
     * The callback must not invoke ledger mutations; acknowledge afterwards. */
    withDispatch: async <T>(noteId: string, args: { expectedRevision: number; token: string }, send: () => Promise<T>): Promise<T> => operation(async assertHeld => {
        const entry = await readUnlocked(noteId);
        assert.ok(entry && entry.revision === args.expectedRevision && entry.pending && entry.pending.token === args.token && entry.stage !== "cancelled", "Stale or cancelled dispatch authority");
        const now = ports.now(); time(now);
        assert.ok(now >= entry.pending.issuedAt && now - entry.pending.issuedAt <= DRAWING_TITLE_REFRESH_INTERVAL_MS, "Expired title dispatch authority");
        await assertHeld();
        const result = await send();
        await assertHeld();
        return result;
    }),
    read: readUnlocked,
    listNoteIds: async () => { await safePaths(); let files; try {
      files = await readdir(directory);
    }
    catch (error) {
      if (isEnoent(error))
        return [];
      throw error;
    } const ids: string[] = []; for (const item of files) {
      if (item === "writer.lockdir") continue;
      assert.ok(/^[a-f0-9]{64}\.json(?:\.next)?$/.test(item), "Unknown lease storage file");
      if (!item.endsWith(".json")) { await safeRead(path.join(directory, item)); continue; }
      const raw = await safeRead(path.join(directory, item));
      assert.ok(raw);
      const entry = JSON.parse(raw) as DrawingTitleLeaseEntry;
      validEntry(entry);
      assert.equal(path.basename(name(entry.intent.noteId)), item, "Wrong ledger scope");
      ids.push(entry.intent.noteId);
    } return ids.sort(); },
    register: async (input: DrawingTitleLeaseRegistration, args: {
      expectedRevision?: number;
    } = {}) => {
      const { initialNoteTag, initialAttachmentTag, ...data } = input;
      tag(initialNoteTag); tag(initialAttachmentTag);
      validateIntent(data);
      const intent = data;
      return (await change(intent.noteId, args.expectedRevision, entry => {
        const binding = (value: DrawingTitleLeaseIntent) => ({ noteId: value.noteId.toUpperCase(), attachmentId: value.attachmentId.toUpperCase(), folderId: value.folderId.toUpperCase(), targetTitle: value.targetTitle, file: value.file, ...Object.fromEntries(digestFields.map(field => [field, value[field]])) });
        if (entry && equal(binding(entry.intent), binding(intent)))
          return { entry };
        assert.ok(!entry?.pending, "Pending title request cannot be replaced");
        return { entry: { version: 2 as const, revision: 1, intent, stage: "attachment" as const, tags: { note: initialNoteTag, attachment: initialAttachmentTag }, recentUncertain: entry?.recentUncertain ?? [] } };
      })).entry;
    },
    claim: async (noteId: string, args: RevisionObservation) => {
      observation(args.observation);
      return change(noteId, args.expectedRevision, (entry, now) => {
        assert.ok(entry, "Missing title lease");
        const current = args.observation;
        if (entry.stage === "cancelled")
          return { entry };
        if (!stateMatches(entry, current)) {
          cancelEntry(entry);
          return { entry };
        }
        if (entry.pending) {
          if (entry.pending.phase !== "refresh" || now < entry.pending.issuedAt + DRAWING_TITLE_REFRESH_INTERVAL_MS)
            return { entry };
          archive(entry, entry.pending); // A new rate-limited request, never replay or ACK.
        }
        else if (entry.stage === "active" && now < entry.nextDue!)
          return { entry };
        if (entry.stage !== "active" && (current.noteTag !== entry.tags.note || current.attachmentTag !== entry.tags.attachment)) {
          cancelEntry(entry);
          return { entry };
        }
        const phase: Phase = entry.stage === "attachment" ? "A" : entry.stage === "note" ? "B" : "refresh";
        const tags = { note: current.noteTag, attachment: current.attachmentTag };
        const request: Pending = { token: randomUUID(), phase, beforeTags: tags, issuedAt: now };
        entry.pending = request;
        const dispatch: DrawingTitleLeaseDispatch = { token: request.token, phase, recordName: phase === "A" ? entry.intent.attachmentId : entry.intent.noteId, recordChangeTag: phase === "A" ? current.attachmentTag : current.noteTag, targetTitle: entry.intent.targetTitle, ...(phase === "B" ? { modificationDate: entry.intent.noteModificationDate } : {}) };
        return { entry, dispatch };
      });
    },
    acknowledge: (noteId: string, args: RevisionObservation & { token: string }) => resolve(noteId, args, true),
    resolvePending: (noteId: string, args: RevisionObservation) => resolve(noteId, args, false),
    cancel: async (noteId: string, args: {
      expectedRevision: number;
      reason: string;
    }) => (await change(noteId, args.expectedRevision, entry => { assert.ok(entry); cancelEntry(entry); return { entry }; })).entry,
  };
}
