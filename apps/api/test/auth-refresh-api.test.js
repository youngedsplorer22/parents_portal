import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { setStaffDisabled } from "../src/modules/staff/provision.js";
import { STAFF_PASSWORD, startApp, validAnswers } from "./harness.js";
import { TEST_PASSWORD, createTestPool, registrationFields, resetTables } from "./helpers.js";

// Access + refresh tokens over HTTP, for parents (/api/auth) and staff (/api/admin/auth). The browser only ever holds
// them in HttpOnly cookies; this file checks every cookie, every refresh outcome and every way a sign-in must end.

const pool = createTestPool();
let h;
after(() => pool.end());
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
});
afterEach(() => h.close());

const EMAIL = "parent@example.com";
const cookieValue = (res, name) => res.setCookie.find((c) => c.startsWith(`${name}=`));
const pair = (res, a = "pp_access", r = "pp_refresh") => ({
  access: cookieValue(res, a)?.split(";")[0],
  refresh: cookieValue(res, r)?.split(";")[0],
});
const both = (p) => `${p.access}; ${p.refresh}`;
async function parentSignIn() {
  await h.signUp(EMAIL);
  const res = await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD });
  assert.equal(res.status, 200);
  return { res, ...pair(res) };
}
const refresh = (cookie, extra = {}) => h.api.post("/api/auth/refresh", {}, { cookie, ...extra });
const session = (cookie) => h.api.get("/api/auth/session", { cookie });
const expireAccess = (table = "auth_sessions") => pool.query(`UPDATE ${table} SET access_expires_at = now() - interval '1 second'`);

describe("parent sign-in sets two HttpOnly cookies, never a token in the body", () => {
  it("an access cookie for /api (15 min) and a refresh cookie for /api/auth only (inactivity limit), both HttpOnly and SameSite=Strict", async () => {
    const { res } = await parentSignIn();
    const access = cookieValue(res, "pp_access");
    const refreshC = cookieValue(res, "pp_refresh");
    assert.match(access, /^pp_access=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/api; HttpOnly; SameSite=Strict$/);
    assert.match(refreshC, /^pp_refresh=[A-Za-z0-9_-]{43}; Max-Age=1800; Path=\/api\/auth; HttpOnly; SameSite=Strict$/);
    assert.ok(res.setCookie.some((c) => /^pp_session=; Max-Age=0; Path=\/api;/.test(c)), "the old single-cookie session is cleared");
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(access.split(";")[0].split("=")[1]) && !body.includes(refreshC.split(";")[0].split("=")[1]));
  });

  it("registration and email-code sign-in set the same pair", async () => {
    const verificationToken = await h.verifiedToken("new@example.com", "registration");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("new@example.com"), verificationToken });
    assert.ok(pair(reg).access && pair(reg).refresh);
    const login = await h.logIn("new@example.com");
    assert.ok(pair(login.res).access && pair(login.res).refresh);
  });

  it("Secure is added in production", async () => {
    const prod = await startApp({ db: pool, auth: { cookieSecure: true } });
    try {
      await prod.signUp("s@example.com");
      const res = await prod.api.post("/api/auth/login/password", { email: "s@example.com", password: TEST_PASSWORD });
      for (const name of ["pp_access", "pp_refresh"]) assert.match(cookieValue(res, name), /; Secure$/);
    } finally {
      await prod.close();
    }
  });
});

describe("the access token on protected requests", () => {
  it("works while fresh; once expired the request is 401 and the refresh token gets a new one", async () => {
    const p = await parentSignIn();
    assert.equal((await session(p.access)).status, 200);
    await expireAccess();
    assert.equal((await session(p.access)).status, 401);
    const r = await refresh(p.refresh);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { authenticated: true, user: { email: EMAIL, firstName: "Asha", lastName: "Rao", role: "Student" } });
    const next = pair(r);
    assert.equal((await session(next.access)).status, 200);
    assert.equal((await session(p.access)).status, 401, "the old access token stays dead");
  });

  it("the refresh token alone is not an access token, and the access token alone can't refresh", async () => {
    const p = await parentSignIn();
    assert.equal((await session(p.refresh.replace("pp_refresh", "pp_access"))).status, 401);
    assert.equal((await refresh(p.access.replace("pp_access", "pp_refresh"))).status, 401);
    assert.equal((await refresh(p.access)).status, 401, "no refresh cookie: nothing to refresh with");
  });

  it("an ID in the URL is never proof: a fresh access token of parent A can't open parent B's registration", async () => {
    const a = await parentSignIn();
    const verificationToken = await h.verifiedToken("b@example.com", "registration");
    const regB = await h.api.post("/api/registrations", { ...registrationFields("b@example.com"), verificationToken });
    const b = pair(regB);
    await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: null, version: null, enrolmentId: "legacy" }, { cookie: b.access });
    const r = await refresh(a.refresh);
    const aNew = pair(r);
    const formB = await h.api.get("/api/onboarding?enrolment=legacy", { cookie: aNew.access });
    assert.equal(formB.status, 200);
    assert.equal(formB.body.form, null, "A sees only A's own (empty) form, never B's");
  });
});

describe("the session check says whether renewing could work (so a visitor's page doesn't try in vain)", () => {
  it("no cookies at all: 401 with renewable false; an expired access token with its refresh cookie: renewable true", async () => {
    const none = await session(undefined);
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, "UNAUTHENTICATED");
    assert.equal(none.body.error.renewable, false);
    const p = await parentSignIn();
    await expireAccess();
    const stale = await session(both(p));
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.renewable, true);
    assert.equal((await session(p.refresh)).body.error.renewable, true); // the browser already dropped the expired access cookie
    assert.equal((await session("pp_session=" + "x".repeat(43))).body.error.renewable, true); // an old-format sign-in can be upgraded
    // only presence is reported: a forged refresh cookie gains nothing here, and the refresh endpoint still refuses it
    assert.equal((await refresh("pp_refresh=" + "y".repeat(43))).status, 401);
  });

  it("other protected routes don't say (they can't see the refresh cookie), and the staff check says the same", async () => {
    const r = await h.api.get("/api/onboarding", {});
    assert.equal(r.status, 401);
    assert.equal(r.body.error.renewable, undefined);
    const staff = await h.api.get("/api/admin/auth/session", {});
    assert.equal(staff.status, 401);
    assert.equal(staff.body.error.renewable, false);
    assert.equal((await h.api.get("/api/admin/auth/session", { cookie: "pp_staff_refresh=" + "z".repeat(43) })).body.error.renewable, true);
    assert.equal((await h.api.get("/api/admin/itinerary/trips", {})).body.error.renewable, undefined);
  });
});

describe("refresh rules", () => {
  it("rotation: each refresh token works once; a reuse after the grace window is a replay that ends the whole sign-in", async () => {
    const p = await parentSignIn();
    const r1 = await refresh(p.refresh);
    const fresh = pair(r1);
    await pool.query("UPDATE auth_refresh_tokens SET used_at = now() - interval '1 minute' WHERE used_at IS NOT NULL");
    const replay = await refresh(p.refresh);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "UNAUTHENTICATED");
    assert.equal((await session(fresh.access)).status, 401, "the newest access token is revoked too");
    assert.equal((await refresh(fresh.refresh)).status, 401, "and the newest refresh token");
    assert.deepEqual((await pool.query("SELECT revoke_reason FROM auth_sessions WHERE revoked_at IS NOT NULL")).rows, [{ revoke_reason: "refresh_reuse" }]);
    assert.ok(h.logged.some((l) => /refresh token was reused/i.test(l)), "logged (without any token)");
    assert.ok(!h.logged.join(" ").includes(p.refresh.split("=")[1]));
  });

  it("simultaneous refreshes (several tabs): one 200 with new cookies, the others 409 REFRESH_RACE with no cookies and no revocation", async () => {
    const p = await parentSignIn();
    const results = await Promise.all([refresh(p.refresh), refresh(p.refresh), refresh(p.refresh)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      assert.equal(r.body.error.code, "REFRESH_RACE");
      assert.deepEqual(r.setCookie, []);
    }
    const winner = pair(results.find((r) => r.status === 200));
    assert.equal((await session(winner.access)).status, 200, "the sign-in continues with the winner's cookies");
  });

  it("past the inactivity limit the refresh token has expired: 401 and the cookies are cleared", async () => {
    const p = await parentSignIn();
    await pool.query("UPDATE auth_refresh_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'");
    const r = await refresh(p.refresh);
    assert.equal(r.status, 401);
    for (const name of ["pp_access", "pp_refresh"]) assert.match(cookieValue(r, name), /Max-Age=0/);
  });

  it("past the absolute limit nothing renews it, however active the parent has been", async () => {
    const p = await parentSignIn();
    const r1 = pair(await refresh(p.refresh));
    await pool.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'");
    assert.equal((await refresh(r1.refresh)).status, 401);
  });

  it("each refresh moves the inactivity window but never beyond the absolute end", async () => {
    const p = await parentSignIn();
    await pool.query("UPDATE auth_sessions SET expires_at = now() + interval '10 minutes'");
    const r = await refresh(p.refresh);
    assert.match(cookieValue(r, "pp_refresh"), /Max-Age=(\d+);/);
    const max = Number(/Max-Age=(\d+);/.exec(cookieValue(r, "pp_refresh"))[1]);
    assert.ok(max <= 600, `refresh cookie ${max}s <= the 600s left of the sign-in`);
  });

  it("a session from before this change (the old pp_session cookie) is upgraded once by the refresh endpoint", async () => {
    await h.signUp(EMAIL);
    const regId = (await pool.query("SELECT id FROM parent_registrations")).rows[0].id;
    const legacy = "Q".repeat(43);
    const legacyHash = createHmac("sha256", "a".repeat(64)).update(`session-token-v1:${legacy}`).digest("hex");
    await pool.query("INSERT INTO auth_sessions (registration_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [regId, legacyHash]);
    assert.equal((await session(`pp_session=${legacy}`)).status, 401, "the old cookie is not an access token");
    const up = await refresh(`pp_session=${legacy}`);
    assert.equal(up.status, 200);
    assert.ok(up.setCookie.some((c) => /^pp_session=; Max-Age=0/.test(c)));
    assert.equal((await session(pair(up).access)).status, 200);
    assert.equal((await refresh(`pp_session=${legacy}`)).status, 401, "the old token works for one upgrade only");
  });
});

describe("refresh endpoint protection", () => {
  it("only accepts a JSON POST: a cross-site HTML form (no JSON) is refused before anything happens", async () => {
    const p = await parentSignIn();
    const form = await h.api.post("/api/auth/refresh", "a=1", { cookie: p.refresh, raw: true, headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415);
    assert.equal((await h.api.get("/api/auth/refresh", { cookie: p.refresh })).status, 404);
    assert.equal((await refresh(p.refresh)).status, 200, "the refresh token was not spent by the refused requests");
  });

  it("refuses a request from another site (Origin check)", async () => {
    const p = await parentSignIn();
    const res = await refresh(p.refresh, { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CROSS_SITE_REQUEST");
  });

  it("is rate limited per address", async () => {
    const limited = await startApp({ db: pool, auth: { refreshLimit: { windowMs: 60_000, max: 3 } } });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.api.post("/api/auth/refresh", {}, { cookie: "pp_refresh=" + "z".repeat(43) })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });

  it("is never cached, and never puts a token in the body", async () => {
    const p = await parentSignIn();
    const r = await refresh(p.refresh);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const tokens = [pair(r).access.split("=")[1], pair(r).refresh.split("=")[1]];
    assert.ok(tokens.every((t) => !JSON.stringify(r.body).includes(t)));
  });
});

describe("ending a parent sign-in", () => {
  it("logout revokes it and clears all cookies, even when the access token has already expired", async () => {
    const p = await parentSignIn();
    await expireAccess();
    const out = await h.api.post("/api/auth/logout", undefined, { cookie: both(p) });
    assert.equal(out.status, 200);
    for (const name of ["pp_access", "pp_refresh", "pp_session"]) assert.match(cookieValue(out, name), /Max-Age=0/);
    assert.equal((await refresh(p.refresh)).status, 401);
    assert.deepEqual((await pool.query("SELECT revoke_reason FROM auth_sessions WHERE revoked_at IS NOT NULL")).rows, [{ revoke_reason: "logout" }], "only that sign-in ended (the sign-up's own sign-in is still live)");
  });

  it("logging out one browser leaves the parent's other sign-ins alone", async () => {
    const p = await parentSignIn();
    const other = pair(await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD }));
    await h.api.post("/api/auth/logout", undefined, { cookie: both(p) });
    assert.equal((await refresh(other.refresh)).status, 200);
  });

  it("a password reset ends every sign-in of that parent: access and refresh tokens both stop working", async () => {
    const p = await parentSignIn();
    h.clock.advance(31_000);
    await h.api.post("/api/auth/password-reset/request", { email: EMAIL });
    const verified = await h.api.post("/api/auth/password-reset/verify", { email: EMAIL, code: h.sender.last().code });
    const reset = await h.api.post("/api/auth/password-reset/confirm", { email: EMAIL, verificationToken: verified.body.verificationToken, password: "a-new-passphrase-99", confirmPassword: "a-new-passphrase-99" });
    assert.equal(reset.status, 200);
    assert.equal((await session(p.access)).status, 401);
    assert.equal((await refresh(p.refresh)).status, 401);
  });
});

describe("staff: separate cookies, stricter limits, the same rules", () => {
  async function staffSignIn(email = "sales@example.com", role = "sales") {
    await h.makeStaff({ email, role });
    const res = await h.api.post("/api/admin/auth/login", { email, password: STAFF_PASSWORD });
    assert.equal(res.status, 200);
    return { res, ...pair(res, "pp_staff_access", "pp_staff_refresh") };
  }
  const staffRefresh = (cookie) => h.api.post("/api/admin/auth/refresh", {}, { cookie });
  const staffSession = (cookie) => h.api.get("/api/admin/auth/session", { cookie });

  it("an access cookie for /api/admin and a refresh cookie for /api/admin/auth only", async () => {
    const { res } = await staffSignIn();
    assert.match(cookieValue(res, "pp_staff_access"), /^pp_staff_access=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/api\/admin; HttpOnly; SameSite=Strict$/);
    assert.match(cookieValue(res, "pp_staff_refresh"), /^pp_staff_refresh=[A-Za-z0-9_-]{43}; Max-Age=1200; Path=\/api\/admin\/auth; HttpOnly; SameSite=Strict$/);
  });

  it("expired access -> 401 -> refresh -> works; the role is still enforced after refreshing", async () => {
    const s = await staffSignIn("sales@example.com", "sales");
    await expireAccess("staff_sessions");
    assert.equal((await staffSession(s.access)).status, 401);
    const r = await staffRefresh(s.refresh);
    assert.equal(r.status, 200);
    assert.equal(r.body.staff.role, "sales");
    const next = pair(r, "pp_staff_access", "pp_staff_refresh");
    assert.equal((await h.api.get("/api/admin/itinerary/trips", { cookie: next.access })).status, 200, "its one area still works");
    assert.equal((await h.api.get("/api/admin/schools", { cookie: next.access })).status, 404, "there is no schools route");
    assert.equal((await h.api.get("/api/admin/staff", { cookie: next.access })).status, 404, "there is no staff route");
  });

  it("parent and staff tokens never cross over", async () => {
    const p = await parentSignIn();
    const s = await staffSignIn();
    assert.equal((await staffRefresh(p.refresh.replace("pp_refresh", "pp_staff_refresh"))).status, 401);
    assert.equal((await refresh(s.refresh.replace("pp_staff_refresh", "pp_refresh"))).status, 401);
    assert.equal((await staffSession(p.access.replace("pp_access", "pp_staff_access"))).status, 401);
    assert.equal((await session(s.access.replace("pp_staff_access", "pp_access"))).status, 401);
  });

  it("deactivating a staff member ends their sign-in at once: no request and no refresh works", async () => {
    const sales = await staffSignIn("sales@example.com", "sales");
    await setStaffDisabled(pool, { email: "sales@example.com", disabled: true }); // the developer command ops sales:disable
    assert.equal((await staffSession(sales.access)).status, 401);
    assert.equal((await staffRefresh(sales.refresh)).status, 401);
  });

  it("a disabled account can't refresh even if its sign-in wasn't revoked (belt and braces)", async () => {
    const s = await staffSignIn("sales@example.com", "sales");
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = 'sales@example.com'");
    assert.equal((await staffRefresh(s.refresh)).status, 401);
  });

  it("changing the password keeps THIS sign-in (it can still refresh) and ends all others", async () => {
    const here = await staffSignIn();
    const elsewhere = pair(await h.api.post("/api/admin/auth/login", { email: "sales@example.com", password: STAFF_PASSWORD }), "pp_staff_access", "pp_staff_refresh");
    const change = await h.api.post("/api/admin/auth/password", { currentPassword: STAFF_PASSWORD, password: "changed-pass-4321", confirmPassword: "changed-pass-4321" }, { cookie: here.access });
    assert.equal(change.status, 200);
    assert.equal((await staffRefresh(here.refresh)).status, 200);
    assert.equal((await staffRefresh(elsewhere.refresh)).status, 401);
    assert.equal((await staffSession(elsewhere.access)).status, 401);
  });

  it("a replayed staff refresh token ends the sign-in and is written to the audit log", async () => {
    const s = await staffSignIn();
    await staffRefresh(s.refresh);
    await pool.query("UPDATE staff_refresh_tokens SET used_at = now() - interval '1 minute' WHERE used_at IS NOT NULL");
    assert.equal((await staffRefresh(s.refresh)).status, 401);
    const audit = (await pool.query("SELECT action, details FROM audit_log WHERE action = 'staff.session_reuse'")).rows;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(s.refresh.split("=")[1]));
  });

  it("staff logout revokes and clears the staff cookies, even with an expired access token", async () => {
    const s = await staffSignIn();
    await expireAccess("staff_sessions");
    const out = await h.api.post("/api/admin/auth/logout", undefined, { cookie: both(s) });
    for (const name of ["pp_staff_access", "pp_staff_refresh", "pp_staff_session"]) assert.match(cookieValue(out, name), /Max-Age=0/);
    assert.equal((await staffRefresh(s.refresh)).status, 401);
  });
});
