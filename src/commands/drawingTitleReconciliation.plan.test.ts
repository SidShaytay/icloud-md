import { openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

// Isolate sessions and debug logs before loading any account-related modules.
// Every request is mocked; these tests cannot contact a real iCloud account.
const home = await mkdtemp(path.join(os.tmpdir(), "attachment-title-plan-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { create } = await import("@bufbuild/protobuf");
const { AttachmentInfoSchema } = await import("../notes/gen/topotext_pb.js");
const { buildInitialNoteDocument, encodeNoteDocument } = await import("../notes/noteDocument.js");
const { compressNoteDocument } = await import("../notes/noteText.js");
const { classifyNoteRecord } = await import("../notes/decodeNoteRecord.js");
const { formatEmbedMarker } = await import("../notes/unknownContent.js");
const { writeCloneState, readCloneState } = await import("../notes/cloneState.js");
const { writeBaseCopy } = await import("../notes/baseCopy.js");
const { composeNoteFile } = await import("../notes/noteIdFrontmatter.js");
const { writeSessionFile } = await import("../session.js");
const { accountSessionPath } = await import("../auth/accountStore.js");
let clock = Date.now(); const realNow = Date.now; Date.now = () => clock;
const { runPush } = await import("./push.js");
const { runStatus } = await import("./status.js");

after(async () => {
  Date.now = realNow;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const replica = new Uint8Array(16).fill(7);
const noteId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const account = { appleId: "fixture@example.invalid", dsid: "fixture-account" };

function rawRecord(record: CloudKitRecord) { const { parentRecordName, ...raw } = structuredClone(record); return { ...raw, ...(parentRecordName ? { parent: { recordName: parentRecordName } } : {}) }; }

function drawingRecord(title = "Original drawing"): CloudKitRecord {
  const doc = buildInitialNoteDocument("\uFFFC", replica);
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, {
    attachmentIdentifier: attachmentId,
    typeUTI: "com.apple.paper",
  });
  return {
    recordName: noteId, recordType: "Note", recordChangeTag: "drawing-tag", parentRecordName: folderId,
    fields: {
      Deleted: { type: "INT64", value: 0 },
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from(title).toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } },
      ModificationDate: { type: "TIMESTAMP", value: 100 },
    },
  };
}

test("ongoing SDK workflow settles two filenames and later refreshes only the note title", async () => {
    const vault = await mkdtemp(path.join(home, "vault-"));
    const record = drawingRecord();
    const drawing: CloudKitRecord = { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "drawing-a", parentRecordName: noteId, fields: {
      UTI: { type: "STRING", value: "com.apple.paper" }, Deleted: { type: "INT64", value: 0 }, Note: { type: "REFERENCE", value: { recordName: noteId } }, UserTitle: { type: "ENCRYPTED_BYTES", value: Buffer.from("Original drawing").toString("base64") },
      PaperDatabase: { type: "ASSETID", value: { downloadURL: "https://cvws.icloud-content.com/fixture", size: 3, fileChecksum: "pixels", referenceChecksum: "reference", wrappingKey: "key" } },
    } };
    const modifications: string[][] = [];
    const classified = classifyNoteRecord(record, { titleMode: "filename" });
    assert.equal(classified.status, "ok");
    if (classified.status !== "ok") return;
    assert.equal(classified.titleInMetadata, true);
    assert.equal(classified.publishable, true, "exercise a renderable drawing, not an earlier unsupported-body refusal");
    const body = classified.markdownText.replace("\uFFFC", formatEmbedMarker(classified.attachments[0]!));
    const originalFile = "TEST/Original drawing.md", currentFile = "TEST/Changed drawing.md";
    await writeCloneState(vault, {
      account, titleMode: "filename", replicaId: Buffer.from(replica).toString("base64"), syncToken: "",
      folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
      notes: { [noteId]: { file: originalFile, recordChangeTag: "drawing-tag", modificationDate: 100, folderRecordName: folderId,
      } },
    });
    await mkdir(path.join(vault, "TEST"));
    await writeBaseCopy(vault, noteId, body);
    await writeFile(path.join(vault, currentFile), composeNoteFile("", body, noteId));
    await writeSessionFile({
      cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1",
      capturedAt: new Date().toISOString(),
    }, accountSessionPath(account.dsid));

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "cvws.icloud-content.com") return new Response(new Uint8Array([1, 2, 3]));
      if (url.pathname.endsWith("/validate")) {
        return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
      }
      if (url.pathname.endsWith("/records/lookup")) {
        const requested = JSON.parse(init!.body as string).records as { recordName: string }[];
        const records = requested.map(({ recordName }) => {
          if (recordName === noteId) return rawRecord(record);
          if (recordName === attachmentId) return rawRecord(drawing);
          if (recordName === folderId) return { recordName: folderId, recordType: "Folder", recordChangeTag: "folder-a", deleted: false, fields: { TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("TEST").toString("base64") } } };
          assert.fail("Unexpected fixture lookup: " + recordName);
        });
        return Response.json({ records });
      }
      if (url.pathname.endsWith("/records/modify")) {
        const operations = JSON.parse(init!.body as string).operations;
        assert.equal(operations.length, 1);
        const update = operations[0].record;
        const current = update.recordName === noteId ? record : drawing;
        assert.equal(update.recordChangeTag, current.recordChangeTag);
        modifications.push(Object.keys(update.fields));
        for (const [key, field] of Object.entries(update.fields)) current.fields[key] = { ...(field as { value: unknown }), type: key === "ModificationDate" ? "TIMESTAMP" : "ENCRYPTED_BYTES" };
        current.recordChangeTag += "+";
        return Response.json({ records: [rawRecord(current)] });
      }
      assert.fail("Unexpected request in offline test: " + url.pathname);
    };
    const lockPath = path.join(home, "sync.lock"), fd = openSync(lockPath, "a", 0o600);
    assert.equal(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] }).status, 0);
    const oldPath = process.env.ICLOUD_MD_PROBE_LOCK_PATH, oldFd = process.env.ICLOUD_MD_PROBE_LOCK_FD;
    process.env.ICLOUD_MD_PROBE_LOCK_PATH = lockPath; process.env.ICLOUD_MD_PROBE_LOCK_FD = String(fd);
    try {
      const options = { drawingTitleReconciliation: { journalDirectory: path.join(home, "title-journal"), folderIds: [folderId], noteIds: [noteId] } };
      const status = await runStatus(vault, options);
      assert.equal(status.entries[0]?.resolution, "ready", JSON.stringify(status));
      const preview = await runPush(vault, { ...options, dryRun: true });
      assert.equal(preview.entries[0]?.resolution, "ready", JSON.stringify(preview)); assert.equal(modifications.length, 0);
      const first = await runPush(vault, options);
      assert.equal(first.pushed, 1, JSON.stringify(first)); assert.equal(modifications.length, 2);
      const nextFile = "TEST/Newest drawing.md"; await rename(path.join(vault, currentFile), path.join(vault, nextFile));
      clock += 1000;
      const second = await runPush(vault, options);
      assert.equal(second.pushed, 1, JSON.stringify(second)); assert.equal(modifications.length, 4);
      assert.deepEqual(modifications, [["UserTitle"], ["TitleEncrypted", "ModificationDate"], ["UserTitle"], ["TitleEncrypted", "ModificationDate"]]);
      assert.equal((await readCloneState(vault))?.notes[noteId]?.file, nextFile);
      assert.equal((await readCloneState(vault))?.notes[noteId]?.recordChangeTag, record.recordChangeTag);
      assert.equal((await runPush(vault, options)).pushed, 0);
      const beforeRefresh = structuredClone(record), stamp = (await import("node:fs/promises")).stat;
      const fileBefore = await stamp(path.join(vault, nextFile)); clock += 300001;
      const dueStatus = await runStatus(vault, options);
      assert.equal(dueStatus.entries[0]?.kind, "update"); assert.equal(dueStatus.entries[0]?.resolution, "ready");
      assert.equal(modifications.length, 4, "status must not send a due refresh");
      const refresh = await runPush(vault, options); assert.equal(refresh.pushed, 1);
      assert.equal(modifications.length, 5); assert.deepEqual(modifications[4], ["TitleEncrypted"]);
      assert.equal(record.fields.ModificationDate!.value, beforeRefresh.fields.ModificationDate!.value);
      assert.equal(record.fields.TextDataEncrypted!.value, beforeRefresh.fields.TextDataEncrypted!.value);
      assert.equal((await stamp(path.join(vault, nextFile))).mtimeMs, fileBefore.mtimeMs);
      assert.equal(record.fields.TitleEncrypted!.value, Buffer.from("Newest drawing").toString("base64"));
      assert.equal(drawing.fields.UserTitle!.value, record.fields.TitleEncrypted!.value);
      assert.equal(await readFile(path.join(vault, nextFile), "utf8"), composeNoteFile("", body, noteId));
    } finally {
      closeSync(fd);
      if (oldPath === undefined) delete process.env.ICLOUD_MD_PROBE_LOCK_PATH; else process.env.ICLOUD_MD_PROBE_LOCK_PATH = oldPath;
      if (oldFd === undefined) delete process.env.ICLOUD_MD_PROBE_LOCK_FD; else process.env.ICLOUD_MD_PROBE_LOCK_FD = oldFd;
      globalThis.fetch = originalFetch;
      await rm(vault, { recursive: true, force: true });
    }
});
