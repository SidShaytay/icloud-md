import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const wrapper = fileURLToPath(new URL("./runAttachmentTitleProbe", import.meta.url));

async function fixture(run: (f: { directory: string; lock: string; output: string; env: NodeJS.ProcessEnv }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-trial-wrapper-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const output = path.join(directory, "executed.jsonl");
  const lock = path.join(directory, "sync.lock");
  await writeFile(path.join(bin, "node"), '#!/bin/bash\nset -eu\nif flock --nonblock "$ICLOUD_MD_PROBE_LOCK_PATH" true; then exit 99; fi\nprintf "%s\\n" "$@" > "$ICLOUD_MD_LOCK_TEST_OUTPUT"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ICLOUD_MD_PROBE_LOCK_PATH: lock, ICLOUD_MD_LOCK_TEST_OUTPUT: output };
  try { await run({ directory, lock, output, env }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("wrapper holds the sync lock and forwards arguments literally without truncating it", () => fixture(async f => {
  await writeFile(f.lock, "existing-lock-contents", { mode: 0o600 });
  const literal = 'literal $(touch should-not-exist)';
  await execute("/bin/bash", [wrapper, "--file", literal], { env: f.env });
  const args = (await readFile(f.output, "utf8")).trim().split("\n");
  assert.equal(args.at(-1), literal);
  assert.ok(args.includes("tsx"));
  assert.ok(args.some(arg => arg.endsWith("attachmentTitleRunnerCli.ts")));
  assert.equal(await readFile(f.lock, "utf8"), "existing-lock-contents");
}));

test("a busy normal sync lock prevents the runner from starting", () => fixture(async f => {
  const holder = spawn("/bin/bash", ["-c", 'set -eu; exec 9<>"$1"; flock --nonblock 9; printf ready; read -r release', "holder", f.lock]);
  try {
    await once(holder.stdout!, "data");
    await assert.rejects(execute("/bin/bash", [wrapper], { env: f.env }), error => {
      assert.equal((error as { code?: number }).code, 75);
      return true;
    });
    await assert.rejects(access(f.output));
  } finally {
    const exited = once(holder, "exit");
    holder.stdin!.end("release\n");
    await exited;
  }
}));
