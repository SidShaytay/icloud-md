import type { Cookie } from "playwright";
import { parseCookieHeader } from "../src/session.js";

/** API validation rotates web-auth cookies into session.local.json. The
 * persistent browser profile can be older even while that session works.
 * Refresh only iCloud web-auth cookies, retaining existing cookie attributes. */
export function oracleSessionCookies(header: string, existing: readonly Cookie[]): Cookie[] {
  const result: Cookie[] = [];
  for (const [name, value] of parseCookieHeader(header)) {
    if (!name.startsWith("X-APPLE-WEBAUTH-")) continue;
    const matches = existing.filter(cookie => cookie.name === name && (cookie.domain === "icloud.com" || cookie.domain.endsWith(".icloud.com")));
    if (matches.length > 0) {
      result.push(...matches.map(cookie => ({ ...cookie, value, expires: -1 })));
    } else {
      result.push({ name, value, domain: ".icloud.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" });
    }
  }
  return result;
}
