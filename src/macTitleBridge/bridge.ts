import { open, readFile } from 'node:fs/promises';
import { privateDirectory } from './storage.js';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export interface RenameIntent {
  id: string; noteId: string; oldTitle: string; targetTitle: string;
  file: string; fileSha256: string;
}
export interface BridgeIO {
  checkLocal(): Promise<void>;
  inspectCloud(): Promise<{ attachmentTitle: string; noteTitle: string }>;
  inspectMac(): Promise<{ ready: boolean; nativeTitle?: string; persistedTitle?: string }>;
  publishAttachmentTitle(): Promise<void>;
  assignNativeName(): Promise<void>;
  publishNoteTitle(): Promise<void>;
  verify(): Promise<{ macPersisted: boolean }>;
}
type Result = { status: 'completed' | 'pending' | 'ambiguous'; stage: string };
// Fault-injection seam; production must leave this as FileHandle.sync().
export const durability = { sync: (file: FileHandle): Promise<void> => file.sync() };
const active = new Set<string>();
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
async function contents(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (e) { if (missing(e)) return; throw e; }
}
async function syncDirectory(path: string) {
  const fd = await open(path, 'r');
  try { await durability.sync(fd); } finally { await fd.close(); }
}
async function durableCreate(path: string, value: string) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(value); await durability.sync(fd); } finally { await fd.close(); }
  await syncDirectory(dirname(path));
  await syncDirectory(dirname(dirname(path)));
}

/** Orchestration independent of live adapters; ordinary push stays refused.
 * Caller MUST hold a service-level flock across the entire invocation, including
 * crash recovery. The in-process guard is supplemental; exclusive operation files
 * prevent redispatch even after a crash. Never delete an INTENT to retry.
 * Adapters enforce identity, baseline ETags, body/assets and allowed field masks:
 * A = Attachment.UserTitle; N = publicNote.name; B = TitleEncrypted + ModificationDate.
 * ready after A means A was imported, not merely that the Mac is reachable.
 * checkLocal rejects changed note bytes/target; verify checks body/assets and DB
 * persistence. Phone visual confirmation remains outside this module.
 */
export async function runBridge(directory: string, intent: RenameIntent, io: BridgeIO): Promise<Result> {
  const key = createHash('sha256').update(intent.id).digest('hex');
  const dir = join(directory, key);
  if (active.has(dir)) return { status: 'pending', stage: 'locked' };
  active.add(dir);
  let stage = 'journal';
  try {
    // Deliberately propagate preservation failures instead of treating them as retryable.
    await io.checkLocal();
    const identity = JSON.stringify([intent.id, intent.noteId, intent.oldTitle,
      intent.targetTitle, intent.file, intent.fileSha256]);
    const manifest = join(dir, 'rename.json');
    const existing = await contents(manifest);
    if (existing !== undefined && existing !== identity) throw Error('intent mismatch');
    try {
      // Establish every missing ancestor durably before any remote dispatch.
      await privateDirectory(directory);
      await privateDirectory(dir);
      await syncDirectory(dir);
      await syncDirectory(directory);
      await syncDirectory(dirname(directory));
      if (existing === undefined) await durableCreate(manifest, identity);
      else {
        const fd = await open(manifest, 'r');
        try { await durability.sync(fd); } finally { await fd.close(); }
      }
      // Both inspections precede any cloud dispatch, including resumed attempts.
      stage = 'preflight';
      await io.inspectCloud();
      if (!(await io.inspectMac()).ready) return { status: 'pending', stage };

      async function step(name: string, mutate: () => Promise<void>, proof: () => Promise<boolean>) {
        stage = name;
        const marker = join(dir, `${name}.INTENT.json`);
        const ack = join(dir, `${name}.ACK.json`);
        const value = JSON.stringify({ identity, operation: name });
        const recorded = await contents(marker);
        const acknowledged = await contents(ack);
        if (recorded !== undefined) {
          if (recorded !== value) return false; // Partial/corrupt intent is never retried.
          if (acknowledged !== undefined) return acknowledged === value;
          // An equal title cannot prove B's modification-date event occurred.
          // Without a successful ACK, keep B ambiguous for manual inspection.
          if (name === 'B' || !(await proof())) return false;
          await durableCreate(ack, value); // Read-only remote proof, never redispatch.
          return true;
        }
        if (acknowledged !== undefined) return false;
        // wx uniqueness and all three fsyncs must succeed BEFORE invoking adapter.
        await durableCreate(marker, value);
        await io.checkLocal();
        await mutate();
        await durableCreate(ack, value);
        return true;
      }
      if (!(await step('A', () => io.publishAttachmentTitle(), async () =>
        (await io.inspectCloud()).attachmentTitle === intent.targetTitle))) {
        return { status: 'ambiguous', stage };
      }
      stage = 'A-import';
      const mac = await io.inspectMac();
      if (!mac.ready) return { status: 'pending', stage };
      // An outstanding N INTENT must be reconciled even if nativeTitle matches.
      const nativeIntent = await contents(join(dir, 'N.INTENT.json'));
      if (nativeIntent !== undefined || mac.nativeTitle !== intent.targetTitle) {
        if (!(await step('N', () => io.assignNativeName(), async () =>
          (await io.inspectMac()).nativeTitle === intent.targetTitle))) {
          return { status: 'ambiguous', stage };
        }
      }
      // Do not skip B just because its title already matches: this is a heartbeat.
      if (!(await step('B', () => io.publishNoteTitle(), async () =>
        (await io.inspectCloud()).noteTitle === intent.targetTitle))) {
        return { status: 'ambiguous', stage };
      }
      stage = 'verify';
      const verified = await io.verify();
      return { status: verified.macPersisted ? 'completed' : 'pending', stage };
    } catch {
      // Dispatch, journal ACK, durability, or inspection failure: no rollback/retry.
      return { status: 'ambiguous', stage };
    }
  } finally { active.delete(dir); }
}
