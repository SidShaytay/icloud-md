import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface CliPorts {
  run(args: string[]): Promise<unknown>;
  stdout(message: string): void;
  stderr(message: string): void;
}
const defaults: CliPorts = {
  run: async args => {
    const { parseAttachmentTitleRunnerArgs, runAttachmentTitleRunner } = await import("./attachmentTitleRunner.js");
    return runAttachmentTitleRunner(parseAttachmentTitleRunnerArgs(args));
  },
  stdout: message => console.log(message), stderr: message => console.error(message),
};
const usage = `Experimental Linux-only drawing-title trial (preview by default).
Run through integration/runAttachmentTitleProbe with ICLOUD_MD_PROBE_LOCK_PATH
set to the normal sync writer's lock; pause that writer's timer during a trial.

Required: --vault ABS --file RELATIVE.md --note UUID --attachment UUID
          --folder UUID --journal ABS --phase A|B|BA|BD
          --modification-date MILLISECONDS --deadline MILLISECONDS
Apply:    --expected-plan PREVIEW_SHA256 --apply

A changes drawing UserTitle. A separate B changes note title/date.
Alternative BA atomically updates note title/date, then reasserts drawing UserTitle.
Alternative BD changes CRDT history using a new already-deleted character;
document bytes change while visible content and original formatting stay unchanged.
B, BA and BD are mutually exclusive terminal choices for one operation.
No phase contacts or waits for a native device. A cloud result is native-unverified.
An ambiguous result exits 3 and must not be replayed or automatically rolled back.`;

export async function attachmentTitleRunnerCli(args: string[], overrides: Partial<CliPorts> = {}): Promise<number> {
  const ports = { ...defaults, ...overrides };
  if (args.length === 1 && args[0] === "--help") { ports.stdout(usage); return 0; }
  try {
    const result = await ports.run(args);
    assert.ok(result && typeof result === "object" && !Array.isArray(result));
    const data = result as Record<string, unknown>;
    assert.ok(["preview", "cloud-applied-native-unverified", "already-recorded-native-unverified", "ambiguous"].includes(data.status as string));
    const fields = ["status", "phase", "planSha256", "fieldMask", "file", "targetTitle", "noteId", "attachmentId", "folderId", "deadline", "modificationDate", "syncLockPath", "captureSha256"];
    const safe = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
    if (data.documentRevision !== undefined) {
      assert.ok(data.documentRevision && typeof data.documentRevision === "object" && !Array.isArray(data.documentRevision));
      const revision = data.documentRevision as Record<string, unknown>;
      assert.equal(revision.strategy, "trailing-tombstone-v1");
      assert.ok(["previousDocumentSha256", "documentSha256", "replicaIdSha256"].every(key => typeof revision[key] === "string" && /^[a-f0-9]{64}$/.test(revision[key] as string)));
      safe.documentRevision = Object.fromEntries(["strategy", "previousDocumentSha256", "documentSha256", "replicaIdSha256"].map(key => [key, revision[key]]));
    }
    ports.stdout(JSON.stringify(safe));
    return data.status === "ambiguous" ? 3 : 0;
  } catch {
    // Network failures can contain signed asset URLs or session details.
    ports.stderr("Drawing-title trial stopped. Inspect private evidence; do not replay an uncertain write.");
    return 1;
  }
}

// Resolve aliases such as /mnt -> /var/mnt before deciding whether this is the
// executable entry point. Importing this module must not execute a trial.
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  process.exitCode = await attachmentTitleRunnerCli(process.argv.slice(2));
}
