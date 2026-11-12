/** Private-zone metadata IO for ongoing drawing-title reconciliation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdate, type NoteZone } from "../cloudkit/databaseClient.js";
import type { IcloudSession } from "../session.js";

export interface DrawingTitleAccount { session: IcloudSession; ckdatabasewsUrl: string; dsid: string; zone: NoteZone; }
export interface DrawingTitleIO {
  accountDsidSha256: string;
  lookup(ids: string[]): Promise<CloudKitRecord[]>;
  update(update: RecordUpdate): Promise<void>;
}

/** One SDK call per conditional write: no redirects, retries or native APIs. */
export function createDrawingTitleIO(account: DrawingTitleAccount): DrawingTitleIO {
  assert.ok(account.zone.database === "private", "Shared zones are unsupported");
  const { session, ckdatabasewsUrl, dsid } = account;
  const zoneID = structuredClone(account.zone.zoneID);
  return {
    accountDsidSha256: createHash("sha256").update(dsid).digest("hex"),
    lookup: ids => lookupRecords(session, ckdatabasewsUrl, dsid, "private", zoneID, ids),
    update: async update => {
      const result = await updateRecords(session, ckdatabasewsUrl, dsid, "private", zoneID, [update], { redirect: "error", signal: AbortSignal.timeout(30_000) });
      assert.ok(result.length === 1 && result[0]!.ok && result[0]!.record.recordName === update.recordName && result[0]!.record.recordType === update.recordType, "Cloud update was rejected or unclear");
    },
  };
}
