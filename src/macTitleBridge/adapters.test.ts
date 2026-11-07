import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { records, noteId, attachmentId, folderId } from "./model.test.js";
import { createBridgeIO } from "./adapters.js";
import { runBridge, type RenameIntent } from "./bridge.js";
import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import type { MacResult } from "./mac.js";
import { encryptedTitle, sha256 } from "./model.js";

async function fixture(body: (f: ReturnType<typeof setup>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "title-adapters-"));
  try { await body(setup(), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function setup() {
  let cloud = records(), nativeTitle = "Old drawing", persistedTitle = "Old drawing", localHash: string | undefined;
  let available = true, localChanged = false, bytesChanged = false;
  const writes: string[] = [];
  const intent: RenameIntent = { id: "intent", noteId, oldTitle: "Old drawing", targetTitle: "New drawing", file: "TEST/New drawing.md", fileSha256: "f".repeat(64) };
  const baseline = { scope: { noteId, attachmentId, folderId }, records: structuredClone(cloud), assets: [{ sha256: "pixels" }] };
  const deps = {
    checkLocal: async () => { assert.ok(!localChanged, "file changed"); },
    lookup: async () => structuredClone(cloud),
    update: async (update: RecordUpdate) => {
      writes.push(update.recordType === "Note" ? "B" : "A");
      const record = cloud.find(r => r.recordName === update.recordName)!;
      assert.equal(update.recordChangeTag, record.recordChangeTag);
      for (const [key, value] of Object.entries(update.fields)) record.fields[key] = { type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES", ...value };
      record.recordChangeTag += "+";
    },
    mac: async (request: {mode:string;targetTitle:string;expected:{noteTagSha256:string;attachmentTagSha256:string}}): Promise<MacResult> => {
      if (!available) throw Error("offline");
      if (request.mode === "apply") { writes.push("N"); nativeTitle = persistedTitle = request.targetTitle; }
      return { status: request.mode === "apply" ? "assigned" : "ready", writeMayHaveOccurred: request.mode === "apply", nativeTitle, persistedTitle,
        scriptingId: "x-coredata://44444444-4444-4444-8444-444444444444/ICNote/p7", localDocumentSha256: "a".repeat(64), ...request.expected };
    },
    readMacBaseline: async () => localHash,
    saveMacBaseline: async (hash: string) => { localHash = hash; },
    assets: async () => [{ sha256: bytesChanged ? "changed" : "pixels" }],
  };
  const io = createBridgeIO(intent, baseline, { storeUuid: "44444444-4444-4444-8444-444444444444", macBuild: "25G83", remoteUser: "tester" }, deps);
  return { io, intent, writes, deps, baseline, cloud: () => cloud, setOffline: () => { available = false; }, changeLocal: () => { localChanged = true; }, changeBytes: () => { bytesChanged = true; },
    changeRemote: () => { cloud[0]!.fields.TextDataEncrypted = { type: "ENCRYPTED_BYTES", value: "changed" }; },
    changeTitle: () => { cloud[0]!.fields.TitleEncrypted = { type: "ENCRYPTED_BYTES", value: Buffer.from("Other user's title").toString("base64") }; },
  };
}
test("real adapter protocol targets A, native N, then B without document or asset fields", () => fixture(async (f, dir) => {
  const before = f.cloud()[0]!.fields.TextDataEncrypted;
  assert.equal((await runBridge(dir, f.intent, f.io)).status, "completed");
  assert.deepEqual(f.writes, ["A", "N", "B"]);
  assert.equal(encryptedTitle(f.cloud()[0]!, "TitleEncrypted"), "New drawing");
  assert.deepEqual(f.cloud()[0]!.fields.TextDataEncrypted, before);
  await runBridge(dir, f.intent, f.io); assert.deepEqual(f.writes, ["A", "N", "B"]);
}));
test("unavailable Mac leaves filename intent pending with zero writes", () => fixture(async (f, dir) => {
  f.setOffline(); assert.equal((await runBridge(dir, f.intent, f.io)).status, "pending"); assert.deepEqual(f.writes, []);
}));
for (const changed of ["changeLocal", "changeRemote", "changeTitle"] as const) test(`${changed} prevents all writes`, () => fixture(async (f, dir) => {
  f[changed]();
  try { await runBridge(dir, f.intent, f.io); } catch { /* checkLocal fails before journal */ }
  assert.deepEqual(f.writes, []);
}));
test("changed downloaded drawing bytes cannot report completion", () => fixture(async (f, dir) => {
  f.changeBytes(); assert.notEqual((await runBridge(dir, f.intent, f.io)).status, "completed");
}));
