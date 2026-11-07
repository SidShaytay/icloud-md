import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { nativeWorkerPython } from "./nativeWorker.js";

export interface MacResult {
  status: "ready" | "pending" | "error" | "assigned" | "persistence-pending" | "ambiguous";
  writeMayHaveOccurred: boolean;
  scriptingId: string | null; nativeTitle: string | null; persistedTitle: string | null;
  localDocumentSha256: string | null; noteTagSha256: string | null; attachmentTagSha256: string | null;
}
export function sshInvocation(target: string, request: unknown): { args: string[]; stdin: string } {
  assert.match(target, /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/);
  // The command contains only this package's trusted program. Request data cannot
  // become shell/JavaScript/Python source, including title punctuation and Unicode.
  const command = "/usr/bin/python3 -c '" + nativeWorkerPython.replace(/'/g, "'\\''") + "'";
  const stdin = JSON.stringify(request);
  assert.ok(Buffer.byteLength(stdin) <= 32768, "Mac request too large");
  return { args: ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", target, command], stdin };
}
export function parseMacResult(output: string): MacResult {
  assert.ok(Buffer.byteLength(output) <= 32768, "Mac response too large");
  const result: MacResult = JSON.parse(output);
  assert.ok(result && typeof result === "object");
  assert.ok(["ready", "pending", "error", "assigned", "persistence-pending", "ambiguous"].includes(result.status));
  assert.equal(typeof result.writeMayHaveOccurred, "boolean");
  for (const key of ["nativeTitle", "persistedTitle"] as const) assert.ok(result[key] === null || typeof result[key] === "string");
  for (const key of ["localDocumentSha256", "noteTagSha256", "attachmentTagSha256"] as const) assert.ok(result[key] === null || typeof result[key] === "string" && /^[a-f0-9]{64}$/.test(result[key]));
  assert.ok(result.scriptingId === null || /^x-coredata:\/\/[0-9A-F-]{36}\/ICNote\/p[1-9][0-9]*$/.test(result.scriptingId));
  if (["ready", "assigned", "persistence-pending"].includes(result.status)) {
    for (const key of ["scriptingId", "nativeTitle", "persistedTitle", "localDocumentSha256", "noteTagSha256", "attachmentTagSha256"] as const) assert.equal(typeof result[key], "string", "Incomplete Mac observation");
  }
  return result;
}
export function invokeMac(target: string, request: unknown): MacResult {
  const invocation = sshInvocation(target, request);
  const result = spawnSync("ssh", invocation.args, { input: invocation.stdin, encoding: "utf8", timeout: 45000, maxBuffer: 65536 });
  // A disconnected apply is ambiguous. The caller records intent before this call
  // and never infers that a nonzero exit means an assignment was not dispatched.
  assert.ok(!result.error && result.status === 0, "Mac transport unavailable or outcome unclear");
  return parseMacResult(result.stdout);
}
