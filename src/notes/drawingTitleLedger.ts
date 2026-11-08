/** Bounded, private Linux-only metadata lease ledger. A dispatch is returned only
* after its unique intent is durable. Cloud postconditions are never SDK ACKs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { isNoteId } from "./noteIdFrontmatter.js";
import { titleIsRepresentable } from "./titleFilename.js";
import { titleFromNoteFileName } from "./noteTitleParagraph.js";
import { getAttachmentTitleLockAuthority } from "./attachmentTitleLock.js";
import { createProbeJournal, privateProbeDirectory } from "./attachmentTitleProbeJournal.js";
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
  documentSha256: string;
  assetRefsSha256: string;
  protectedSha256: string;
  initialNoteTitle: string;
  initialAttachmentTitle: string;
  initialNoteTag: string;
  initialAttachmentTag: string;
  initialModificationDate: number;
  noteModificationDate: number;
}
export interface DrawingTitleLeaseObservation {
  file: string;
  fileSha256: string;
  localBodySha256: string;
  documentSha256: string;
  assetRefsSha256: string;
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
interface Pending {
  token: string;
  phase: Phase;
  beforeTags: Tags;
  issuedAt: number;
  recordName: string;
  targetTitle: string;
  requestSha256: string;
}
interface Receipt extends Pending {
  outcome: "sdk-acknowledged" | "postcondition-observed" | "uncertain";
  observedAt: number;
}
export interface DrawingTitleLeaseEntry {
  version: 1;
  revision: number;
  intent: DrawingTitleLeaseIntent;
  stage: "attachment" | "note" | "active" | "cancelled";
  tags: Tags;
  pending?: Pending;
  nextDue?: number;
  lastAcknowledgedAt?: number;
  lastReceipt?: Receipt;
  recentUncertain: Receipt[];
  uncertainCount: number;
  cancelReason?: string;
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
interface Options {
  vault: string;
  journalDirectory: string;
  accountDsidSha256: string;
}
interface Ports {
  now(): number;
  lockAuthority: typeof getAttachmentTitleLockAuthority;
}
export const drawingTitleLedgerDurability = { sync: (file: Awaited<ReturnType<typeof open>>) => file.sync() };
const defaults: Ports = { now: Date.now, lockAuthority: getAttachmentTitleLockAuthority };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const json = (value: unknown) => JSON.stringify(stable(value));
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const digestFields = ["fileSha256", "localBodySha256", "documentSha256", "assetRefsSha256", "protectedSha256"] as const;
function tag(value: unknown): asserts value is string { assert.ok(typeof value === "string" && /^[A-Za-z0-9_.:+-]{1,512}$/.test(value), "Invalid cloud version"); }
function time(value: unknown): asserts value is number { assert.ok(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER - DRAWING_TITLE_REFRESH_INTERVAL_MS, "Invalid lease time"); }
function title(value: unknown) { assert.ok(typeof value === "string" && value.length <= 1024 && !/[\r\n\0]/.test(value), "Invalid title"); }
function file(value: unknown) { assert.ok(typeof value === "string" && value.length <= 4096 && value.endsWith(".md") && !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== ".."), "Invalid lease note path"); }
function hashes(value: Pick<DrawingTitleLeaseIntent, typeof digestFields[number]>) { for (const key of digestFields)
  assert.match(value[key], /^[a-f0-9]{64}$/, "Invalid lease fingerprint"); }
function normalizeIntent(input: DrawingTitleLeaseIntent): DrawingTitleLeaseIntent {
  const value = structuredClone(input);
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
  tag(value.initialNoteTag);
  tag(value.initialAttachmentTag);
  time(value.initialModificationDate);
  time(value.noteModificationDate);
  const allowed = ["noteId", "attachmentId", "folderId", "targetTitle", "file", ...digestFields, "initialNoteTitle", "initialAttachmentTitle", "initialNoteTag", "initialAttachmentTag", "initialModificationDate", "noteModificationDate"];
  assert.ok(Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key)), "Unknown lease intent fields");
  return value;
}
function observation(value: DrawingTitleLeaseObservation) { file(value.file); hashes(value); tag(value.noteTag); tag(value.attachmentTag); title(value.noteTitle); title(value.attachmentTitle); time(value.modificationDate); }
function pending(value: Pending) {
  assert.match(value.token, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, "Invalid request token");
  assert.ok(["A", "B", "refresh"].includes(value.phase), "Invalid lease phase");
  tag(value.beforeTags.note);
  tag(value.beforeTags.attachment);
  time(value.issuedAt);
  title(value.targetTitle);
  assert.ok(isNoteId(value.recordName), "Invalid pending record");
  assert.match(value.requestSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.keys(value.beforeTags).length === 2 && Object.keys(value.beforeTags).every(key => ["note", "attachment"].includes(key)), "Unknown request version fields");
  assert.ok(Object.keys(value).every(key => ["token", "phase", "beforeTags", "issuedAt", "recordName", "targetTitle", "requestSha256", "outcome", "observedAt"].includes(key)), "Unknown request fields");
}
function validEntry(value: DrawingTitleLeaseEntry) {
  assert.ok(value && value.version === 1 && Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision < Number.MAX_SAFE_INTEGER, "Invalid lease revision");
  assert.ok(["attachment", "note", "active", "cancelled"].includes(value.stage), "Invalid lease stage");
  assert.ok(equal(value.intent, normalizeIntent(value.intent)), "Noncanonical lease identity");
  tag(value.tags.note);
  tag(value.tags.attachment);
  assert.ok(Object.keys(value.tags).length === 2 && Object.keys(value.tags).every(key => ["note", "attachment"].includes(key)), "Unknown lease version fields");
  assert.ok(Array.isArray(value.recentUncertain) && value.recentUncertain.length <= MAX_UNCERTAIN && Number.isSafeInteger(value.uncertainCount) && value.uncertainCount >= value.recentUncertain.length, "Invalid bounded request history");
  for (const receipt of [...value.recentUncertain, ...(value.lastReceipt ? [value.lastReceipt] : [])]) {
    pending(receipt);
    time(receipt.observedAt);
    assert.ok(["sdk-acknowledged", "postcondition-observed", "uncertain"].includes(receipt.outcome), "Invalid receipt outcome");
  }
  assert.ok(value.recentUncertain.every(receipt => receipt.outcome === "uncertain"), "Uncertain attempts cannot become ACKs");
  if (value.pending) {
    pending(value.pending);
    assert.equal(value.pending.targetTitle, value.intent.targetTitle, "Pending title identity changed");
    assert.equal(value.pending.recordName, value.pending.phase === "A" ? value.intent.attachmentId : value.intent.noteId, "Pending record identity changed");
    assert.equal(value.pending.requestSha256, requestHash(value.intent, value.pending.phase, value.pending.beforeTags), "Pending request identity changed");
    assert.ok(value.stage === "cancelled" || (value.stage === "attachment" ? value.pending.phase === "A" : value.stage === "note" ? value.pending.phase === "B" : value.pending.phase === "refresh"), "Pending phase does not match lease stage");
  }
  if (value.nextDue !== undefined)
    time(value.nextDue);
  if (value.lastAcknowledgedAt !== undefined)
    time(value.lastAcknowledgedAt);
  assert.ok(value.lastReceipt === undefined || value.lastReceipt.outcome !== "uncertain", "Uncertain receipt cannot be the completed request");
  assert.ok(value.stage !== "active" || value.nextDue !== undefined, "Missing due deadline");
  assert.ok(value.cancelReason === undefined || ["observation-changed", "caller-cancelled"].includes(value.cancelReason), "Invalid cancellation reason");
  const allowed = ["version", "revision", "intent", "stage", "tags", "pending", "nextDue", "lastAcknowledgedAt", "lastReceipt", "recentUncertain", "uncertainCount", "cancelReason"];
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), "Unknown ledger fields");
  assert.ok(Buffer.byteLength(json(value)) <= MAX_BYTES, "Oversized lease");
}
function requestHash(intent: DrawingTitleLeaseIntent, phase: Phase, tags: Tags) {
  return sha(json({ phase, recordName: phase === "A" ? intent.attachmentId : intent.noteId,
    recordChangeTag: phase === "A" ? tags.attachment : tags.note, targetTitle: intent.targetTitle,
    ...(phase === "B" ? { modificationDate: intent.noteModificationDate } : {}) }));
}
async function safeRead(name: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  catch (error) {
    if (isEnoent(error))
      return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= MAX_BYTES, "Unsafe ledger file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead)
        break;
      offset += read.bytesRead;
    }
    assert.ok(offset <= MAX_BYTES, "Oversized ledger file");
    return bytes.subarray(0, offset).toString("utf8");
  }
  finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string) { const handle = await open(directory, "r"); try {
  await drawingTitleLedgerDurability.sync(handle);
}
finally {
  await handle.close();
} }
const locks = new Map<string, Promise<void>>();
async function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
  locks.set(key, current);
  await previous;
  await Promise.resolve();
  try {
    return await run();
  }
  finally {
    release();
    if (locks.get(key) === current)
      locks.delete(key);
  }
}
export async function openDrawingTitleLedger(options: Options, overrides: Partial<Ports> = {}) {
  assert.match(options.accountDsidSha256, /^[a-f0-9]{64}$/);
  assert.ok(path.isAbsolute(options.journalDirectory), "Absolute external journal required");
  const vault = await realpath(options.vault), root = path.resolve(options.journalDirectory), rel = path.relative(vault, root);
  assert.ok(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel), "Journal must be outside the vault");
  const ports = { ...defaults, ...overrides }, leasesRoot = path.join(root, "drawing-title-leases-v1"), directory = path.join(leasesRoot, sha(JSON.stringify([vault, options.accountDsidSha256]))), pin = path.join(vault, ".icloud-md", "attachment-title-journal.json");
  const identity = async () => { const stat = await lstat(root, { bigint: true }); return json({ directory: root, accountDsidSha256: options.accountDsidSha256, dev: stat.dev.toString(), ino: stat.ino.toString() }); };
  async function safePaths() {
    let current = path.parse(directory).root;
    for (const part of directory.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe journal ancestry");
        if (current === root || current === leasesRoot || current === directory)
          assert.ok(stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "Unsafe private journal directory");
      }
      catch (error) {
        if (isEnoent(error))
          break;
        throw error;
      }
    }
    const metadata = await lstat(path.dirname(pin));
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid?.(), "Unsafe vault metadata directory");
    const authority = await safeRead(pin);
    if (authority !== undefined)
      assert.equal(authority, await identity(), "Title journal authority changed");
  }
  await safePaths();
  const name = (noteId: string) => { assert.ok(isNoteId(noteId)); return path.join(directory, sha(JSON.stringify([vault, options.accountDsidSha256, noteId.toUpperCase()])) + ".json"); };
  async function readUnlocked(noteId: string) { await safePaths(); const raw = await safeRead(name(noteId)); if (raw === undefined)
    return undefined; const entry = JSON.parse(raw) as DrawingTitleLeaseEntry; validEntry(entry); assert.equal(entry.intent.noteId.toUpperCase(), noteId.toUpperCase(), "Wrong ledger note"); return entry; }
  async function storage() {
    await safePaths();
    await privateProbeDirectory(root);
    await privateProbeDirectory(directory);
    const wanted = await identity(), existing = await safeRead(pin);
    if (existing === undefined)
      await createProbeJournal(pin, wanted);
    else
      assert.equal(existing, wanted, "Title journal authority changed");
  }
  async function kernelLock(file: string) {
    await storage();
    const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      assert.ok(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "Unsafe note lease lock");
      // Separate open descriptions exclude sibling workers that inherited the
      // SAME normal-sync flock. The descriptor remains held in this process.
      const held = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
      assert.equal(held.status, 0, "Another worker holds the lease lock");
      return handle;
    }
    catch (error) {
      await handle.close();
      throw error;
    }
  }
  const noteLock = (noteId: string) => kernelLock(name(noteId).replace(/\.json$/, ".lock"));
  async function persist(noteId: string, entry: DrawingTitleLeaseEntry, authority: Awaited<ReturnType<Ports["lockAuthority"]>>) {
    validEntry(entry);
    await safePaths();
    await privateProbeDirectory(root);
    await privateProbeDirectory(directory);
    const wanted = await identity(), existing = await safeRead(pin);
    if (existing === undefined)
      await createProbeJournal(pin, wanted);
    else
      assert.equal(existing, wanted, "Title journal authority changed");
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
    assert.ok(equal(await ports.lockAuthority(), authority), "Sync lock authority changed");
    await safePaths();
    await rename(temporary, destination);
    await syncDirectory(directory);
    await syncDirectory(root);
  }
  async function change<T>(noteId: string, expectedRevision: number | undefined, run: (entry: DrawingTitleLeaseEntry | undefined, now: number) => {
    entry: DrawingTitleLeaseEntry;
    result: (entry: DrawingTitleLeaseEntry) => T;
    changed?: boolean;
  }) {
    return serialize(name(noteId), async () => {
      const authority = await ports.lockAuthority(), held = await noteLock(noteId);
      try {
        const entry = await readUnlocked(noteId);
        assert.equal(entry?.revision, expectedRevision, "Stale lease revision");
        const now = ports.now();
        time(now);
        const decision = run(entry && structuredClone(entry), now);
        if (decision.changed !== false) {
          decision.entry.revision = (entry?.revision ?? 0) + 1;
          await persist(noteId, decision.entry, authority);
        }
        return decision.result(structuredClone(decision.entry));
      }
      finally {
        await held.close();
      }
    });
  }
  function common(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation) { return current.file === entry.intent.file && digestFields.every(field => current[field] === entry.intent[field]); }
  function stateMatches(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation, after: boolean) {
    const phase = entry.pending?.phase ?? (entry.stage === "attachment" ? "A" : entry.stage === "note" ? "B" : "refresh"), wanted = entry.intent;
    const expectedNote = phase === "refresh" || (after && phase === "B") ? wanted.targetTitle : wanted.initialNoteTitle;
    const expectedDrawing = phase !== "A" || after ? wanted.targetTitle : wanted.initialAttachmentTitle;
    const expectedDate = phase === "refresh" || (after && phase === "B") ? wanted.noteModificationDate : wanted.initialModificationDate;
    return common(entry, current) && current.noteTitle === expectedNote && current.attachmentTitle === expectedDrawing && current.modificationDate === expectedDate;
  }
  function cancelEntry(entry: DrawingTitleLeaseEntry) { entry.stage = "cancelled"; entry.cancelReason = "observation-changed"; delete entry.nextDue; }
  function archive(entry: DrawingTitleLeaseEntry, pending: Pending, now: number) { entry.recentUncertain = [...entry.recentUncertain, { ...pending, outcome: "uncertain" as const, observedAt: now }].slice(-MAX_UNCERTAIN); entry.uncertainCount += 1; }
  function finish(entry: DrawingTitleLeaseEntry, current: DrawingTitleLeaseObservation, now: number, outcome: Receipt["outcome"]) {
    const pending = entry.pending!;
    if (outcome === "postcondition-observed")
      archive(entry, pending, now);
    entry.lastReceipt = { ...pending, outcome, observedAt: now };
    entry.tags = { note: current.noteTag, attachment: current.attachmentTag };
    delete entry.pending;
    if (pending.phase === "A")
      entry.stage = "note";
    else {
      entry.stage = "active";
      if (outcome === "sdk-acknowledged")
        entry.lastAcknowledgedAt = now;
      entry.nextDue = Math.max(now, pending.issuedAt) + DRAWING_TITLE_REFRESH_INTERVAL_MS;
    }
  }
  async function resolve(noteId: string, args: {
    expectedRevision: number;
    token?: string;
    observation: DrawingTitleLeaseObservation;
  }, acknowledged: boolean) {
    observation(args.observation);
    return change(noteId, args.expectedRevision, (entry, now) => {
      assert.ok(entry?.pending, "No pending title request");
      if (acknowledged)
        assert.equal(args.token, entry.pending.token, "Wrong request token");
      const pending = entry.pending, current = args.observation, targetChanged = pending.phase === "A" ? current.attachmentTag !== pending.beforeTags.attachment : current.noteTag !== pending.beforeTags.note;
      const untouchedSame = pending.phase === "A" ? current.noteTag === pending.beforeTags.note : current.attachmentTag === pending.beforeTags.attachment;
      if (entry.stage !== "cancelled" && targetChanged && untouchedSame && stateMatches(entry, current, true))
        finish(entry, current, now, acknowledged ? "sdk-acknowledged" : "postcondition-observed");
      else if (!stateMatches(entry, current, false) || !untouchedSame || entry.stage === "cancelled") {
        cancelEntry(entry);
        if (targetChanged) {
          archive(entry, pending, now);
          delete entry.pending;
        }
      }
      else
        return { entry, result: (value: DrawingTitleLeaseEntry) => value, changed: false };
      return { entry, result: (value: DrawingTitleLeaseEntry) => value };
    });
  }
  return {
    /** Exclude sibling writers across planning, SDK operations and clone-state
     * bookkeeping. This lock is distinct from all note locks used inside run. */
    withVaultWriter: async <T>(run: () => Promise<T>): Promise<T> => serialize(path.join(directory, "writer.lock"), async () => {
      const authority = await ports.lockAuthority(), held = await kernelLock(path.join(directory, "writer.lock"));
      try {
        assert.ok(equal(await ports.lockAuthority(), authority), "Sync lock authority changed");
        const result = await run();
        assert.ok(equal(await ports.lockAuthority(), authority), "Sync lock authority changed");
        return result;
      } finally { await held.close(); }
    }),
    /** Hold execution ownership through the final checks and single SDK call.
     * The callback must not invoke ledger mutations; acknowledge afterwards. */
    withDispatch: async <T>(noteId: string, args: { expectedRevision: number; token: string }, send: () => Promise<T>): Promise<T> => serialize(name(noteId), async () => {
      const authority = await ports.lockAuthority(), held = await noteLock(noteId);
      try {
        const entry = await readUnlocked(noteId);
        assert.ok(entry && entry.revision === args.expectedRevision && entry.pending && entry.pending.token === args.token && entry.stage !== "cancelled", "Stale or cancelled dispatch authority");
        const now = ports.now(); time(now);
        assert.ok(now >= entry.pending.issuedAt && now - entry.pending.issuedAt <= DRAWING_TITLE_REFRESH_INTERVAL_MS, "Expired title dispatch authority");
        assert.ok(equal(await ports.lockAuthority(), authority), "Sync lock authority changed");
        const result = await send();
        assert.ok(equal(await ports.lockAuthority(), authority), "Sync lock authority changed");
        return result;
      } finally { await held.close(); }
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
      assert.ok(item === "writer.lock" || /^[a-f0-9]{64}\.(?:json(?:\.next)?|lock)$/.test(item), "Unknown lease storage file");
      if (!item.endsWith(".json")) { await safeRead(path.join(directory, item)); continue; }
      const raw = await safeRead(path.join(directory, item));
      assert.ok(raw);
      const entry = JSON.parse(raw) as DrawingTitleLeaseEntry;
      validEntry(entry);
      assert.equal(path.basename(name(entry.intent.noteId)), item, "Wrong ledger scope");
      ids.push(entry.intent.noteId);
    } return ids.sort(); },
    register: async (input: DrawingTitleLeaseIntent, args: {
      expectedRevision?: number;
    } = {}) => {
      const intent = normalizeIntent(input);
      return change(intent.noteId, args.expectedRevision, entry => {
        const binding = (value: DrawingTitleLeaseIntent) => ({ noteId: value.noteId.toUpperCase(), attachmentId: value.attachmentId.toUpperCase(), folderId: value.folderId.toUpperCase(), targetTitle: value.targetTitle, file: value.file, ...Object.fromEntries(digestFields.map(field => [field, value[field]])) });
        if (entry && equal(binding(entry.intent), binding(intent)))
          return { entry, changed: false, result: (value: DrawingTitleLeaseEntry) => value };
        assert.ok(!entry?.pending, "Pending title request cannot be replaced");
        return { entry: { version: 1 as const, revision: 1, intent, stage: "attachment" as const, tags: { note: intent.initialNoteTag, attachment: intent.initialAttachmentTag }, recentUncertain: entry?.recentUncertain ?? [], uncertainCount: entry?.uncertainCount ?? 0 }, result: (value: DrawingTitleLeaseEntry) => value };
      });
    },
    claim: async (noteId: string, args: {
      expectedRevision: number;
      observation: DrawingTitleLeaseObservation;
    }) => {
      observation(args.observation);
      return change<DrawingTitleLeaseClaim>(noteId, args.expectedRevision, (entry, now) => {
        assert.ok(entry, "Missing title lease");
        const current = args.observation;
        if (entry.stage === "cancelled")
          return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch: undefined }), changed: false };
        if (!stateMatches(entry, current, false)) {
          cancelEntry(entry);
          return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch: undefined }) };
        }
        if (entry.pending) {
          if (entry.pending.phase !== "refresh" || now < entry.pending.issuedAt + DRAWING_TITLE_REFRESH_INTERVAL_MS)
            return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch: undefined }), changed: false };
          archive(entry, entry.pending, now); // A new rate-limited request, never replay or ACK.
        }
        else if (entry.stage === "active" && now < entry.nextDue!)
          return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch: undefined }), changed: false };
        if (entry.stage !== "active" && (current.noteTag !== entry.tags.note || current.attachmentTag !== entry.tags.attachment)) {
          cancelEntry(entry);
          return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch: undefined }) };
        }
        const phase: Phase = entry.stage === "attachment" ? "A" : entry.stage === "note" ? "B" : "refresh";
        const tags = { note: current.noteTag, attachment: current.attachmentTag };
        const request: Pending = { token: randomUUID(), phase, beforeTags: tags, issuedAt: now, recordName: phase === "A" ? entry.intent.attachmentId : entry.intent.noteId, targetTitle: entry.intent.targetTitle, requestSha256: requestHash(entry.intent, phase, tags) };
        entry.pending = request;
        const dispatch: DrawingTitleLeaseDispatch = { token: request.token, phase, recordName: phase === "A" ? entry.intent.attachmentId : entry.intent.noteId, recordChangeTag: phase === "A" ? current.attachmentTag : current.noteTag, targetTitle: entry.intent.targetTitle, ...(phase === "B" ? { modificationDate: entry.intent.noteModificationDate } : {}) };
        return { entry, result: (value: DrawingTitleLeaseEntry) => ({ entry: value, dispatch }) };
      });
    },
    acknowledge: (noteId: string, args: {
      expectedRevision: number;
      token: string;
      observation: DrawingTitleLeaseObservation;
    }) => resolve(noteId, args, true),
    resolvePending: (noteId: string, args: {
      expectedRevision: number;
      observation: DrawingTitleLeaseObservation;
    }) => resolve(noteId, args, false),
    cancel: (noteId: string, args: {
      expectedRevision: number;
      reason: string;
    }) => change(noteId, args.expectedRevision, entry => { assert.ok(entry); entry.stage = "cancelled"; entry.cancelReason = "caller-cancelled"; delete entry.nextDue; return { entry, result: (value: DrawingTitleLeaseEntry) => value }; }),
  };
}
