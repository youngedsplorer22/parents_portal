import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

// The API behind the portal web servers trusts exactly ONE hop (TRUST_PROXY_HOPS=1): the web server, which sends exactly one
// validated X-Forwarded-For address. The per-IP limit on the public trip lookup records the address it used
// (trip_link_lookups.request_ip), which is what these tests read.
const pool = createTestPool();
after(() => pool.end());

const lastIp = async () => (await pool.query("SELECT host(request_ip) AS ip FROM trip_link_lookups ORDER BY created_at DESC, id DESC LIMIT 1")).rows[0]?.ip ?? null;
const lookup = (h, headers) => h.api.get("/api/join/some-school/main/some-trip", { headers });

describe("TRUST_PROXY_HOPS=1 with exactly one sanitized upstream address", () => {
  let h;
  beforeEach(async () => {
    await resetTables(pool);
    h = await startApp({ db: pool, trustProxyHops: 1 });
  });
  afterEach(() => h.close());

  it("uses the one address the web server sent", async () => {
    await lookup(h, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(await lastIp(), "203.0.113.9");
    await lookup(h, { "x-forwarded-for": "2001:db8::7" });
    assert.equal(await lastIp(), "2001:db8::7");
  });

  it("with no header at all it falls back to the connection's own address, never to nothing", async () => {
    await lookup(h, {});
    assert.equal(await lastIp(), "127.0.0.1");
  });

  it("a garbage value falls back to the connection's own address (a bad header can only cost the caller)", async () => {
    await lookup(h, { "x-forwarded-for": "not-an-ip" });
    assert.equal(await lastIp(), "127.0.0.1");
  });

  it("if a caller somehow reached the API with a longer chain, only the rightmost entry counts; the left side is ignored", async () => {
    await lookup(h, { "x-forwarded-for": "6.6.6.6, 5.5.5.5, 203.0.113.9" });
    assert.equal(await lastIp(), "203.0.113.9");
  });

  it("X-Real-IP, Forwarded and X-Forwarded-Host are never used", async () => {
    await lookup(h, { "x-forwarded-for": "203.0.113.9", "x-real-ip": "6.6.6.6", forwarded: "for=7.7.7.7", "x-forwarded-host": "evil.example" });
    assert.equal(await lastIp(), "203.0.113.9");
  });

  it("per-IP limits count each visitor separately, because each gets their own address", async () => {
    await lookup(h, { "x-forwarded-for": "203.0.113.10" });
    await lookup(h, { "x-forwarded-for": "203.0.113.11" });
    const rows = (await pool.query("SELECT DISTINCT host(request_ip) AS ip FROM trip_link_lookups ORDER BY 1")).rows.map((r) => r.ip);
    assert.deepEqual(rows, ["203.0.113.10", "203.0.113.11"]);
  });
});

describe("with 0 hops (local development) the header is ignored entirely", () => {
  let h;
  beforeEach(async () => {
    await resetTables(pool);
    h = await startApp({ db: pool, trustProxyHops: 0 });
  });
  afterEach(() => h.close());

  it("uses the socket address whatever the header says", async () => {
    await lookup(h, { "x-forwarded-for": "203.0.113.9" });
    assert.equal(await lastIp(), "127.0.0.1");
  });
});
