#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { runCompanion } from "./companion.js";
import { readJson } from "./storage.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { vault: { type: "string" }, config: { type: "string" }, apply: { type: "boolean", default: false } } });
  assert.ok(values.vault && values.config, "Use --vault PATH --config PRIVATE_JSON [--apply]");
  const config = await readJson(values.config);
  assert.ok(config, "Private bridge configuration is missing");
  const result = await runCompanion(path.resolve(values.vault), config, values.apply);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status === "pending") process.exitCode = 3;
  else if (result.status === "ambiguous") process.exitCode = 4;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : "Drawing rename stopped" }) + "\n");
    process.exitCode = 1;
  });
}
