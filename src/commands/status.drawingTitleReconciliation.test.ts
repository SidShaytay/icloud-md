import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, lstat, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// This boundary test uses an empty bound vault. It must not authenticate, fetch
// records, create a lease, or dispatch any SDK write while checking forwarding.
const home = await mkdtemp(path.join(os.tmpdir(), "status-title-scope-"));
const oldHome = process.env.HOME;
process.env.HOME = home;
const { runStatus } = await import("./status.js");
const { writeCloneState } = await import("../notes/cloneState.js");
after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(home, { recursive: true, force: true }); });
const folderId = "33333333-3333-4333-8333-333333333333", noteId = "11111111-1111-4111-8111-111111111111";
async function fixture(run: (vault: string, journalDirectory: string) => Promise<void>) {
  const vault = await mkdtemp(path.join(home, "vault-")), journalDirectory = path.join(home, "private-evidence");
  await writeCloneState(vault, { titleMode: "filename", account: { appleId: "fixture@example.invalid", dsid: "fixture" }, syncToken: "", notes: {} });
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("Unexpected network request in status forwarding test"); };
  try { await run(vault, journalDirectory); } finally { globalThis.fetch = fetch; }
}
for (const field of ["folderIds", "noteIds"] as const) test(`status forwards ${field} to the same checked planner as push`, () => fixture(async (vault, journalDirectory) => {
  await assert.rejects(runStatus(vault, { drawingTitleReconciliation: { journalDirectory, folderIds: [folderId], noteIds: [noteId], [field]: ["invalid-uuid"] } }), /Invalid drawing title reconciliation scope/);
}));
test("status forwards valid reconciliation configuration without creating journals or changing clone state", () => fixture(async (vault, journalDirectory) => {
  const fdPath = path.join(home, "sync.lock"), fd = openSync(fdPath, "a", 0o600);
  assert.equal(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] }).status, 0);
  const oldPath = process.env.ICLOUD_MD_PROBE_LOCK_PATH, oldFd = process.env.ICLOUD_MD_PROBE_LOCK_FD;
  process.env.ICLOUD_MD_PROBE_LOCK_PATH = fdPath; process.env.ICLOUD_MD_PROBE_LOCK_FD = String(fd);
  const statePath = path.join(vault, ".icloud-md", "state.json"), before = await readFile(statePath, "utf8");
  try {
    const result = await runStatus(vault, { drawingTitleReconciliation: { journalDirectory, folderIds: [folderId], noteIds: [noteId] } });
    assert.deepEqual(result.entries, []); assert.equal(result.unchanged, 0);
    assert.equal(await readFile(statePath, "utf8"), before);
    await assert.rejects(lstat(journalDirectory), { code: "ENOENT" });
  } finally {
    closeSync(fd);
    if (oldPath === undefined) delete process.env.ICLOUD_MD_PROBE_LOCK_PATH; else process.env.ICLOUD_MD_PROBE_LOCK_PATH = oldPath;
    if (oldFd === undefined) delete process.env.ICLOUD_MD_PROBE_LOCK_FD; else process.env.ICLOUD_MD_PROBE_LOCK_FD = oldFd;
  }
}));
