import assert from "node:assert/strict";
import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import type { BridgeIO, RenameIntent } from "./bridge.js";
import type { MacResult } from "./mac.js";
import { drawingScope, encryptedTitle, metadataUpdate, preservationKey, sha256, type DrawingScope } from "./model.js";

export interface MacProfile { storeUuid: string; macBuild: string; remoteUser: string; }
export interface MacRequest {
  mode: "inspect" | "apply";
  scope: DrawingScope & MacProfile;
  expected: { noteTagSha256: string; attachmentTagSha256: string; localDocumentSha256?: string };
  expectedUserTitle: string; targetTitle: string; expectedNativeTitle?: string; deadlineMs: number;
}
export interface BridgeBaseline { scope: DrawingScope; records: CloudKitRecord[]; assets: unknown[]; }
export interface AdapterDependencies {
  checkLocal(): Promise<void>;
  lookup(): Promise<CloudKitRecord[]>;
  update(update: RecordUpdate): Promise<void>;
  mac(request: MacRequest): Promise<MacResult>;
  assets(records: CloudKitRecord[]): Promise<unknown[]>;
  readMacBaseline(): Promise<string | undefined>;
  saveMacBaseline(hash: string): Promise<void>;
}

/** The only mutators are two narrowly constructed CloudKit updates and one
 * public Notes name assignment. All three are called behind durable journal
 * intents by runBridge; neither this module nor the worker retries them. */
export function createBridgeIO(intent: RenameIntent, baseline: BridgeBaseline, profile: MacProfile, deps: AdapterDependencies): BridgeIO {
  const original = drawingScope(baseline.records, baseline.scope);
  const originalAttachmentTitle = encryptedTitle(original.attachment, "UserTitle");
  const preserved = preservationKey(baseline.records);
  assert.equal(encryptedTitle(original.note, "TitleEncrypted"), intent.oldTitle);
  assert.equal(original.note.recordName.toUpperCase(), intent.noteId.toUpperCase());
  async function fresh() {
    await deps.checkLocal();
    const records = await deps.lookup();
    const scope = drawingScope(records, baseline.scope);
    assert.equal(preservationKey(records), preserved, "Drawing, document, relationships or formatting changed");
    const noteTitle = encryptedTitle(scope.note, "TitleEncrypted");
    const attachmentTitle = encryptedTitle(scope.attachment, "UserTitle");
    assert.ok([intent.oldTitle, intent.targetTitle].includes(noteTitle), "Concurrent note title change");
    assert.ok([originalAttachmentTitle, intent.targetTitle].includes(attachmentTitle), "Concurrent drawing title change");
    return { records, ...scope, noteTitle, attachmentTitle };
  }
  async function request(mode: "inspect" | "apply", expectedNativeTitle?: string): Promise<MacRequest> {
    const current = await fresh();
    const localDocumentSha256 = await deps.readMacBaseline();
    return { mode, scope: { ...baseline.scope, ...profile }, expected: {
      noteTagSha256: sha256(current.note.recordChangeTag!), attachmentTagSha256: sha256(current.attachment.recordChangeTag!),
      ...(localDocumentSha256 === undefined ? {} : { localDocumentSha256 }),
    }, expectedUserTitle: current.attachmentTitle, targetTitle: intent.targetTitle,
    ...(expectedNativeTitle === undefined ? {} : { expectedNativeTitle }), deadlineMs: Date.now() + 30000 };
  }
  async function inspect(): Promise<MacResult | undefined> {
    // Inspect failures make the Mac unavailable, never evidence that an apply
    // failed before dispatch. Apply uses a separate, terminal error path.
    const data = await request("inspect");
    let result: MacResult;
    try { result = await deps.mac(data); } catch { return undefined; }
    if (result.status !== "ready" || result.writeMayHaveOccurred) return undefined;
    assert.ok(result.localDocumentSha256 && result.nativeTitle !== null);
    assert.equal(result.noteTagSha256, data.expected.noteTagSha256);
    assert.equal(result.attachmentTagSha256, data.expected.attachmentTagSha256);
    assert.ok([intent.oldTitle, intent.targetTitle].includes(result.nativeTitle), "Mac has a different local title");
    const oldHash = await deps.readMacBaseline();
    if (oldHash === undefined) await deps.saveMacBaseline(result.localDocumentSha256);
    else assert.equal(result.localDocumentSha256, oldHash, "Mac document changed");
    return result;
  }
  async function publish(phase: "attachment" | "note") {
    const current = await fresh();
    if (phase === "note") assert.equal(current.attachmentTitle, intent.targetTitle, "Drawing title has not been published");
    // Even an equal note title gets the separately journaled modification-date
    // event after A import. This lets native readers derive against the new title.
    if (phase === "attachment" && current.attachmentTitle === intent.targetTitle) return;
    const update = metadataUpdate(current.records, baseline.scope, phase, intent.targetTitle, Date.now());
    await deps.update(update);
    const after = await fresh();
    assert.equal(phase === "attachment" ? after.attachmentTitle : after.noteTitle, intent.targetTitle, "Cloud title update was not observed");
  }
  return {
    checkLocal: deps.checkLocal,
    inspectCloud: async () => { const current = await fresh(); return { attachmentTitle: current.attachmentTitle, noteTitle: current.noteTitle }; },
    inspectMac: async () => {
      const result = await inspect();
      return result === undefined ? { ready: false } : { ready: true, nativeTitle: result.nativeTitle!, persistedTitle: result.persistedTitle! };
    },
    publishAttachmentTitle: () => publish("attachment"),
    assignNativeName: async () => {
      const current = await fresh();
      assert.equal(current.attachmentTitle, intent.targetTitle);
      const before = await inspect();
      assert.ok(before, "Mac unavailable before name assignment");
      if (before.nativeTitle === intent.targetTitle) return;
      const data = await request("apply", before.nativeTitle!);
      const result = await deps.mac(data);
      assert.ok(["assigned", "persistence-pending"].includes(result.status), "Native name outcome is unclear; do not retry");
      assert.equal(result.nativeTitle, intent.targetTitle);
      assert.equal(result.localDocumentSha256, await deps.readMacBaseline(), "Mac document changed");
      await fresh();
    },
    publishNoteTitle: () => publish("note"),
    verify: async () => {
      const before = await fresh();
      assert.equal(before.noteTitle, intent.targetTitle); assert.equal(before.attachmentTitle, intent.targetTitle);
      assert.deepEqual(await deps.assets(before.records), baseline.assets, "Drawing or preview bytes changed");
      const after = await fresh();
      for (const old of before.records) assert.equal(after.records.find(r => r.recordName === old.recordName)?.recordChangeTag, old.recordChangeTag, "Record changed during asset verification");
      const mac = await inspect();
      await deps.checkLocal();
      return { macPersisted: mac !== undefined && mac.nativeTitle === intent.targetTitle && mac.persistedTitle === intent.targetTitle };
    },
  };
}
