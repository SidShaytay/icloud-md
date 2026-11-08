import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CloudKitRecord, RecordUpdate } from "../src/cloudkit/databaseClient.js";
import { writeBaseCopy } from "../src/notes/baseCopy.js";
import { writeCloneState } from "../src/notes/cloneState.js";
import { AttachmentInfoSchema } from "../src/notes/gen/topotext_pb.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../src/notes/noteDocument.js";
import { composeNoteFile } from "../src/notes/noteIdFrontmatter.js";
import { compressNoteDocument } from "../src/notes/noteText.js";
import { formatEmbedMarker } from "../src/notes/unknownContent.js";
import { probeJournalDurability } from "./attachmentTitleProbeJournal.js";
import type { TitleProbeIO } from "./attachmentTitleProbe.js";
import { parseAttachmentTitleRunnerArgs, runAttachmentTitleRunner, type TitleRunnerOptions, type TitleRunnerPorts } from "./attachmentTitleRunner.js";

const noteId = "AAAA1111-1111-4111-8111-111111111111";
const attachmentId = "BBBB2222-2222-4222-8222-222222222222";
const folderId = "CCCC3333-3333-4333-8333-333333333333";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const encoded = (value: string) => Buffer.from(value).toString("base64");

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "title-runner-")), vault = path.join(root, "vault");
  await mkdir(path.join(vault, "TEST"), { recursive: true });
  const body = formatEmbedMarker({ attachmentIdentifier: attachmentId, typeUti: "com.apple.paper" });
  const file = "TEST/New drawing.md", local = composeNoteFile("", body, noteId);
  await writeFile(path.join(vault, file), local);
  const account = { appleId: "fixture@example.invalid", dsid: "fixture" };
  const state = { account, titleMode: "filename" as const, syncToken: "", replicaId: Buffer.alloc(16, 7).toString("base64"),
    folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
    notes: { [noteId]: { file: "TEST/Old drawing.md", recordChangeTag: "note-tag", modificationDate: 100, folderRecordName: folderId } } };
  await writeCloneState(vault, state); await writeBaseCopy(vault, noteId, body);
  const doc = buildInitialNoteDocument("\uFFFC", new Uint8Array(16).fill(7));
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" });
  const cloud: CloudKitRecord[] = [
    { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId, fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") }, TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } }, Deleted: { type: "INT64", value: 0 }, ModificationDate: { type: "TIMESTAMP", value: 100 },
    } },
    { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId, fields: {
      UTI: { type: "STRING", value: "com.apple.paper" }, Deleted: { type: "INT64", value: 0 }, Note: { type: "REFERENCE", value: { recordName: noteId } }, UserTitle: { type: "ENCRYPTED_BYTES", value: encoded("Old drawing") },
      PaperDatabase: { type: "ASSETID", value: { fileChecksum: "pixels", size: 3, referenceChecksum: "reference", wrappingKey: "key", downloadURL: "https://example.invalid/signed" } },
    } },
    { recordName: folderId, recordType: "Folder", recordChangeTag: "folder-tag", fields: { Deleted: { type: "INT64", value: 0 } } },
  ];
  let now = 1_000;
  const options: TitleRunnerOptions = { vault, file, noteId, attachmentId, folderId, journalDirectory: path.join(root, "journal"), phase: "A", modificationDate: 2_000, deadline: 10_000 };
  const writes: RecordUpdate[] = [], batches: RecordUpdate[][] = [], captures: string[] = [];
  const io: TitleProbeIO = { accountDsidSha256: sha(account.dsid), lookup: async (ids: string[]) => structuredClone(cloud.filter(r => ids.includes(r.recordName))), update: async (update: RecordUpdate) => {
    writes.push(structuredClone(update)); const record = cloud.find(r => r.recordName === update.recordName)!;
    assert.equal(record.recordChangeTag, update.recordChangeTag);
    for (const [key, field] of Object.entries(update.fields)) record.fields[key] = { ...field, type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES" };
    record.recordChangeTag += "+";
  }, updateBatch: async updates => { batches.push(structuredClone(updates)); for (const update of updates) await io.update(update); } };
  const ports: TitleRunnerPorts = { connect: async () => io, assertLock: async () => {}, lockAuthority: async () => ({ path: "/fixture/sync.lock", dev: "1", ino: "2" }), now: () => now,
    capture: async (scope, lookup, opts) => {
      const records = await lookup([scope.noteId, scope.attachmentId]);
      const result = { records, documentSha256: sha(Buffer.from(records[0]!.fields.TextDataEncrypted!.value as string, "base64")), assets: [{ field: "Attachment.PaperDatabase", size: 3, sha256: "a".repeat(64), contentIdentityHash: "b".repeat(64), referenceIdentityHash: "c".repeat(64) }] };
      if (opts?.directory) { captures.push(opts.directory); await mkdir(opts.directory, { recursive: true, mode: 0o700 }); await writeFile(path.join(opts.directory, "complete.json"), JSON.stringify(result), { mode: 0o600 }); }
      return result;
    },
  };
  return { root, vault, body, file, local, state, cloud, options, writes, batches, captures, ports, io, expire: () => { now = 20_000; } };
}
async function approved(f: Awaited<ReturnType<typeof setup>>, options = f.options) {
  const preview = await runAttachmentTitleRunner(options, f.ports);
  return { ...options, apply: true, expectedPlanSha256: preview.planSha256 };
}

test("runner preview checks actual local intent/cloud but writes no journal or mutation", () => fixture(async f => {
  const result = await runAttachmentTitleRunner(f.options, f.ports);
  assert.equal(result.status, "preview"); assert.match(result.planSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.captures, []);
  assert.deepEqual((await readdir(f.root)).sort(), ["vault"]);
}));

test("apply requires exact preview digest and held normal-sync lock", () => fixture(async f => {
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, apply: true }, f.ports), /plan/i);
  const options = await approved(f);
  await assert.rejects(runAttachmentTitleRunner(options, { ...f.ports, assertLock: async () => { throw Error("lock unavailable"); } }), /lock/);
  await assert.rejects(runAttachmentTitleRunner({ ...options, expectedPlanSha256: "0".repeat(64) }, f.ports), /plan/i);
  assert.equal(f.writes.length, 0);
}));

test("A and separately invoked B preserve local bytes/state, body and asset capture", () => fixture(async f => {
  const stateBefore = await readFile(path.join(f.vault, ".icloud-md/state.json"));
  const a = await runAttachmentTitleRunner(await approved(f), f.ports);
  assert.equal(a.status, "cloud-applied-native-unverified");
  const bOptions = { ...f.options, phase: "B" as const, modificationDate: 3_000 };
  const b = await runAttachmentTitleRunner(await approved(f, bOptions), f.ports);
  assert.equal(b.status, "cloud-applied-native-unverified");
  assert.deepEqual(f.writes.map(w => Object.keys(w.fields)), [["UserTitle"], ["TitleEncrypted", "ModificationDate"]]);
  assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.local);
  assert.deepEqual(await readFile(path.join(f.vault, ".icloud-md/state.json")), stateBefore);
  assert.equal(f.captures.length, 4);
}));

test("changed local note, duplicate case-insensitive identity or old path refuses before any mutation", () => fixture(async f => {
  const options = await approved(f);
  await writeFile(path.join(f.vault, f.file), f.local + "changed");
  await assert.rejects(runAttachmentTitleRunner(options, f.ports));
  await writeFile(path.join(f.vault, f.file), f.local);
  await writeFile(path.join(f.vault, "TEST/Duplicate.md"), f.local.replace(noteId, noteId.toLowerCase()));
  await assert.rejects(runAttachmentTitleRunner(options, f.ports), /identity|claim/i);
  await rm(path.join(f.vault, "TEST/Duplicate.md"));
  await writeFile(path.join(f.vault, "TEST/Old drawing.md"), f.local);
  await assert.rejects(runAttachmentTitleRunner(options, f.ports), /original|old|rename/i);
  assert.equal(f.writes.length, 0);
}));

test("local note change while primitive intent fsyncs prevents SDK dispatch", () => fixture(async f => {
  const options = await approved(f), sync = probeJournalDurability.sync;
  probeJournalDurability.sync = async file => {
    await sync(file);
    if ((await file.stat()).isFile()) {
      const target = await import("node:fs/promises").then(fs => fs.readlink(`/proc/self/fd/${file.fd}`));
      if (target.endsWith("A.intent.json")) await writeFile(path.join(f.vault, f.file), f.local + "changed");
    }
  };
  try { assert.equal((await runAttachmentTitleRunner(options, f.ports)).status, "ambiguous"); }
  finally { probeJournalDurability.sync = sync; }
  assert.equal(f.writes.length, 0);
}));

test("deadline expiring during capture prevents any mutation", () => fixture(async f => {
  const options = await approved(f), capture = f.ports.capture;
  const ports = { ...f.ports, capture: async (...args: Parameters<typeof capture>) => { const result = await capture(...args); f.expire(); return result; } };
  await assert.rejects(runAttachmentTitleRunner(options, ports), /deadline|expired/i);
  assert.equal(f.writes.length, 0);
}));

test("ambiguous dispatch cannot be bypassed with fresh deadline/date/baseline", () => fixture(async f => {
  const options = await approved(f);
  const ports = { ...f.ports, connect: async () => ({ ...f.io, update: async (update: RecordUpdate) => { await f.io.update(update); throw Error("lost response"); } }) };
  assert.equal((await runAttachmentTitleRunner(options, ports)).status, "ambiguous");
  const retry = { ...f.options, modificationDate: 4_000, deadline: 9_000 };
  await assert.rejects(runAttachmentTitleRunner(retry, f.ports), /existing|recorded|ambiguous|intent/i);
  assert.equal(f.writes.length, 1);
}));

test("asset-byte drift after dispatch is ambiguous and leaves phase B unavailable", () => fixture(async f => {
  const options = await approved(f), capture = f.ports.capture;
  const ports = { ...f.ports, capture: async (...args: Parameters<typeof capture>) => {
    const result = await capture(...args); if (f.writes.length) result.assets[0]!.sha256 = "d".repeat(64); return result;
  } };
  assert.equal((await runAttachmentTitleRunner(options, ports)).status, "ambiguous");
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase: "B" }, f.ports), /phase A|acknowledg|complete/i);
}));

test("journal inside vault, shared folder and symlinked note ancestor are refused", () => fixture(async f => {
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, journalDirectory: path.join(f.vault, "evidence") }, f.ports), /outside|vault/i);
  f.cloud[2]!.shareRecordName = "share";
  await assert.rejects(runAttachmentTitleRunner(f.options, f.ports), /shared|private/i);
  delete f.cloud[2]!.shareRecordName;
  await rm(path.join(f.vault, f.file)); await rm(path.join(f.vault, "TEST"), { recursive: true });
  const real = path.join(f.root, "other"); await mkdir(real); await writeFile(path.join(real, "New drawing.md"), f.local);
  await symlink(real, path.join(f.vault, "TEST"));
  await assert.rejects(runAttachmentTitleRunner(f.options, f.ports), /symlink|outside|path/i);
  assert.equal(f.writes.length, 0);
}));

test("CLI parser defaults to preview and rejects missing/unknown apply parameters", () => {
  const args = ["--vault", "/vault", "--file", "TEST/New.md", "--note", noteId, "--attachment", attachmentId, "--folder", folderId, "--journal", "/journal", "--phase", "A", "--modification-date", "2000", "--deadline", "10000"];
  assert.equal(parseAttachmentTitleRunnerArgs(args).apply, false);
  assert.throws(() => parseAttachmentTitleRunnerArgs([...args, "--apply"]), /plan/i);
  assert.throws(() => parseAttachmentTitleRunnerArgs([...args, "--native-import", "true"]), /unknown/i);
});

test("approved plan cannot move to a fresh journal directory", () => fixture(async f => {
  const options = await approved(f);
  await assert.rejects(runAttachmentTitleRunner({ ...options, journalDirectory: path.join(f.root, "different-journal") }, f.ports), /plan/i);
  assert.equal(f.writes.length, 0);
}));

test("last private-folder lookup cannot hide a local edit before dispatch", () => fixture(async f => {
  const options = await approved(f), sync = probeJournalDurability.sync;
  let intent = false;
  probeJournalDurability.sync = async file => {
    await sync(file);
    if ((await file.stat()).isFile()) {
      const target = await import("node:fs/promises").then(fs => fs.readlink(`/proc/self/fd/${file.fd}`));
      if (target.endsWith("A.intent.json")) intent = true;
    }
  };
  const io = { ...f.io, lookup: async (ids: string[]) => {
    const result = await f.io.lookup(ids);
    if (intent && ids.includes(folderId)) await writeFile(path.join(f.vault, f.file), f.local + "changed");
    return result;
  } };
  try { assert.equal((await runAttachmentTitleRunner(options, { ...f.ports, connect: async () => io })).status, "ambiguous"); }
  finally { probeJournalDurability.sync = sync; }
  assert.equal(f.writes.length, 0);
}));

test("missing or corrupt post-A capture blocks B despite primitive ACK", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const complete = path.join(f.options.journalDirectory, "after-A/complete.json");
  await rm(complete);
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase: "B" }, f.ports), /capture|evidence/i);
  await writeFile(complete, "{}", { mode: 0o600 });
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase: "B" }, f.ports), /capture|evidence/i);
}));

test("code changes or expired approval cannot dispatch", () => fixture(async f => {
  const options = await approved(f);
  await assert.rejects(runAttachmentTitleRunner(options, { ...f.ports, codeIdentity: async () => "changed-code" }), /plan/i);
  f.expire();
  await assert.rejects(runAttachmentTitleRunner(options, f.ports), /deadline|expired/i);
  assert.equal(f.writes.length, 0);
}));

for (const changed of ["account", "folder", "missing-file"] as const) {
  test(`last-snapshot ${changed} authority change prevents dispatch`, () => fixture(async f => {
    const options = await approved(f); let folders = 0;
    const io = { ...f.io, lookup: async (ids: string[]) => {
      const result = await f.io.lookup(ids);
      if (ids.includes(folderId) && ++folders === 2) {
        if (changed === "missing-file") await rm(path.join(f.vault, f.file));
        else {
          if (changed === "account") f.state.account.dsid = "different-account";
          else f.state.folders[folderId].dirName = "Different";
          await writeCloneState(f.vault, f.state);
        }
      }
      return result;
    } };
    assert.equal((await runAttachmentTitleRunner(options, { ...f.ports, connect: async () => io })).status, "ambiguous");
    assert.equal(f.writes.length, 0);
  }));
}

test("approved plan is bound to the exact sync lock authority", () => fixture(async f => {
  const options = await approved(f);
  await assert.rejects(runAttachmentTitleRunner(options, { ...f.ports, lockAuthority: async () => ({ path: "/fixture/unrelated.lock", dev: "1", ino: "3" }) }), /plan|lock/i);
  assert.equal(f.writes.length, 0);
}));

test("native top-level folder may omit the Deleted field", () => fixture(async f => {
  f.cloud[2]!.deleted = false;
  f.cloud[2]!.fields = { TitleEncrypted: { type: "ENCRYPTED_BYTES", value: encoded("TEST") } };
  const result = await runAttachmentTitleRunner(f.options, f.ports);
  assert.equal(result.status, "preview");
  assert.equal(f.writes.length, 0);
}));

for (const deletion of ["field-deleted", "malformed-field", "record-deleted"] as const) {
  test(`folder ${deletion} refuses the title experiment`, () => fixture(async f => {
    if (deletion === "record-deleted") f.cloud[2]!.deleted = true;
    else f.cloud[2]!.fields.Deleted = deletion === "field-deleted" ? { type: "INT64", value: 1 } : { type: "STRING", value: 0 };
    await assert.rejects(runAttachmentTitleRunner(f.options, f.ports), /folder/i);
    assert.equal(f.writes.length, 0);
  }));
}

test("checked runner supports A followed by one captured atomic BA request", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = { ...f.options, phase: "BA" as const, modificationDate: 3_000 };
  const result = await runAttachmentTitleRunner(await approved(f, options), f.ports);
  assert.equal(result.status, "cloud-applied-native-unverified"); assert.equal(f.batches.length, 1);
  assert.deepEqual(f.batches[0]!.map(update => update.recordType), ["Note", "Attachment"]);
  assert.equal(f.writes.length, 3); assert.equal(f.captures.length, 4);
  assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.local);
}));

test("BA cannot bypass an existing ambiguous B caller intent", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = await approved(f, { ...f.options, phase: "B" });
  const ports = { ...f.ports, connect: async () => ({ ...f.io, update: async () => { throw Error("lost before acknowledgement"); } }) };
  assert.equal((await runAttachmentTitleRunner(options, ports)).status, "ambiguous");
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase: "BA" }, f.ports), /terminal|another|alternate/i);
  assert.equal(f.writes.length, 1); assert.equal(f.batches.length, 0);
}));

test("BA repeats the final local authority check before its single batch dispatch", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = await approved(f, { ...f.options, phase: "BA" }); let folderLookups = 0;
  const io = { ...f.io, lookup: async (ids: string[]) => {
    const result = await f.io.lookup(ids);
    if (ids.includes(folderId) && ++folderLookups === 2) await writeFile(path.join(f.vault, f.file), f.local + "changed");
    return result;
  } };
  assert.equal((await runAttachmentTitleRunner(options, { ...f.ports, connect: async () => io })).status, "ambiguous");
  assert.equal(f.batches.length, 0); assert.equal(f.writes.length, 1);
}));

test("BD preview discloses the exact final document hash while local/drawing bytes stay intact", () => fixture(async f => {
  const stateBefore = await readFile(path.join(f.vault, ".icloud-md/state.json"));
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = { ...f.options, phase: "BD" as const, modificationDate: 3_000 };
  const preview = await runAttachmentTitleRunner(options, f.ports);
  assert.equal(preview.documentRevision?.strategy, "trailing-tombstone-v1");
  assert.deepEqual(preview.fieldMask, ["TitleEncrypted", "ModificationDate", "TextDataEncrypted"]);
  const result = await runAttachmentTitleRunner({ ...options, apply: true, expectedPlanSha256: preview.planSha256 }, f.ports);
  assert.equal(result.status, "cloud-applied-native-unverified");
  assert.deepEqual(result.documentRevision, preview.documentRevision);
  assert.equal(sha(Buffer.from(f.cloud[0]!.fields.TextDataEncrypted!.value as string, "base64")), preview.documentRevision!.documentSha256);
  assert.notEqual(preview.documentRevision!.documentSha256, preview.documentRevision!.previousDocumentSha256);
  assert.equal(await readFile(path.join(f.vault, f.file), "utf8"), f.local);
  assert.deepEqual(await readFile(path.join(f.vault, ".icloud-md/state.json")), stateBefore);
  assert.equal(f.batches.length, 0); assert.equal(f.writes.length, 2); assert.equal(f.captures.length, 4);
}));

test("BD's document allowance never weakens asset-byte preservation", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = await approved(f, { ...f.options, phase: "BD" });
  const capture = f.ports.capture;
  const ports = { ...f.ports, capture: async (...args: Parameters<typeof capture>) => {
    const result = await capture(...args); if (f.writes.length > 1) result.assets[0]!.sha256 = "d".repeat(64); return result;
  } };
  assert.equal((await runAttachmentTitleRunner(options, ports)).status, "ambiguous");
  assert.equal(f.writes.length, 2);
}));

test("a prior ambiguous BA caller intent blocks BD before any new dispatch", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = await approved(f, { ...f.options, phase: "BA" });
  const ports = { ...f.ports, connect: async () => ({ ...f.io, updateBatch: async () => { throw Error("uncertain batch"); } }) };
  assert.equal((await runAttachmentTitleRunner(options, ports)).status, "ambiguous");
  await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase: "BD" }, f.ports), /terminal|another|alternate/i);
  assert.equal(f.writes.length, 1);
}));


test("explicit replacement phase parses without opening an account", () => {
  const options = parseAttachmentTitleRunnerArgs(["--vault", "/fixture/vault", "--file", "TEST/New.md", "--note", noteId,
    "--attachment", attachmentId, "--folder", folderId, "--journal", "/fixture/journal", "--phase", "BR",
    "--modification-date", "2000", "--deadline", "10000"]);
  assert.equal(options.phase, "BR");
});


test("BR caller binds and preserves its exact computed revision and asset bytes", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  const options = { ...f.options, phase: "BR" as const, modificationDate: 3_000 };
  const preview = await runAttachmentTitleRunner(options, f.ports);
  assert.equal(preview.documentRevision?.strategy, "replace-drawing-v1");
  const outcome = await runAttachmentTitleRunner({ ...options, apply: true, expectedPlanSha256: preview.planSha256 }, f.ports);
  assert.equal(outcome.status, "cloud-applied-native-unverified"); assert.deepEqual(outcome.documentRevision, preview.documentRevision);
  assert.equal(f.writes.length, 2);
  assert.equal(sha(Buffer.from(f.cloud[0]!.fields.TextDataEncrypted!.value as string, "base64")), preview.documentRevision!.documentSha256);
}));


test("an ambiguous replacement caller intent excludes metadata and dead-character alternatives", () => fixture(async f => {
  await runAttachmentTitleRunner(await approved(f), f.ports);
  await writeFile(path.join(f.options.journalDirectory, "BR.request.json"), "{}", { mode: 0o600 });
  for (const phase of ["B", "BA", "BD"] as const) await assert.rejects(runAttachmentTitleRunner({ ...f.options, phase }, f.ports), /terminal|alternate|another/i);
  assert.equal(f.writes.length, 1);
}));
