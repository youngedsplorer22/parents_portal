import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { createOtpService } from "../src/modules/email-otp/service.js";
import {
  captureSender,
  counterCodes,
  createTestPool,
  errorCode,
  fakeClock,
  resetTables,
  testOtpConfig,
} from "./helpers.js";

const pool = createTestPool();
const EMAIL = "parent@example.com";
const WRONG = "000000";
const SEC = 1000;

let clock;
let sender;
let service;

function build(configOverrides) {
  clock = fakeClock();
  sender = captureSender();
  service = createOtpService({
    db: pool,
    sender,
    config: testOtpConfig(configOverrides),
    clock,
    generateCode: counterCodes(),
  });
}

const rows = async (sql = "SELECT * FROM email_otps ORDER BY created_at, id") => (await pool.query(sql)).rows;

beforeEach(async () => {
  await resetTables(pool);
  build();
});
after(() => pool.end());

describe("send", () => {
  it("creates one OTP, delivers the code once, and stores only a hash", async () => {
    const res = await service.send({ email: EMAIL });
    assert.deepEqual(res, { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "dev-console", alreadySent: false });

    assert.equal(sender.sent.length, 1);
    const { code } = sender.last();
    assert.match(code, /^\d{6}$/);

    const [row] = await rows();
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(code), "plaintext code must not be stored");
    assert.equal(row.expires_at - row.created_at, 300 * SEC);
    assert.equal(row.resend_available_at - row.created_at, 30 * SEC);
    assert.equal(row.attempts, 0);
  });

  it("normalises the email (case and whitespace)", async () => {
    await service.send({ email: "  Parent@Example.COM " });
    const [row] = await rows();
    assert.equal(row.email_normalized, EMAIL);
  });

  it("does NOT generate a new code when one is already pending", async () => {
    await service.send({ email: EMAIL });
    clock.advance(5 * SEC);
    const again = await service.send({ email: EMAIL });
    assert.equal(again.alreadySent, true);
    assert.equal(again.expiresInSeconds, 295);
    assert.equal(sender.sent.length, 1);
    assert.equal((await rows()).length, 1);
  });

  it("does NOT silently regenerate after expiry either; only resend does", async () => {
    await service.send({ email: EMAIL });
    clock.advance(301 * SEC);
    const again = await service.send({ email: EMAIL });
    assert.equal(again.alreadySent, true);
    assert.equal(again.expiresInSeconds, 0);
    assert.equal(sender.sent.length, 1);
  });

  it("voids the code if delivery fails", async () => {
    const failing = createOtpService({
      db: pool,
      sender: { mode: "dev-console", send: async () => { throw new Error("boom"); } },
      config: testOtpConfig(),
      clock,
      generateCode: counterCodes(),
    });
    assert.equal(await errorCode(failing.send({ email: EMAIL })), "DELIVERY_FAILED");
    const [row] = await rows();
    assert.ok(row.invalidated_at, "undelivered code must be invalidated");
  });
});

describe("verify: success, expiry and single use", () => {
  it("accepts the right code and returns a verification token", async () => {
    await service.send({ email: EMAIL });
    clock.advance(10 * SEC);
    const res = await service.verify({ email: EMAIL, code: sender.last().code });
    assert.equal(res.verified, true);
    assert.match(res.verificationToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.verificationTokenExpiresInSeconds, 900);
    const [row] = await rows();
    assert.ok(row.verified_at);
  });

  it("is valid at 299.999s and expired at exactly 300s (5 minutes)", async () => {
    await service.send({ email: EMAIL });
    const { code } = sender.last();

    clock.advance(300 * SEC - 1);
    const ok = await service.verify({ email: EMAIL, code });
    assert.equal(ok.verified, true);

    await resetTables(pool);
    build();
    await service.send({ email: EMAIL });
    clock.advance(300 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: sender.last().code })), "OTP_EXPIRED");
  });

  it("an expired code does not consume attempts, even with the right code", async () => {
    await service.send({ email: EMAIL });
    clock.advance(301 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: WRONG })), "OTP_EXPIRED");
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: sender.last().code })), "OTP_EXPIRED");
    assert.equal((await rows())[0].attempts, 0);
  });

  it("a code works only once", async () => {
    await service.send({ email: EMAIL });
    const { code } = sender.last();
    await service.verify({ email: EMAIL, code });
    assert.equal(await errorCode(service.verify({ email: EMAIL, code })), "OTP_NOT_FOUND");
  });

  it("two simultaneous verifications of the right code: exactly one wins", async () => {
    await service.send({ email: EMAIL });
    const { code } = sender.last();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.verify({ email: EMAIL, code })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await rows("SELECT * FROM email_verification_tokens")).length, 1);
  });

  it("another email cannot use the code", async () => {
    await service.send({ email: EMAIL });
    assert.equal(await errorCode(service.verify({ email: "other@example.com", code: sender.last().code })), "OTP_NOT_FOUND");
  });
});

describe("verify: failed attempts", () => {
  it("counts down remaining attempts, then locks on the 5th wrong guess", async () => {
    await service.send({ email: EMAIL });
    const remaining = [];
    for (let i = 0; i < 4; i++) {
      await service.verify({ email: EMAIL, code: WRONG }).catch((e) => {
        assert.equal(e.code, "INVALID_CODE");
        remaining.push(e.details.attemptsRemaining);
      });
    }
    assert.deepEqual(remaining, [4, 3, 2, 1]);
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: WRONG })), "TOO_MANY_ATTEMPTS");
    assert.equal((await rows())[0].attempts, 5);
  });

  it("a locked code rejects even the correct code", async () => {
    await service.send({ email: EMAIL });
    const { code } = sender.last();
    for (let i = 0; i < 5; i++) await errorCode(service.verify({ email: EMAIL, code: WRONG }));
    assert.equal(await errorCode(service.verify({ email: EMAIL, code })), "TOO_MANY_ATTEMPTS");
    assert.equal((await rows("SELECT * FROM email_verification_tokens")).length, 0);
  });

  it("failed attempts are persisted, not rolled back", async () => {
    await service.send({ email: EMAIL });
    await errorCode(service.verify({ email: EMAIL, code: WRONG }));
    await errorCode(service.verify({ email: EMAIL, code: WRONG }));
    assert.equal((await rows())[0].attempts, 2);
  });

  it("a fresh code after resend is usable again once locked", async () => {
    await service.send({ email: EMAIL });
    for (let i = 0; i < 5; i++) await errorCode(service.verify({ email: EMAIL, code: WRONG }));
    clock.advance(30 * SEC);
    // The locked code is still within its lifetime, but resend must replace it.
    await service.resend({ email: EMAIL });
    const res = await service.verify({ email: EMAIL, code: sender.last().code });
    assert.equal(res.verified, true);
  });
});

describe("resend", () => {
  it("is rejected during the 30s cooldown, with the remaining wait", async () => {
    await service.send({ email: EMAIL });
    clock.advance(10 * SEC);
    const err = await service.resend({ email: EMAIL }).catch((e) => e);
    assert.equal(err.code, "RESEND_COOLDOWN");
    assert.equal(err.status, 429);
    assert.equal(err.details.retryAfterSeconds, 20);
    assert.equal(sender.sent.length, 1);
    assert.equal((await rows()).length, 1);
  });

  it("at 30s issues a new code and invalidates the previous one", async () => {
    await service.send({ email: EMAIL });
    const first = sender.last().code;
    clock.advance(30 * SEC);

    const res = await service.resend({ email: EMAIL });
    assert.equal(res.alreadySent, false);
    assert.equal(res.expiresInSeconds, 300);
    const second = sender.last().code;
    assert.notEqual(first, second);

    const all = await rows();
    assert.equal(all.length, 2);
    assert.ok(all[0].invalidated_at, "old OTP must be invalidated");
    assert.equal(all[1].invalidated_at, null);
    assert.equal(all.filter((r) => !r.invalidated_at && !r.verified_at).length, 1);

    assert.equal(await errorCode(service.verify({ email: EMAIL, code: first })), "INVALID_CODE");
    assert.equal((await service.verify({ email: EMAIL, code: second })).verified, true);
  });

  it("the old code is rejected even though it has not expired yet", async () => {
    await service.send({ email: EMAIL });
    const first = sender.last().code;
    clock.advance(30 * SEC);
    await service.resend({ email: EMAIL });
    // first still has 270s of lifetime left but was superseded
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: first })), "INVALID_CODE");
  });

  it("requires a pending verification", async () => {
    assert.equal(await errorCode(service.resend({ email: EMAIL })), "OTP_NOT_FOUND");
  });

  it("five simultaneous resends produce exactly one new code", async () => {
    await service.send({ email: EMAIL });
    clock.advance(30 * SEC);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.resend({ email: EMAIL })));

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const codes = results.filter((r) => r.status === "rejected").map((r) => r.reason.code);
    assert.deepEqual([...new Set(codes)], ["RESEND_COOLDOWN"]);
    assert.equal(sender.sent.length, 2);
    const live = await rows("SELECT * FROM email_otps WHERE verified_at IS NULL AND invalidated_at IS NULL");
    assert.equal(live.length, 1);
  });

  it("send is also blocked by the cooldown of the latest code after a verify", async () => {
    await service.send({ email: EMAIL });
    await service.verify({ email: EMAIL, code: sender.last().code });
    clock.advance(5 * SEC);
    assert.equal(await errorCode(service.send({ email: EMAIL })), "RESEND_COOLDOWN");
    clock.advance(25 * SEC);
    assert.equal((await service.send({ email: EMAIL })).alreadySent, false);
  });
});

describe("rate limits", () => {
  it("caps sends per email per hour and recovers after the window", async () => {
    build({ maxSendsPerEmailPerHour: 3 });
    await service.send({ email: EMAIL });
    for (let i = 0; i < 2; i++) {
      clock.advance(31 * SEC);
      await service.resend({ email: EMAIL });
    }
    clock.advance(31 * SEC);
    const err = await service.resend({ email: EMAIL }).catch((e) => e);
    assert.equal(err.code, "RATE_LIMITED");
    assert.ok(err.details.retryAfterSeconds > 0 && err.details.retryAfterSeconds <= 3600);
    assert.equal(sender.sent.length, 3);

    clock.advance(3600 * SEC);
    await service.resend({ email: EMAIL });
    assert.equal(sender.sent.length, 4);
  });

  it("caps sends per IP across different emails", async () => {
    build({ maxSendsPerIpPerHour: 2 });
    await service.send({ email: "a@example.com", ip: "203.0.113.7" });
    await service.send({ email: "b@example.com", ip: "203.0.113.7" });
    assert.equal(await errorCode(service.send({ email: "c@example.com", ip: "203.0.113.7" })), "RATE_LIMITED");
    // a different IP is unaffected
    await service.send({ email: "c@example.com", ip: "203.0.113.8" });
  });
});

describe("verification token", () => {
  async function verified() {
    await service.send({ email: EMAIL });
    return (await service.verify({ email: EMAIL, code: sender.last().code })).verificationToken;
  }

  it("can be consumed exactly once", async () => {
    const token = await verified();
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token }), true);
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token }), false);
  });

  it("is stored only as a hash", async () => {
    const token = await verified();
    const [row] = await rows("SELECT * FROM email_verification_tokens");
    assert.ok(!JSON.stringify(row).includes(token));
  });

  it("is bound to the email and the registration purpose", async () => {
    const token = await verified();
    assert.equal(await service.consumeVerificationToken({ email: "other@example.com", token }), false);
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, purpose: "login", token }), false);
    // still valid for its real owner
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token }), true);
  });

  it("rejects guessed, empty and non-string tokens", async () => {
    await verified();
    for (const token of ["nope", "", undefined, null, 123, "x".repeat(500)]) {
      assert.equal(await service.consumeVerificationToken({ email: EMAIL, token }), false);
    }
  });

  it("expires after its lifetime", async () => {
    const token = await verified();
    clock.advance(900 * SEC);
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token }), false);
  });

  it("concurrent consumption succeeds once", async () => {
    const token = await verified();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.consumeVerificationToken({ email: EMAIL, token })));
    assert.equal(results.filter(Boolean).length, 1);
  });
});

describe("expiry is decided by PostgreSQL's clock", () => {
  // No injected clock here: the service reads time from PostgreSQL itself.
  let dbService;
  beforeEach(() => {
    dbService = createOtpService({ db: pool, sender, config: testOtpConfig(), generateCode: counterCodes() });
  });

  it("a fresh code verifies immediately and expires_at is 300s after creation", async () => {
    await dbService.send({ email: EMAIL });
    const [row] = await rows();
    assert.equal(row.expires_at - row.created_at, 300 * SEC);
    assert.equal((await dbService.verify({ email: EMAIL, code: sender.last().code })).verified, true);
  });

  it("a row whose expires_at has passed in PostgreSQL is rejected, whatever the app thinks", async () => {
    await dbService.send({ email: EMAIL });
    await pool.query(
      `UPDATE email_otps SET created_at = created_at - interval '10 minutes',
              expires_at = expires_at - interval '10 minutes',
              resend_available_at = resend_available_at - interval '10 minutes'`,
    );
    assert.equal(await errorCode(dbService.verify({ email: EMAIL, code: sender.last().code })), "OTP_EXPIRED");
    assert.equal((await rows())[0].attempts, 0);
  });

  it("the cooldown is also read from PostgreSQL time", async () => {
    await dbService.send({ email: EMAIL });
    assert.equal(await errorCode(dbService.resend({ email: EMAIL })), "RESEND_COOLDOWN");
    await pool.query("UPDATE email_otps SET created_at = created_at - interval '1 minute', expires_at = expires_at - interval '1 minute', resend_available_at = resend_available_at - interval '1 minute'");
    assert.equal((await dbService.resend({ email: EMAIL })).alreadySent, false);
  });
});

describe("retention", () => {
  it("purges OTPs older than 24h (and their tokens) on the next send", async () => {
    await service.send({ email: EMAIL });
    await service.verify({ email: EMAIL, code: sender.last().code });
    assert.equal((await rows("SELECT * FROM email_verification_tokens")).length, 1);

    clock.advance(25 * 3600 * SEC);
    await service.send({ email: "new@example.com" });
    const left = await rows();
    assert.equal(left.length, 1);
    assert.equal(left[0].email_normalized, "new@example.com");
    assert.equal((await rows("SELECT * FROM email_verification_tokens")).length, 0);
  });
});

describe("staff codes live 15 minutes; every other code is unchanged", () => {
  const STAFF = "staff_password";

  it("a staff code is valid at 14:59.999 and expired at exactly 15:00, judged on the stored expiry", async () => {
    await service.send({ email: EMAIL, purpose: STAFF });
    const { code } = sender.last();
    const [row] = await rows();
    assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 900 * SEC, "the stored expiry is 15 minutes");
    clock.advance(900 * SEC - 1);
    assert.equal((await service.verify({ email: EMAIL, purpose: STAFF, code })).verified, true);

    await resetTables(pool);
    build();
    await service.send({ email: EMAIL, purpose: STAFF });
    clock.advance(900 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code: sender.last().code })), "OTP_EXPIRED");
  });

  it("a staff code is NOT dead at 5 minutes (it was before) and is rejected well after 15", async () => {
    await service.send({ email: EMAIL, purpose: STAFF });
    const { code } = sender.last();
    clock.advance(301 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code: WRONG })), "INVALID_CODE", "still live, so a wrong guess is a wrong guess");
    clock.advance(10 * 60 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code })), "OTP_EXPIRED");
    assert.equal((await rows())[0].attempts, 1, "an expired code consumes no further attempt");
  });

  it("the response, the stored time and the email all say 15 minutes (900 seconds)", async () => {
    const sent = await service.send({ email: EMAIL, purpose: STAFF });
    assert.equal(sent.expiresInSeconds, 900);
    assert.equal(sender.last().expiresInSeconds, 900);
    const resent = await (clock.advance(31 * SEC), service.resend({ email: EMAIL, purpose: STAFF }));
    assert.equal(resent.expiresInSeconds, 900);
    assert.equal(sender.last().expiresInSeconds, 900);
  });

  it("the parents' codes are untouched: registration, login and password_reset still expire at 5 minutes", async () => {
    for (const purpose of ["registration", "login", "password_reset"]) {
      await resetTables(pool);
      build();
      const sent = await service.send({ email: EMAIL, purpose });
      assert.equal(sent.expiresInSeconds, 300, purpose);
      assert.equal(sender.last().expiresInSeconds, 300, purpose);
      clock.advance(300 * SEC);
      assert.equal(await errorCode(service.verify({ email: EMAIL, purpose, code: sender.last().code })), "OTP_EXPIRED", purpose);
    }
  });

  it("nothing else about staff codes was loosened: 30 s cooldown, 5 attempts, single use, hourly cap", async () => {
    const sent = await service.send({ email: EMAIL, purpose: STAFF });
    assert.equal(sent.resendAvailableInSeconds, 30);
    assert.equal(await errorCode(service.resend({ email: EMAIL, purpose: STAFF })), "RESEND_COOLDOWN");
    const { code } = sender.last();
    for (let i = 0; i < 5; i++) assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code: WRONG })), i < 4 ? "INVALID_CODE" : "TOO_MANY_ATTEMPTS");
    assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code })), "TOO_MANY_ATTEMPTS", "locked even for the right code");

    await resetTables(pool);
    build();
    await service.send({ email: EMAIL, purpose: STAFF });
    const ok = await service.verify({ email: EMAIL, purpose: STAFF, code: sender.last().code });
    assert.equal(ok.verified, true);
    assert.equal(await errorCode(service.verify({ email: EMAIL, purpose: STAFF, code: sender.last().code })), "OTP_NOT_FOUND", "single use");
    assert.equal(ok.verificationTokenExpiresInSeconds, 900, "the verification token lifetime is unchanged");
  });

  it("without a staff setting the staff purpose falls back to the shared lifetime (nothing breaks)", async () => {
    build({ staffTtlSeconds: undefined });
    const sent = await service.send({ email: EMAIL, purpose: STAFF });
    assert.equal(sent.expiresInSeconds, 300);
  });
});
