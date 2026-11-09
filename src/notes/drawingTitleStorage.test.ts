import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncTitleDirectory, titleStatePermissions } from "./drawingTitleStorage.js";

test("Windows storage avoids POSIX-only UID/mode and directory-flush assumptions", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    assert.equal(titleStatePermissions({ uid: -1, mode: 0o777 }), true);
    await syncTitleDirectory("a-directory-that-does-not-exist", async () => assert.fail("Windows cannot flush directories through Node"));
  } finally { Object.defineProperty(process, "platform", original); }
});
test("POSIX directory flush failures remain failures", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-flush-"));
  try {
    await assert.rejects(syncTitleDirectory(directory, async () => { throw Error("flush failed"); }), /flush failed/);
    assert.equal(titleStatePermissions({ uid: process.getuid!(), mode: 0o755 }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
