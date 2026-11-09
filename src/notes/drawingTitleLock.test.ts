import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withDrawingTitleWriter } from "./drawingTitleLock.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "title-writer-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("portable title writer excludes competitors and invalidates released guards", () => fixture(async directory => {
  let stale!: () => Promise<void>;
  await withDrawingTitleWriter(directory, async guard => {
    stale = guard;
    await guard();
    await assert.rejects(withDrawingTitleWriter(directory, async () => assert.fail()), /held|busy/);
  });
  await assert.rejects(stale(), /closed/);
  await withDrawingTitleWriter(directory, async guard => {
    await guard();
    await assert.rejects(stale(), /closed/);
  });
}));
test("a crashed owner's lock is never stolen", () => fixture(async directory => {
  const lock = path.join(directory, "writer.lockdir");
  await mkdir(lock); await writeFile(path.join(lock, "owner"), "abandoned-owner");
  await assert.rejects(withDrawingTitleWriter(directory, async () => assert.fail()), /held|busy/);
  assert.equal(await readFile(path.join(lock, "owner"), "utf8"), "abandoned-owner");
}));
test("finally releases after a callback failure", () => fixture(async directory => {
  await assert.rejects(withDrawingTitleWriter(directory, async () => { throw Error("fixture failed"); }), /fixture failed/);
  await withDrawingTitleWriter(directory, guard => guard());
}));
test("ownership loss refuses dispatch and does not delete a replacement owner", () => fixture(async directory => {
  const owner = path.join(directory, "writer.lockdir", "owner");
  await assert.rejects(withDrawingTitleWriter(directory, async guard => {
    await writeFile(owner, "replacement-owner");
    await assert.rejects(guard(), /ownership/);
  }), /ownership/);
  assert.equal(await readFile(owner, "utf8"), "replacement-owner");
}));

test("another process cannot enter, and killing the owner leaves a blocked lock", () => fixture(async directory => {
  const { spawn } = await import("node:child_process");
  const module = new URL("./drawingTitleLock.ts", import.meta.url).href;
  const script = `const { withDrawingTitleWriter } = await import(${JSON.stringify(module)}); await withDrawingTitleWriter(process.argv[1], async () => { process.send('held'); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error(stderr || "writer child exited early"); })]);
    assert.equal(message, "held");
    await assert.rejects(withDrawingTitleWriter(directory, async () => assert.fail()), /busy/);
  } finally {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
  await assert.rejects(withDrawingTitleWriter(directory, async () => assert.fail()), /busy/);
}));
