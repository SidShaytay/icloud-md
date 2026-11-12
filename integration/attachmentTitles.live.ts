import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RunContext } from "./harness.js";
import { plantTableOnNote } from "./plantTable.js";
import { resolveHarnessAccount } from "./harnessAccount.js";
import { TABLE_REV_BASELINE } from "../src/notes/realFixtures.js";
import { lookupRecords, updateNoteRecord, type CloudKitRecord } from "../src/cloudkit/databaseClient.js";
import { buildNoteUpdateFields } from "../src/notes/encodeNoteRecord.js";
import { applyTextEdit, encodeNoteDocument, parseNoteDocument, validateDocumentInvariants } from "../src/notes/noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";
import type { Vault } from "./vault.js";

const enabled = process.env.ICLOUD_MD_ITEST === "1";

describe("independent attachment titles", { concurrency: 1, skip: enabled ? false : "set ICLOUD_MD_ITEST=1 to run" }, () => {
  let run: RunContext;
  let vault: Vault;

  before(async () => {
    run = await RunContext.begin({ filenameAsTitle: true });
    vault = run.primary;
  });
  after(async () => { if (run !== undefined) await run.end(); });

  it("pulls a useful filename, then renames and applies a title key without rewriting the embedded document", async () => {
    const seedFile = `${run.title("attachment title seed")}.md`;
    await vault.writeNote(seedFile, "Disposable test note\n");
    assert.equal((await vault.push()).exitCode, 0);
    const noteId = await vault.noteId(seedFile);
    const planted = await plantTableOnNote({ vaultDir: vault.dir, noteId, tableMergeableDataBase64: TABLE_REV_BASELINE });
    assert.ok(planted.attachmentResult.ok);
    run.disposeAfterTeardown(planted.attachmentId);
    assert.ok(planted.noteResult.ok);

    const account = await resolveHarnessAccount(vault.dir);
    const lookup = async (id: string): Promise<CloudKitRecord> => {
      const [record] = await lookupRecords(account.session, account.ckdatabasewsUrl, account.dsid, "private", account.zone.zoneID, [id]);
      assert.ok(record);
      return record;
    };
    const record = await lookup(noteId);
    const raw = record.fields.TextDataEncrypted?.value;
    assert.equal(typeof raw, "string");
    const doc = parseNoteDocument(decompressNoteDocument(Buffer.from(raw as string, "base64")));
    // Retain the real captured table/reference, deleting only the seed prose.
    assert.ok(applyTextEdit(doc, "\uFFFC\n", { replicaId: account.replicaId }));
    validateDocumentInvariants(doc);
    const initialTitle = run.title("independent table title");
    const fields = buildNoteUpdateFields(record, compressNoteDocument(encodeNoteDocument(doc)).toString("base64"), doc.text, Date.now());
    fields.TitleEncrypted = { value: Buffer.from(initialTitle).toString("base64") };
    const result = await updateNoteRecord(account.session, account.ckdatabasewsUrl, account.dsid, "private", account.zone.zoneID, {
      recordName: noteId, recordChangeTag: record.recordChangeTag!, fields,
    });
    assert.ok(result.ok);
    const baseline = await lookup(noteId);
    const originalTable = await lookup(planted.attachmentId);

    await vault.pull();
    assert.equal(await vault.findByNoteId(noteId), `${initialTitle}.md`);
    assert.equal((await vault.status()).exitCode, 0);

    const verify = async (title: string, checkWeb = false) => {
      const current = await lookup(noteId);
      assert.equal(Buffer.from(current.fields.TitleEncrypted?.value as string, "base64").toString(), title);
      assert.equal(current.fields.TextDataEncrypted?.value, baseline.fields.TextDataEncrypted?.value, "the compressed document stays byte-identical");
      assert.equal((await lookup(planted.attachmentId)).fields.MergeableDataEncrypted?.value, originalTable.fields.MergeableDataEncrypted?.value);
      if (checkWeb) {
        const oracle = await run.oracle();
        const web = await oracle.readNote(noteId);
        assert.deepEqual(web.tables[planted.attachmentId], planted.grid, "Apple must still render the original attachment");
        assert.ok((await oracle.listNotes()).some(row => row.title === title), "Apple's note list must show the independent title");
      }
      console.error(`Verified immutable attachment document and title: ${title}`);
    };
    await verify(initialTitle);

    const renamedTitle = run.title("renamed attachment title");
    await vault.renameNote(`${initialTitle}.md`, `${renamedTitle}.md`);
    assert.equal((await vault.push()).exitCode, 0);
    await verify(renamedTitle);

    const metadataTitle = run.title("frontmatter attachment title");
    const contents = await vault.readNote(`${renamedTitle}.md`);
    await vault.writeNote(`${renamedTitle}.md`, contents.replace(/^---\n/, `---\napple-note-title: ${JSON.stringify(metadataTitle)}\n`));
    const pushed = await vault.push();
    assert.equal(pushed.exitCode, 0);
    const report = JSON.parse(pushed.stdout) as { pushed: number; entries: { outcome?: { succeeded: boolean } }[] };
    assert.equal(report.pushed, 1, "a title-only metadata request must produce a real write");
    assert.equal(report.entries[0]?.outcome?.succeeded, true);
    await verify(metadataTitle);
    await vault.pull();
    assert.equal(await vault.findByNoteId(noteId), `${metadataTitle}.md`);
    assert.equal((await vault.status()).exitCode, 0, "the title request must settle without repeat writes");
    await verify(metadataTitle, true);
  });
});
