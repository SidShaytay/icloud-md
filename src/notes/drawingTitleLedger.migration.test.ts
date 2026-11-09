import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDrawingTitleLedger } from "./drawingTitleLedger.js";

const noteId = "11111111-1111-4111-8111-111111111111", attachmentId = "22222222-2222-4222-8222-222222222222", folderId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const hash = (value: unknown) => sha(JSON.stringify(stable(value)));
function legacy(phase: "A" | "B" | "refresh", cancelled = false) {
  const intent = { noteId, attachmentId, folderId, targetTitle: "New drawing", file: "TEST/New drawing.md", fileSha256: "1".repeat(64), localBodySha256: "2".repeat(64), documentSha256: "3".repeat(64), assetRefsSha256: "4".repeat(64), protectedSha256: "5".repeat(64), initialNoteTitle: "Old drawing", initialAttachmentTitle: "Old drawing", initialNoteTag: "note-1", initialAttachmentTag: "attachment-1", initialModificationDate: 100, noteModificationDate: 200 };
  const pending = { token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", phase, beforeTags: { note: "note-2", attachment: "drawing-2" }, issuedAt: 900, recordName: phase === "A" ? attachmentId : noteId, targetTitle: intent.targetTitle, requestSha256: hash({ phase, recordName: phase === "A" ? attachmentId : noteId, recordChangeTag: phase === "A" ? "drawing-2" : "note-2", targetTitle: intent.targetTitle, ...(phase === "B" ? { modificationDate: 200 } : {}) }) };
  const receipt = { ...pending, token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", outcome: "uncertain" as const, observedAt: 850 };
  return { version: 1, revision: 37, intent, stage: cancelled ? "cancelled" : phase === "A" ? "attachment" : phase === "B" ? "note" : "active", tags: { ...pending.beforeTags }, pending, nextDue: 700000, lastAcknowledgedAt: 800, recentUncertain: [receipt], uncertainCount: 9, ...(cancelled ? { cancelReason: "caller-cancelled" } : {}) };
}
async function fixture(run: (f: { ledger: Awaited<ReturnType<typeof openDrawingTitleLedger>>; file: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "title-v1-")), vault = path.join(root, "vault"), journalDirectory = path.join(root, "state");
  await mkdir(path.join(vault, ".icloud-md"), { recursive: true });
  const ledger = await openDrawingTitleLedger({ vault, journalDirectory, accountDsidSha256: "a".repeat(64) }, { now: () => 1000 });
  try {
    await ledger.withWriter(async () => {});
    const base = path.join(journalDirectory, "drawing-title-leases-v1"), directory = path.join(base, (await readdir(base))[0]!);
    await run({ ledger, file: path.join(directory, sha(JSON.stringify([await (await import("node:fs/promises")).realpath(vault), "a".repeat(64), noteId])) + ".json") });
  } finally { await rm(root, { recursive: true, force: true }); }
}
for (const phase of ["A", "B", "refresh"] as const) test(`legacy pending ${phase} preview is read-only and migration preserves pending authority/deadline`, () => fixture(async ({ ledger, file }) => {
  const old = legacy(phase); await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  const before = await readFile(file, "utf8"), preview = await ledger.read(noteId);
  assert.equal(preview?.version, 2);
  assert.equal(preview?.pending?.token, old.pending.token); assert.equal(preview?.pending?.phase, phase);
  assert.deepEqual(preview?.pending?.beforeTags, old.pending.beforeTags); assert.equal(preview?.pending?.issuedAt, 900);
  assert.equal(preview?.revision, 37); assert.equal(preview?.nextDue, 700000);
  assert.equal(preview?.recentUncertain[0]?.outcome, "uncertain"); assert.equal(preview?.recentUncertain[0]?.token, old.recentUncertain[0]!.token);
  assert.equal(await readFile(file, "utf8"), before);
  await ledger.withWriter(async () => {
    await ledger.withDispatch(noteId, { expectedRevision: 37, token: old.pending.token }, async () => {
      const persisted = JSON.parse(await readFile(file, "utf8"));
      assert.equal(persisted.version, 2); assert.equal(persisted.pending.token, old.pending.token);
      assert.equal(persisted.revision, 37); assert.equal(persisted.nextDue, 700000);
    });
  });
}));
test("cancelled legacy uncertainty stays cancelled with its original pending request", () => fixture(async ({ ledger, file }) => {
  const old = legacy("refresh", true); await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  const entry = await ledger.read(noteId); assert.equal(entry?.version, 2); assert.equal(entry?.stage, "cancelled");
  assert.equal(entry?.pending?.token, old.pending.token); assert.equal(entry?.recentUncertain[0]?.outcome, "uncertain");
  await ledger.withWriter(async () => { await assert.rejects(ledger.withDispatch(noteId, { expectedRevision: 37, token: old.pending.token }, async () => assert.fail()), /cancelled/); });
}));
for (const field of ["requestSha256", "recordName", "targetTitle"] as const) test(`legacy pending ${field} must validate before redundant fields are removed`, () => fixture(async ({ ledger, file }) => {
  const old = legacy("B"); old.pending[field] = field === "requestSha256" ? "0".repeat(64) : field === "recordName" ? folderId : "Other title";
  await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  await assert.rejects(ledger.read(noteId), /Pending/);
}));

test("an active legacy writer-read flushes v2 without changing its future refresh deadline or revision", () => fixture(async ({ ledger, file }) => {
  const base = legacy("refresh"), old = { ...base, pending: undefined, lastReceipt: { ...base.recentUncertain[0]!, outcome: "postcondition-observed" as const } };
  await writeFile(file, JSON.stringify(old), { mode: 0o600 }); const before = await readFile(file, "utf8");
  const preview = await ledger.read(noteId);
  assert.equal(preview?.lastReceipt?.outcome, "postcondition-observed"); assert.equal(await readFile(file, "utf8"), before);
  await ledger.withWriter(async () => {
    const entry = await ledger.read(noteId), persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.version, 2); assert.equal(persisted.revision, old.revision); assert.equal(persisted.nextDue, 700000);
    assert.equal(entry?.stage, "active"); assert.equal(entry?.pending, undefined); assert.deepEqual(persisted.tags, old.tags);
    assert.deepEqual(persisted.lastReceipt, { token: old.lastReceipt.token, phase: "refresh", outcome: "postcondition-observed" });
    assert.equal(persisted.lastAcknowledgedAt, undefined); assert.equal(persisted.uncertainCount, undefined);
  });
}));
function beforeObservation(old: ReturnType<typeof legacy>) {
  return { file: old.intent.file, fileSha256: old.intent.fileSha256, localBodySha256: old.intent.localBodySha256,
    protectedSha256: old.intent.protectedSha256, documentSha256: "3".repeat(64), assetRefsSha256: "4".repeat(64),
    noteTag: old.pending.beforeTags.note, attachmentTag: old.pending.beforeTags.attachment,
    noteTitle: old.pending.phase === "refresh" ? old.intent.targetTitle : old.intent.initialNoteTitle,
    attachmentTitle: old.pending.phase === "A" ? old.intent.initialAttachmentTitle : old.intent.targetTitle,
    modificationDate: old.pending.phase === "refresh" ? 200 : 100 };
}
for (const field of ["documentSha256", "assetRefsSha256"] as const) test(`a valid-looking changed legacy ${field} still cancels before a dispatch`, () => fixture(async ({ ledger, file }) => {
  const old = legacy("A"); old.intent[field] = "0".repeat(64);
  await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  await ledger.withWriter(async () => {
    const claim = await ledger.claim(noteId, { expectedRevision: old.revision, observation: beforeObservation(old) });
    assert.equal(claim.dispatch, undefined); assert.equal(claim.entry.stage, "cancelled");
    assert.equal(claim.entry.pending?.token, old.pending.token);
  });
}));
test("a validated legacy observation drops only its temporary content guards, never pending authority", () => fixture(async ({ ledger, file }) => {
  const old = legacy("A"); await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  await ledger.withWriter(async () => {
    const claim = await ledger.claim(noteId, { expectedRevision: old.revision, observation: beforeObservation(old) });
    assert.equal(claim.dispatch, undefined); assert.equal(claim.entry.pending?.token, old.pending.token);
    assert.equal(claim.entry.pending?.issuedAt, old.pending.issuedAt); assert.equal(claim.entry.nextDue, old.nextDue);
    assert.equal(JSON.parse(await readFile(file, "utf8")).legacyContent, undefined);
  });
}));

for (const shape of ["active", "pending", "four-uncertain"] as const) test(`compact ${shape} records are smaller after an actual writer conversion`, () => fixture(async ({ ledger, file }) => {
  const old = legacy(shape === "pending" ? "A" : "refresh");
  if (shape !== "pending") delete (old as Partial<typeof old>).pending;
  if (shape === "four-uncertain") old.recentUncertain = Array.from({ length: 4 }, (_, index) => ({ ...old.recentUncertain[0]!, token: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}` }));
  await writeFile(file, JSON.stringify(old), { mode: 0o600 });
  const legacyBytes = Buffer.byteLength(await readFile(file, "utf8"));
  await ledger.withWriter(async () => {
    const entry = (await ledger.read(noteId))!;
    const migratedBytes = Buffer.byteLength(await readFile(file, "utf8"));
    assert.equal(entry.version, 2); assert.equal(entry.revision, old.revision); assert.equal(entry.nextDue, old.nextDue);
    assert.ok(migratedBytes < legacyBytes);
    assert.deepEqual(entry.recentUncertain.map(({ token, outcome }) => ({ token, outcome })), old.recentUncertain.map(({ token, outcome }) => ({ token, outcome })));
    const observation = beforeObservation({ ...old, pending: legacy(shape === "pending" ? "A" : "refresh").pending });
    const result = await ledger.claim(noteId, { expectedRevision: entry.revision, observation });
    assert.equal(result.dispatch, undefined);
    const verifiedBytes = Buffer.byteLength(await readFile(file, "utf8"));
    assert.ok(verifiedBytes < migratedBytes);
    console.info(JSON.stringify({ shape, legacyBytes, migratedBytes, verifiedBytes }));
  });
}));
