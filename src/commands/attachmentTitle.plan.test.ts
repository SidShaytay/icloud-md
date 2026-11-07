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
const { runPush } = await import("./push.js");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const replica = new Uint8Array(16).fill(7);
const noteId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const account = { appleId: "fixture@example.invalid", dsid: "fixture-account" };

function drawingRecord(title = "Original drawing"): CloudKitRecord {
  const doc = buildInitialNoteDocument("\uFFFC", replica);
  doc.attributeRuns[0]!.attachmentInfo = create(AttachmentInfoSchema, {
    attachmentIdentifier: attachmentId,
    typeUTI: "com.apple.paper",
  });
  return {
    recordName: noteId, recordType: "Note", recordChangeTag: "drawing-tag",
    fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from(title).toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } },
      ModificationDate: { type: "TIMESTAMP", value: 100 },
    },
  };
}

// Desired caller contract for issue #1. This fake server can prove that push
// targets the existing records and preserves opaque content; it deliberately
// does not simulate Apple's native title cache or establish a safe wire fix.
test("two drawing filename renames converge through icloud-md without changing the document or drawing", async () => {
  const vault = await mkdtemp(path.join(home, "standalone-rename-"));
  const note = drawingRecord();
  const assetBytes = new Map<string, Uint8Array>();
  const opaqueAsset = (name: string) => {
    const downloadURL = `https://assets.invalid/${name}`;
    assetBytes.set(downloadURL, new Uint8Array(32).fill(name.length));
    return { type: "ASSETID", value: { fileChecksum: `${name}-checksum`, size: 32, downloadURL } };
  };
  note.parentRecordName = folderId;
  note.fields.FirstAttachmentThumbnail = opaqueAsset("thumbnail");
  const attachment: CloudKitRecord = {
    recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag", parentRecordName: noteId,
    fields: {
      UTI: { type: "STRING", value: "com.apple.paper" },
      UserTitle: { type: "ENCRYPTED_BYTES", value: Buffer.from("Original drawing").toString("base64") },
      Note: { type: "REFERENCE", value: { recordName: noteId } },
      PaperDatabase: opaqueAsset("paper-database"),
      FallbackImage: opaqueAsset("fallback-image"),
      PreviewImages: { type: "ASSETID_LIST", value: [opaqueAsset("preview").value] },
      PaperAssets: { type: "ASSETID_LIST", value: [opaqueAsset("drawing").value] },
    },
  };
  const records = new Map([[noteId, note], [attachmentId, attachment]]);
  const originalNote = structuredClone(note);
  const originalAttachment = structuredClone(attachment);
  const classified = classifyNoteRecord(note, { titleMode: "filename" });
  assert.equal(classified.status, "ok");
  if (classified.status !== "ok") return;
  assert.equal(classified.titleInMetadata, true);
  assert.equal(classified.publishable, true);
  assert.equal(classified.attachments.length, 1);
  const body = classified.markdownText.replace("\uFFFC", formatEmbedMarker(classified.attachments[0]!));
  const originalContents = composeNoteFile("", body, noteId);
  let currentFile = "TEST/Original drawing.md";
  await mkdir(path.join(vault, "TEST"));
  await writeCloneState(vault, {
    account, titleMode: "filename", replicaId: Buffer.from(replica).toString("base64"), syncToken: "",
    folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
    notes: { [noteId]: { file: currentFile, recordChangeTag: note.recordChangeTag!, modificationDate: 100, folderRecordName: folderId } },
  });
  await writeBaseCopy(vault, noteId, body);
  await writeFile(path.join(vault, currentFile), originalContents);
  await writeSessionFile({
    cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1",
    capturedAt: new Date().toISOString(),
  }, accountSessionPath(account.dsid));

  const originalFetch = globalThis.fetch;
  let version = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/validate")) {
      return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
    }
    if (assetBytes.has(url.href)) {
      assert.equal(init?.method ?? "GET", "GET", "drawing and preview bytes may only be read");
      return new Response(assetBytes.get(url.href)!);
    }
    assert.equal(url.hostname, "cloudkit.invalid", "all cloud mutations must use the fixture CloudKit endpoint");
    if (url.pathname.endsWith("/records/lookup")) {
      const requested = JSON.parse(init!.body as string).records as { recordName: string }[];
      return Response.json({ records: requested.map(({ recordName }) => {
        const record = records.get(recordName);
        assert.ok(record, "only the existing note and drawing may be read");
        return structuredClone(record);
      }) });
    }
    if (url.pathname.endsWith("/records/modify")) {
      const request = JSON.parse(init!.body as string) as { operations: {
        operationType: string;
        record: { recordName: string; recordType: string; recordChangeTag: string; fields: Record<string, { value: unknown; type?: string }> };
      }[] };
      const updated = request.operations.map(operation => {
        assert.equal(operation.operationType, "update", "a rename must not create or delete a note or drawing");
        const existing = records.get(operation.record.recordName);
        assert.ok(existing, "only the existing note and drawing may be updated");
        assert.equal(operation.record.recordType, existing.recordType);
        assert.equal(operation.record.recordChangeTag, existing.recordChangeTag, "updates must target the current record version");
        for (const [key, field] of Object.entries(operation.record.fields)) {
          existing.fields[key] = { value: field.value, type: field.type ?? existing.fields[key]?.type ?? "STRING" };
        }
        existing.recordChangeTag = `renamed-${++version}`;
        return structuredClone(existing);
      });
      return Response.json({ records: updated });
    }
    assert.fail("Unexpected request in offline rename regression: " + url.pathname);
  };
  try {
    for (const title of ["First drawing rename", "Second drawing rename"]) {
      const renamedFile = `TEST/${title}.md`;
      await rename(path.join(vault, currentFile), path.join(vault, renamedFile));
      let converged = false;
      // A standalone implementation may publish drawing metadata and the note
      // title in separate cycles. Do not require a single atomic cloud request
      // or pretend that our fake server can acknowledge a native import.
      for (let phase = 0; phase < 4; phase++) {
        const result = await runPush(vault);

        // Preservation is checked even while the required rename still fails.
        assert.equal(note.fields.TextDataEncrypted?.value, originalNote.fields.TextDataEncrypted?.value);
        assert.deepEqual(note.fields.FirstAttachmentThumbnail, originalNote.fields.FirstAttachmentThumbnail);
        assert.equal(note.parentRecordName, originalNote.parentRecordName);
        assert.deepEqual(note.fields.Folder, originalNote.fields.Folder);
        for (const key of ["UTI", "Note", "PaperDatabase", "FallbackImage", "PreviewImages", "PaperAssets"]) {
          assert.deepEqual(attachment.fields[key], originalAttachment.fields[key], `${key} must remain unchanged`);
        }
        assert.equal(attachment.parentRecordName, originalAttachment.parentRecordName);
        assert.equal(records.size, 2, "the original note and drawing retain their identities");
        assert.equal(await readFile(path.join(vault, renamedFile), "utf8"), originalContents, "no heading or other body change may be added");

        for (const entry of result.entries) {
          assert.notEqual(entry.resolution, "refused", entry.reason);
          assert.notEqual(entry.resolution, "conflict", entry.reason);
        }
        const state = await readCloneState(vault);
        converged = Buffer.from(note.fields.TitleEncrypted!.value as string, "base64").toString() === title
          && state?.notes[noteId]?.file === renamedFile;
        if (converged) break;
      }
      assert.equal(converged, true, "cloud title and local filename tracking must converge within bounded sync phases");
      const writesBeforeRepeat = version;
      assert.equal((await runPush(vault)).pushed, 0, "another sync must not repeat a completed rename");
      assert.equal(version, writesBeforeRepeat, "completed renames must not emit another cloud mutation");
      currentFile = renamedFile;
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(vault, { recursive: true, force: true });
  }
});

for (const request of ["filename", "frontmatter", "body-and-title", "removed-title", "relocated-title", "different-replica", "already-current"] as const) {
  test(`push does not write an independent attachment title requested through ${request}`, async () => {
    const vault = await mkdtemp(path.join(home, "vault-"));
    const record = drawingRecord(request === "removed-title" ? "CON" : request === "already-current" ? "Changed drawing" : "Original drawing");
    const before = structuredClone(record);
    const classified = classifyNoteRecord(record, { titleMode: "filename" });
    assert.equal(classified.status, "ok");
    if (classified.status !== "ok") return;
    assert.equal(classified.titleInMetadata, true);
    assert.equal(classified.publishable, true, "exercise a renderable drawing, not an earlier unsupported-body refusal");
    const body = classified.markdownText.replace("\uFFFC", formatEmbedMarker(classified.attachments[0]!));
    const originalFile = request === "removed-title" ? "TEST/Untitled.md" : "TEST/Original drawing.md";
    const currentFile = request === "relocated-title" ? "OTHER/Changed drawing.md"
      : request === "filename" || request === "different-replica" || request === "already-current" ? "TEST/Changed drawing.md" : originalFile;
    const requestedTitle = request === "frontmatter" || request === "body-and-title" ? "Changed drawing" : undefined;
    const cloneReplica = request === "different-replica" ? new Uint8Array(16).fill(9) : replica;
    await writeCloneState(vault, {
      account, titleMode: "filename", replicaId: Buffer.from(cloneReplica).toString("base64"), syncToken: "",
      folders: { [folderId]: { name: "TEST", dirName: "TEST" }, "OTHER-FOLDER": { name: "OTHER", dirName: "OTHER" } },
      notes: { [noteId]: { file: originalFile, recordChangeTag: "drawing-tag", modificationDate: 100, folderRecordName: folderId,
        ...(request === "removed-title" ? { frontmatterTitle: "CON" } : {}),
      } },
    });
    await mkdir(path.join(vault, "TEST"));
    await mkdir(path.join(vault, "OTHER"));
    await writeBaseCopy(vault, noteId, body);
    await writeFile(path.join(vault, currentFile), composeNoteFile("", request === "body-and-title" ? body + "\nEdited prose" : body, noteId, requestedTitle));
    await writeSessionFile({
      cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1",
      capturedAt: new Date().toISOString(),
    }, accountSessionPath(account.dsid));

    const originalFetch = globalThis.fetch;
    let modifications = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/validate")) {
        return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
      }
      if (url.pathname.endsWith("/records/lookup")) {
        const requested = JSON.parse(init!.body as string).records as { recordName: string }[];
        const records = requested.map(({ recordName }) => {
          if (recordName === noteId) return structuredClone(record);
          if (recordName === attachmentId) {
            return {
              recordName: attachmentId, recordType: "Attachment", recordChangeTag: "attachment-tag",
              fields: {
                UTI: { type: "STRING", value: "com.apple.paper" },
                UserTitle: { type: "ENCRYPTED_BYTES", value: Buffer.from("Original drawing").toString("base64") },
              },
            };
          }
          assert.fail("Unexpected fixture lookup: " + recordName);
        });
        return Response.json({ records });
      }
      if (url.pathname.endsWith("/records/modify")) {
        modifications++;
        return Response.json({ records: [{ recordName: noteId, serverErrorCode: "FORBIDDEN", reason: "fixture prohibits writes" }] });
      }
      assert.fail("Unexpected request in offline test: " + url.pathname);
    };
    try {
      const result = await runPush(vault);
      assert.equal(modifications, 0, "refusal must occur before records/modify");
      assert.equal(result.entries.length, 1);
      if (request === "already-current") {
        assert.equal(result.pushed, 1);
        assert.equal(result.entries[0]?.resolution, "ready");
        assert.equal(result.entries[0]?.localOnly, true);
        assert.equal((await readCloneState(vault))?.notes[noteId]?.file, currentFile);
      } else {
        assert.equal(result.pushed, 0);
        assert.equal(result.entries[0]?.resolution, "refused");
        assert.match(result.entries[0]?.reason ?? "", /retitle.*Notes/i);
      }
      assert.deepEqual(record, before);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(vault, { recursive: true, force: true });
    }
  });
}
