import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { records, noteId, folderId } from "./model.test.js";
const oldHome = process.env.HOME;
const testHome = await mkdtemp(path.join(os.tmpdir(), "bridge-account-"));
process.env.HOME = testHome;
const { parseBridgeConfig, runCompanion } = await import("./companion.js");
const { writeSessionFile } = await import("../session.js");
const { accountSessionPath } = await import("../auth/accountStore.js");
after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await rm(testHome, { recursive: true, force: true }); });
import { sha256 } from "./model.js";
import { composeNoteFile } from "../notes/noteIdFrontmatter.js";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { compressNoteDocument } from "../notes/noteText.js";
import type { MacRequest } from "./adapters.js";
import type { MacResult } from "./mac.js";
import type { RecordUpdate } from "../cloudkit/databaseClient.js";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "title-companion-"));
  const vault = path.join(root, "vault"); await mkdir(path.join(vault, "TEST"), { recursive: true });
  const file = "TEST/New drawing.md", text = composeNoteFile("", "opaque drawing marker", noteId);
  await writeFile(path.join(vault, file), text);
  await writeBaseCopy(vault, noteId, "opaque drawing marker");
  const account = { appleId: "fixture@example.invalid", dsid: "fixture" };
  let state = { account, titleMode: "filename" as const, notes: { [noteId]: { file: "TEST/Old drawing.md", recordChangeTag: "note-tag", modificationDate: 0, folderRecordName: folderId } } };
  const config = { version: 1, enabled: true, sshTarget: "tester@mac.local", storeUuid: "44444444-4444-4444-8444-444444444444", macBuild: "25G83", accountDsidSha256: sha256(account.dsid), allowedNoteIds: [noteId], journalDirectory: path.join(root, "journal") };
  const cloud = records(), writes: string[] = [];
  let native = "Old drawing", persisted = "Old drawing", ready = true;
  const ports = {
    readState: async () => state,
    preview: async () => ({ entries: state.notes[noteId].file === file ? [] : [{ kind: "move" as const, resolution: "refused" as const, file, previousFile: "TEST/Old drawing.md" }], notices: [] }),
    connect: async () => ({ lookup: async (ids: string[]) => structuredClone(cloud.filter(r => ids.includes(r.recordName))), update: async (update: RecordUpdate) => {
      writes.push(update.recordType === "Note" ? "B" : "A"); const r = cloud.find(r => r.recordName === update.recordName)!;
      for (const [key, value] of Object.entries(update.fields)) r.fields[key] = { type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES", ...value };
      r.recordChangeTag += "+";
    } }),
    assets: async () => [{ field: "Attachment.PaperDatabase", size: 3, sha256: "pixels", contentIdentityHash: "content", referenceIdentityHash: "reference" }],
    mac: async (_target: string, request: MacRequest): Promise<MacResult> => {
      if (!ready) throw Error("offline");
      if (request.mode === "apply") { writes.push("N"); native = request.targetTitle; }
      return { status: request.mode === "apply" ? "persistence-pending" : "ready", writeMayHaveOccurred: request.mode === "apply", nativeTitle: native, persistedTitle: persisted,
        scriptingId: `x-coredata://${config.storeUuid}/ICNote/p7`, localDocumentSha256: "a".repeat(64), noteTagSha256: request.expected.noteTagSha256, attachmentTagSha256: request.expected.attachmentTagSha256 };
    },
  };
  return { root, vault, config, ports, writes, text, file, offline: () => { ready = false; }, persist: () => { persisted = "New drawing"; },
    adopt: () => { state = { ...state, notes: { [noteId]: { ...state.notes[noteId], file } } }; } };
}
test("disabled or preview-only companion never connects or writes", () => fixture(async f => {
  const ports = { ...f.ports, connect: async () => { throw Error("must not connect"); } };
  assert.equal((await runCompanion(f.vault, { ...f.config, enabled: false }, true, ports)).status, "disabled");
  assert.equal((await runCompanion(f.vault, f.config, false, ports)).status, "preview");
  assert.deepEqual(f.writes, []);
}));
test("invalid config rejects shell destinations, unknown OS builds and account mismatches", () => fixture(async f => {
  for (const bad of [{ ...f.config, sshTarget: "tester@host;pwd" }, { ...f.config, macBuild: "unreviewed" }, { ...f.config, allowedNoteIds: ["not-an-id"] }]) assert.throws(() => parseBridgeConfig(bad));
  await assert.rejects(runCompanion(f.vault, { ...f.config, accountDsidSha256: "b".repeat(64) }, true, f.ports));
  assert.deepEqual(f.writes, []);
}));
test("offline Mac preserves the exact file and performs zero mutations", () => fixture(async f => {
  f.offline(); assert.equal((await runCompanion(f.vault, f.config, true, f.ports)).status, "pending");
  assert.deepEqual(f.writes, []); assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.text);
}));
test("default preview cannot merge an unrelated locally and remotely edited note", () => fixture(async f => {
  const otherId = "55555555-5555-4555-8555-555555555555";
  const otherFile = path.join(f.vault, "TEST/Other.md");
  const localText = composeNoteFile("", "Local A\nB", otherId);
  await writeFile(otherFile, localText); await writeBaseCopy(f.vault, otherId, "A\nB");
  const initial = await f.ports.readState();
  const raw = JSON.stringify({ ...initial, layoutVersion: 4, replicaId: Buffer.alloc(16, 7).toString("base64"), folders: { [folderId]: { name: "TEST", dirName: "TEST" } }, notes: { ...initial.notes, [otherId]: { file: "TEST/Other.md", recordChangeTag: "other-old", modificationDate: 0, folderRecordName: folderId } } });
  const stateFile = path.join(f.vault, ".icloud-md/state.json"); await writeFile(stateFile, raw);
  await writeSessionFile({ cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: new Date().toISOString() }, accountSessionPath(initial.account.dsid));
  const remote = { ...records()[0]!, recordName: otherId, recordChangeTag: "other-new", fields: {
    ...records()[0]!.fields, TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Other").toString("base64") },
    TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(buildInitialNoteDocument("Other\nA\nRemote B", new Uint8Array(16).fill(7)))).toString("base64") },
  } };
  const fetchBefore = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++; const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/validate")) return Response.json({ dsInfo: initial.account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
    if (u.pathname.endsWith("/records/lookup")) return Response.json({ records: (JSON.parse(init!.body as string).records as {recordName:string}[]).map(({recordName}) => recordName === otherId ? remote : records().find(r => r.recordName === recordName)) });
    throw Error("Unexpected offline request");
  };
  try {
    assert.equal((await runCompanion(f.vault, f.config, false)).status, "preview");
    assert.equal(await readFile(otherFile, "utf8"), localText);
    assert.equal(await readBaseCopy(f.vault, otherId), "A\nB");
    assert.equal(await readFile(stateFile, "utf8"), raw);
    assert.equal(requests, 0, "A local preview must not invoke the cloud planner");
  } finally { globalThis.fetch = fetchBefore; }
}));

test("pending journal survives pull adopting the filename; no repeated writes before persisted completion", () => fixture(async f => {
  assert.equal((await runCompanion(f.vault, f.config, true, f.ports)).status, "pending");
  assert.deepEqual(f.writes, ["A", "N", "B"]);
  f.adopt(); f.persist();
  assert.equal((await runCompanion(f.vault, f.config, true, f.ports)).status, "completed");
  assert.deepEqual(f.writes, ["A", "N", "B"]);
  assert.equal((await runCompanion(f.vault, f.config, true, f.ports)).status, "skipped");
  assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.text);
}));
