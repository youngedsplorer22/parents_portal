import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { TEST_PASSWORD, createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
const EMAIL = "parent@example.com";
const UNKNOWN = "nobody@example.com";
const NEW_PASSWORD = "a-brand-new-passphrase";
const SEC = 1000;
const apps = [];
let h;

const open = async (opts = {}) => {
  const app = await startApp({ db: opts.db ?? pool, auth: opts.auth });
  apps.push(app);
  return app;
};
beforeEach(async () => {
  await resetTables(pool);
  h = await open();
});
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});
after(() => pool.end());

const R = "/api/auth/password-reset";
const requestReset = (email, app = h) => app.api.post(`${R}/request`, { email });
const resendReset = (email, app = h) => app.api.post(`${R}/resend`, { email });
const verifyReset = (email, code, app = h) => app.api.post(`${R}/verify`, { email, code });
const confirmReset = (body, app = h) => app.api.post(`${R}/confirm`, body);
const passwordLogin = (email, password, app = h) => app.api.post("/api/auth/login/password", { email, password });
const sessionCount = async () => (await pool.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;

/** request -> verify with the emailed code -> the single-use reset authorisation. */
async function resetToken(email, app = h) {
  app.clock.advance(31 * SEC);
  const asked = await requestReset(email, app);
  assert.equal(asked.status, 200);
  const verified = await verifyReset(email, app.sender.last().code, app);
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body.verificationToken;
}
const confirmBody = (email, verificationToken, password = NEW_PASSWORD, confirmPassword = password) => ({ email, verificationToken, password, confirmPassword });

describe("the public response never reveals whether an account exists", () => {
  beforeEach(async () => {
    await h.signUp(EMAIL);
    h.sender.sent.length = 0;
  });

  it("request: identical status, body and headers for a registered and an unknown email", async () => {
    const known = await requestReset(EMAIL);
    const unknown = await requestReset(UNKNOWN);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.body, known.body);
    assert.equal(unknown.status, known.status);
    assert.deepEqual(known.setCookie, []);
    assert.deepEqual(unknown.setCookie, []);
    assert.equal(known.headers.get("cache-control"), unknown.headers.get("cache-control"));
    // only the real account is emailed
    assert.equal(h.sender.sent.length, 1);
    assert.equal(h.sender.sent[0].email, EMAIL);
    assert.equal(h.sender.sent[0].purpose, "password_reset");
  });

  it("an unknown email still gets a real challenge, so everything after it behaves the same", async () => {
    await requestReset(UNKNOWN);
    const rows = (await pool.query("SELECT purpose, verified_at FROM email_otps WHERE email_normalized = $1", [UNKNOWN])).rows;
    assert.deepEqual(rows.map((r) => r.purpose), ["password_reset"]);
    assert.equal(rows[0].verified_at, null);
  });

  it("wrong codes: the same errors, attempts left and lock-out for both", async () => {
    await requestReset(EMAIL);
    await requestReset(UNKNOWN);
    for (let i = 0; i < 6; i++) {
      const a = await verifyReset(EMAIL, "000000");
      const b = await verifyReset(UNKNOWN, "000000");
      assert.equal(b.status, a.status, `attempt ${i + 1}`);
      assert.deepEqual(b.body, a.body, `attempt ${i + 1}`);
    }
    assert.equal((await verifyReset(EMAIL, "000000")).body.error.code, "TOO_MANY_ATTEMPTS");
  });

  it("an unknown email's code can never be verified (nobody knows it)", async () => {
    await requestReset(UNKNOWN);
    // (the test harness issues predictable codes from 100001 up, so guess outside that range)
    for (const guess of ["000000", "999999", "123456"]) assert.equal((await verifyReset(UNKNOWN, guess)).status, 400);
    assert.equal(h.sender.sent.length, 0);
  });

  it("resend, cooldown and expiry are identical for both", async () => {
    await requestReset(EMAIL);
    await requestReset(UNKNOWN);
    const early = [await resendReset(EMAIL), await resendReset(UNKNOWN)];
    assert.equal(early[0].status, 429);
    assert.equal(early[0].body.error.code, "RESEND_COOLDOWN");
    assert.deepEqual(early[1].body, early[0].body);

    h.clock.advance(31 * SEC);
    const ok = [await resendReset(EMAIL), await resendReset(UNKNOWN)];
    assert.equal(ok[0].status, 200);
    assert.deepEqual(ok[1].body, ok[0].body);

    h.clock.advance(301 * SEC);
    const expired = [await verifyReset(EMAIL, h.sender.last().code), await verifyReset(UNKNOWN, "123456")];
    assert.equal(expired[0].status, 410);
    assert.deepEqual(expired[1].body, expired[0].body);
  });

  it("resend without a request first is the same 'no active code' answer for both", async () => {
    const a = await resendReset(EMAIL);
    const b = await resendReset(UNKNOWN);
    assert.equal(a.body.error.code, "OTP_NOT_FOUND");
    assert.deepEqual(b.body, a.body);
  });

  it("the hourly cap applies the same way to both", async () => {
    const codes = { known: [], unknown: [] };
    for (let i = 0; i < 7; i++) {
      h.clock.advance(31 * SEC);
      const a = i === 0 ? await requestReset(EMAIL) : await resendReset(EMAIL);
      const b = i === 0 ? await requestReset(UNKNOWN) : await resendReset(UNKNOWN);
      codes.known.push(a.status === 200 ? 200 : a.body.error.code);
      codes.unknown.push(b.status === 200 ? 200 : b.body.error.code);
    }
    assert.deepEqual(codes.unknown, codes.known);
    assert.deepEqual(codes.known.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(codes.known[5], "RATE_LIMITED");
  });

  it("a failed email delivery is not reported (that would reveal the account), and the answer stays 200", async () => {
    h.sender.send = async () => {
      throw new Error("smtp down");
    };
    const known = await requestReset(EMAIL);
    const unknown = await requestReset(UNKNOWN);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.body, known.body);
  });

  it("does not wait for delivery, so response time doesn't depend on whether an email is sent", async () => {
    let release;
    h.sender.send = () => new Promise((resolve) => { release = resolve; }); // a very slow mail server
    const started = Date.now();
    const answer = await Promise.race([requestReset(EMAIL), new Promise((r) => setTimeout(() => r("waited for the mail server"), 3000))]);
    release?.();
    assert.notEqual(answer, "waited for the mail server");
    assert.equal(answer.status, 200);
    assert.ok(Date.now() - started < 2000);
  });

  it("validates the request body", async () => {
    assert.equal((await h.api.post(`${R}/request`, {})).status, 400);
    assert.equal((await h.api.post(`${R}/request`, { email: "bad" })).status, 400);
    assert.equal((await h.api.post(`${R}/request`, { email: EMAIL, purpose: "login" })).status, 400);
  });
});

describe("the generic email-otp routes cannot be used for password reset", () => {
  it("rejects the purpose on send, resend and verify", async () => {
    await h.signUp(EMAIL);
    for (const [path, extra] of [["send", {}], ["resend", {}], ["verify", { code: "123456" }]]) {
      const res = await h.api.post(`/api/email-otp/${path}`, { email: EMAIL, purpose: "password_reset", ...extra });
      assert.equal(res.status, 400, path);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM email_otps WHERE purpose = 'password_reset'")).rows[0].n, 0);
  });
});

describe("resetting the password", () => {
  let oldCookie;
  beforeEach(async () => {
    ({ cookie: oldCookie } = await h.signUp(EMAIL));
  });

  it("changes the password, signs nobody in, revokes every session and stores only a new hash", async () => {
    const second = await h.logIn(EMAIL); // a second signed-in browser
    const [{ password_hash: before }] = (await pool.query("SELECT password_hash FROM password_credentials")).rows;
    const sessionsBefore = await sessionCount();
    const token = await resetToken(EMAIL);

    const res = await confirmReset(confirmBody(EMAIL, token));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { passwordChanged: true });
    assert.deepEqual(res.setCookie, [], "no cookie: the user must log in again");
    assert.equal(await sessionCount(), sessionsBefore, "no new session");

    for (const cookie of [oldCookie, second.cookie]) {
      assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 401);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM auth_sessions WHERE revoked_at IS NULL")).rows[0].n, 0);

    const [{ password_hash: after, changed_at, created_at }] = (await pool.query("SELECT * FROM password_credentials")).rows;
    assert.notEqual(after, before);
    assert.match(after, /^scrypt\$/);
    assert.ok(changed_at >= created_at);
    const everything = JSON.stringify((await pool.query("SELECT * FROM password_credentials, email_otps, email_verification_tokens")).rows);
    assert.ok(!everything.includes(NEW_PASSWORD) && !everything.includes(TEST_PASSWORD));
    assert.ok(!JSON.stringify(res.body).includes(NEW_PASSWORD));
  });

  it("the old password stops working and the new one works (after a manual login)", async () => {
    const token = await resetToken(EMAIL);
    await confirmReset(confirmBody(EMAIL, token));
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 401);
    const ok = await passwordLogin(EMAIL, NEW_PASSWORD);
    assert.equal(ok.status, 200);
    assert.equal((await h.api.get("/api/auth/session", { cookie: h.cookieOf(ok) })).status, 200);
  });

  it("sends a password-changed notice with no secrets in it, and a failing notice doesn't undo the reset", async () => {
    const token = await resetToken(EMAIL);
    await confirmReset(confirmBody(EMAIL, token));
    assert.equal(h.sender.notices.length, 1);
    assert.deepEqual(h.sender.notices[0], { email: EMAIL });

    h.sender.sendPasswordChanged = async () => {
      throw new Error(`smtp down for ${EMAIL} ${NEW_PASSWORD}`);
    };
    const again = await resetToken(EMAIL);
    const res = await confirmReset(confirmBody(EMAIL, again, "yet-another-passphrase"));
    assert.equal(res.status, 200, "the reset is not claimed or undone by the notice");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(h.logged.some((m) => m.includes("could not send the password-changed notice")));
    assert.ok(!JSON.stringify(h.logged).includes(EMAIL) && !JSON.stringify(h.logged).includes(NEW_PASSWORD));
    assert.equal((await passwordLogin(EMAIL, "yet-another-passphrase")).status, 200);
  });

  it("works for an existing account that has no password yet", async () => {
    await pool.query("DELETE FROM password_credentials");
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 401);
    const token = await resetToken(EMAIL);
    assert.equal((await confirmReset(confirmBody(EMAIL, token))).status, 200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM password_credentials")).rows[0].n, 1);
    assert.equal((await passwordLogin(EMAIL, NEW_PASSWORD)).status, 200);
  });

  it("matches the email case-insensitively", async () => {
    const token = await resetToken("  Parent@Example.COM ");
    assert.equal((await confirmReset(confirmBody(" PARENT@example.com", token))).status, 200);
  });

  it("ends a password lock-out, since ownership of the email was just proven", async () => {
    for (let i = 0; i < 5; i++) await passwordLogin(EMAIL, "wrong-password-here");
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 429);
    const token = await resetToken(EMAIL);
    await confirmReset(confirmBody(EMAIL, token));
    assert.equal((await passwordLogin(EMAIL, NEW_PASSWORD)).status, 200);
  });

  it("leaves email-code login and registration verification working", async () => {
    const token = await resetToken(EMAIL);
    await confirmReset(confirmBody(EMAIL, token));
    assert.equal((await h.logIn(EMAIL)).res.status, 200);
    const fresh = await h.signUp("other@example.com");
    assert.equal(fresh.res.status, 201);
  });

  it("never logs the password, code or token", async () => {
    const token = await resetToken(EMAIL);
    const code = h.sender.last().code;
    await confirmReset(confirmBody(EMAIL, token));
    await confirmReset(confirmBody(EMAIL, token)); // a failing replay too
    const logs = JSON.stringify(h.logged);
    for (const secret of [NEW_PASSWORD, token, code]) assert.ok(!logs.includes(secret));
  });
});

describe("the reset authorisation: binding, expiry and replay", () => {
  beforeEach(async () => {
    await h.signUp(EMAIL);
    await h.signUp("other@example.com");
  });

  it("is single use: the same token can't be replayed, and a replay changes nothing", async () => {
    const token = await resetToken(EMAIL);
    assert.equal((await confirmReset(confirmBody(EMAIL, token))).status, 200);
    const replay = await confirmReset(confirmBody(EMAIL, token, "attacker-chosen-pass"));
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error.code, "VERIFICATION_REQUIRED");
    assert.equal((await passwordLogin(EMAIL, NEW_PASSWORD)).status, 200);
    assert.equal((await passwordLogin(EMAIL, "attacker-chosen-pass")).status, 401);
  });

  it("an OTP can't be verified twice", async () => {
    await requestReset(EMAIL);
    const code = h.sender.last().code;
    assert.equal((await verifyReset(EMAIL, code)).status, 200);
    assert.equal((await verifyReset(EMAIL, code)).status, 404);
  });

  it("is bound to the email: another account's token can't reset this one, and isn't spent by trying", async () => {
    const token = await resetToken(EMAIL);
    const wrong = await confirmReset(confirmBody("other@example.com", token));
    assert.equal(wrong.status, 403);
    assert.equal((await passwordLogin("other@example.com", TEST_PASSWORD)).status, 200, "the other account is untouched");
    assert.equal((await confirmReset(confirmBody(EMAIL, token))).status, 200, "the owner can still use it");
  });

  it("is bound to the purpose: registration and login tokens are refused", async () => {
    for (const purpose of ["registration", "login"]) {
      const token = await h.verifiedToken(EMAIL, purpose);
      const res = await confirmReset(confirmBody(EMAIL, token));
      assert.equal(res.status, 403, purpose);
    }
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200);
    // and a reset token can't log in or register
    const reset = await resetToken(EMAIL);
    assert.equal((await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: reset })).status, 403);
  });

  it("rejects an invented, empty or oversized token with the same answer", async () => {
    for (const verificationToken of ["not-a-real-token", "x".repeat(200)]) {
      const res = await confirmReset(confirmBody(EMAIL, verificationToken));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
    }
    assert.equal((await confirmReset(confirmBody(EMAIL, ""))).status, 400);
    assert.equal((await confirmReset(confirmBody(EMAIL, "x".repeat(201)))).status, 400);
  });

  it("expires (15 minutes) and a refused token changes nothing", async () => {
    const token = await resetToken(EMAIL);
    h.clock.advance(901 * SEC);
    const res = await confirmReset(confirmBody(EMAIL, token));
    assert.equal(res.status, 403);
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200);
  });

  it("a successful reset also kills any other unused reset authorisation for that email", async () => {
    const first = await resetToken(EMAIL);
    const second = await resetToken(EMAIL);
    assert.equal((await confirmReset(confirmBody(EMAIL, first))).status, 200);
    assert.equal((await confirmReset(confirmBody(EMAIL, second, "second-chosen-pass"))).status, 403);
    assert.equal((await passwordLogin(EMAIL, "second-chosen-pass")).status, 401);
  });
});

describe("new password validation (server side)", () => {
  let token;
  beforeEach(async () => {
    await h.signUp(EMAIL);
    token = await resetToken(EMAIL);
  });

  const bad = [
    ["mismatched confirmation", { confirmPassword: "something-else-entirely" }, "confirmPassword"],
    ["missing password", { password: undefined }, "password"],
    ["missing confirmation", { confirmPassword: undefined }, "confirmPassword"],
    ["fewer than 10 characters", { password: "short-pw1", confirmPassword: "short-pw1" }, "password"],
    ["more than 128 characters", { password: "a".repeat(129), confirmPassword: "a".repeat(129) }, "password"],
    ["a common password", { password: "password123", confirmPassword: "password123" }, "password"],
    ["only spaces", { password: " ".repeat(12), confirmPassword: " ".repeat(12) }, "password"],
    ["the email address", { password: EMAIL, confirmPassword: EMAIL }, "password"],
  ];
  for (const [label, over, path] of bad) {
    it(`rejects ${label} and does not spend the token`, async () => {
      const res = await confirmReset({ ...confirmBody(EMAIL, token), ...over });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.fields.some((f) => f.path === path), JSON.stringify(res.body.error.fields));
      assert.ok(!JSON.stringify(res.body).includes(NEW_PASSWORD));
      assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200, "password unchanged");
      assert.equal((await confirmReset(confirmBody(EMAIL, token))).status, 200, "the same token still works");
    });
  }

  it("rejects unexpected fields", async () => {
    const res = await confirmReset({ ...confirmBody(EMAIL, token), isAdmin: true });
    assert.equal(res.status, 400);
  });
});

describe("concurrency", () => {
  beforeEach(async () => {
    await h.signUp(EMAIL);
  });

  it("of 8 simultaneous confirms with the same token exactly one succeeds", async () => {
    const token = await resetToken(EMAIL);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => confirmReset(confirmBody(EMAIL, token, `parallel-password-${i}`))),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 403).length, 7);
    const winner = results.findIndex((r) => r.status === 200);
    assert.equal((await passwordLogin(EMAIL, `parallel-password-${winner}`)).status, 200);
    assert.equal(h.sender.notices.length, 1);
  });

  it("two different valid tokens racing: still only one reset wins", async () => {
    const first = await resetToken(EMAIL);
    const second = await resetToken(EMAIL);
    const results = await Promise.all([
      confirmReset(confirmBody(EMAIL, first, "winner-or-loser-one")),
      confirmReset(confirmBody(EMAIL, second, "winner-or-loser-two")),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  });

  it("a failure while saving rolls everything back: password, sessions and token are untouched", async () => {
    const { failingDb } = await import("./helpers.js");
    const broken = await open({ db: failingDb(pool, /UPDATE auth_sessions SET revoked_at/) });
    const { cookie } = await broken.signUp("fresh@example.com");
    const token = await resetToken("fresh@example.com", broken);
    const [{ password_hash: before }] = (await pool.query("SELECT password_hash FROM password_credentials WHERE registration_id = (SELECT id FROM parent_registrations WHERE email_normalized = 'fresh@example.com')")).rows;

    const res = await confirmReset(confirmBody("fresh@example.com", token), broken);
    assert.equal(res.status, 500);
    const [{ password_hash: after }] = (await pool.query("SELECT password_hash FROM password_credentials WHERE registration_id = (SELECT id FROM parent_registrations WHERE email_normalized = 'fresh@example.com')")).rows;
    assert.equal(after, before);
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 200, "the session was not revoked");
    assert.equal((await pool.query("SELECT consumed_at FROM email_verification_tokens WHERE purpose = 'password_reset'")).rows[0].consumed_at, null);
    assert.equal(broken.sender.notices.length, 0);
  });
});
