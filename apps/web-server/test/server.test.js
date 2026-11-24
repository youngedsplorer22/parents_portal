import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
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
    assert.equal(seen.xff, "127.0.0.1", "exactly one address: the connecting one (no CLIENT_IP_SOURCE set), never the browser's");
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
  const prod = (over = {}) => ({ NODE_ENV: "production", PORTAL_ROLE: "public", STATIC_DIR: "apps/portal-domestic-free/dist", PORTAL_PROXY_SECRET: SECRET, CLIENT_IP_SOURCE: "xff:1", ...over });

  it("a public portal in production starts with a valid secret, and sends it", () => {
    assert.deepEqual(resolvePortalStartup(prod()), { ok: true, role: "public", portalSecret: SECRET, clientIpSource: { mode: "xff", hops: 1 } });
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
    assert.deepEqual(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", STATIC_DIR: "apps/portal-staff/dist", PORTAL_PROXY_SECRET: undefined })), { ok: true, role: "staff", portalSecret: null, clientIpSource: { mode: "xff", hops: 1 } });
    assert.deepEqual(resolvePortalStartup(prod({ PORTAL_ROLE: "staff", STATIC_DIR: "/app/apps/portal-staff/dist", PORTAL_PROXY_SECRET: "" })), { ok: true, role: "staff", portalSecret: null, clientIpSource: { mode: "xff", hops: 1 } });
  });

  it("Railway counts as production even when NODE_ENV was never set", () => {
    assert.equal(isProduction({ RAILWAY_SERVICE_ID: "x" }), true);
    assert.equal(isProduction({ RAILWAY_ENVIRONMENT_NAME: "production" }), true);
    assert.equal(isProduction({ RAILWAY_HOME: "/Users/dev/.railway" }), false);
    assert.equal(resolvePortalStartup({ RAILWAY_SERVICE_ID: "x", STATIC_DIR: "apps/portal-domestic-free/dist" }).ok, false);
  });

  it("local development keeps working: no role, no secret, still refuses a too-short secret and a bad role", () => {
    assert.deepEqual(resolvePortalStartup({ STATIC_DIR: "apps/portal-domestic-free/dist" }), { ok: true, role: null, portalSecret: null, clientIpSource: { mode: "peer" } });
    assert.deepEqual(resolvePortalStartup({ NODE_ENV: "development", PORTAL_ROLE: "public", STATIC_DIR: "x" }), { ok: true, role: "public", portalSecret: null, clientIpSource: { mode: "peer" } });
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
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", CLIENT_IP_SOURCE: "xff:1", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 1);
    assert.match(r.out, /PORTAL_PROXY_SECRET is required for a public portal in production/);
  });

  it("exits 1 in production when the secret is too short, without echoing it", async () => {
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", PORTAL_PROXY_SECRET: "tiny-secret-value", CLIENT_IP_SOURCE: "xff:1", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 1);
    assert.ok(!r.out.includes("tiny-secret-value"));
  });

  it("starts in production with a valid secret and exits cleanly when stopped", async () => {
    const secret = "v".repeat(40);
    const r = await run({ NODE_ENV: "production", PORTAL_ROLE: "public", PORTAL_PROXY_SECRET: secret, CLIENT_IP_SOURCE: "xff:1", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 0);
    assert.match(r.out, /\(role public\) \(portal key set\) \(client address: xff:1\)/);
    assert.ok(!r.out.includes(secret));
  });

  it("starts locally with no role and no secret", async () => {
    const r = await run({ STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 0);
    assert.match(r.out, /\(no portal key\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The API allowlist, the client address and the headers sent upstream, through the real server and a recording fake API.
// ---------------------------------------------------------------------------------------------------------------------
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET_KEY = "k".repeat(40);

/** A fake private API that records every request it receives. */
async function recordingApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      res.end('{"fromApi":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Sends the request line EXACTLY as written (fetch and http.request would tidy the path first). */
function rawRequest(port, method, target, { headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: portal.example", "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      sock.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
      let payload = rest.join("\r\n\r\n");
      if (/transfer-encoding: chunked/i.test(head)) {
        // undo the chunk framing: <hex size>\r\n<data>\r\n ... 0\r\n\r\n
        let out = "";
        for (let i = 0; i < payload.length; ) {
          const eol = payload.indexOf("\r\n", i);
          const size = parseInt(payload.slice(i, eol), 16);
          if (!size) break;
          out += payload.slice(eol + 2, eol + 2 + size);
          i = eol + 2 + size + 2;
        }
        payload = out;
      }
      resolve({ status, head, body: payload });
    });
    sock.on("error", reject);
  });
}

async function portal({ role, clientIpSource = { mode: "xff", hops: 1 }, portalSecret = role === "staff" ? null : SECRET_KEY }) {
  const upstream = await recordingApi();
  const site = mkdtempSync(path.join(tmpdir(), "portal-site-"));
  writeFileSync(path.join(site, "index.html"), "<html>shell</html>");
  const server = createWebServer({ staticDir: site, apiUrl: upstream.url, portalSecret, role, clientIpSource });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, upstream, port: server.address().port, close: async () => { server.close(); await upstream.close(); } };
}

describe("a public portal forwards only its own calls", () => {
  let p;
  before(async () => { p = await portal({ role: "public" }); });
  after(() => p.close());

  it("forwards an allowed call with the canonical target, the body, and only the headers it should", async () => {
    const before = p.upstream.calls.length;
    const res = await rawRequest(p.port, "POST", "/api/auth/login/password", {
      headers: {
        "Content-Type": "application/json", Cookie: "pp_access=a", Origin: "https://portal.example",
        "X-Forwarded-For": "6.6.6.6, 203.0.113.9", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http", Forwarded: "for=6.6.6.6",
        "X-Real-IP": "7.7.7.7", "X-Client-IP": "8.8.8.8", "True-Client-IP": "9.9.9.9", "CF-Connecting-IP": "1.1.1.1",
        "X-Portal-Key": "forged", "X-Portal-Template": "domestic_none",
      },
      body: '{"email":"a@b.test"}',
    });
    assert.equal(res.status, 200);
    assert.equal(p.upstream.calls.length, before + 1);
    const call = p.upstream.calls.at(-1);
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/api/auth/login/password");
    assert.equal(call.body, '{"email":"a@b.test"}');
    assert.equal(call.headers["x-forwarded-for"], "203.0.113.9", "exactly one address: the rightmost entry (xff:1)");
    for (const h of ["x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "x-portal-template"]) assert.equal(call.headers[h], undefined, h);
    assert.equal(call.headers["x-portal-key"], SECRET_KEY, "the portal's own key replaces anything the browser sent");
    assert.equal(call.headers.host, "portal.example");
    assert.equal(call.headers.cookie, "pp_access=a");
    assert.equal(call.headers.origin, "https://portal.example");
  });

  it("forwards the validated query exactly, and nothing else of the query", async () => {
    const res = await rawRequest(p.port, "GET", `/api/onboarding/pdf?enrolment=${UUID}`);
    assert.equal(res.status, 200);
    assert.equal(p.upstream.calls.at(-1).url, `/api/onboarding/pdf?enrolment=${UUID}`);
  });

  it("answers blocked calls with the same JSON 404 and the API never sees them", async () => {
    const before = p.upstream.calls.length;
    for (const [method, target] of [
      ["GET", `/api/admin/trips/${UUID}/live-location`],
      ["POST", "/api/mobile/auth/login"], ["GET", "/api/mobile/me"], ["GET", "/api/health"], ["GET", "/api/health/ready"],
      ["GET", "/api/enrolments"], ["DELETE", "/api/onboarding"], ["DELETE", `/api/onboarding?enrolment=${UUID}`],
      ["POST", "/api/auth/password"], ["GET", "/api"], ["GET", "/api/"], ["GET", "/api/anything"], ["OPTIONS", "/api/auth/login"], ["HEAD", "/api/auth/session"],
      ["PUT", "/api/auth/login"], ["GET", "/api/auth/login"],
    ]) {
      const res = await rawRequest(p.port, method, target);
      assert.equal(res.status, 404, `${method} ${target}`);
      if (method !== "HEAD") assert.deepEqual(JSON.parse(res.body), { error: { code: "NOT_FOUND", message: "Not found." } }, `${method} ${target}`);
      assert.match(res.head, /cache-control: no-store/i);
    }
    assert.equal(p.upstream.calls.length, before, "nothing reached the API");
  });

  it("blocks every raw and encoded way around the list, before any URL parsing", async () => {
    const before = p.upstream.calls.length;
    for (const target of [
      "/api/auth/../admin/auth/login", "/api/%2e%2e/admin/auth/login", "/api/auth/..%2fadmin/auth/login", "/api/auth%2f..%2fadmin", "/.%2e/api/admin/auth/login",
      "//api/auth/login", "/api//auth/login", "/api/auth/login/", "/api\\auth\\login", "/api/auth/login;x=1", "/api/auth/login%00", "/api/%61uth/login",
      "/API/auth/login", "/Api/AUTH/login", "/%61pi/auth/login", "/%41PI/admin/auth/login", "/api%2fadmin%2fauth%2flogin", "/api/auth/login?x=1",
      `/api/onboarding?enrolment=${UUID}&enrolment=${UUID}`, `/api/onboarding?enrolment=${UUID}&x=1`, "/api/onboarding?enrolment=%31",
      "http://evil.example/api/auth/login", "/api/auth/login#x",
    ]) {
      const res = await rawRequest(p.port, target.startsWith("http") ? "POST" : "POST", target);
      assert.equal(res.status, 404, target);
    }
    assert.equal(p.upstream.calls.length, before, "nothing reached the API");
  });

  it("never serves an API-looking address as a web page", async () => {
    for (const target of ["/API/auth/login", "/%61pi/x", "/api%2fx", "/Api"]) {
      const res = await rawRequest(p.port, "GET", target);
      assert.equal(res.status, 404, target);
      assert.doesNotMatch(res.body, /shell/, target);
    }
  });

  it("still serves the website: pages, assets paths and /healthz", async () => {
    assert.match((await rawRequest(p.port, "GET", "/join/a/b/c")).body, /shell/);
    assert.equal((await rawRequest(p.port, "GET", "/healthz")).status, 200);
    assert.match((await rawRequest(p.port, "GET", "/apix")).body, /shell/, "a website path that merely starts with api is a page");
  });

  it("blocks all Sales calls (Sales routes are not forwarded by public portals)", async () => {
    const before = p.upstream.calls.length;
    for (const [method, target] of [
      ["POST", "/api/admin/auth/login"], ["GET", "/api/admin/auth/session"],
      ["GET", "/api/admin/itinerary/trips"], ["POST", `/api/admin/trips/${UUID}/itinerary`],
      ["PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID}`],
    ]) {
      const res = await rawRequest(p.port, method, target, { headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.9", "X-Portal-Key": "forged" } });
      assert.equal(res.status, 404, `${method} ${target}`);
    }
    assert.equal(p.upstream.calls.length, before, "nothing reached the API");
  });

  it("admin-management paths are still blocked for a public portal, whatever the method", async () => {
    const before = p.upstream.calls.length;
    for (const [method, target] of [
      ["GET", "/api/admin/schools"], ["POST", "/api/admin/staff"], ["GET", "/api/admin/audit"],
      ["GET", "/api/admin/trips"], ["GET", `/api/admin/trips/${UUID}`],
      ["GET", `/api/admin/trips/${UUID}/live-location`],
    ]) {
      assert.equal((await rawRequest(p.port, method, target)).status, 404, `${method} ${target}`);
    }
    assert.equal(p.upstream.calls.length, before, "nothing reached the API");
  });
});

describe("the Sales portal forwards only the Sales calls", () => {
  let p;
  before(async () => { p = await portal({ role: "staff" }); });
  after(() => p.close());

  it("forwards each Sales call, with no portal key and one address", async () => {
    for (const [method, target] of [["POST", "/api/admin/auth/login"], ["GET", "/api/admin/auth/session"], ["GET", "/api/admin/itinerary/trips"], ["POST", `/api/admin/trips/${UUID}/itinerary`], ["PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID}`]]) {
      const res = await rawRequest(p.port, method, target, { headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.9", "X-Portal-Key": "forged" } });
      assert.equal(res.status, 200, `${method} ${target}`);
      const call = p.upstream.calls.at(-1);
      assert.equal(call.url, target);
      assert.equal(call.headers["x-portal-key"], undefined, "the Sales portal never carries a portal key, and a browser's is dropped");
      assert.equal(call.headers["x-forwarded-for"], "203.0.113.9");
    }
  });

  it("answers every parent route with the JSON 404", async () => {
    const before = p.upstream.calls.length;
    for (const [method, target] of [
      ["POST", "/api/auth/login"], ["POST", "/api/registrations"], ["POST", "/api/email-otp/send"], ["GET", "/api/join/a/b/c"], ["GET", "/api/onboarding"],
      ["POST", "/api/enrolments"], ["POST", "/api/live-location/start"], ["GET", "/api/school-logos/a/b"], ["GET", "/api/mobile/me"], ["POST", "/api/mobile/auth/login"],
      ["GET", "/api/health"], ["GET", "/api/admin/schools"], ["GET", "/api/admin/trips"], ["POST", "/api/admin/staff"], ["GET", "/api/admin/audit"], ["PUT", "/api/admin/portal-deployments/domestic_none"],
    ]) {
      assert.equal((await rawRequest(p.port, method, target)).status, 404, `${method} ${target}`);
    }
    assert.equal(p.upstream.calls.length, before);
  });
});

describe("each CLIENT_IP_SOURCE mode, through the real server", () => {
  const send = async (source, headers) => {
    const p = await portal({ role: "public", clientIpSource: source });
    try {
      await rawRequest(p.port, "POST", "/api/auth/login", { headers });
      return p.upstream.calls.at(-1).headers["x-forwarded-for"];
    } finally {
      await p.close();
    }
  };
  it("xff:1 sends the rightmost entry, xff:2 the second from the right", async () => {
    assert.equal(await send({ mode: "xff", hops: 1 }, { "X-Forwarded-For": "6.6.6.6, 203.0.113.9" }), "203.0.113.9");
    assert.equal(await send({ mode: "xff", hops: 2 }, { "X-Forwarded-For": "6.6.6.6, 203.0.113.9, 10.0.0.1" }), "203.0.113.9");
  });
  it("x-real-ip sends that header; a bad one falls back to the connecting address", async () => {
    assert.equal(await send({ mode: "x-real-ip" }, { "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "6.6.6.6" }), "203.0.113.9");
    assert.equal(await send({ mode: "x-real-ip" }, { "X-Real-IP": "not-an-ip", "X-Forwarded-For": "6.6.6.6" }), "127.0.0.1");
  });
  it("peer sends the connecting address whatever the headers say", async () => {
    assert.equal(await send({ mode: "peer" }, { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "7.7.7.7" }), "127.0.0.1");
  });
  it("an invalid or too-short xff falls back to the connecting address, never to a caller's entry", async () => {
    assert.equal(await send({ mode: "xff", hops: 1 }, { "X-Forwarded-For": "garbage" }), "127.0.0.1");
    assert.equal(await send({ mode: "xff", hops: 2 }, { "X-Forwarded-For": "6.6.6.6" }), "127.0.0.1");
    assert.equal(await send({ mode: "xff", hops: 1 }, {}), "127.0.0.1");
  });
});

describe("local development with no portal role keeps working", () => {
  it("forwards any /api path as before, but still sends one clean address and the browser's portal headers never arrive", async () => {
    const p = await portal({ role: null, clientIpSource: { mode: "peer" }, portalSecret: null });
    try {
      const res = await rawRequest(p.port, "GET", "/api/anything/at/all?x=1", { headers: { "X-Forwarded-For": "6.6.6.6", "X-Portal-Key": "forged", "X-Real-IP": "7.7.7.7" } });
      assert.equal(res.status, 200);
      const call = p.upstream.calls.at(-1);
      assert.equal(call.url, "/api/anything/at/all?x=1");
      assert.equal(call.headers["x-forwarded-for"], "127.0.0.1");
      assert.equal(call.headers["x-portal-key"], undefined);
      assert.equal(call.headers["x-real-ip"], undefined);
    } finally {
      await p.close();
    }
  });
});

describe("startup: CLIENT_IP_SOURCE is required in production and never guessed", () => {
  const base = { NODE_ENV: "production", PORTAL_ROLE: "public", STATIC_DIR: "apps/portal-domestic-free/dist", PORTAL_PROXY_SECRET: "s".repeat(40) };
  const staff = { NODE_ENV: "production", PORTAL_ROLE: "staff", STATIC_DIR: "apps/portal-staff/dist" };

  it("a public or Sales portal in production refuses to start without it, or with an invalid value", () => {
    for (const env of [base, staff]) {
      for (const bad of [undefined, "", "xff", "xff:0", "xff:9", "XFF:1", " xff:1", "auto", "x-real-ip ", "cloudflare"]) {
        const r = resolvePortalStartup({ ...env, CLIENT_IP_SOURCE: bad });
        assert.equal(r.ok, false, `${env.PORTAL_ROLE} ${JSON.stringify(bad)}`);
        assert.match(r.error, /CLIENT_IP_SOURCE/);
      }
    }
  });
  it("accepts the three explicit forms", () => {
    for (const [value, expected] of [["xff:1", { mode: "xff", hops: 1 }], ["xff:3", { mode: "xff", hops: 3 }], ["x-real-ip", { mode: "x-real-ip" }], ["peer", { mode: "peer" }]]) {
      assert.deepEqual(resolvePortalStartup({ ...base, CLIENT_IP_SOURCE: value }).clientIpSource, expected);
      assert.deepEqual(resolvePortalStartup({ ...staff, CLIENT_IP_SOURCE: value }).clientIpSource, expected);
    }
  });
  it("Railway counts as production here too", () => {
    const r = resolvePortalStartup({ RAILWAY_SERVICE_ID: "x", PORTAL_ROLE: "public", STATIC_DIR: "apps/portal-domestic-free/dist", PORTAL_PROXY_SECRET: "s".repeat(40) });
    assert.equal(r.ok, false);
    assert.match(r.error, /CLIENT_IP_SOURCE/);
  });
  it("locally it is optional (peer), but a value that is set must be valid", () => {
    assert.deepEqual(resolvePortalStartup({ STATIC_DIR: "x" }).clientIpSource, { mode: "peer" });
    assert.equal(resolvePortalStartup({ STATIC_DIR: "x", CLIENT_IP_SOURCE: "nonsense" }).ok, false);
    assert.deepEqual(resolvePortalStartup({ STATIC_DIR: "x", CLIENT_IP_SOURCE: "xff:2" }).clientIpSource, { mode: "xff", hops: 2 });
  });
  it("the error never prints the value that was given", () => {
    const r = resolvePortalStartup({ ...base, CLIENT_IP_SOURCE: "super-secret-looking-value" });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes("super-secret-looking-value"));
  });
});

describe("the real process", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "portal-proc-"));
  mkdirSync(path.join(dir, "portal-domestic-free"), { recursive: true });
  writeFileSync(path.join(dir, "portal-domestic-free", "index.html"), "<html>ok</html>");
  const SERVER = new URL("../src/server.js", import.meta.url).pathname;
  const start = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, API_URL: "http://127.0.0.1:1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; if (/Portal web server on :\d+/.test(out)) resolve({ child, out, port: Number(/Portal web server on :(\d+)/.exec(out)[1]) }); });
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
      setTimeout(() => resolve({ child, out, timeout: true }), 8000).unref();
    });
  const stop = (child) => new Promise((r) => (child.exitCode !== null ? r() : (child.once("exit", r), child.kill("SIGTERM"))));

  it("refuses to start in production without CLIENT_IP_SOURCE, saying how to fix it and printing no secret", async () => {
    const r = await start({ NODE_ENV: "production", PORTAL_ROLE: "public", PORTAL_PROXY_SECRET: "z".repeat(40), PORT: "0", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.equal(r.code, 1);
    assert.match(r.out, /CLIENT_IP_SOURCE is required in production/);
    assert.ok(!r.out.includes("z".repeat(40)));
  });

  it("listens on every interface it can: reachable on the IPv4 loopback, and on the IPv6 loopback when the machine has one", async () => {
    const r = await start({ PORT: "0", STATIC_DIR: path.join(dir, "portal-domestic-free") });
    assert.ok(r.child, r.out);
    try {
      assert.match(r.out, /listening on all interfaces/);
      const get = (host) => new Promise((resolve) => http.get({ host, port: r.port, path: "/healthz", timeout: 2000 }, (res) => (res.resume(), resolve(res.statusCode))).on("error", (e) => resolve(e.code)));
      assert.equal(await get("127.0.0.1"), 200);
      const hasV6 = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(0, "::1", () => probe.close(() => resolve(true)));
      });
      if (hasV6) assert.equal(await get("::1"), 200, "dual-stack: the IPv6 loopback works too");
    } finally {
      await stop(r.child);
    }
  });
});

describe("a request with no Host header cannot crash the server (found by the independent security probe)", () => {
  // HTTP/1.0 allows a request with no Host. The API compares Host with Origin on every write, so a call without one is refused
  // here; before this check, http.request() threw on the missing Host and the whole web server process died.
  for (const [label, opts] of [["a public portal", { role: "public" }], ["the Sales portal", { role: "staff" }], ["local development (no role)", { role: null, clientIpSource: { mode: "peer" } }]]) {
    it(`${label}: an allowed API call with no Host is answered 400 and the server keeps serving`, async () => {
      const p = await portal(opts);
      try {
        const target = opts.role === "staff" ? "/api/admin/auth/session" : "/api/auth/session";
        const res = await new Promise((resolve, reject) => {
          const sock = net.connect(p.port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.0\r\n\r\n`));
          let data = "";
          sock.on("data", (d) => (data += d));
          sock.on("close", () => resolve(data));
          sock.on("error", reject);
        });
        assert.match(res, /^HTTP\/1\.[01] 400 /);
        assert.match(res, /BAD_REQUEST/);
        assert.equal(p.upstream.calls.length, 0, "nothing reached the API");
        // the process is still alive and serving
        assert.equal((await rawRequest(p.port, "GET", "/healthz")).status, 200);
      } finally {
        await p.close();
      }
    });
  }

  it("an empty Host and a repeated Host are both refused with 400 (Node itself would keep only the first), and a normal request still works", async () => {
    const p = await portal({ role: "public" });
    try {
      const probe = (extra) => new Promise((resolve) => {
        const sock = net.connect(p.port, "127.0.0.1", () => sock.write(`GET /api/auth/session HTTP/1.1\r\n${extra}Connection: close\r\n\r\n`));
        let data = "";
        sock.on("data", (d) => (data += d));
        sock.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
        sock.on("error", () => resolve(0));
      });
      assert.equal(await probe("Host: \r\n"), 400);
      assert.equal(await probe("Host: first.example\r\nHost: second.example\r\n"), 400);
      assert.equal(p.upstream.calls.length, 0, "nothing reached the API");
      assert.equal(await probe("Host: portal.example\r\n"), 200);
    } finally {
      await p.close();
    }
  });
});
