import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { captureSender, counterCodes, createTestPool, fakeClock, resetTables, testAuthConfig, testOtpConfig, testStaffConfig } from "./helpers.js";

const pool = createTestPool();
const EMAIL = "parent@example.com";
const SEC = 1000;

let server;
let base;
let clock;
let sender;
let services;
let logged;

before(async () => {
  clock = fakeClock();
  sender = captureSender();
  logged = [];
  const built = createApp({
    db: pool,
    sender,
    config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() },
    clock,
    generateCode: counterCodes(),
    logger: { error: (m) => logged.push(m) },
  });
  services = built.services;
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await resetTables(pool);
  sender.sent.length = 0;
  logged.length = 0;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const post = (path, body, init = {}) =>
  fetch(base + "/api/email-otp" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

const json = async (res) => ({ status: res.status, headers: res.headers, body: await res.json() });
const reg = (extra = {}) => ({ email: EMAIL, purpose: "registration", ...extra });

describe("POST /send", () => {
  it("returns timers and delivery mode, and never the code", async () => {
    const res = await json(await post("/send", reg()));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "dev-console", alreadySent: false });

    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(sender.last().code), "code must not appear in the response");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("rejects bad input with field details", async () => {
    for (const body of [
      {},
      reg({ email: "not-an-email" }),
      reg({ email: "" }),
      reg({ purpose: "password-reset" }),
      reg({ purpose: undefined }),
      reg({ extra: "field" }),
      reg({ email: "a".repeat(250) + "@example.com" }),
    ]) {
      const res = await json(await post("/send", body));
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    assert.equal(sender.sent.length, 0);
  });

  it("handles malformed JSON, non-JSON bodies and oversized bodies", async () => {
    let res = await json(await post("/send", "{not json"));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_JSON");

    res = await json(await post("/send", "email=a@b.co", { headers: { "content-type": "text/plain" } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");

    res = await json(await post("/send", reg({ email: "a".repeat(5000) })));
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });
});

describe("POST /resend", () => {
  it("returns 429 with Retry-After during the cooldown", async () => {
    await post("/send", reg());
    clock.advance(10 * SEC);
    const res = await json(await post("/resend", reg()));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, "RESEND_COOLDOWN");
    assert.equal(res.body.error.retryAfterSeconds, 20);
    assert.equal(res.headers.get("retry-after"), "20");
  });

  it("after the cooldown issues a new code and kills the old one", async () => {
    await post("/send", reg());
    const first = sender.last().code;
    clock.advance(30 * SEC);

    const re = await json(await post("/resend", reg()));
    assert.equal(re.status, 200);
    const second = sender.last().code;
    assert.notEqual(first, second);

    const bad = await json(await post("/verify", reg({ code: first })));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_CODE");

    const good = await json(await post("/verify", reg({ code: second })));
    assert.equal(good.status, 200);
  });

  it("is 404 when nothing is pending", async () => {
    const res = await json(await post("/resend", reg()));
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "OTP_NOT_FOUND");
  });
});

describe("POST /verify", () => {
  it("full happy path returns a token that the server can consume once", async () => {
    await post("/send", reg());
    const res = await json(await post("/verify", reg({ code: sender.last().code })));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.verificationTokenExpiresInSeconds, 900);

    const token = res.body.verificationToken;
    assert.equal(await services.emailOtp.consumeVerificationToken({ email: EMAIL, token }), true);
    assert.equal(await services.emailOtp.consumeVerificationToken({ email: EMAIL, token }), false);
  });

  it("reports attempts remaining, then locks with 429", async () => {
    await post("/send", reg());
    const remaining = [];
    for (let i = 0; i < 4; i++) {
      const res = await json(await post("/verify", reg({ code: "000000" })));
      assert.equal(res.status, 400);
      remaining.push(res.body.error.attemptsRemaining);
    }
    assert.deepEqual(remaining, [4, 3, 2, 1]);

    const locked = await json(await post("/verify", reg({ code: "000000" })));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, "TOO_MANY_ATTEMPTS");

    const stillLocked = await json(await post("/verify", reg({ code: sender.last().code })));
    assert.equal(stillLocked.status, 429);
  });

  it("returns 410 once the 5 minutes are up", async () => {
    await post("/send", reg());
    clock.advance(301 * SEC);
    const res = await json(await post("/verify", reg({ code: sender.last().code })));
    assert.equal(res.status, 410);
    assert.equal(res.body.error.code, "OTP_EXPIRED");
  });

  it("validates the code format before touching the database", async () => {
    await post("/send", reg());
    for (const code of ["12345", "1234567", "abcdef", "12 456", 123456, null]) {
      const res = await json(await post("/verify", reg({ code })));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    const [row] = (await pool.query("SELECT attempts FROM email_otps")).rows;
    assert.equal(row.attempts, 0, "invalid format must not consume attempts");
  });
});

describe("app plumbing", () => {
  it("health and unknown routes return JSON", async () => {
    const health = await json(await fetch(base + "/api/health"));
    assert.deepEqual(health.body, { status: "ok" });

    const missing = await json(await fetch(base + "/api/nope"));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  });

  it("GET on a POST route is not served", async () => {
    const res = await fetch(base + "/api/email-otp/verify");
    assert.equal(res.status, 404);
  });

  it("unexpected errors become a generic 500 with nothing leaked", async () => {
    const broken = createApp({
      db: { connect: async () => { throw new Error("secret connection string postgresql://u:pw@host/db"); } },
      sender,
      config: { otp: testOtpConfig(), auth: testAuthConfig(), staff: testStaffConfig() },
      logger: { error: (m) => logged.push(m) },
    });
    const s = await new Promise((resolve) => {
      const x = broken.app.listen(0, "127.0.0.1", () => resolve(x));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/email-otp/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reg()),
      });
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.ok(!text.includes("secret") && !text.includes("postgresql"), "internal detail leaked");
      assert.equal(JSON.parse(text).error.code, "INTERNAL_ERROR");
      assert.equal(logged.length, 1);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
