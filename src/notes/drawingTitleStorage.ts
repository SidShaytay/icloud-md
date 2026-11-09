import assert from "node:assert/strict";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";

/** Windows cannot open/flush directories through Node's portable fs API.
 * Files are flushed on every platform; power-loss durability is not promised. */
export async function syncTitleDirectory(directory: string, sync = (file: Awaited<ReturnType<typeof open>>) => file.sync()): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(directory, "r");
  try { await sync(file); } finally { await file.close(); }
}

/** Node exposes no Windows ACL ownership check: the caller must choose a private
 * user-accessible directory there. POSIX ownership/modes remain enforced. */
export function titleStatePermissions(stat: { uid: number | bigint; mode: number | bigint }, privateMode = true): boolean {
  return process.platform === "win32" || (BigInt(stat.uid) === BigInt(process.getuid!()) && (!privateMode || (BigInt(stat.mode) & 0o077n) === 0n));
}

export async function privateTitleStateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (isEnoent(error)) { await privateTitleStateDirectory(path.dirname(directory)); await mkdir(directory, { mode: 0o700 }); }
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && titleStatePermissions(stat), "Drawing title state must be private and user-owned");
  await syncTitleDirectory(directory);
  await syncTitleDirectory(path.dirname(directory));
}

/** Exclusive creation plus file and ancestor fsyncs must precede dispatch. */
export async function createPrivateTitleState(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  await syncTitleDirectory(path.dirname(file));
  await syncTitleDirectory(path.dirname(path.dirname(file)));
}
