import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

// No real account or network: isolate HOME before importing account modules.
const home = await mkdtemp(path.join(os.tmpdir(), "attachment-title-pull-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const { create } = await import("@bufbuild/protobuf");
const { AttachmentInfoSchema, AttributeRunSchema } = await import("../notes/gen/topotext_pb.js");
const { buildInitialNoteDocument, encodeNoteDocument } = await import("../notes/noteDocument.js");
const { compressNoteDocument } = await import("../notes/noteText.js");
const { classifyNoteRecord } = await import("../notes/decodeNoteRecord.js");
const { formatEmbedMarker } = await import("../notes/unknownContent.js");
const { readCloneState, readRawStateFile, writeRawStateFile, writeCloneState } = await import("../notes/cloneState.js");
const { readBaseCopy, writeBaseCopy } = await import("../notes/baseCopy.js");
const { composeNoteFile } = await import("../notes/noteIdFrontmatter.js");
const { writeSessionFile } = await import("../session.js");
const { accountSessionPath } = await import("../auth/accountStore.js");
const { runPull } = await import("./pull.js");

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const replica = new Uint8Array(16).fill(7);
const account = { appleId: "fixture@example.invalid", dsid: "fixture-account" };
const folderId = "TEST-FOLDER";
const noteId = "11111111-1111-4111-8111-111111111111";
const absentIds = {
  clean: "22222222-2222-4222-8222-222222222221",
  dirty: "22222222-2222-4222-8222-222222222222",
  moved: "22222222-2222-4222-8222-222222222223",
};
const localFrontmatter = "---\ntags: [keep]\n---\n\n";
const owner = "shared-owner";
const zoneID = { zoneName: "Notes", ownerRecordName: owner };
const folder: CloudKitRecord = {
  recordName: folderId, recordType: "Folder",
  fields: { TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("TEST").toString("base64") } },
};

function note(recordName: string, title: string, drawing = false): CloudKitRecord {
  const doc = buildInitialNoteDocument(drawing ? "\uFFFC\nOriginal prose" : `${title}\nOriginal prose`, replica);
  if (drawing) {
    const first = doc.attributeRuns[0]!;
    if (first.length > 1) {
      doc.attributeRuns.splice(1, 0, create(AttributeRunSchema, { length: first.length - 1, paragraphStyle: first.paragraphStyle }));
      first.length = 1;
    }
    first.attachmentInfo = create(AttachmentInfoSchema, {
      attachmentIdentifier: "DRAWING-ATTACHMENT", typeUTI: "com.apple.paper",
    });
  }
  return {
    recordName, recordType: "Note", recordChangeTag: "same-tag",
    fields: {
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from(title).toString("base64") },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(encodeNoteDocument(doc)).toString("base64") },
      Folder: { type: "REFERENCE", value: { recordName: folderId } },
      ModificationDate: { type: "TIMESTAMP", value: 100 },
    },
  };
}

for (const scenario of ["ordinary", "deferred-collision", "dirty-title", "shared", "local-move", "local-delete", "reserved-title", "long-title", "remote-absence", "missing-body", "skipped-shared", "fetch-failure"] as const) {
  test(`an unchanged layout-3 drawing gets a safe one-time filename refresh: ${scenario}`, async () => {
    const vault = await mkdtemp(path.join(home, "vault-"));
    const shared = scenario === "shared" || scenario === "skipped-shared";
    const dir = shared ? "Shared owner" : "TEST";
    const oldFile = `${dir}/\uFFFC.md`;
    const title = scenario === "reserved-title" ? "CON" : scenario === "long-title" ? "A drawing title that is longer than the supported filename length limit" : "Readable drawing";
    const unrepresentable = scenario === "reserved-title" || scenario === "long-title";
    const record = note(noteId, title, true);
    const beforeRemote = structuredClone(record);
    const classified = classifyNoteRecord(record, { titleMode: "filename" });
    assert.equal(classified.status, "ok");
    if (classified.status !== "ok") return;
    const base = classified.markdownText.replace("\uFFFC", formatEmbedMarker(classified.attachments[0]!));
    const localBody = scenario === "dirty-title" ? base.replace("Original prose", "Local prose") : base;
    const original = composeNoteFile(localFrontmatter, localBody, noteId, scenario === "dirty-title" ? "Wanted title" : undefined);
    await mkdir(path.join(vault, "TEST"), { recursive: true });
    await mkdir(path.join(vault, dir), { recursive: true });
    const localDrawingFile = scenario === "local-move" ? `${dir}/User's drawing.md` : oldFile;
    if (scenario !== "local-delete") await writeFile(path.join(vault, localDrawingFile), original);
    await writeBaseCopy(vault, noteId, base);
    const initialMtime = scenario === "local-delete" ? undefined : (await stat(path.join(vault, localDrawingFile))).mtimeMs;
    const notes: NonNullable<Awaited<ReturnType<typeof readCloneState>>>["notes"] = {
      [noteId]: {
        file: oldFile, recordChangeTag: "same-tag", modificationDate: 100,
        ...(shared ? { sharedZoneOwner: owner } : { folderRecordName: folderId }),
      },
    };
    const regularRecords: CloudKitRecord[] = [];
    const retainedFiles = new Map<string, string>();
    for (const kind of ["clean", "dirty", "missing", "moved"] as const) {
      const id = "00000001-0000-4000-8000-00000000000" + ["clean", "dirty", "missing", "moved"].indexOf(kind);
      const title = `Regular ${kind}`;
      const regular = note(id, title);
      regularRecords.push(regular);
      const decoded = classifyNoteRecord(regular, { titleMode: "filename" });
      assert.equal(decoded.status, "ok");
      if (decoded.status !== "ok") return;
      const file = `TEST/${title}.md`;
      notes[id] = { file, recordChangeTag: "same-tag", modificationDate: 100, folderRecordName: folderId };
      await writeBaseCopy(vault, id, decoded.markdownText);
      if (kind !== "missing") {
        const actualFile = kind === "moved" ? "TEST/Locally renamed.md" : file;
        const content = composeNoteFile("", kind === "dirty" ? "Local prose" : decoded.markdownText, id);
        await writeFile(path.join(vault, actualFile), content);
        retainedFiles.set(actualFile, content);
      }
    }
    if (scenario === "remote-absence") {
      for (const kind of ["clean", "dirty", "moved"] as const) {
        const id = absentIds[kind];
        const file = `TEST/Absent ${kind}.md`;
        notes[id] = { file, recordChangeTag: "same-tag", modificationDate: 100, folderRecordName: folderId };
        await writeBaseCopy(vault, id, "Original prose");
        const actual = kind === "moved" ? "TEST/Locally moved absent.md" : file;
        await writeFile(path.join(vault, actual), composeNoteFile("", kind === "dirty" ? "Locally edited prose" : "Original prose", id));
      }
    }
    const collisionFile = `${dir}/Readable drawing.md`;
    if (scenario === "deferred-collision") await writeFile(path.join(vault, collisionFile), "Untracked content");
    await writeCloneState(vault, {
      account, titleMode: "filename", replicaId: Buffer.from(replica).toString("base64"),
      syncToken: "old-private", sharedZoneSyncTokens: shared ? { [owner]: "old-shared" } : {},
      folders: { [folderId]: { name: "TEST", dirName: "TEST" } },
      ...(shared ? { sharerHomes: { [owner]: { name: "Shared owner", dirName: dir } } } : {}),
      notes,
    });
    await writeRawStateFile(vault, { ...(await readRawStateFile(vault))!, layoutVersion: 3 });
    await writeSessionFile({
      cookie: "fixture=local", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1",
      capturedAt: new Date().toISOString(),
    }, accountSessionPath(account.dsid));

    const originalFetch = globalThis.fetch;
    let modifications = 0;
    let incomplete = scenario === "missing-body" || scenario === "skipped-shared";
    let failFetch = scenario === "fetch-failure";
    const inputCursors: Array<string | undefined> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/validate")) return Response.json({ dsInfo: account, webservices: { ckdatabasews: { url: "https://cloudkit.invalid" } } });
      if (url.pathname.endsWith("/records/modify")) {
        modifications++;
        assert.fail("offline pull must never write remote records");
      }
      if (url.pathname.endsWith("/changes/database")) return Response.json({ zones: shared ? [{ zoneID }] : [] });
      if (url.pathname.endsWith("/changes/zone")) {
        if (failFetch) throw new Error("fixture fetch failure");
        const request = JSON.parse(init!.body as string).zones[0];
        const isShared = url.pathname.includes("/shared/");
        inputCursors.push(request.syncToken);
        // An unchanged note is absent from an incremental delta. Only a
        // token-free replay can deliver it for the filename correction.
        const drawing = structuredClone(record);
        if (incomplete) delete drawing.fields.TextDataEncrypted;
        const records = request.syncToken ? [] : isShared ? [drawing] : [folder, ...regularRecords, ...(shared ? [] : [drawing])];
        return Response.json({ zones: [{ zoneID: isShared ? zoneID : { zoneName: "Notes" }, records, syncToken: isShared ? "new-shared" : "new-private" }] });
      }
      if (url.pathname.endsWith("/records/lookup")) {
        const requested = JSON.parse(init!.body as string).records as { recordName: string }[];
        return Response.json({ records: requested.map(({ recordName }) => {
          if (recordName === noteId) {
            const drawing = structuredClone(record);
            if (incomplete) delete drawing.fields.TextDataEncrypted;
            return drawing;
          }
          assert.equal(recordName, "DRAWING-ATTACHMENT");
          return { recordName, recordType: "Attachment", fields: { UTI: { type: "STRING", value: "com.apple.paper" } } };
        }) });
      }
      assert.fail("Unexpected request in offline test: " + url.pathname);
    };
    try {
      if (failFetch) {
        await assert.rejects(() => runPull(vault), /fixture fetch failure/);
        assert.equal((await readCloneState(vault))?.syncToken, undefined);
        failFetch = false;
      }
      if (incomplete) {
        await runPull(vault);
        const pending = await readCloneState(vault);
        assert.equal(shared ? pending?.sharedZoneSyncTokens?.[owner] : pending?.syncToken, undefined);
        assert.equal(pending?.notes[noteId]?.file, oldFile);
        assert.equal(await readFile(path.join(vault, oldFile), "utf-8"), original);
        incomplete = false;
      }
      const result = await runPull(vault, undefined, undefined, { deferRenames: scenario === "deferred-collision" });
      if (scenario === "remote-absence") {
        assert.equal(result.conflicts.length, 1);
        assert.match(result.conflicts[0]!, /deleted remotely.*local edits/);
      } else assert.deepEqual(result.conflicts, []);
      const state = (await readCloneState(vault))!;
      const leftLocally = scenario === "local-delete" || scenario === "local-move";
      const expectedFile = scenario === "deferred-collision" || leftLocally ? oldFile : `${dir}/${unrepresentable ? "Untitled" : "Readable drawing"}.md`;
      assert.equal(state.notes[noteId]?.file, expectedFile);
      assert.equal(state.notes[noteId]?.pendingRename, scenario === "deferred-collision" ? "Readable drawing 2.md" : undefined);
      if (leftLocally) {
        await assert.rejects(readFile(path.join(vault, oldFile)), { code: "ENOENT" });
        if (scenario === "local-move") assert.equal(await readFile(path.join(vault, localDrawingFile), "utf-8"), original);
      } else {
        const expectedContent = unrepresentable ? composeNoteFile(localFrontmatter, localBody, noteId, title) : original;
        assert.equal(await readFile(path.join(vault, expectedFile), "utf-8"), expectedContent, "body, ID and local title choice are preserved");
        if (!unrepresentable) assert.equal((await stat(path.join(vault, expectedFile))).mtimeMs, initialMtime);
        if (unrepresentable) assert.equal(state.notes[noteId]?.frontmatterTitle, title);
      }
      if (scenario === "remote-absence") {
        assert.equal(state.notes[absentIds.clean], undefined);
        assert.equal(state.notes[absentIds.moved], undefined);
        assert.ok(state.notes[absentIds.dirty], "a deletion/edit conflict stays tracked");
        await assert.rejects(readFile(path.join(vault, "TEST/Absent clean.md")), { code: "ENOENT" });
        assert.match(await readFile(path.join(vault, "TEST/Absent dirty.md"), "utf-8"), /Locally edited prose/);
        assert.match(await readFile(path.join(vault, "TEST/Locally moved absent.md"), "utf-8"), /Original prose/);
      }
      assert.equal(await readBaseCopy(vault, noteId), base);
      assert.equal(state.replicaId, Buffer.from(replica).toString("base64"));
      assert.equal(state.syncToken, "new-private");
      if (shared) assert.equal(state.sharedZoneSyncTokens?.[owner], "new-shared");
      for (const [file, content] of retainedFiles) assert.equal(await readFile(path.join(vault, file), "utf-8"), content);
      for (const file of ["TEST/Regular missing.md", "TEST/Regular moved.md"]) await assert.rejects(readFile(path.join(vault, file)), { code: "ENOENT" });
      if (scenario === "deferred-collision") assert.equal(await readFile(path.join(vault, collisionFile), "utf-8"), "Untracked content");
      assert.ok(!result.notices.some(({ message }) => message.includes("no longer accepted")), "a deliberate refresh isn't token rejection");
      assert.ok(inputCursors.includes(undefined), "upgrade must request a complete listing");
      inputCursors.length = 0;
      await runPull(vault, undefined, undefined, { deferRenames: scenario === "deferred-collision" });
      assert.ok(inputCursors.length > 0 && inputCursors.every((cursor) => cursor !== undefined), "subsequent pulls resume incremental sync");
      assert.equal(modifications, 0);
      assert.deepEqual(record, beforeRemote);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(vault, { recursive: true, force: true });
    }
  });
}
