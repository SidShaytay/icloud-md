import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const { writeCloneState } = await import("../notes/cloneState.js");
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
const attachmentId = "DRAWING-ATTACHMENT";
const folderId = "TEST-FOLDER";
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

for (const request of ["filename", "frontmatter", "body-and-title", "removed-title", "relocated-title", "different-replica"] as const) {
  test(`push does not write an independent attachment title requested through ${request}`, async () => {
    const vault = await mkdtemp(path.join(home, "vault-"));
    const record = drawingRecord(request === "removed-title" ? "CON" : "Original drawing");
    const before = structuredClone(record);
    const classified = classifyNoteRecord(record, { titleMode: "filename" });
    assert.equal(classified.status, "ok");
    if (classified.status !== "ok") return;
    assert.equal(classified.titleInMetadata, true);
    assert.equal(classified.publishable, true, "exercise a renderable drawing, not an earlier unsupported-body refusal");
    const body = classified.markdownText.replace("\uFFFC", formatEmbedMarker(classified.attachments[0]!));
    const originalFile = request === "removed-title" ? "TEST/Untitled.md" : "TEST/Original drawing.md";
    const currentFile = request === "relocated-title" ? "OTHER/Changed drawing.md"
      : request === "filename" || request === "different-replica" ? "TEST/Changed drawing.md" : originalFile;
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
      assert.equal(result.pushed, 0);
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0]?.resolution, "refused");
      assert.match(result.entries[0]?.reason ?? "", /retitle.*Notes/i);
      assert.deepEqual(record, before);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(vault, { recursive: true, force: true });
    }
  });
}
