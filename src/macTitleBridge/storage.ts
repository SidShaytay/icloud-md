import assert from "node:assert/strict";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";

export async function privateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (isEnoent(error)) { await privateDirectory(path.dirname(directory)); await mkdir(directory, { mode: 0o700 }); }
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), "Journal directory must be private and user-owned");
  for (const name of [directory, path.dirname(directory)]) {
    const handle = await open(name, "r"); try { await handle.sync(); } finally { await handle.close(); }
  }
}
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), "Journal file must be private and user-owned");
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) { if (isEnoent(error)) return undefined; throw error; }
}
export async function createJson(file: string, data: unknown): Promise<void> {
  await privateDirectory(path.dirname(file));
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(data) + "\n"); await handle.sync(); } finally { await handle.close(); }
  for (const name of [path.dirname(file), path.dirname(path.dirname(file))]) {
    const directory = await open(name, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
}
