import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdate } from "../cloudkit/databaseClient.js";
import { isEnoent } from "../fsUtil.js";
import { readCloneState, type CloneState, type CloneStateAccount } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { readLocalNote } from "../notes/localFileState.js";
import { isNoteId, readNoteId, readNoteTitleKey } from "../notes/noteIdFrontmatter.js";
import type { SerializedPlanEntry } from "../notes/pushPlan.js";
import { indexUntrackedNoteIds } from "../notes/untrackedFiles.js";
import { createBridgeIO, type BridgeBaseline, type MacRequest } from "./adapters.js";
import { snapshotAssets } from "./assets.js";
import { runBridge, type RenameIntent } from "./bridge.js";
import { invokeMac, sshInvocation, type MacResult } from "./mac.js";
import { nativeWorkerPython } from "./nativeWorker.js";
import { drawingScope, encryptedTitle, selectLocalRename, sha256, type LocalRename } from "./model.js";
import { createJson, privateDirectory, readJson } from "./storage.js";

export interface BridgeConfig {
  version: number; enabled: boolean; sshTarget: string; storeUuid: string; macBuild: string;
  accountDsidSha256: string; allowedNoteIds: string[]; journalDirectory: string;
}
export function parseBridgeConfig(value: unknown): BridgeConfig {
  assert.ok(value && typeof value === "object");
  const c = value as BridgeConfig;
  assert.equal(c.version, 1); assert.equal(typeof c.enabled, "boolean");
  assert.equal(typeof c.sshTarget, "string"); sshInvocation(c.sshTarget, {});
  assert.ok(typeof c.storeUuid === "string" && isNoteId(c.storeUuid));
  assert.equal(c.macBuild, "25G83", "Mac build has not been verified");
  assert.ok(typeof c.accountDsidSha256 === "string" && /^[a-f0-9]{64}$/.test(c.accountDsidSha256));
  assert.ok(Array.isArray(c.allowedNoteIds) && c.allowedNoteIds.length <= 16 && c.allowedNoteIds.every(id => typeof id === "string" && isNoteId(id)));
  assert.ok(typeof c.journalDirectory === "string" && path.isAbsolute(c.journalDirectory));
  return { version: 1, enabled: c.enabled, sshTarget: c.sshTarget, storeUuid: c.storeUuid.toUpperCase(), macBuild: c.macBuild,
    accountDsidSha256: c.accountDsidSha256, allowedNoteIds: [...new Set(c.allowedNoteIds.map(id => id.toUpperCase()))].sort(), journalDirectory: path.resolve(c.journalDirectory) };
}
type State = Pick<CloneState, "notes" | "account" | "titleMode">;
export interface CompanionPorts {
  readState(vault: string): Promise<State | undefined>;
  preview(vault: string, state: State, allowed: string[]): Promise<{ entries: SerializedPlanEntry[]; notices: unknown[] }>;
  connect(vault: string, account: CloneStateAccount): Promise<{ lookup(ids: string[]): Promise<CloudKitRecord[]>; update(update: RecordUpdate): Promise<void> }>;
  assets(records: CloudKitRecord[]): Promise<unknown[]>;
  mac(target: string, request: MacRequest): Promise<MacResult>;
}
const defaults: CompanionPorts = {
  readState: readCloneState,
  preview: async (vault, state, allowed) => {
    // Ordinary push planning may merge files even with dryRun. Discover only
    // identity-based local moves here, with no cloud planner or local writes.
    const index = await indexUntrackedNoteIds(vault, state.notes, "filename");
    assert.equal(index.unreadable.length, 0, "Untracked files could hide duplicate note identities");
    const entries: SerializedPlanEntry[] = [];
    for (const [id, entry] of Object.entries(state.notes)) {
      if (!allowed.includes(id.toUpperCase()) || !(await absent(path.join(vault, entry.file)))) continue;
      const claims = [...index.claims].filter(([claimed]) => claimed.toUpperCase() === id.toUpperCase()).flatMap(([, files]) => files);
      assert.ok(claims.length <= 1, "Several files claim this drawing's identity");
      if (claims[0]) entries.push({ kind: "move", resolution: "ready", file: claims[0], previousFile: entry.file });
    }
    return { entries, notices: [] };
  },
  connect: async (vault, account) => {
    const auth = await resolveFolderAccount(vault, account);
    const host = auth.ckdatabasewsUrl;
    assert.ok(host, "Notes database is unavailable for this account");
    const zone = { zoneName: "Notes" };
    return {
      lookup: ids => lookupRecords(auth.session, host, auth.dsid, "private", zone, ids),
      update: async update => {
        const results = await updateRecords(auth.session, host, auth.dsid, "private", zone, [update]);
        assert.ok(results.length === 1 && results[0]!.ok, "Cloud title update was rejected or unclear");
      },
    };
  },
  assets: snapshotAssets,
  mac: async (target, request) => invokeMac(target, request),
};
interface Saved { version: number; configHash: string; local: LocalRename; intent: RenameIntent; baseline: BridgeBaseline; }
export interface CompanionResult { status: "disabled" | "preview" | "skipped" | "pending" | "ambiguous" | "completed"; stage?: string; file?: string; }
const outside = (root: string, file: string): boolean => { const relative = path.relative(root, file); return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative); };
async function absent(file: string) { try { await lstat(file); return false; } catch (error) { if (isEnoent(error)) return true; throw error; } }

/** Opt-in companion for a checked sync wrapper. It never updates local note
 * bytes/state. Ordinary pull adopts the matching filename after completion;
 * a wrapper must refuse a remaining managed move rather than echo its document.
 * Caller holds the same flock as pull/status/push, including resumed attempts. */
export async function runCompanion(vault: string, rawConfig: unknown, apply = false, overrides: Partial<CompanionPorts> = {}): Promise<CompanionResult> {
  const config = parseBridgeConfig(rawConfig), ports = { ...defaults, ...overrides };
  if (!config.enabled) return { status: "disabled" };
  const state = await ports.readState(vault);
  assert.ok(state?.account && state.titleMode === "filename", "A bound filename-title vault is required");
  assert.equal(sha256(state.account.dsid), config.accountDsidSha256, "Wrong vault account");
  const vaultReal = await realpath(vault);
  assert.ok(outside(vaultReal, config.journalDirectory), "Journal must be outside the vault");
  const configHash = sha256(JSON.stringify(config) + sha256(nativeWorkerPython));
  let saved: Saved | undefined;
  // A pull may adopt the new filename after B while the Mac is still pending.
  // Resume private journals BEFORE interpreting an empty ordinary push preview.
  for (const id of config.allowedNoteIds) {
    const directory = path.join(config.journalDirectory, id);
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if (isEnoent(error)) continue; throw error; }
    for (const name of names) {
      assert.match(name, /^[a-f0-9]{64}$/);
      const attempt = path.join(directory, name);
      if (await readJson(path.join(attempt, "complete.json")) !== undefined) continue;
      const pending = await readJson<Saved>(path.join(attempt, "baseline.json"));
      if (pending === undefined) continue;
      assert.ok(!saved, "More than one rename is pending; inspect the journal");
      assert.equal(pending.version, 1); assert.equal(pending.configHash, configHash, "Pending rename belongs to another configuration/build");
      assert.equal(pending.local.noteId.toUpperCase(), id);
      assert.equal(sha256(pending.intent.id), name);
      saved = pending;
    }
  }
  const preview = await ports.preview(vault, state, config.allowedNoteIds);
  assert.equal(preview.notices.length, 0, "Sync notices require review before a drawing rename");
  const local = saved?.local ?? selectLocalRename(state, preview.entries, config.allowedNoteIds);
  if (!local) return { status: "skipped" };
  const entry = state.notes[local.noteId];
  assert.ok(entry && [local.previousFile, local.file].includes(entry.file) && entry.sharedZoneOwner === undefined && entry.folderRecordName?.toUpperCase() === local.folderId.toUpperCase(), "Tracked identity or folder changed");
  const target = path.join(vault, local.file);
  const originalBytes = await readFile(target);
  const fileHash = sha256(originalBytes);
  async function checkLocal() {
    const stat = await lstat(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && !outside(vaultReal, await realpath(target)), "Unsafe local note path");
    if (local!.previousFile !== local!.file) assert.ok(await absent(path.join(vault, local!.previousFile)), "Original file reappeared; rename is ambiguous");
    assert.equal(sha256(await readFile(target)), saved?.intent.fileSha256 ?? fileHash, "Local note or rename request changed");
    const parsed = await readLocalNote(vault, { ...entry!, file: local!.file }, local!.noteId, "filename");
    assert.ok(parsed.status === "clean", "Only an unchanged drawing body can be renamed");
    assert.equal(readNoteId(parsed.frontmatter)?.toUpperCase(), local!.noteId.toUpperCase(), "Wrong local note identity");
    assert.equal(readNoteTitleKey(parsed.frontmatter).kind, "absent", "Frontmatter title changes are unsupported");
  }
  await checkLocal();
  if (!apply) return { status: "preview", file: local.file };
  await privateDirectory(config.journalDirectory);
  assert.ok(outside(vaultReal, await realpath(config.journalDirectory)), "Journal resolves inside the vault");
  const cloud = await ports.connect(vault, state.account);
  if (!saved) {
    const first = await cloud.lookup([local.noteId]);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.recordChangeTag, entry.recordChangeTag, "Run pull before starting a drawing rename");
    const decoded = classifyNoteRecord(first[0]!, { titleMode: "filename" });
    assert.ok(decoded.status === "ok" && decoded.attachments.length === 1, "Expected one drawing");
    const attachmentId = decoded.attachments[0]!.attachmentIdentifier;
    assert.ok(attachmentId && isNoteId(attachmentId));
    const records = await cloud.lookup([local.noteId, attachmentId]);
    const scope = { noteId: local.noteId, attachmentId, folderId: local.folderId };
    const { note } = drawingScope(records, scope);
    assert.equal(note.recordChangeTag, first[0]!.recordChangeTag, "Note changed during preflight");
    const oldTitle = encryptedTitle(note, "TitleEncrypted");
    if (oldTitle === local.targetTitle) return { status: "skipped", file: local.file };
    const assets = await ports.assets(records);
    const after = await cloud.lookup([local.noteId, attachmentId]); drawingScope(after, scope);
    for (const before of records) assert.equal(after.find(r => r.recordName === before.recordName)?.recordChangeTag, before.recordChangeTag, "Records changed during baseline capture");
    const id = sha256(JSON.stringify([config.accountDsidSha256, local.noteId, local.previousFile, local.file, fileHash, entry.recordChangeTag]));
    saved = { version: 1, configHash, local, intent: { id, noteId: local.noteId, oldTitle, targetTitle: local.targetTitle, file: local.file, fileSha256: fileHash }, baseline: { scope, records, assets } };
    await createJson(path.join(config.journalDirectory, local.noteId.toUpperCase(), sha256(id), "baseline.json"), saved);
  }
  const directory = path.join(config.journalDirectory, local.noteId.toUpperCase());
  const attempt = path.join(directory, sha256(saved.intent.id));
  const localBaseline = path.join(attempt, "mac-baseline.json");
  const io = createBridgeIO(saved.intent, saved.baseline, { storeUuid: config.storeUuid, macBuild: config.macBuild, remoteUser: config.sshTarget.split("@")[0]! }, {
    checkLocal, lookup: () => cloud.lookup([saved!.baseline.scope.noteId, saved!.baseline.scope.attachmentId]), update: cloud.update,
    mac: request => ports.mac(config.sshTarget, request), assets: ports.assets,
    readMacBaseline: async () => { const value = await readJson<{hash:string}>(localBaseline); if (value) assert.match(value.hash, /^[a-f0-9]{64}$/); return value?.hash; },
    saveMacBaseline: hash => createJson(localBaseline, { hash }),
  });
  const result = await runBridge(directory, saved.intent, io);
  if (result.status === "completed") await createJson(path.join(attempt, "complete.json"), { completedAt: new Date().toISOString(), noteId: local.noteId, file: local.file });
  return { ...result, file: local.file };
}
