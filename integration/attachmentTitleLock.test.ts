import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const moduleUrl = new URL("./attachmentTitleLock.ts", import.meta.url).href;
const verify = `const { assertAttachmentTitleLockHeld } = await import(${JSON.stringify(moduleUrl)}); await assertAttachmentTitleLockHeld(); console.log('verified');`;

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-probe-lock-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function worker(lock: string, declared: string, acquire: boolean) {
  return execute("/bin/bash", ["-c", `
    set -eu
    umask 077
    exec 9>"$1"
    if [ "$3" = yes ]; then flock --nonblock --conflict-exit-code 75 9; fi
    export ICLOUD_MD_PROBE_LOCK_PATH="$2" ICLOUD_MD_PROBE_LOCK_FD=9
    exec "$4" --import tsx --input-type=module -e "$5"
  `, "probe-lock-test", lock, declared, acquire ? "yes" : "no", process.execPath, verify]);
}

async function refused(result: Promise<unknown>, message: string) {
  await assert.rejects(result, error => {
    assert.ok((error as { stderr?: string }).stderr?.includes(`AssertionError [ERR_ASSERTION]: ${message}`));
    return true;
  });
}

test("a real inherited exclusive flock is accepted", () => fixture(async directory => {
  const lock = path.join(directory, "sync.lock");
  assert.equal((await worker(lock, lock, true)).stdout.trim(), "verified");
}));

test("an open descriptor without an acquired flock cannot authorize apply", () => fixture(async directory => {
  const lock = path.join(directory, "sync.lock");
  await refused(worker(lock, lock, false), "The inherited descriptor must hold an exclusive flock");
}));

test("a flock on a different file cannot authorize the declared sync lock", () => fixture(async directory => {
  const declared = path.join(directory, "other.lock");
  await writeFile(declared, "", { mode: 0o600 });
  await refused(worker(path.join(directory, "sync.lock"), declared, true), "The lock descriptor must reference the declared file");
}));

test("a symlink cannot stand in for the declared lock file", () => fixture(async directory => {
  const lock = path.join(directory, "sync.lock");
  const declared = path.join(directory, "alias.lock");
  await symlink(lock, declared);
  await refused(worker(lock, declared, true), "The sync lock must be an owned regular file");
}));

test("missing inherited lock details refuse apply", async () => {
  const env = { ...process.env };
  delete env.ICLOUD_MD_PROBE_LOCK_PATH;
  delete env.ICLOUD_MD_PROBE_LOCK_FD;
  await refused(execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", verify], { env }), "An inherited exclusive sync lock is required");
});
