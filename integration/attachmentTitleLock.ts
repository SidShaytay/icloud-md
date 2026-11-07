import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/** Linux-only live-test exclusion. The wrapper passes the descriptor that it
 * actually locked, not a boolean claiming that another process holds a lock.
 * Its path must be the normal sync writer's lock; keep that writer's timer
 * paused during an experiment so systemd cannot remove/recreate its directory. */
export async function assertAttachmentTitleLockHeld(): Promise<void> {
  const lockPath = process.env.ICLOUD_MD_PROBE_LOCK_PATH;
  const descriptor = process.env.ICLOUD_MD_PROBE_LOCK_FD;
  assert.ok(lockPath && path.isAbsolute(lockPath) && descriptor && /^[1-9]\d*$/.test(descriptor) && Number(descriptor) >= 3,
    "An inherited exclusive sync lock is required");
  const declared = await lstat(lockPath, { bigint: true });
  assert.ok(declared.isFile() && !declared.isSymbolicLink() && declared.uid === BigInt(process.getuid!()) && (declared.mode & 0o022n) === 0n,
    "The sync lock must be an owned regular file");
  const inherited = fstatSync(Number(descriptor), { bigint: true });
  assert.ok(inherited.isFile() && inherited.dev === declared.dev && inherited.ino === declared.ino,
    "The lock descriptor must reference the declared file");
  const information = await readFile(`/proc/self/fdinfo/${descriptor}`, "utf8");
  assert.match(information, /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?\d+\s+/m,
    "The inherited descriptor must hold an exclusive flock");
}
