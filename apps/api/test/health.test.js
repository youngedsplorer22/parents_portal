import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { captureSender, testAuthConfig, testOtpConfig, testStaffConfig } from "./helpers.js";

// Liveness: "the process answers". Readiness: "the database answers and we are not shutting down". Neither leaks anything.

let mode = "ok"; // ok | fail | hang
let queries = 0;
const db = {
  query: async () => {
    queries++;
    if (mode === "fail") throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2"), { code: "ECONNREFUSED" });
    if (mode === "hang") return new Promise(() => {});
    return { rows: [{ ok: 1 }] };
  },
};
let server, base, lifecycle;
before(async () => {
  const made = createApp({ db, sender: captureSender(), logger: { error() {} }, healthTimeoutMs: 200, healthCacheMs: 0, config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() } });
  lifecycle = made.lifecycle;
  server = await new Promise((r) => { const s = made.app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, text: await r.text() }; };

describe("health checks", () => {
  it("live answers 200 {status:ok} without touching the database, even when it is down", async () => {
    mode = "fail";
    const before = queries;
    const r = await get("/api/health/live");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { status: "ok" });
    assert.equal(queries, before);
    assert.equal((await get("/api/health")).status, 200, "the old path stays a liveness check");
  });

  it("ready is 200 when the database answers", async () => {
    mode = "ok";
    const r = await get("/api/health/ready");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { status: "ok" });
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("ready is 503 when the database fails, and the body leaks no error, host, password or version", async () => {
    mode = "fail";
    const r = await get("/api/health/ready");
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.text), { status: "unavailable" });
    assert.doesNotMatch(r.text + JSON.stringify([...r.headers]), /ECONNREFUSED|10\.1\.2\.3|hunter2|postgres|express|node/i);
  });

  it("ready gives up on a hung database within the timeout", async () => {
    mode = "hang";
    const t = Date.now();
    const r = await get("/api/health/ready");
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t < 1500, "answered quickly instead of hanging");
  });

  it("ready turns 503 as soon as shutdown begins; live stays 200", async () => {
    mode = "ok";
    assert.equal((await get("/api/health/ready")).status, 200);
    lifecycle.beginShutdown();
    assert.equal((await get("/api/health/ready")).status, 503);
    assert.equal((await get("/api/health/live")).status, 200);
  });

  it("only GET works; there is no query or path that reveals more", async () => {
    const post = await fetch(base + "/api/health/ready", { method: "POST" });
    assert.equal(post.status, 404);
    const r = await get("/api/health/ready?verbose=1&debug=true");
    assert.deepEqual(Object.keys(JSON.parse(r.text)), ["status"]);
  });
});
