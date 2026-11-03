import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cookie } from "playwright";
import { oracleSessionCookies } from "./oracleCookies.js";

const cookie: Cookie = { name: "X-APPLE-WEBAUTH-TOKEN", value: "stale-test-value", domain: ".icloud.com", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "Lax" };
const fresh = ["fresh", "test", "value"].join("-");
const header = [cookie.name, fresh].join("=");

test("oracle cookie refresh preserves attributes and does not mutate the stored browser cookie", () => {
  const result = oracleSessionCookies(header + "; unrelated=ignored", [cookie]);
  assert.deepEqual(result, [{ ...cookie, value: fresh, expires: -1 }]);
  assert.equal(cookie.value, "stale-test-value");
});

test("oracle cookie refresh never copies web-auth values onto another domain", () => {
  const result = oracleSessionCookies(header, [{ ...cookie, domain: ".example.com" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.domain, ".icloud.com");
  assert.equal(result[0]?.secure, true);
  assert.equal(result[0]?.httpOnly, true);
});

test("oracle cookie refresh does not import unrelated cookies", () => {
  assert.deepEqual(oracleSessionCookies("unrelated=ignored", [cookie]), []);
});
