/** Exclusion for participating title-store writers only, not general vault commands. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export async function withDrawingTitleWriter<T>(directory: string, run: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
  const lock = path.join(directory, "writer.lockdir"), owner = path.join(lock, "owner"), token = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("Drawing title writer is busy or its lock was left by an interrupted run; stop all writers before manual recovery");
    throw error;
  }
  // If publishing ownership fails, leave the lock blocked rather than risk a takeover.
  const file = await open(owner, "wx", 0o600);
  try { await file.writeFile(token); await file.sync(); } finally { await file.close(); }
  let active = true;
  const checkOwner = async () => {
    const directoryStat = await lstat(lock), ownerStat = await lstat(owner);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && ownerStat.isFile() && !ownerStat.isSymbolicLink() && await readFile(owner, "utf8") === token, "Drawing title writer ownership changed");
  };
  const assertHeld = async () => { assert.ok(active, "Drawing title writer scope is closed"); await checkOwner(); assert.ok(active, "Drawing title writer scope is closed"); };
  try { await assertHeld(); return await run(assertHeld); }
  finally {
    active = false;
    await checkOwner();
    await unlink(owner);
    await rmdir(lock);
  }
}
