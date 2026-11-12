import assert from "node:assert/strict";
import { test } from "node:test";
import { noteZone, type RecordUpdate } from "../cloudkit/databaseClient.js";
import type { DrawingTitleAccount } from "./drawingTitleCloud.js";
import { createDrawingTitleIO } from "./drawingTitleCloud.js";

const account: DrawingTitleAccount = {
  dsid: "offline-fixture", ckdatabasewsUrl: "https://cloudkit.invalid",
  session: { cookie: "fixture=offline", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: "fixture" },
  zone: noteZone(undefined),
};
const encoded = Buffer.from("New drawing").toString("base64");
const phases: RecordUpdate[] = [
  { recordName: "fixture-drawing", recordType: "Attachment", recordChangeTag: "drawing-tag", parentRecordName: "fixture-note", fields: { UserTitle: { value: encoded } } },
  { recordName: "fixture-note", recordType: "Note", recordChangeTag: "note-tag", parentRecordName: "fixture-folder", fields: { TitleEncrypted: { value: encoded }, ModificationDate: { value: 200 } } },
];

test("drawing-title adapter sends exact private-zone updates through the SDK with one-shot transport", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: URL; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://cloudkit.invalid", "all requests stay on the offline fixture");
    assert.ok(init);
    requests.push({ url, init });
    const body = JSON.parse(init.body as string);
    const record = body.operations[0].record;
    return Response.json({ records: [{ ...record, recordChangeTag: "next" }] });
  };
  try {
    const io = createDrawingTitleIO(account);
    assert.equal(requests.length, 0, "constructing the adapter must not connect or write");
    for (const phase of phases) await io.update(phase);
    assert.equal(requests.length, 2);
    requests.forEach(({ url, init }, index) => {
      const phase = phases[index]!;
      assert.equal(url.pathname, "/database/1/com.apple.notes/production/private/records/modify");
      assert.equal(url.searchParams.get("dsid"), account.dsid);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error", "a redirect must not resend a metadata write");
      assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted, "writes require a bounded cancellation signal");
      assert.deepEqual(JSON.parse(init.body as string), {
        zoneID: { zoneName: "Notes" },
        operations: [{ operationType: "update", record: {
          recordName: phase.recordName, recordType: phase.recordType,
          recordChangeTag: phase.recordChangeTag, parent: { recordName: phase.parentRecordName }, fields: phase.fields,
        } }],
      });
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("drawing-title adapter rejects failed or mismatched responses without retrying", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const io = createDrawingTitleIO(account);
    for (const failure of ["conflict", "lost-response", "wrong-record", "wrong-type"]) {
      let dispatches = 0;
      globalThis.fetch = async () => {
        dispatches++;
        if (failure === "lost-response") throw Error("offline transport failure");
        if (failure === "wrong-record") return Response.json({ records: [{ ...phases[0], recordName: "unrelated-record" }] });
        if (failure === "wrong-type") return Response.json({ records: [{ ...phases[0], recordType: "Note" }] });
        return Response.json({ records: [{ recordName: phases[0]!.recordName, serverErrorCode: "CONFLICT" }] });
      };
      await assert.rejects(io.update(phases[0]!));
      assert.equal(dispatches, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});
