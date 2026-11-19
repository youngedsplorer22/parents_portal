import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createAuthService } from "../src/modules/auth/service.js";
import { createPasswordHasher } from "../src/modules/auth/password.js";
import { createWorkGate } from "../src/modules/auth/work-gate.js";
import { startApp } from "./harness.js";
import { TEST_PASSWORD, TEST_SCRYPT_COST, createTestPool, failingDb, fakeClock, resetTables, testAuthConfig, testOtpConfig } from "./helpers.js";
import { createOtpService } from "../src/modules/email-otp/service.js";

const pool = createTestPool();
const EMAIL = "parent@example.com";
const WRONG = "definitely-not-the-password";
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

const passwordLogin = (email, password, app = h, opts) => app.api.post("/api/auth/login/password", { email, password }, opts);
const credentialRows = async () => (await pool.query("SELECT * FROM password_credentials")).rows;
const attemptRows = async () => (await pool.query("SELECT * FROM password_login_attempts")).rows;
const sessionCount = async () => (await pool.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n;

describe("password hashing (scrypt)", () => {
  const hasher = createPasswordHasher({ cost: TEST_SCRYPT_COST });

  it("stores a salted, self-describing hash that never contains the password", async () => {
    const a = await hasher.hash(TEST_PASSWORD);
    const b = await hasher.hash(TEST_PASSWORD);
    assert.match(a, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.notEqual(a, b, "a fresh random salt per password");
    assert.ok(!a.includes(TEST_PASSWORD));
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hasher.hash(TEST_PASSWORD);
    assert.equal(await hasher.verify(TEST_PASSWORD, stored), true);
    assert.equal(await hasher.verify(TEST_PASSWORD + "x", stored), false);
    assert.equal(await hasher.verify("", stored), false);
  });

  it("treats canonically equivalent Unicode as the same password", async () => {
    const stored = await hasher.hash("café-au-lait-2024"); // é as one character
    assert.equal(await hasher.verify("café-au-lait-2024", stored), true); // e + combining accent
  });

  it("reads the cost from the stored hash, so a raised default still verifies old hashes", async () => {
    const old = await createPasswordHasher({ cost: { N: 512, r: 8, p: 1 } }).hash(TEST_PASSWORD);
    assert.equal(await hasher.verify(TEST_PASSWORD, old), true);
  });

  it("when the hashing gate is full, refuses at once with 503 SERVER_BUSY and a retry delay (no hashing, no waiting)", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const busy = createPasswordHasher({ cost: TEST_SCRYPT_COST, gate });
    const stored = await busy.hash(TEST_PASSWORD);
    const held = gate.reserve();
    const isBusy = (err) => err.status === 503 && err.code === "SERVER_BUSY" && err.details.retryAfterSeconds >= 1 && !/password/i.test(err.message);
    assert.throws(() => busy.reserve(), isBusy);
    await assert.rejects(busy.hash(TEST_PASSWORD), isBusy);
    await assert.rejects(busy.verify(TEST_PASSWORD, stored), isBusy);
    await assert.rejects(busy.verifyDecoy(TEST_PASSWORD), isBusy);
    held.release();
    assert.equal(await busy.verify(TEST_PASSWORD, stored), true, "works again as soon as there is room");
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, admitted: 0 });
  });

  it("a reserved ticket carries the caller through verify and hash without needing a second place", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const g = createPasswordHasher({ cost: TEST_SCRYPT_COST, gate });
    const stored = await g.hash(TEST_PASSWORD);
    const ticket = g.reserve();
    assert.equal(await g.verify(TEST_PASSWORD, stored, { ticket }), true);
    assert.equal(await g.verifyDecoy(TEST_PASSWORD, { ticket }), false);
    assert.match(await g.hash("another-long-passphrase", { ticket }), /^scrypt\$/);
    ticket.release();
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, admitted: 0 });
  });

  it("a decoy hash that was refused as busy is retried later, not remembered as a failure", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const g = createPasswordHasher({ cost: TEST_SCRYPT_COST, gate });
    const held = gate.reserve();
    await assert.rejects(g.verifyDecoy(TEST_PASSWORD), { code: "SERVER_BUSY" });
    held.release();
    assert.equal(await g.verifyDecoy(TEST_PASSWORD), false);
  });

  it("a malformed stored hash is refused without taking a place in the gate", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const g = createPasswordHasher({ cost: TEST_SCRYPT_COST, gate });
    const held = gate.reserve();
    assert.equal(await g.verify(TEST_PASSWORD, "not-a-hash"), false);
    held.release();
  });

  it("refuses malformed, tampered or dangerous stored hashes instead of throwing", async () => {
    const stored = await hasher.hash(TEST_PASSWORD);
    const parts = stored.split("$");
    for (const bad of [
      "", "plaintext", null, undefined, "scrypt$1024$8$1$abc",
      ["scrypt", "1000", ...parts.slice(2)].join("$"), // N not a power of two
      ["scrypt", String(2 ** 30), ...parts.slice(2)].join("$"), // N far above the cap
      ["scrypt", "1024", "8", "99", parts[4], parts[5]].join("$"), // p above the cap
      ["scrypt", ...parts.slice(1, 5), parts[5].slice(0, -4)].join("$"), // truncated hash
    ]) {
      assert.equal(await hasher.verify(TEST_PASSWORD, bad), false, String(bad));
    }
    const flipped = parts.slice(0, 5).concat(parts[5].replace(/^./, (c) => (c === "A" ? "B" : "A"))).join("$");
    assert.equal(await hasher.verify(TEST_PASSWORD, flipped), false);
  });
});

describe("registration with a password", () => {
  it("registers, stores only a scrypt hash, starts a session and never echoes the password", async () => {
    const { res, cookie, registrationId } = await h.signUp(EMAIL);
    assert.equal(res.status, 201);
    assert.ok(cookie.startsWith("pp_access="));
    assert.ok(!JSON.stringify(res.body).includes(TEST_PASSWORD));

    const [cred] = await credentialRows();
    assert.equal(cred.registration_id, registrationId);
    assert.match(cred.password_hash, /^scrypt\$/);
    const everything = JSON.stringify(
      (await Promise.all(["password_credentials", "parent_registrations", "auth_sessions", "email_otps", "email_verification_tokens"].map((t) => pool.query(`SELECT * FROM ${t}`)))).map((r) => r.rows),
    );
    assert.ok(!everything.includes(TEST_PASSWORD), "the plain password is stored nowhere");

    const session = await h.api.get("/api/auth/session", { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.email, EMAIL);
  });

  it("assigns no school from the client: the stored value is a fixed placeholder", async () => {
    await h.signUp(EMAIL);
    const [row] = (await pool.query("SELECT school FROM parent_registrations")).rows;
    assert.equal(row.school, "Unassigned");
  });

  it("rejects a leftover confirmPassword field and spends nothing", async () => {
    const token = await h.verifiedToken(EMAIL, "registration");
    const body = { firstName: "A", lastName: "B", role: "Student", phone: "9876543210", email: EMAIL, password: TEST_PASSWORD, verificationToken: token };
    const res = await h.api.post("/api/registrations", { ...body, confirmPassword: TEST_PASSWORD });
    assert.equal(res.status, 400);
    assert.deepEqual(res.setCookie, []);
    assert.equal((await credentialRows()).length, 0);
    // the same, still unspent token works with just the password
    const ok = await h.api.post("/api/registrations", body);
    assert.equal(ok.status, 201);
  });

  it("refuses a duplicate email and leaves the first account's password untouched", async () => {
    await h.signUp(EMAIL);
    const [first] = await credentialRows();
    const token = await h.verifiedToken(EMAIL, "registration");
    const res = await h.api.post("/api/registrations", {
      firstName: "X", lastName: "Y", role: "Teacher", phone: "9876543210", email: EMAIL,
      password: "another-long-password", verificationToken: token,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "EMAIL_ALREADY_REGISTERED");
    const after = await credentialRows();
    assert.equal(after.length, 1);
    assert.equal(after[0].password_hash, first.password_hash);
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200, "the original password still works");
    assert.equal((await passwordLogin(EMAIL, "another-long-password")).status, 401);
  });

  it("still requires a valid email OTP verification (a login-purpose or missing token is refused)", async () => {
    const wrongPurpose = await h.verifiedToken(EMAIL, "login");
    const base = { firstName: "A", lastName: "B", role: "Student", phone: "9876543210", email: EMAIL, password: TEST_PASSWORD };
    const res = await h.api.post("/api/registrations", { ...base, verificationToken: wrongPurpose });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
    assert.equal((await h.api.post("/api/registrations", { ...base, verificationToken: "nope" })).status, 403);
    assert.equal((await credentialRows()).length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM parent_registrations")).rows[0].n, 0);
  });

  it("is atomic: if saving the password fails, no account exists and the token is not spent", async () => {
    const broken = await open({ db: failingDb(pool, /INSERT INTO password_credentials/) });
    const token = await broken.verifiedToken(EMAIL, "registration");
    const res = await broken.api.post("/api/registrations", {
      firstName: "A", lastName: "B", role: "Student", phone: "9876543210", email: EMAIL, password: TEST_PASSWORD, verificationToken: token,
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.setCookie, []);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM parent_registrations")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT consumed_at FROM email_verification_tokens")).rows[0].consumed_at, null);
    assert.equal(await sessionCount(), 0);
  });
});

describe("POST /api/auth/login/password", () => {
  beforeEach(async () => {
    await h.signUp(EMAIL, { role: "Teacher" });
  });

  it("signs in with the right password, creates a session and sets the cookie", async () => {
    const before = await sessionCount();
    const res = await passwordLogin(EMAIL, TEST_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, EMAIL);
    assert.equal(res.body.user.role, "Teacher");
    assert.ok(!JSON.stringify(res.body).includes(TEST_PASSWORD));
    assert.ok(res.setCookie.some((c) => /^pp_access=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/api; HttpOnly; SameSite=Strict$/.test(c)));
    assert.ok(res.setCookie.some((c) => /^pp_refresh=[A-Za-z0-9_-]{43}; Max-Age=1800; Path=\/api\/auth; HttpOnly; SameSite=Strict$/.test(c)));
    assert.equal(await sessionCount(), before + 1);

    const cookie = h.cookieOf(res);
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 200);
    assert.equal((await h.api.get("/api/onboarding", { cookie })).status, 200, "the existing onboarding works with this session");
    const stored = (await pool.query("SELECT token_hash FROM auth_sessions ORDER BY created_at DESC LIMIT 1")).rows[0].token_hash;
    assert.notEqual(stored, cookie.split("=")[1]);
  });

  it("matches the email case-insensitively", async () => {
    assert.equal((await passwordLogin("  Parent@Example.COM ", TEST_PASSWORD)).status, 200);
  });

  it("answers a wrong password, an unknown email and an account with no password identically", async () => {
    await h.signUp("legacy@example.com");
    await pool.query("DELETE FROM password_credentials WHERE registration_id = (SELECT id FROM parent_registrations WHERE email_normalized = 'legacy@example.com')");

    const results = [
      await passwordLogin(EMAIL, WRONG),
      await passwordLogin("nobody@example.com", WRONG),
      await passwordLogin("legacy@example.com", TEST_PASSWORD),
    ];
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
      assert.deepEqual(r.setCookie, []);
    }
    assert.deepEqual(results[1].body, results[0].body);
    assert.deepEqual(results[2].body, results[0].body);
  });

  it("does the same hashing work for an unknown email as for a real one", async () => {
    const calls = [];
    const spy = { reserve: () => ({ release() {} }), hash: async () => "x", verify: async () => (calls.push("verify"), false), verifyDecoy: async () => (calls.push("decoy"), false) };
    const otp = createOtpService({ db: pool, sender: h.sender, config: testOtpConfig(), clock: fakeClock() });
    const auth = createAuthService({ db: pool, emailOtp: otp, config: testAuthConfig(), passwords: spy });
    await assert.rejects(auth.passwordLogin({ email: EMAIL, password: WRONG }), { code: "INVALID_CREDENTIALS" });
    await assert.rejects(auth.passwordLogin({ email: "nobody@example.com", password: WRONG }), { code: "INVALID_CREDENTIALS" });
    assert.deepEqual(calls, ["verify", "decoy"]);
  });

  it("validates the request (400) and rejects unknown fields", async () => {
    assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL })).status, 400);
    assert.equal((await h.api.post("/api/auth/login/password", { email: "bad", password: "x" })).status, 400);
    assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL, password: "a".repeat(129) })).status, 400);
    assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD, role: "Admin" })).status, 400);
    assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL, password: { $ne: "" } })).status, 400);
  });

  it("never logs the password or sets a cookie on failure", async () => {
    await passwordLogin(EMAIL, WRONG);
    assert.ok(!JSON.stringify(h.logged).includes(WRONG));
    assert.ok(!JSON.stringify(h.logged).includes(TEST_PASSWORD));
  });
});

describe("email code login is unchanged", () => {
  it("still works for an account with a password", async () => {
    await h.signUp(EMAIL);
    const { res } = await h.logIn(EMAIL);
    assert.equal(res.status, 200);
  });

  it("still works for an existing account that has no password", async () => {
    await h.signUp(EMAIL);
    await pool.query("DELETE FROM password_credentials");
    const { res } = await h.logIn(EMAIL);
    assert.equal(res.status, 200);
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 401);
  });
});

describe("password sign-in rate limiting", () => {
  beforeEach(async () => {
    await h.signUp(EMAIL);
  });

  it("locks the account after 5 wrong passwords, even for the right password, and says when to retry", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await passwordLogin(EMAIL, WRONG)).status, 401);
    const blocked = await passwordLogin(EMAIL, TEST_PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
    assert.deepEqual(blocked.setCookie, []);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal((await attemptRows()).length, 5, "a blocked request is not counted again");
  });

  it("does not lock other accounts, and email-code sign-in still works while locked", async () => {
    await h.signUp("other@example.com");
    for (let i = 0; i < 6; i++) await passwordLogin(EMAIL, WRONG);
    assert.equal((await passwordLogin("other@example.com", TEST_PASSWORD)).status, 200);
    assert.equal((await h.logIn(EMAIL)).res.status, 200);
  });

  it("limits an unknown email exactly like a real one, revealing nothing", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await passwordLogin("nobody@example.com", WRONG)).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  });

  it("lets attempts through again once they age out of the window", async () => {
    for (let i = 0; i < 5; i++) await passwordLogin(EMAIL, WRONG);
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 429);
    await pool.query("UPDATE password_login_attempts SET created_at = created_at - interval '16 minutes'");
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200);
  });

  it("a successful sign-in clears that account's failed attempts", async () => {
    for (let i = 0; i < 4; i++) await passwordLogin(EMAIL, WRONG);
    assert.equal((await passwordLogin(EMAIL, TEST_PASSWORD)).status, 200);
    assert.equal((await attemptRows()).length, 0);
    for (let i = 0; i < 4; i++) assert.equal((await passwordLogin(EMAIL, WRONG)).status, 401);
  });

  it("counts parallel guesses: of 12 simultaneous wrong attempts exactly 5 are checked", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => passwordLogin(EMAIL, WRONG)));
    const by = (s) => results.filter((r) => r.status === s).length;
    assert.equal(by(401), 5);
    assert.equal(by(429), 7);
    assert.equal((await attemptRows()).length, 5);
  });

  it("limits per IP across different emails", async () => {
    const limited = await open({ auth: { passwordLogin: { windowSeconds: 900, maxPerEmail: 5, maxPerIp: 3 } } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await passwordLogin(`user${i}@example.com`, WRONG, limited)).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  });
});
