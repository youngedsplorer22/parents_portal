import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { createWebServer, isProduction, resolvePortalStartup } from "../src/server.js";

let api, web, seen, base, dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "portal-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<html>shell</html>");
  writeFileSync(path.join(dir, "assets", "a.js"), "x");
  writeFileSync(path.join(dir, ".secret"), "nope");
  api = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url, host: req.headers.host, xff: req.headers["x-forwarded-for"], cookie: req.headers.cookie, portalKey: req.headers["x-portal-key"], portalOther: req.headers["x-portal-template"] };
    res.setHeader("Set-Cookie", "pp=1; Path=/api; HttpOnly; SameSite=Strict");
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  web = createWebServer({ staticDir: dir, apiUrl: `http://127.0.0.1:${api.address().port}` });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${web.address().port}`;
});
after(() => { api.close(); web.close(); });

describe("portal web server", () => {
  it("serves the app shell for deep links and sends security headers", async () => {
    const res = await fetch(`${base}/join/a/b/c`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<html>shell</html>");
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  });
  it("404s missing assets, never serves dotfiles or path traversal", async () => {
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    assert.notEqual(await (await fetch(`${base}/.secret`)).text(), "nope");
    assert.notEqual(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text(), "root");
  });
  it("forwards /api with the original Host, the cookie, and returns Set-Cookie untouched", async () => {
    const res = await fetch(`${base}/api/x?y=1`, { method: "POST", headers: { cookie: "a=b", "x-forwarded-for": "9.9.9.9" }, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(seen.url, "/api/x?y=1");
    assert.equal(seen.host, new URL(base).host);
    assert.equal(seen.cookie, "a=b");
    assert.match(seen.xff, /^9\.9\.9\.9, /);
    assert.match(res.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  });
  it("answers 502 JSON when the API is down", async () => {
    const dead = createWebServer({ staticDir: dir, apiUrl: "http://127.0.0.1:1" });
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${dead.address().port}/api/x`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "UPSTREAM_UNAVAILABLE");
    dead.close();
  });
  it("refuses writes to static paths", async () => {
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  });
});

describe("portal identity: the server adds the portal's secret key; a browser can't", () => {
  const KEY = "k".repeat(40);
  const startWith = async (portalSecret) => {
    const w = createWebServer({ staticDir: dir, apiUrl: `http://127.0.0.1:${api.address().port}`, portalSecret });
    await new Promise((r) => w.listen(0, "127.0.0.1", r));
    return { w, url: `http://127.0.0.1:${w.address().port}` };
  };
  it("adds x-portal-key to every forwarded /api call", async () => {
    const { w, url } = await startWith(KEY);
    await fetch(`${url}/api/registrations`, { method: "POST", body: "{}" });
    assert.equal(seen.portalKey, KEY);
    w.close();
  });
  it("throws away any x-portal-* header a browser sends, and puts its own key (or none) in its place", async () => {
    const { w, url } = await startWith(KEY);
    await fetch(`${url}/api/x`, { headers: { "x-portal-key": "browser-chosen", "x-portal-template": "domestic_none" } });
    assert.equal(seen.portalKey, KEY);
    assert.equal(seen.portalOther, undefined);
    w.close();
    const none = await startWith(null);
    await fetch(`${none.url}/api/x`, { headers: { "x-portal-key": "browser-chosen" } });
    assert.equal(seen.portalKey, undefined, "a portal with no key configured never passes the browser's");
    none.w.close();
  });
  it("never serves the key to a browser: not in a page, an asset, a header or an error", async () => {
    const { w, url } = await startWith(KEY);
    for (const p of ["/", "/join/a/b/c", "/assets/a.js", "/healthz", "/api/x"]) {
      const res = await fetch(url + p);
      const text = await res.text();
      assert.ok(!text.includes(KEY), p);
      assert.ok(![...res.headers.values()].some((v) => v.includes(KEY)), `${p} headers`);
    }
    w.close();
  });
});


describe("startup: role and secret (resolvePortalStartup)", () => {
  const SECRET = "s".repeat(40);
  const prod = (over = {}) => ({ NODE_ENV: "production", PORTAL_ROLE: "public", STATIC_DIR: "apps/portal-domestic-free/dist", PORTAL_PROXY_SECRET: SECRET, ...over });

  it("a public portal in production starts with a valid secret, and sends it", () => {
    assert.deepEqual(resolvePortalStartup(prod()), { ok: true, role: "public", portalSecret: SECRET });
  });

  it("a public portal in production refuses to start with the secret missing, empty or too short", () => {
    for (const bad of [undefined, "", "short", "x".repeat(31)]) {
      const r = resolvePortalStartup(prod({ PORTAL_PROXY_SECRET: bad }));
      assert.equal(r.ok, false, String(bad));
      assert.match(r.error, /PORTAL_PROXY_SECRET/);
    }
  });

  it("production needs a role, and only public or staff", () => {
    assert.match(resolvePortalStartup(prod({ PORTAL_ROLE: undefined })).error, /PORTAL_ROLE is required in production/);
    assert.match(resolvePortalStartup(prod({ PORTAL_ROLE: "" })).error, /PORTAL_ROLE is required in production/);
    for (const bad of ["Public", "admin", "all", "true"]) assert.match(resolvePortalStartup(prod({ PORTAL_ROLE: bad })).error, /must be "public" or "staff"/);
  });

  it("the Sales portal and a registration portal can never be swapped, by folder or by secret", () => {
    assert.match(resolvePortalStartup(prod({ STATIC_DIR: "apps/portal-staff/dist" })).error, /STATIC_DIR is the Sales portal/);
    assert.match(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", PORTAL_PROXY_SECRET: undefined })).error, /not the Sales portal/);
    assert.match(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", STATIC_DIR: "apps/portal-staff/dist" })).error, /must not have a PORTAL_PROXY_SECRET/);
  });

  it("the Sales portal starts as staff with no secret, and sends none", () => {
    assert.deepEqual(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", STATIC_DIR: "apps/portal-staff/dist", PORTAL_PROXY_SECRET: undefined })), { ok: true, role: "staff", portalSecret: null });
    assert.deepEqual(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", STATIC_DIR: "/app/apps/portal-staff/dist", PORTAL_PROXY_SECRET: "" })), { ok: true, role: "staff", portalSecret: null });
  });

  it("Railway counts as production even when NODE_ENV was never set", () => {
    assert.equal(isProduction({ RAILWAY_SERVICE_ID: "x" }), true);
    assert.equal(isProduction({ RAILWAY_ENVIRONMENT_NAME: "production" }), true);
    assert.equal(isProduction({ RAILWAY_HOME: "/Users/dev/.railway" }), false);
    assert.equal(resolvePortalStartup({ RAILWAY_SERVICE_ID: "x", STATIC_DIR: "apps/portal-domestic-free/dist" }).ok, false);
  });

  it("local development keeps working: no role, no secret, still refuses a too-short secret and a bad role", () => {
    assert.deepEqual(resolvePortalStartup({ STATIC_DIR: "apps/portal-domestic-free/dist" }), { ok: true, role: null, portalSecret: null });
    assert.deepEqual(resolvePortalStartup({ NODE_ENV: "development", PORTAL_ROLE: "public", STATIC_DIR: "x" }), { ok: true, role: "public", portalSecret: null });
    assert.equal(resolvePortalStartup({ PORTAL_PROXY_SECRET: "short" }).ok, false);
    assert.equal(resolvePortalStartup({ PORTAL_ROLE: "nope" }).ok, false);
    assert.equal(resolvePortalStartup({ NODE_ENV: "test", PORTAL_ROLE: "staff", PORTAL_PROXY_SECRET: SECRET }).ok, false, "staff never carries a secret, even locally");
  });

  it("no message ever contains a secret value", () => {
    const secrets = ["short-secret-value", SECRET, "z".repeat(31)];
    for (const secret of secrets) {
      for (const env of [prod({ PORTAL_PROXY_SECRET: secret }), prod({ PORTAL_ROLE: "staff", STATIC_DIR: "apps/portal-staff/dist", PORTAL_PROXY_SECRET: secret }), prod({ PORTAL_ROLE: "bad", PORTAL_PROXY_SECRET: secret }), prod({ STATIC_DIR: "apps/portal-staff/dist", PORTAL_PROXY_SECRET: secret })]) {
        const r = resolvePortalStartup(env);
        if (!r.ok) assert.ok(!r.error.includes(secret), r.error);
      }
    }
  });
});

describe("startup: the real process", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "portal-start-"));
  mkdirSync(path.join(dir, "portal-domestic-free"), { recursive: true });
  writeFileSync(path.join(dir, "portal-domestic-free", "index.html"), "<html></html>");
  const SERVER = new URL("../src/server.js", import.meta.url).pathname;
  const run = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, API_URL: "http://127.0.0.1:1", PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; if (/Portal web server on/.test(out)) child.kill("SIGTERM"); });
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
    });

  it("exits 1 in production without the secret, says why, and never prints a secret", async () => {
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 1);
    assert.match(r.out, /PORTAL_PROXY_SECRET is required for a public portal in production/);
  });

  it("exits 1 in production when the secret is too short, without echoing it", async () => {
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", PORTAL_PROXY_SECRET: "tiny-secret-value", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 1);
    assert.ok(!r.out.includes("tiny-secret-value"));
  });

  it("starts in production with a valid secret and exits cleanly when stopped", async () => {
    const secret = "v".repeat(40);
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", PORTAL_PROXY_SECRET: secret, STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 0);
    assert.match(r.out, /\(role public\) \(portal key set\)/);
    assert.ok(!r.out.includes(secret));
  });

  it("starts locally with no role and no secret", async () => {
    const r = await run({ STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 0);
    assert.match(r.out, /\(no portal key\)/);
  });
});
