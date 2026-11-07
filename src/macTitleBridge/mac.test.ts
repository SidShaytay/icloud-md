import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeWorkerPython } from "./nativeWorker.js";
import { sshInvocation, parseMacResult } from "./mac.js";

test("SSH transports title data only on stdin and pins existing host verification", () => {
  const request = { targetTitle: "'; $(touch /tmp/should-never-exist)" };
  const result = sshInvocation("tester@mac.local", request);
  assert.equal(result.stdin, JSON.stringify(request));
  assert.ok(!result.args.at(-1)!.includes(request.targetTitle));
  assert.ok(result.args.includes("BatchMode=yes") && result.args.includes("StrictHostKeyChecking=yes"));
  for (const target of ["-oProxyCommand=x", "tester@host;pwd", "tester@host\n", "host", "tester@$(pwd)"]) assert.throws(() => sshInvocation(target, request));
});
test("only a validated ready result can be used for another operation", () => {
  const good = { status: "ready", writeMayHaveOccurred: false, nativeTitle: "Old", persistedTitle: "Old", localDocumentSha256: "a".repeat(64), noteTagSha256: "b".repeat(64), attachmentTagSha256: "c".repeat(64), scriptingId: "x-coredata://44444444-4444-4444-8444-444444444444/ICNote/p7" };
  assert.equal(parseMacResult(JSON.stringify(good)).status, "ready");
  for (const value of [{ ...good, localDocumentSha256: "no" }, { ...good, status: "complete" }, { ...good, writeMayHaveOccurred: "false" }]) assert.throws(() => parseMacResult(JSON.stringify(value)));
});
test("embedded production Python worker passes its offline SQLite, adapter and JXA guards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mac-title-worker-"));
  try {
    await writeFile(path.join(dir, "mac_worker.py"), nativeWorkerPython);
    await writeFile(path.join(dir, "test_mac_worker.py"), await readFile(new URL("./mac_worker.test.py", import.meta.url)));
    const result = spawnSync("python3", ["-m", "unittest", "-v", "test_mac_worker.py"], { cwd: dir, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Ran 21 tests/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
