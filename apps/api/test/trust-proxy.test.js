import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

// Per-IP limits must key on the address the trusted proxy saw, never on a header the caller can write.
// Here the test client plays the part of the platform's proxy: the TCP peer (127.0.0.1) is "the proxy", and what it
// appends to X-Forwarded-For is the real client.

const pool = createTestPool();
const apps = [];
beforeEach(() => resetTables(pool));
after(async () => { for (const a of apps) await a.close(); await pool.end(); });
const open = async (opts) => { const a = await startApp({ db: pool, auth: { passwordLogin: { windowSeconds: 900, maxPerEmail: 50, maxPerIp: 3 } }, ...opts }); apps.push(a); return a; };
const attempt = (a, i, xff) => a.api.post("/api/auth/login/password", { email: `u${i}@example.com`, password: "wrong-password-1" }, { headers: xff ? { "x-forwarded-for": xff } : {} });
const statuses = async (a, n, xffFor) => { const out = []; for (let i = 0; i < n; i++) out.push((await attempt(a, i, xffFor(i))).status); return out; };

describe("no trusted proxy (TRUST_PROXY_HOPS=0, the default)", () => {
  it("a spoofed X-Forwarded-For cannot dodge the per-IP limit", async () => {
    const a = await open({});
    assert.deepEqual(await statuses(a, 5, (i) => `203.0.113.${i + 1}`), [401, 401, 401, 429, 429]);
  });
});

describe("one trusted proxy (TRUST_PROXY_HOPS=1, Railway)", () => {
  it("keys on the address the proxy appended, ignoring anything the caller wrote further left", async () => {
    const a = await open({ trustProxyHops: 1 });
    // The caller forges a different leftmost address every time; the proxy appended the same real client.
    const codes = await statuses(a, 5, (i) => `198.51.100.${i + 1}, 203.0.113.50`);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  });

  it("different real clients behind the proxy get separate limits (one cannot lock out the other)", async () => {
    const a = await open({ trustProxyHops: 1 });
    assert.deepEqual(await statuses(a, 5, () => "203.0.113.50"), [401, 401, 401, 429, 429]);
    assert.deepEqual(await statuses(a, 3, () => "203.0.113.51"), [401, 401, 401]);
    assert.equal((await attempt(a, 99, "203.0.113.50")).status, 429, "the first client is still limited");
  });

  it("a garbage or missing header falls back to the connection address and is still limited", async () => {
    const a = await open({ trustProxyHops: 1 });
    assert.deepEqual(await statuses(a, 4, () => "not-an-ip"), [401, 401, 401, 429]);
    await resetTables(pool); // both apps share the DB and the 127.0.0.1 address; start the second from a clean counter
    const b = await open({ trustProxyHops: 1 });
    assert.deepEqual(await statuses(b, 4, () => undefined), [401, 401, 401, 429]);
  });

  it("X-Real-IP, Forwarded and X-Forwarded-Host are not used for the client address or the same-site check", async () => {
    const a = await open({ trustProxyHops: 1 });
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await a.api.post("/api/auth/login/password", { email: `r${i}@example.com`, password: "wrong-password-1" }, { headers: { "x-real-ip": `192.0.2.${i + 1}`, forwarded: `for=192.0.2.${i + 1}`, "x-forwarded-for": "203.0.113.60" } });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    // Same-site check compares Origin with the Host the backend receives; X-Forwarded-Host must not satisfy it.
    const staff = await a.api.post("/api/admin/auth/login", { email: "x@example.com", password: "whatever-pass-1" }, { headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example" } });
    assert.equal(staff.status, 403);
  });

  it("the IP recorded for OTP sends is the proxy-reported client", async () => {
    const a = await open({ trustProxyHops: 1 });
    await a.api.post("/api/email-otp/send", { email: "p@example.com", purpose: "registration" }, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.70" } });
    const { rows } = await pool.query("SELECT request_ip AS ip FROM email_otps ORDER BY created_at DESC LIMIT 1");
    assert.equal(String(rows[0]?.ip), "203.0.113.70");
  });
});
