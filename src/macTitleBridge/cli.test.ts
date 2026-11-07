import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("companion CLI remains disabled and performs no vault/network access without explicit configuration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-"));
  try {
    const config = path.join(dir, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, enabled: false, sshTarget: "tester@mac.invalid", storeUuid: "44444444-4444-4444-8444-444444444444", macBuild: "25G83", accountDsidSha256: "a".repeat(64), allowedNoteIds: [], journalDirectory: path.join(dir, "journal") }), { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), "--config", config, "--vault", path.join(dir, "nonexistent-vault")], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: "disabled" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
