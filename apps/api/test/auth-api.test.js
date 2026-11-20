import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
const EMAIL = "parent@example.com";

before(async () => {
  h = await startApp({ db: pool });
});
beforeEach(() => resetTables(pool));
after(async () => {
  await h.close();
  await pool.end();
});

const sessionRows = async () => (await pool.query("SELECT * FROM auth_sessions")).rows;
const tokenConsumed = async (purpose) =>
  (await pool.query("SELECT consumed_at FROM email_verification_tokens WHERE purpose = $1", [purpose])).rows.map((r) => r.consumed_at !== null);

describe("registration starts a session", () => {
  it("sets HttpOnly, SameSite=Strict cookies (access for /api, refresh for /api/auth), and never puts a token in the body", async () => {
    const { res, cookie, refreshCookie } = await h.signUp(EMAIL);
    const access = res.setCookie.find((c) => c.startsWith("pp_access="));
    const refresh = res.setCookie.find((c) => c.startsWith("pp_refresh="));
    for (const header of [access, refresh]) {
      assert.match(header, /; HttpOnly/);
      assert.match(header, /; SameSite=Strict/);
      assert.doesNotMatch(header, /Secure/); // plain http in tests; production sets it (below)
    }
    assert.match(access, /; Max-Age=300; Path=\/api;/); // the short-lived access token (test policy)
    assert.match(refresh, /; Max-Age=1800; Path=\/api\/auth;/); // the inactivity limit (test policy)
    for (const c of [cookie, refreshCookie]) assert.ok(!JSON.stringify(res.body).includes(c.split("=")[1]));
  });

  it("stores only hashes of the access and refresh tokens", async () => {
    const { cookie, refreshCookie } = await h.signUp(EMAIL);
    const [row] = await sessionRows();
    assert.match(row.access_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.token_hash, null); // the old single-token column is no longer used for new sign-ins
    const { rows: refreshRows } = await pool.query("SELECT token_hash FROM auth_refresh_tokens");
    assert.equal(refreshRows.length, 1);
    assert.match(refreshRows[0].token_hash, /^[0-9a-f]{64}$/);
    const everything = JSON.stringify((await pool.query("SELECT * FROM auth_sessions, auth_refresh_tokens, parent_registrations")).rows);
    for (const c of [cookie, refreshCookie]) assert.ok(!everything.includes(c.split("=")[1]));
  });

  it("the session is created in the same transaction: a duplicate email leaves no extra session", async () => {
    await h.signUp(EMAIL);
    const token = await h.verifiedToken(EMAIL, "registration");
    const res = await h.api.post("/api/registrations", {
      firstName: "A", lastName: "B", role: "Student", phone: "9876543210", email: EMAIL, password: "correct-horse-battery", verificationToken: token,
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.setCookie, []);
    assert.equal((await sessionRows()).length, 1);
  });

  it("the cookie carries Secure in production", async () => {
    const prod = await startApp({ db: pool, auth: { cookieSecure: true } });
    try {
      const { res } = await prod.signUp("secure@example.com");
      assert.match(res.setCookie[0], /; Secure/);
    } finally {
      await prod.close();
    }
  });
});

describe("GET /api/auth/session", () => {
  it("returns the signed-in user, derived from the cookie", async () => {
    const { cookie } = await h.signUp(EMAIL, { role: "Teacher" });
    const res = await h.api.get("/api/auth/session", { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { authenticated: true, user: { email: EMAIL, firstName: "Asha", lastName: "Rao", role: "Teacher" } });
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("answers 401 without a cookie, with a garbage cookie, and with a well-formed but unknown token", async () => {
    await h.signUp(EMAIL);
    for (const cookie of [undefined, "pp_session=garbage", `pp_session=${"A".repeat(43)}`, "other=1"]) {
      const res = await h.api.get("/api/auth/session", { cookie });
      assert.equal(res.status, 401, String(cookie));
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
  });

  it("ignores an email or user id supplied by the client", async () => {
    const a = await h.signUp("a@example.com");
    await h.signUp("b@example.com");
    const res = await h.api.get("/api/auth/session?email=b@example.com", { cookie: a.cookie, headers: { "x-user-email": "b@example.com" } });
    assert.equal(res.body.user.email, "a@example.com");
  });

  it("rejects an expired session and a revoked one", async () => {
    const { cookie } = await h.signUp(EMAIL);
    await pool.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'");
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 401);
  });
});

describe("login with an email code", () => {
  it("emails a code for the login purpose and signs the registered user in", async () => {
    await h.signUp(EMAIL);
    const { res, cookie } = await h.logIn(EMAIL);
    assert.equal(h.sender.last().purpose, "login");
    assert.equal(res.status, 200);
    assert.equal(res.body.authenticated, true);
    assert.equal(res.body.user.email, EMAIL);
    assert.match(cookie, /^pp_access=[A-Za-z0-9_-]{43}$/);
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 200);
    assert.equal((await sessionRows()).length, 2); // the registration session and this one
    assert.ok(!JSON.stringify(res.body).includes(cookie.split("=")[1]));
  });

  it("the login token is single-use", async () => {
    await h.signUp(EMAIL);
    const token = await h.verifiedToken(EMAIL, "login");
    assert.equal((await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: token })).status, 200);
    const again = await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: token });
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, "VERIFICATION_REQUIRED");
  });

  it("a registration token cannot log in, and a login token cannot register", async () => {
    await h.signUp(EMAIL);
    const reg = await h.verifiedToken(EMAIL, "registration");
    assert.equal((await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: reg })).status, 403);

    const login = await h.verifiedToken("new@example.com", "login");
    const res = await h.api.post("/api/registrations", {
      firstName: "A", lastName: "B", role: "Student", phone: "9876543210", email: "new@example.com", password: "correct-horse-battery", verificationToken: login,
    });
    assert.equal(res.status, 403);
  });

  it("a token for another email is refused", async () => {
    await h.signUp("a@example.com");
    await h.signUp("b@example.com");
    const tokenForB = await h.verifiedToken("b@example.com", "login");
    const res = await h.api.post("/api/auth/login", { email: "a@example.com", verificationToken: tokenForB });
    assert.equal(res.status, 403);
  });

  it("an unknown or garbage token is refused", async () => {
    await h.signUp(EMAIL);
    const res = await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: "nope" });
    assert.equal(res.status, 403);
    assert.deepEqual(res.setCookie, []);
  });

  it("a verified email with no account gets ACCOUNT_NOT_FOUND, no session, and the token is not spent", async () => {
    const token = await h.verifiedToken("nobody@example.com", "login");
    const res = await h.api.post("/api/auth/login", { email: "nobody@example.com", verificationToken: token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "ACCOUNT_NOT_FOUND");
    assert.deepEqual(res.setCookie, []);
    assert.equal((await sessionRows()).length, 0);
    assert.deepEqual(await tokenConsumed("login"), [false]);
  });

  it("validates the body", async () => {
    for (const body of [{}, { email: "x", verificationToken: "t" }, { email: EMAIL }, { email: EMAIL, verificationToken: "t", extra: 1 }]) {
      const res = await h.api.post("/api/auth/login", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it("an unknown OTP purpose is still rejected", async () => {
    const res = await h.api.post("/api/email-otp/send", { email: EMAIL, purpose: "admin" });
    assert.equal(res.status, 400);
  });

  it("a database failure while logging in leaves the token unspent", async () => {
    await h.signUp(EMAIL);
    const token = await h.verifiedToken(EMAIL, "login");
    await pool.query("ALTER TABLE auth_sessions ADD CONSTRAINT zz_block CHECK (false) NOT VALID");
    try {
      const res = await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: token });
      assert.equal(res.status, 500);
      assert.deepEqual(res.setCookie, []);
    } finally {
      await pool.query("ALTER TABLE auth_sessions DROP CONSTRAINT zz_block");
    }
    assert.deepEqual(await tokenConsumed("login"), [false]);
    assert.equal((await h.api.post("/api/auth/login", { email: EMAIL, verificationToken: token })).status, 200);
  });
});

describe("logout", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const { cookie, refreshCookie } = await h.signUp(EMAIL);
    const res = await h.api.post("/api/auth/logout", undefined, { cookie });
    assert.equal(res.status, 200);
    for (const name of ["pp_access", "pp_refresh", "pp_session"]) assert.ok(res.setCookie.some((c) => c.startsWith(`${name}=; Max-Age=0`)), name);
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 401); // the old cookie is dead even if replayed
    assert.equal((await h.api.post("/api/auth/refresh", {}, { cookie: refreshCookie })).status, 401); // and so is its refresh token
  });

  it("is harmless without a session", async () => {
    assert.equal((await h.api.post("/api/auth/logout")).status, 200);
  });

  it("only ends the caller's own session", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    await h.api.post("/api/auth/logout", undefined, { cookie: a.cookie });
    assert.equal((await h.api.get("/api/auth/session", { cookie: b.cookie })).status, 200);
  });
});
