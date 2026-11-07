import assert from "node:assert/strict";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../src/fsUtil.js";

// Fault-injection seam. Live callers must use the default FileHandle.sync.
export const probeJournalDurability = { sync: (file: Awaited<ReturnType<typeof open>>) => file.sync() };

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await probeJournalDurability.sync(file); } finally { await file.close(); }
}

export async function privateProbeDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (isEnoent(error)) { await privateProbeDirectory(path.dirname(directory)); await mkdir(directory, { mode: 0o700 }); }
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "Probe journal must be private and user-owned");
  await syncDirectory(directory);
  await syncDirectory(path.dirname(directory));
}

export async function readProbeJournal(file: string): Promise<string | undefined> {
  try {
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "Unsafe probe journal file");
    return await readFile(file, "utf8");
  } catch (error) { if (isEnoent(error)) return undefined; throw error; }
}

/** Exclusive creation plus file and ancestor fsyncs must precede dispatch. */
export async function createProbeJournal(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(contents); await probeJournalDurability.sync(handle); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
  await syncDirectory(path.dirname(path.dirname(file)));
}
