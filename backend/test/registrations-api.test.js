import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { captureSender, counterCodes, createTestPool, failingDb, fakeClock, registrationFields, resetTables, testAuthConfig, testOtpConfig, testStaffConfig } from "./helpers.js";

const pool = createTestPool();
const SEC = 1000;
const EMAIL = "parent@example.com";

let clock;
let sender;
let logged;
let server;
let base;
let brokenServer;
let brokenBase;

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const build = (db) => createApp({
  db,
  sender,
  config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() },
  clock,
  generateCode: counterCodes(),
  logger: { error: (m) => logged.push(m) },
}).app;

before(async () => {
  clock = fakeClock();
  sender = captureSender();
  logged = [];
  server = await listen(build(pool));
  base = `http://127.0.0.1:${server.address().port}`;
  // Same app, but every INSERT into parent_registrations fails: simulates a database outage mid-request.
  brokenServer = await listen(build(failingDb(pool, /INSERT INTO parent_registrations/)));
  brokenBase = `http://127.0.0.1:${brokenServer.address().port}`;
});
beforeEach(async () => {
  await resetTables(pool);
  sender.sent.length = 0;
  logged.length = 0;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => brokenServer.close(r));
  await pool.end();
});

const post = (path, body, { url = base, raw = false } = {}) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
const json = async (res) => ({ status: res.status, headers: res.headers, body: await res.json() });

/** Real OTP flow over HTTP -> verification token. */
async function verifiedToken(email = EMAIL) {
  clock.advance(31 * SEC);
  await post("/api/email-otp/send", { email, purpose: "registration" });
  const res = await json(await post("/api/email-otp/verify", { email, purpose: "registration", code: sender.last().code }));
  assert.equal(res.status, 200);
  return res.body.verificationToken;
}
const register = async (token, over = {}, opts) => json(await post("/api/registrations", { ...registrationFields(EMAIL, over), verificationToken: token }, opts));
const rows = async () => (await pool.query("SELECT * FROM parent_registrations")).rows;
const tokenState = async () => (await pool.query("SELECT consumed_at FROM email_verification_tokens ORDER BY created_at")).rows.map((r) => r.consumed_at);

describe("POST /api/registrations: success", () => {
  it("creates the registration, answers 201 only after the insert, and never echoes the token", async () => {
    const token = await verifiedToken();
    const res = await register(token, { firstName: "  Asha  ", lastName: "Rao   Devi", email: "  Parent@Example.COM " });

    assert.equal(res.status, 201);
    assert.equal(res.body.registered, true);
    assert.match(res.body.registrationId, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.email, EMAIL);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(res.body).includes(token));

    const [row] = await rows();
    assert.equal(row.id, res.body.registrationId);
    assert.deepEqual([row.first_name, row.last_name, row.email_normalized], ["Asha", "Rao Devi", EMAIL]);
    assert.equal((await tokenState())[0] !== null, true);
  });

  it("records the caller's IP", async () => {
    await register(await verifiedToken());
    assert.match((await rows())[0].request_ip, /^(127\.0\.0\.1|::1)$/);
  });
});

describe("POST /api/registrations: validation (400, and the token is not spent)", () => {
  it("rejects a missing verification token", async () => {
    await verifiedToken();
    const res = await json(await post("/api/registrations", registrationFields()));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(res.body.error.fields.map((f) => f.path), ["verificationToken"]);
    assert.equal((await rows()).length, 0);
  });

  const bad = [
    ["empty first name", { firstName: "" }, "firstName"],
    ["whitespace-only last name", { lastName: "   " }, "lastName"],
    ["name over 100 chars", { firstName: "x".repeat(101) }, "firstName"],
    ["control characters in a name", { firstName: "Asha\u0000" }, "firstName"],
    ["a school sent by the client (the school is never chosen by the parent)", { school: "Young Edsplorer Academy" }, ""],
    ["an old client still sending confirmPassword", { confirmPassword: "whatever-it-was-1" }, ""],
    ["missing password", { password: undefined }, "password"],
    ["password shorter than 10 characters", { password: "short-pw1" }, "password"],
    ["password over 128 characters", { password: "a".repeat(129) }, "password"],
    ["a common password", { password: "password123" }, "password"],
    ["a password that is only spaces", { password: " ".repeat(12) }, "password"],
    ["a password equal to the email", { password: EMAIL }, "password"],
    ["role not on the list", { role: "Admin" }, "role"],
    ["bad phone", { phone: "call me" }, "phone"],
    ["short phone", { phone: "123" }, "phone"],
    ["bad email", { email: "not-an-email" }, "email"],
    ["non-string name", { firstName: 42 }, "firstName"],
  ];
  for (const [label, over, path] of bad) {
    it(`rejects ${label}`, async () => {
      const token = await verifiedToken();
      const res = await register(token, over);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.fields.some((f) => f.path === path), JSON.stringify(res.body.error.fields));
      assert.ok(!JSON.stringify(res.body).includes("correct-horse-battery"), "the password is never echoed back");
      assert.equal((await rows()).length, 0);
      assert.equal((await tokenState())[0], null, "validation failure must not spend the token");
    });
  }

  it("reports every invalid field at once", async () => {
    const token = await verifiedToken();
    const res = await register(token, { firstName: "", phone: "x", role: "Nope" });
    assert.deepEqual(res.body.error.fields.map((f) => f.path).sort(), ["firstName", "phone", "role"]);
  });

  it("rejects unexpected fields (no mass assignment)", async () => {
    const token = await verifiedToken();
    const res = await json(await post("/api/registrations", { ...registrationFields(), verificationToken: token, isAdmin: true, id: "x" }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.equal((await rows()).length, 0);
  });

  it("rejects a non-object body, malformed JSON and oversized bodies", async () => {
    assert.equal((await json(await post("/api/registrations", ["a"]))).status, 400);
    assert.equal((await json(await post("/api/registrations", "null"))).status, 400);
    const malformed = await json(await post("/api/registrations", "{nope", { raw: true }));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_JSON");
    const big = await json(await post("/api/registrations", { ...registrationFields(), firstName: "a".repeat(6000) }));
    assert.equal(big.status, 413);
  });

  it("a corrected retry with the same token then succeeds", async () => {
    const token = await verifiedToken();
    assert.equal((await register(token, { phone: "bad" })).status, 400);
    assert.equal((await register(token)).status, 201);
  });
});

describe("POST /api/registrations: verification token (403)", () => {
  const expect403 = (res) => {
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
  };

  it("invalid token", async () => {
    await verifiedToken();
    expect403(await register("A".repeat(43)));
    assert.equal((await rows()).length, 0);
  });

  it("already-used token", async () => {
    const token = await verifiedToken();
    assert.equal((await register(token)).status, 201);
    expect403(await register(token, { firstName: "Other" }));
    assert.equal((await rows()).length, 1);
  });

  it("expired token", async () => {
    const token = await verifiedToken();
    clock.advance(900 * SEC);
    expect403(await register(token));
    assert.equal((await rows()).length, 0);
  });

  it("token for a different email, which also stays unspent", async () => {
    const token = await verifiedToken("a@example.com");
    expect403(await register(token, { email: "b@example.com" }));
    assert.equal((await rows()).length, 0);
    assert.equal((await tokenState())[0], null);
    assert.equal((await register(token, { email: "a@example.com" })).status, 201);
  });

  it("every failure looks the same, so the response does not reveal why", async () => {
    const used = await verifiedToken("u@example.com");
    await register(used, { email: "u@example.com" });
    const stale = await verifiedToken("s@example.com");
    clock.advance(901 * SEC);
    const other = await verifiedToken("o@example.com");
    const responses = [
      await register("garbage", { email: "g@example.com" }),
      await register(used, { email: "u@example.com" }),
      await register(stale, { email: "s@example.com" }),
      await register(other, { email: "wrong@example.com" }),
    ];
    assert.equal(new Set(responses.map((r) => JSON.stringify(r.body))).size, 1);
  });
});

describe("POST /api/registrations: duplicates and races", () => {
  it("duplicate email: 409, first registration untouched, new token unspent", async () => {
    assert.equal((await register(await verifiedToken(), { firstName: "First" })).status, 201);
    const second = await verifiedToken();
    const res = await register(second, { firstName: "Second" });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "EMAIL_ALREADY_REGISTERED");
    assert.ok(!JSON.stringify(res.body).includes("First"), "must not reveal the existing record");
    const all = await rows();
    assert.equal(all.length, 1);
    assert.equal(all[0].first_name, "First");
    assert.equal((await tokenState())[1], null);
  });

  it("six simultaneous requests with one token: one 201, five 403, one row", async () => {
    const token = await verifiedToken();
    const results = await Promise.all(Array.from({ length: 6 }, () => register(token)));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 403, 403, 403, 403, 403]);
    assert.equal((await rows()).length, 1);
  });
});

describe("POST /api/registrations: server failures", () => {
  it("a database failure answers 500 with nothing leaked, persists nothing and leaves the token usable", async () => {
    const token = await verifiedToken();
    const res = await register(token, {}, { url: brokenBase });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    const text = JSON.stringify(res.body);
    for (const leak of ["simulated", "INSERT", "parent_registrations", "Asha", EMAIL, token]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes(token) && !logged[0].includes(EMAIL), "log must not contain the token or email");

    assert.equal((await rows()).length, 0);
    assert.equal((await tokenState())[0], null, "token rolled back");
    assert.equal((await register(token)).status, 201, "the same token succeeds once the database recovers");
  });
});

describe("routing", () => {
  it("only POST is served", async () => {
    assert.equal((await fetch(base + "/api/registrations")).status, 404);
    assert.equal((await fetch(base + "/api/registrations", { method: "PUT" })).status, 404);
  });
});
