import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { describe, it } from "node:test";
import http from "node:http";

// The real server process, started the way Railway and a developer start it, with a clean environment.
// Refusals must happen before anything connects anywhere; a start must listen where it was told to.
// The only database ever opened is the isolated local test database.

const TEST_DB = process.env.TEST_DATABASE_URL;
const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const DB_PW = "remote-db-pw-value";
const REMOTE = `postgresql://postgres:${DB_PW}@postgres.railway.internal:5432/railway`;
const SMTP = { OTP_DELIVERY: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "u", SMTP_PASSWORD: "smtp-pw-value", SMTP_FROM: "a@example.com" };
const SECRET = "b".repeat(64);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Starts `node src/server.js` with exactly this environment (plus PATH). Resolves once it exits or `until` matches. */
function start(env, { until } = {}) {
  const child = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const done = new Promise((resolve) => {
    const check = () => until && until.test(out) && resolve({ code: null, out, child });
    child.stdout.on("data", (d) => ((out += d), check()));
    child.stderr.on("data", (d) => ((out += d), check()));
    child.on("exit", (code) => resolve({ code, out, child }));
    setTimeout(() => resolve({ code: "TIMEOUT", out, child }), 15000).unref();
  });
  return done;
}
const stop = (child) => new Promise((r) => (child.exitCode !== null ? r() : (child.once("exit", r), child.kill("SIGTERM"))));
const get = (host, port) =>
  new Promise((resolve) => {
    const req = http.get({ host, port, path: "/api/health", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    req.on("timeout", () => (req.destroy(), resolve("TIMEOUT")));
  });

const prod = (over = {}) => ({ NODE_ENV: "production", PORT: "4999", DATABASE_URL: REMOTE, OTP_HMAC_SECRET: SECRET, ALLOW_PRODUCTION_DATABASE: "true", ...SMTP, ...over });
const local = (port, over = {}) => ({ NODE_ENV: "development", PORT: String(port), DATABASE_URL: TEST_DB, OTP_HMAC_SECRET: SECRET, OTP_DELIVERY: "dev-console", ...over });

describe("the server refuses to start on an unsafe configuration (before connecting anywhere)", () => {
  const refused = async (env, pattern) => {
    const { code, out } = await start(env);
    assert.equal(code, 1, `exit code ${code}; output: ${out.slice(0, 300)}`);
    assert.match(out, pattern);
    for (const secret of [DB_PW, "smtp-pw-value", SECRET]) assert.ok(!out.includes(secret), "no secret in the output");
    assert.ok(!/listening|backend on/i.test(out), "it never got as far as listening");
  };

  it("no DATABASE_URL", async () => refused(prod({ DATABASE_URL: undefined }), /DATABASE_URL/));
  it("production, another host, no opt-in", async () => refused(prod({ ALLOW_PRODUCTION_DATABASE: undefined }), /ALLOW_PRODUCTION_DATABASE=true/));
  it("production, a wrong opt-in value", async () => refused(prod({ ALLOW_PRODUCTION_DATABASE: "yes" }), /must be exactly "true"/));
  it("production on a test-named database", async () => refused(prod({ DATABASE_URL: REMOTE.replace("/railway", "/parents_portal_test") }), /test database/));
  it("production with TEST_DATABASE_URL set", async () => refused(prod({ TEST_DATABASE_URL: REMOTE }), /TEST_DATABASE_URL must not be set in production/));
  it("no NODE_ENV (means development) with another host", async () => refused(prod({ NODE_ENV: undefined }), /must point at localhost or 127.0.0.1/));
  it("development with another host, even with the opt-in", async () => refused(prod({ NODE_ENV: "development", OTP_DELIVERY: "dev-console", SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_SECURE: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, SMTP_FROM: undefined }), /must point at localhost or 127.0.0.1/));
  it("the ?host= trick", async () => refused(prod({ DATABASE_URL: `${REMOTE}?host=other.example` }), /unsupported connection option/));
  it("no OTP secret", async () => refused(prod({ OTP_HMAC_SECRET: undefined }), /OTP_HMAC_SECRET/));
  it("a HOST that is not an IP address", async () => refused(prod({ HOST: "example.com" }), /HOST/));
});

describe("the server refuses the development database and weak TLS in production (before connecting anywhere)", () => {
  const refused = async (env, pattern) => {
    const { code, out } = await start(env);
    assert.equal(code, 1, `exit code ${code}; output: ${out.slice(0, 300)}`);
    assert.match(out, pattern);
    for (const secret of [DB_PW, "smtp-pw-value", SECRET]) assert.ok(!out.includes(secret), "no secret in the output");
    assert.ok(!/listening|backend on|ECONN|ENOTFOUND|EAI_AGAIN/i.test(out), "it never connected or listened");
  };
  const dev = (host) => `postgresql://postgres:${DB_PW}@${host}:5432/parents_portal_dev`;

  it("parents_portal_dev on Railway's private host, with every opt-in set", async () => refused(prod({ DATABASE_URL: dev("postgres.railway.internal") }), /development database/));
  it("parents_portal_dev on a local closed port (a real connect would say ECONNREFUSED)", async () => refused(prod({ DATABASE_URL: dev("localhost").replace(":5432", ":1") }), /development database/));
  it("parents_portal_dev on an unroutable address (a real connect would hang)", async () => refused(prod({ DATABASE_URL: dev("192.0.2.1") }), /development database/));
  it("sslmode=require", async () => refused(prod({ DATABASE_URL: `${REMOTE}?sslmode=require` }), /sslmode/));
  it("sslmode=no-verify", async () => refused(prod({ DATABASE_URL: `${REMOTE}?sslmode=no-verify` }), /sslmode/));
  it("sslmode given twice, the last turning verification off", async () => refused(prod({ DATABASE_URL: `${REMOTE}?sslmode=disable&sslmode=no-verify` }), /more than once/));
  it("a host outside Railway's private network without sslmode=verify-full", async () => refused(prod({ DATABASE_URL: REMOTE.replace("postgres.railway.internal", "192.0.2.1") }), /sslmode=verify-full/));
  it("PGSSLMODE set", async () => refused(prod({ PGSSLMODE: "no-verify" }), /PGSSLMODE/));
  it("NODE_TLS_REJECT_UNAUTHORIZED=0", async () => refused(prod({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /NODE_TLS_REJECT_UNAUTHORIZED/));
});

describe("npm run migrate:production (node src/db/migrate.js --production) refuses the same, before connecting", () => {
  const migrate = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["src/db/migrate.js", "--production"], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ code, out }));
      setTimeout(() => (child.kill("SIGKILL"), resolve({ code: "TIMEOUT", out })), 15000).unref();
    });
  const migEnv = (db, over = {}) => ({ NODE_ENV: "production", DATABASE_URL: db, ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: new URL(db).pathname.slice(1), ...over });
  const refused = async (env, pattern) => {
    const { code, out } = await migrate(env);
    assert.equal(code, 1, `exit code ${code}; output: ${out.slice(0, 300)}`);
    assert.match(out, /Migration error:/);
    assert.match(out, pattern);
    assert.ok(!out.includes(DB_PW), "no password in the output");
    assert.ok(!/Connected to|ECONN|ENOTFOUND|EAI_AGAIN/i.test(out), "it never connected");
  };
  const dev = (host, port = 5432) => `postgresql://postgres:${DB_PW}@${host}:${port}/parents_portal_dev`;

  it("parents_portal_dev on Railway's private host, confirmed and opted in", async () => refused(migEnv(dev("postgres.railway.internal")), /development database/));
  it("parents_portal_dev on a local closed port", async () => refused(migEnv(dev("localhost", 1)), /development database/));
  it("parents_portal_dev on an unroutable address", async () => refused(migEnv(dev("192.0.2.1")), /development database/));
  it("sslmode=require", async () => refused(migEnv(`${REMOTE}?sslmode=require`), /sslmode/));
  it("a host outside Railway's private network without sslmode=verify-full", async () => refused(migEnv(REMOTE.replace("postgres.railway.internal", "192.0.2.1")), /sslmode=verify-full/));
  it("PGSSLMODE set", async () => refused(migEnv(REMOTE, { PGSSLMODE: "no-verify" }), /PGSSLMODE/));
  it("NODE_TLS_REJECT_UNAUTHORIZED=0", async () => refused(migEnv(REMOTE, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /NODE_TLS_REJECT_UNAUTHORIZED/));
});

describe("the server listens where it was told to", () => {
  it("development: this machine only, and says so (as before)", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const port = await freePort();
    const { out, child } = await start(local(port), { until: /Parents Portal backend on/ });
    try {
      assert.match(out, new RegExp(`Parents Portal backend on http://127\\.0\\.0\\.1:${port}`));
      assert.equal(await get("127.0.0.1", port), 200);
      if (lanAddress) assert.equal(await get(lanAddress, port), "ECONNREFUSED", "not reachable from the network");
    } finally {
      await stop(child);
    }
  });

  it("HOST=0.0.0.0: reachable on the network address too", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    if (!lanAddress) return t.skip("no network address on this machine");
    const port = await freePort();
    const { out, child } = await start(local(port, { HOST: "0.0.0.0" }), { until: /Parents Portal backend on/ });
    try {
      assert.match(out, new RegExp(`Parents Portal backend on http://0\\.0\\.0\\.0:${port}`));
      assert.equal(await get(lanAddress, port), 200);
    } finally {
      await stop(child);
    }
  });

  it("reads PORT from the environment", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const port = await freePort();
    const { child } = await start(local(port), { until: /Parents Portal backend on/ });
    try {
      assert.equal(await get("127.0.0.1", port), 200);
    } finally {
      await stop(child);
    }
  });
});

describe("the API does not need a frontend build to start (it is deployed on its own)", () => {
  const MISSING = "/nonexistent/frontend/dist";
  const MISSING_MSG = /frontend build was not found/;

  it("SERVE_FRONTEND=true with no build refuses to start, so the flag is what decides, and it says how to fix it", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const port = await freePort();
    const { code, out } = await start(local(port, { SERVE_FRONTEND: "true", FRONTEND_DIST: MISSING }));
    assert.equal(code, 1);
    assert.match(out, MISSING_MSG);
  });

  it("SERVE_FRONTEND=false with no build starts and answers, and serves no website", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const port = await freePort();
    const { out, child } = await start(local(port, { SERVE_FRONTEND: "false", FRONTEND_DIST: MISSING }), { until: /Parents Portal backend on/ });
    try {
      assert.doesNotMatch(out, MISSING_MSG);
      assert.equal(await get("127.0.0.1", port), 200);
      const root = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => (res.resume(), resolve(res.statusCode))).on("error", (e) => resolve(e.code)));
      assert.equal(root, 404, "the API has no page of its own");
    } finally {
      await stop(child);
    }
  });

  it("local development is unchanged: no SERVE_FRONTEND means off, so no build is needed", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const port = await freePort();
    const { out, child } = await start(local(port, { FRONTEND_DIST: MISSING }), { until: /Parents Portal backend on/ });
    try {
      assert.doesNotMatch(out, MISSING_MSG);
      assert.equal(await get("127.0.0.1", port), 200);
    } finally {
      await stop(child);
    }
  });

  it("the exact start command in railway/api.json starts the API with no build, even if a service variable says SERVE_FRONTEND=true", async (t) => {
    if (!TEST_DB) return t.skip("TEST_DATABASE_URL is not set (run through npm test)");
    const root = new URL("../../..", import.meta.url);
    const { readFileSync } = await import("node:fs");
    const command = JSON.parse(readFileSync(new URL("railway/api.json", root), "utf8")).deploy.startCommand;
    const port = await freePort();
    // The start command runs through a shell, with the service's variables already in the environment (here a wrong one).
    const child = spawn("sh", ["-c", command], { cwd: root, env: { PATH: process.env.PATH, ...local(port, { SERVE_FRONTEND: "true", FRONTEND_DIST: MISSING }) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const up = new Promise((resolve) => {
      child.stdout.on("data", (d) => ((out += d), /Parents Portal backend on/.test(out) && resolve(true)));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", () => resolve(false));
      setTimeout(() => resolve(false), 20000).unref();
    });
    try {
      assert.equal(await up, true, `did not start: ${out.slice(0, 300)}`);
      assert.doesNotMatch(out, MISSING_MSG);
      assert.equal(await get("127.0.0.1", port), 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    }
  });
});
