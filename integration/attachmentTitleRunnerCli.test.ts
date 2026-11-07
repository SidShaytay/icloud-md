import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentTitleRunnerCli } from "./attachmentTitleRunnerCli.js";

test("CLI help does not connect to an account or execute a phase", async () => {
  const output: string[] = [];
  const code = await attachmentTitleRunnerCli(["--help"], { run: async () => { assert.fail("help must not execute"); }, stdout: text => output.push(text), stderr: () => assert.fail() });
  assert.equal(code, 0);
  assert.match(output.join(""), /--expected-plan/);
});

test("CLI projects a safe result and gives ambiguous writes a failing exit", async () => {
  const output: string[] = [];
  const code = await attachmentTitleRunnerCli([], { run: async () => ({ status: "ambiguous", phase: "A", planSha256: "a".repeat(64), syncLockPath: "/fixture/sync.lock", records: [{ signedURL: "private-url" }], cookie: "private-cookie" }), stdout: text => output.push(text), stderr: () => assert.fail() });
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(output[0]!), { status: "ambiguous", phase: "A", planSha256: "a".repeat(64), syncLockPath: "/fixture/sync.lock" });
});

test("CLI failures never print transport or signed-URL details", async () => {
  const errors: string[] = [];
  const code = await attachmentTitleRunnerCli([], { run: async () => { throw Error("https://private-url/?secret-cookie=fixture"); }, stdout: () => assert.fail(), stderr: text => errors.push(text) });
  assert.equal(code, 1);
  assert.doesNotMatch(errors.join(""), /private-url|secret-cookie/);
  assert.match(errors.join(""), /stopped/i);
});
