import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { createOtpService } from "../src/modules/email-otp/service.js";
import { createAuthService } from "../src/modules/auth/service.js";
import { createRegistrationService } from "../src/modules/registrations/service.js";
import {
  captureSender,
  counterCodes,
  createTestPool,
  errorCode,
  failingDb,
  fakeClock,
  registrationFields,
  resetTables,
  testAuthConfig,
  testOtpConfig,
} from "./helpers.js";

const pool = createTestPool();
const SEC = 1000;
const EMAIL = "parent@example.com";

let clock;
let sender;
let otp;
let registrations;
let sessions;

beforeEach(async () => {
  await resetTables(pool);
  clock = fakeClock();
  sender = captureSender();
  otp = createOtpService({ db: pool, sender, config: testOtpConfig(), clock, generateCode: counterCodes() });
  sessions = createAuthService({ db: pool, emailOtp: otp, config: testAuthConfig() });
  registrations = createRegistrationService({ db: pool, emailOtp: otp, sessions, passwords: sessions.passwords });
});
after(() => pool.end());

/** Runs the real OTP flow and returns the verification token. Advances the clock past the resend cooldown first. */
async function verifiedToken(email = EMAIL) {
  clock.advance(31 * SEC);
  await otp.send({ email });
  const res = await otp.verify({ email, code: sender.last().code });
  return res.verificationToken;
}
const fieldsFor = (email = EMAIL, over = {}) => {
  const { firstName, lastName, role, phone, password } = registrationFields(email, over);
  return { firstName, lastName, role, phone, email, password };
};
const register = (token, fields = fieldsFor(), ip) => registrations.register({ fields, verificationToken: token, ip });
const all = async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY created_at`)).rows;
const countRegistrations = async () => (await all("parent_registrations")).length;
const tokenRow = async () => (await all("email_verification_tokens"))[0];

describe("successful registration", () => {
  it("stores the details and spends the token in the same commit", async () => {
    const token = await verifiedToken();
    const created = await register(token, fieldsFor(EMAIL), "203.0.113.9");
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.email, EMAIL);

    const [row] = await all("parent_registrations");
    assert.deepEqual(
      { f: row.first_name, l: row.last_name, s: row.school, r: row.role, p: row.phone, e: row.email_normalized, ip: row.request_ip },
      { f: "Asha", l: "Rao", s: "Unassigned", r: "Teacher", p: "9876543210", e: EMAIL, ip: "203.0.113.9" },
    );
    const t = await tokenRow();
    assert.ok(t.consumed_at, "token must be spent");
    assert.equal(row.verification_token_id, t.id);
    assert.equal(row.email_verified_at.getTime(), t.created_at.getTime(), "verified-at is when the OTP was verified");
  });

  it("never stores the raw token or the OTP anywhere", async () => {
    const token = await verifiedToken();
    const code = sender.last().code;
    await register(token);
    for (const table of ["parent_registrations", "email_verification_tokens", "email_otps"]) {
      const dump = JSON.stringify(await all(table));
      assert.ok(!dump.includes(token), `raw token found in ${table}`);
      assert.ok(!dump.includes(code), `OTP found in ${table}`);
    }
  });

  it("registrations for different emails are independent", async () => {
    await register(await verifiedToken("a@example.com"), fieldsFor("a@example.com"));
    await register(await verifiedToken("b@example.com"), fieldsFor("b@example.com"));
    assert.equal(await countRegistrations(), 2);
  });

  it("the registration survives the 24h purge of its OTP and token", async () => {
    await register(await verifiedToken());
    clock.advance(25 * 3600 * SEC);
    await otp.send({ email: "someone-else@example.com" }); // triggers the retention purge
    assert.equal((await all("email_verification_tokens")).length, 0);
    const [row] = await all("parent_registrations");
    assert.equal(row.verification_token_id, null);
    assert.equal(row.email_normalized, EMAIL);
  });
});

describe("token checks: nothing is created, and a rejected request never burns a valid token", () => {
  it("missing, empty and garbage tokens are rejected", async () => {
    await verifiedToken();
    for (const bad of [undefined, null, "", "not-a-token", "x".repeat(500), 12345]) {
      assert.equal(await errorCode(register(bad)), "VERIFICATION_REQUIRED", String(bad).slice(0, 20));
    }
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null);
  });

  it("an already-used token is rejected the second time", async () => {
    const token = await verifiedToken();
    await register(token);
    assert.equal(await errorCode(register(token, fieldsFor(EMAIL, { firstName: "Other" }))), "VERIFICATION_REQUIRED");
    assert.equal(await countRegistrations(), 1);
    assert.equal((await all("parent_registrations"))[0].first_name, "Asha", "second attempt must not overwrite");
  });

  it("an expired token is rejected", async () => {
    const token = await verifiedToken();
    clock.advance(900 * SEC);
    assert.equal(await errorCode(register(token)), "VERIFICATION_REQUIRED");
    assert.equal(await countRegistrations(), 0);
  });

  it("a token is valid until the last moment of its lifetime", async () => {
    const token = await verifiedToken();
    clock.advance(900 * SEC - 1);
    await register(token);
    assert.equal(await countRegistrations(), 1);
  });

  it("a token issued for another email is rejected, and is not burned by the attempt", async () => {
    const tokenA = await verifiedToken("a@example.com");
    assert.equal(await errorCode(register(tokenA, fieldsFor("b@example.com"))), "VERIFICATION_REQUIRED");
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null, "mismatch must not spend the token");
    await register(tokenA, fieldsFor("a@example.com")); // its real owner can still use it
    assert.equal(await countRegistrations(), 1);
  });

  it("email case and spacing do not defeat the binding or the match", async () => {
    const token = await verifiedToken("parent@example.com");
    const created = await register(token, fieldsFor("  Parent@Example.COM  ".trim().toLowerCase()));
    assert.equal(created.email, "parent@example.com");
  });
});

describe("duplicate email", () => {
  it("is rejected with a clear error, leaves the first registration intact, and does not burn the new token", async () => {
    await register(await verifiedToken(), fieldsFor(EMAIL, { firstName: "First" }));

    const second = await verifiedToken(); // the same person verifies the email again
    assert.equal(await errorCode(register(second, fieldsFor(EMAIL, { firstName: "Second" }))), "EMAIL_ALREADY_REGISTERED");

    const rows = await all("parent_registrations");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].first_name, "First");
    const tokens = await all("email_verification_tokens");
    assert.equal(tokens.length, 2);
    assert.equal(tokens[1].consumed_at, null, "rolled back: the second token is unspent");
    assert.equal(await otp.consumeVerificationToken({ email: EMAIL, token: second }), true);
  });

  it("the unique constraint also holds at the database level", async () => {
    await register(await verifiedToken());
    const err = await pool
      .query(
        `INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at)
         VALUES ('A', 'B', 'S', 'R', '12345678', $1, now())`,
        [EMAIL],
      )
      .catch((e) => e);
    assert.equal(err.code, "23505");
    assert.equal(err.constraint, "parent_registrations_email_key");
  });
});

describe("atomicity: database failures roll the token back too", () => {
  it("a failed INSERT leaves no registration and the token unspent and reusable", async () => {
    const token = await verifiedToken();
    const broken = createRegistrationService({ db: failingDb(pool, /INSERT INTO parent_registrations/), emailOtp: otp, sessions, passwords: sessions.passwords });

    await assert.rejects(broken.register({ fields: fieldsFor(), verificationToken: token }), /simulated database failure/);
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null, "token consumption must roll back with the failed insert");

    await register(token); // the same token now works once the database is healthy
    assert.equal(await countRegistrations(), 1);
    assert.ok((await tokenRow()).consumed_at);
  });

  it("a failed COMMIT persists neither the registration nor the token spend", async () => {
    const token = await verifiedToken();
    const broken = createRegistrationService({ db: failingDb(pool, /^COMMIT$/), emailOtp: otp, sessions, passwords: sessions.passwords });
    await assert.rejects(broken.register({ fields: fieldsFor(), verificationToken: token }), /simulated database failure/);
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null);
    await register(token);
    assert.equal(await countRegistrations(), 1);
  });

  it("a failed token spend creates nothing", async () => {
    const token = await verifiedToken();
    const broken = createRegistrationService({ db: failingDb(pool, /UPDATE email_verification_tokens/), emailOtp: otp, sessions, passwords: sessions.passwords });
    await assert.rejects(broken.register({ fields: fieldsFor(), verificationToken: token }), /simulated database failure/);
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null);
  });

  it("a constraint violation raised by the database (not caught by validation) rolls everything back", async () => {
    const token = await verifiedToken();
    // 101 characters passes no application check here because we bypass it, so the CHECK constraint fires.
    const err = await register(token, fieldsFor(EMAIL, { firstName: "x".repeat(101) })).catch((e) => e);
    assert.equal(err.code, "23514");
    assert.equal(await countRegistrations(), 0);
    assert.equal((await tokenRow()).consumed_at, null);
  });
});

describe("concurrency", () => {
  it("six simultaneous requests with one token: exactly one registration", async () => {
    const token = await verifiedToken();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => register(token)));

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const codes = results.filter((r) => r.status === "rejected").map((r) => r.reason.code);
    assert.deepEqual([...new Set(codes)], ["VERIFICATION_REQUIRED"]);
    assert.equal(await countRegistrations(), 1);
  });

  it("two different valid tokens for the same email: exactly one registration, the loser's token is unspent", async () => {
    const first = await verifiedToken();
    const second = await verifiedToken(); // a second OTP round for the same email
    const results = await Promise.allSettled([register(first), register(second)]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const loser = results.find((r) => r.status === "rejected");
    assert.equal(loser.reason.code, "EMAIL_ALREADY_REGISTERED");
    assert.equal(await countRegistrations(), 1);
    const spent = (await all("email_verification_tokens")).filter((t) => t.consumed_at);
    assert.equal(spent.length, 1, "only the winner's token is spent");
  });

  it("simultaneous registrations for different emails all succeed", async () => {
    const emails = ["a@example.com", "b@example.com", "c@example.com"];
    const tokens = [];
    for (const e of emails) tokens.push(await verifiedToken(e));
    const results = await Promise.allSettled(emails.map((e, i) => register(tokens[i], fieldsFor(e))));
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(await countRegistrations(), 3);
  });
});

describe("database constraints (defence in depth)", () => {
  const insert = (over = {}) => {
    const r = {
      first_name: "Asha", last_name: "Rao", school: "Young Edsplorer Academy", role: "Teacher",
      phone: "+91 98765 43210", email_normalized: "ok@example.com", ...over,
    };
    return pool.query(
      `INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [r.first_name, r.last_name, r.school, r.role, r.phone, r.email_normalized],
    );
  };

  it("accepts a valid row", async () => {
    await insert();
  });

  for (const [label, over, constraint] of [
    ["empty first name", { first_name: "" }, "parent_registrations_first_name_chk"],
    ["padded first name", { first_name: " Asha" }, "parent_registrations_first_name_chk"],
    ["first name over 100 chars", { first_name: "x".repeat(101) }, "parent_registrations_first_name_chk"],
    ["control character in last name", { last_name: "Ra\no" }, "parent_registrations_last_name_chk"],
    ["empty school", { school: "" }, "parent_registrations_school_chk"],
    ["empty role", { role: "" }, "parent_registrations_role_chk"],
    ["letters in phone", { phone: "call-me-maybe" }, "parent_registrations_phone_chk"],
    ["phone too short", { phone: "12345" }, "parent_registrations_phone_chk"],
    ["phone too long", { phone: "1234567890123456" }, "parent_registrations_phone_chk"],
    ["upper-case email", { email_normalized: "Ok@Example.com" }, "parent_registrations_email_chk"],
    ["email without a domain dot", { email_normalized: "ok@example" }, "parent_registrations_email_chk"],
    ["email with spaces", { email_normalized: "o k@example.com" }, "parent_registrations_email_chk"],
  ]) {
    it(`rejects ${label}`, async () => {
      const err = await insert(over).catch((e) => e);
      assert.equal(err.code, "23514");
      assert.equal(err.constraint, constraint);
    });
  }
});
