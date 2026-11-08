import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { updateRecords } from "./databaseClient.js";

const session = { cookie: "fixture=offline", clientId: "fixture", clientBuildNumber: "1", clientMasteringNumber: "1", capturedAt: "fixture" };
const update = { recordName: "fixture-note", recordType: "Note", recordChangeTag: "original", fields: { TitleEncrypted: { value: "dGl0bGU=" } } };

async function listening(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("one-shot update refuses redirects instead of resending a mutation", async () => {
  let initialRequests = 0;
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/redirected") {
      redirectedRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ records: [update] }));
    } else {
      initialRequests++;
      response.writeHead(307, { Location: "/redirected" });
      response.end();
    }
  });
  try {
    const host = await listening(server);
    await assert.rejects(updateRecords(session, host, "offline", "private", { zoneName: "Notes" }, [update], { redirect: "error" }));
    assert.equal(initialRequests, 1);
    assert.equal(redirectedRequests, 0, "redirects must not replay the write");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("an already-cancelled update sends no HTTP request", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ records: [update] }));
  });
  try {
    const host = await listening(server);
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(updateRecords(session, host, "offline", "private", { zoneName: "Notes" }, [update], { signal: cancellation.signal }));
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("an explicit atomic batch preserves operation order and conditional versions", async () => {
  const originalFetch = globalThis.fetch;
  const updates = [update, { recordName: "fixture-drawing", recordType: "Attachment", recordChangeTag: "drawing-original", parentRecordName: "fixture-note", fields: { UserTitle: { value: "dGl0bGU=" } } }];
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://cloudkit.invalid");
    assert.equal(url.pathname, "/database/1/com.apple.notes/production/private/records/modify");
    requests++;
    const body = JSON.parse(init!.body as string);
    assert.equal(body.atomic, true);
    assert.deepEqual(body.operations.map((operation: { operationType: string; record: Record<string, unknown> }) => ({ kind: operation.operationType, name: operation.record.recordName, tag: operation.record.recordChangeTag })), [
      { kind: "update", name: "fixture-note", tag: "original" },
      { kind: "update", name: "fixture-drawing", tag: "drawing-original" },
    ]);
    return Response.json({ records: updates.map(record => ({ ...record, fields: {}, recordChangeTag: "next" })) });
  };
  try {
    const results = await updateRecords(session, "https://cloudkit.invalid", "offline", "private", { zoneName: "Notes" }, updates, { atomic: true, redirect: "error", signal: AbortSignal.timeout(1_000) });
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.ok));
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});
