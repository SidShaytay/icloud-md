import assert from "node:assert/strict";
import { test } from "node:test";
import { noteZone, type RecordUpdate } from "../src/cloudkit/databaseClient.js";
import type { HarnessAccount } from "./harnessAccount.js";
import { createAttachmentTitleProbeIO } from "./attachmentTitleProbe.js";

const account: HarnessAccount = {
  dsid: "offline-fixture", ckdatabasewsUrl: "https://cloudkit.invalid",
  session: { cookie: "fixture=offline", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: "fixture" },
  zone: noteZone(undefined), replicaId: new Uint8Array(16),
};
const encoded = Buffer.from("New drawing").toString("base64");
const updates: RecordUpdate[] = [
  { recordName: "fixture-note", recordType: "Note", recordChangeTag: "note-tag", parentRecordName: "fixture-folder", fields: { TitleEncrypted: { value: encoded }, ModificationDate: { value: 200 } } },
  { recordName: "fixture-drawing", recordType: "Attachment", recordChangeTag: "drawing-tag", parentRecordName: "fixture-note", fields: { UserTitle: { value: encoded } } },
];

test("batch adapter sends one explicit atomic Note-then-Attachment request", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://cloudkit.invalid");
    assert.equal(url.pathname, "/database/1/com.apple.notes/production/private/records/modify");
    assert.equal(init?.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
    assert.deepEqual(JSON.parse(init.body as string), {
      atomic: true, zoneID: { zoneName: "Notes" }, operations: updates.map(update => ({ operationType: "update", record: {
        recordName: update.recordName, recordType: update.recordType, recordChangeTag: update.recordChangeTag,
        parent: { recordName: update.parentRecordName }, fields: update.fields,
      } })),
    });
    // Validation must associate responses by identity, not their array position.
    return Response.json({ records: [...updates].reverse().map(update => ({ ...update, fields: {}, recordChangeTag: "next" })) });
  };
  try {
    const io = createAttachmentTitleProbeIO(account);
    await io.updateBatch!(updates);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("batch adapter never retries malformed, partial, failed or lost batch responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const io = createAttachmentTitleProbeIO(account);
    for (const failure of ["partial", "duplicate", "wrong-type", "server-error", "lost-response"]) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        if (failure === "lost-response") throw Error("offline transport failure");
        const records = updates.map(update => ({ ...update, fields: {}, recordChangeTag: "next" }));
        if (failure === "partial") records.pop();
        if (failure === "duplicate") records[1] = records[0]!;
        if (failure === "wrong-type") records[1]!.recordType = "Note";
        if (failure === "server-error") return Response.json({ records: [{ recordName: "fixture-note", serverErrorCode: "CONFLICT" }, records[1]] });
        return Response.json({ records });
      };
      await assert.rejects(async () => io.updateBatch!(updates));
      assert.equal(requests, 1, `${failure} must make one dispatch and no retry`);
    }
  } finally { globalThis.fetch = originalFetch; }
});
