import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { captureSender, testAuthConfig, testOtpConfig, testStaffConfig } from "./helpers.js";

// The built React app is served by Express: real files as files, app routes as index.html, and /api never as HTML.

const dist = mkdtempSync(path.join(tmpdir(), "pp-dist-"));
mkdirSync(path.join(dist, "assets"));
writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>APP-SHELL</title>");
writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log('app')");
writeFileSync(path.join(dist, "logo.png"), "png");
writeFileSync(path.join(dist, ".secret"), "dotfile");
const outside = path.join(dist, "..", "pp-outside-secret.txt");
writeFileSync(outside, "SECRET");

// The routes under test never touch the database.
const db = { query: async () => ({ rows: [] }), connect: async () => { throw new Error("no db in this test"); } };
let server;
let base;
before(async () => {
  const { app } = createApp({
    db, sender: captureSender(), frontendDist: dist, logger: { error() {} },
    config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() },
  });
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dist, { recursive: true, force: true }); rmSync(outside, { force: true }); });

const html = { accept: "text/html,application/xhtml+xml" };
const get = async (p, headers = {}, method = "GET") => {
  const res = await fetch(base + p, { method, headers, redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

const rawGet = (p) => new Promise((resolve, reject) => {
  const { port } = server.address();
  const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: html }, (res) => {
    let text = "";
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject);
  req.end();
});

describe("serving the frontend", () => {
  it("serves index.html at / and for app routes (deep links), with no-cache", async () => {
    for (const p of ["/", "/admin/login", "/admin/trips/42", "/join/abc_DEF-123", "/join/a.b.c", "/dashboard?x=1"]) {
      const r = await get(p, html);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /APP-SHELL/, p);
      assert.equal(r.headers.get("cache-control"), "no-cache", p);
      assert.match(r.headers.get("content-type"), /text\/html/);
    }
  });

  it("serves hashed assets as immutable and other public files with a short cache", async () => {
    const a = await get("/assets/index-abc123.js");
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(a.headers.get("content-type"), /javascript/);
    const l = await get("/logo.png");
    assert.equal(l.status, 200);
    assert.equal(l.headers.get("cache-control"), "public, max-age=3600");
    assert.equal((await get("/index.html")).headers.get("cache-control"), "no-cache");
  });

  it("a missing asset or file is a 404, never the app shell", async () => {
    for (const p of ["/assets/missing-123.js", "/nope.css", "/assets/"]) {
      const r = await get(p, { accept: "*/*" });
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /APP-SHELL/, p);
    }
    // even a browser navigation to a missing asset must not get HTML cached as that asset
    assert.equal((await get("/assets/missing-123.js", html)).status, 404);
  });

  it("only GET and HEAD get the shell; other methods on app routes are 404", async () => {
    assert.equal((await get("/admin/login", html, "HEAD")).status, 200);
    const post = await fetch(base + "/admin/login", { method: "POST", headers: { origin: base } });
    assert.equal(post.status, 404);
  });
});

describe("API route protection", () => {
  it("unknown /api paths are JSON 404, never HTML, whatever the Accept header or case", async () => {
    for (const p of ["/api/nope", "/api/", "/api", "/API/nope"]) {
      const r = await get(p, html);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /APP-SHELL/, p);
      assert.match(r.headers.get("content-type"), /json/, p);
    }
  });

  it("dot-segment paths sent raw (fetch would normalize them away) never reach the shell from /api", async () => {
    // Raw request line: the server sees the literal path, as an attacker's client could send it.
    for (const p of ["/api/health/../nope", "/api/%2e%2e/index.html", "/api/..%2findex.html", "/api/%2e%2e%2f%2e%2e%2fpp-outside-secret.txt"]) {
      const r = await rawGet(p);
      assert.doesNotMatch(r.text, /APP-SHELL|SECRET/, p);
      assert.notEqual(r.status, 500, p);
    }
  });

  it("an unknown admin path needs a staff session first (401 JSON), never HTML", async () => {
    const r = await get("/api/admin/nope", html);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("content-type"), /json/);
  });

  it("an API path that exists is still the API (health), not the shell", async () => {
    const r = await get("/api/health/live", html);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { status: "ok" });
  });

  it("an API error is JSON and carries no-store, not the shell", async () => {
    const r = await get("/api/auth/me", html);
    assert.ok([401, 404].includes(r.status));
    assert.doesNotMatch(r.text, /APP-SHELL/);
  });
});

describe("static file safety", () => {
  it("does not serve dotfiles or files outside the folder", async () => {
    for (const p of ["/.secret", "/%2e%2e/pp-outside-secret.txt", "/..%2fpp-outside-secret.txt", "/assets/..%2f..%2fpp-outside-secret.txt", "/%2e%2e%2f%2e%2e%2fetc/passwd", "/..\\pp-outside-secret.txt"]) {
      const r = await get(p, { accept: "*/*" });
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.text, /SECRET|dotfile/, p);
    }
  });

  it("keeps the security headers on the shell and allows map tiles (images) over https", async () => {
    const r = await get("/", html);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-powered-by"), null);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /img-src [^;]*https:/);
    assert.match(csp, /script-src 'self'/);
  });
});

describe("without a frontend folder configured (development)", () => {
  it("/ is the API's JSON 404, as before", async () => {
    const { app } = createApp({ db, sender: captureSender(), logger: { error() {} }, config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() } });
    const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { headers: html });
      assert.equal(res.status, 404);
      assert.match(res.headers.get("content-type"), /json/);
    } finally { s.close(); }
  });
});
