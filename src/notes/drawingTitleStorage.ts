import assert from "node:assert/strict";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export async function privateTitleStateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (isEnoent(error)) { await privateTitleStateDirectory(path.dirname(directory)); await mkdir(directory, { mode: 0o700 }); }
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "Drawing title state must be private and user-owned");
  await syncDirectory(directory);
  await syncDirectory(path.dirname(directory));
}

/** Exclusive creation plus file and ancestor fsyncs must precede dispatch. */
export async function createPrivateTitleState(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
  await syncDirectory(path.dirname(path.dirname(file)));
}
