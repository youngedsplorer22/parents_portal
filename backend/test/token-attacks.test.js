import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { STAFF_PASSWORD, startApp, validAnswers } from "./harness.js";
import { TEST_PASSWORD, createTestPool, registrationFields, resetTables } from "./helpers.js";

// Attacks on the access/refresh token system, written from an attacker's side: what they could hold (a stolen or old
// cookie, a database dump, another parent's IDs, a cross-site page) and what each gets them. Every case must get nothing.

const pool = createTestPool();
let h;
after(() => pool.end());
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
});
afterEach(() => h.close());

const SECRET = "a".repeat(64); // the test SESSION_SECRET (see helpers.js)
const value = (cookie) => cookie.split("=")[1];
const take = (res, name) => (res.setCookie.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? "").split(";")[0];
const pairOf = (res) => ({ access: take(res, "pp_access"), refresh: take(res, "pp_refresh") });
const session = (cookie) => h.api.get("/api/auth/session", { cookie });
const refresh = (cookie, o = {}) => h.api.post("/api/auth/refresh", {}, { cookie, ...o });
async function parent(email = "parent@example.com") {
  await h.signUp(email);
  const res = await h.api.post("/api/auth/login/password", { email, password: TEST_PASSWORD });
  return pairOf(res);
}

describe("a stolen cookie", () => {
  it("an access token stolen before logout is dead after logout, and so is its refresh token", async () => {
    const p = await parent();
    assert.equal((await session(p.access)).status, 200);
    await h.api.post("/api/auth/logout", undefined, { cookie: `${p.access}; ${p.refresh}` });
    assert.equal((await session(p.access)).status, 401);
    assert.equal((await h.api.get("/api/onboarding", { cookie: p.access })).status, 401);
    assert.equal((await refresh(p.refresh)).status, 401);
  });

  it("an access token stolen before a refresh stops working the moment the owner refreshes", async () => {
    const p = await parent();
    const r = await refresh(p.refresh);
    assert.equal(r.status, 200);
    assert.equal((await session(p.access)).status, 401, "only the newest access token works");
    assert.equal((await session(pairOf(r).access)).status, 200);
  });

  it("a thief who refreshes first is cut off when the owner's (now spent) token is presented: the whole sign-in ends", async () => {
    const p = await parent();
    const thief = pairOf(await refresh(p.refresh));
    await pool.query("UPDATE auth_refresh_tokens SET used_at = used_at - interval '1 minute' WHERE used_at IS NOT NULL"); // past the grace window
    assert.equal((await refresh(p.refresh)).status, 401); // the owner's next renewal reveals the replay
    assert.equal((await session(thief.access)).status, 401, "the thief's access token is revoked with the family");
    assert.equal((await refresh(thief.refresh)).status, 401, "and so is the thief's refresh token");
    // the replayed token's address doesn't matter: detection is by token, not by IP
  });

  it("replaying inside the grace window gets the attacker no token at all (409, no cookies)", async () => {
    const p = await parent();
    assert.equal((await refresh(p.refresh)).status, 200);
    const again = await refresh(p.refresh);
    assert.equal(again.status, 409);
    assert.ok(!again.setCookie.some((c) => /^pp_(access|refresh)=[A-Za-z0-9_-]{43}/.test(c)), "nothing issued");
  });
});

describe("forged and leaked values", () => {
  it("random, malformed, oversized and swapped cookies are all refused, without a 500", async () => {
    const p = await parent();
    const bad = [
      `pp_access=${"A".repeat(43)}`, "pp_access=", "pp_access=short", `pp_access=${"A".repeat(5000)}`, "pp_access=../../etc",
      `pp_access=${value(p.refresh)}`, // a refresh token presented as an access token
      `pp_access=${value(p.access)}x`, `pp_access=${value(p.access).slice(1)}`,
    ];
    for (const cookie of bad) assert.equal((await session(cookie)).status, 401, cookie.slice(0, 40));
    for (const cookie of [`pp_refresh=${"B".repeat(43)}`, `pp_refresh=${value(p.access)}`, "pp_refresh=%00%27", `pp_refresh=${"C".repeat(5000)}`]) {
      assert.equal((await refresh(cookie)).status, 401, cookie.slice(0, 40));
    }
    assert.equal((await refresh(p.refresh)).status, 200, "none of that disturbed the real sign-in");
  });

  it("a database dump is not enough: the stored hashes don't work as cookies", async () => {
    await parent();
    const s = (await pool.query("SELECT access_token_hash FROM auth_sessions WHERE access_token_hash IS NOT NULL")).rows[0];
    const rt = (await pool.query("SELECT token_hash FROM auth_refresh_tokens")).rows[0];
    for (const hash of [s.access_token_hash, rt.token_hash]) {
      const asToken = Buffer.from(hash, "hex").toString("base64url"); // the right shape, 43 characters
      assert.equal((await session(`pp_access=${asToken}`)).status, 401);
      assert.equal((await refresh(`pp_refresh=${asToken}`)).status, 401);
      assert.equal((await session(`pp_access=${hash}`)).status, 401);
    }
  });

  it("an old-format cookie of a revoked or expired sign-in can't be upgraded into a new pair", async () => {
    await h.signUp("parent@example.com");
    const regId = (await pool.query("SELECT id FROM parent_registrations")).rows[0].id;
    const legacyHash = (t) => createHmac("sha256", SECRET).update(`session-token-v1:${t}`).digest("hex");
    await pool.query(
      `INSERT INTO auth_sessions (registration_id, token_hash, created_at, expires_at, revoked_at) VALUES
         ($1, $2, now() - interval '1 hour', now() + interval '1 day', now()),
         ($1, $3, now() - interval '2 days', now() - interval '1 second', NULL)`,
      [regId, legacyHash("R".repeat(43)), legacyHash("E".repeat(43))],
    );
    assert.equal((await refresh(`pp_session=${"R".repeat(43)}`)).status, 401, "revoked");
    assert.equal((await refresh(`pp_session=${"E".repeat(43)}`)).status, 401, "expired");
  });

  it("a staff old-format cookie can't be upgraded by the parent endpoint, nor a parent one by the staff endpoint", async () => {
    await h.signUp("parent@example.com");
    const regId = (await pool.query("SELECT id FROM parent_registrations")).rows[0].id;
    const staff = await h.makeStaff({ email: "admin@example.com", role: "admin" });
    const staffId = (await pool.query("SELECT id FROM staff_users")).rows[0].id;
    const t = "S".repeat(43);
    await pool.query("INSERT INTO staff_sessions (staff_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [staffId, createHmac("sha256", SECRET).update(`staff-session-token-v1:${t}`).digest("hex")]);
    await pool.query("INSERT INTO auth_sessions (registration_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [regId, createHmac("sha256", SECRET).update(`session-token-v1:${"P".repeat(43)}`).digest("hex")]);
    assert.equal((await refresh(`pp_session=${t}`)).status, 401);
    assert.equal((await h.api.post("/api/admin/auth/refresh", {}, { cookie: `pp_staff_session=${"P".repeat(43)}` })).status, 401);
    assert.ok(staff);
  });
});

describe("cross-site requests (CSRF) against the refresh endpoints", () => {
  for (const [type, body] of [["application/x-www-form-urlencoded", "a=1"], ["multipart/form-data; boundary=x", "--x--"], ["text/plain", "{}"]]) {
    it(`a ${type.split(";")[0]} POST (what an HTML form can send) is refused and spends nothing`, async () => {
      const p = await parent();
      for (const url of ["/api/auth/refresh", "/api/admin/auth/refresh"]) {
        const res = await h.api.post(url, body, { cookie: p.refresh, raw: true, headers: { "content-type": type } });
        assert.equal(res.status, 415, `${url} ${type}`);
        assert.equal(res.setCookie.length, 0);
      }
      assert.equal((await refresh(p.refresh)).status, 200, "the refresh token is still unspent");
    });
  }

  it("a JSON POST from another origin is refused (403) and spends nothing", async () => {
    const p = await parent();
    assert.equal((await refresh(p.refresh, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await refresh(p.refresh, { headers: { origin: "null" } })).status, 403);
    assert.equal((await refresh(p.refresh)).status, 200);
  });
});

describe("IDs are never proof of identity, before or after renewal", () => {
  it("parent A, freshly renewed, can't read, save, submit or download parent B's registration by its id", async () => {
    const a = await parent("a@example.com");
    const vt = await h.verifiedToken("b@example.com", "registration");
    const b = pairOf(await h.api.post("/api/registrations", { ...registrationFields("b@example.com"), verificationToken: vt }));
    await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: null, version: null, enrolmentId: "legacy" }, { cookie: b.access });
    const bReg = (await pool.query("SELECT id FROM parent_registrations WHERE email_normalized = 'b@example.com'")).rows[0].id;
    const bRow = () => pool.query("SELECT f.* FROM onboarding_forms f JOIN parent_registrations r ON r.id = f.registration_id WHERE r.email_normalized = 'b@example.com'").then((x) => x.rows);
    const before = await bRow();
    const aNew = pairOf(await refresh(a.refresh));
    for (const q of [`?enrolment=${bReg}`, "?enrolment=00000000-0000-4000-8000-000000000000"]) {
      const r = await h.api.get(`/api/onboarding${q}`, { cookie: aNew.access });
      assert.notEqual(r.status, 200, q);
      assert.ok(!JSON.stringify(r.body).includes("domestic"), "nothing of B's form");
      assert.notEqual((await h.api.get(`/api/onboarding/pdf${q}`, { cookie: aNew.access })).status, 200);
    }
    const put = await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: 1, enrolmentId: bReg }, { cookie: aNew.access });
    assert.notEqual(put.status, 200);
    const submit = await h.api.post("/api/onboarding/submit", { version: 1, enrolmentId: bReg }, { cookie: aNew.access });
    assert.notEqual(submit.status, 200);
    assert.equal(before.length, 1);
    assert.deepEqual(await bRow(), before, "B's form row is exactly as it was (answers, status, version)");
  });

  it("a registration id or email in a header or the body is ignored: identity comes only from the access cookie", async () => {
    await parent("a@example.com");
    const bReg = (await pool.query("SELECT id FROM parent_registrations")).rows[0].id;
    for (const headers of [{ "x-registration-id": bReg }, { authorization: `Bearer ${bReg}` }, { "x-user-email": "a@example.com" }]) {
      assert.equal((await h.api.get("/api/onboarding", { headers })).status, 401);
    }
  });
});

describe("staff tokens", () => {
  it("a Sales member's renewed token still can't use admin-only routes, and a parent token can't refresh a staff sign-in", async () => {
    await h.makeStaff({ email: "admin@example.com", role: "admin" });
    await h.makeStaff({ email: "sales@example.com", role: "sales" });
    const login = await h.api.post("/api/admin/auth/login", { email: "sales@example.com", password: STAFF_PASSWORD });
    const r = await h.api.post("/api/admin/auth/refresh", {}, { cookie: take(login, "pp_staff_refresh") });
    assert.equal(r.status, 200);
    const access = take(r, "pp_staff_access");
    assert.equal((await h.api.get("/api/admin/staff", { cookie: access })).status, 403);
    assert.equal((await h.api.patch(`/api/admin/schools/00000000-0000-4000-8000-000000000000`, { name: "X" }, { cookie: access })).status, 403);
    const p = await parent();
    assert.equal((await h.api.post("/api/admin/auth/refresh", {}, { cookie: `pp_staff_refresh=${value(p.refresh)}` })).status, 401);
    assert.equal((await refresh(`pp_refresh=${value(take(r, "pp_staff_refresh"))}`)).status, 401);
  });
});

describe("nothing secret leaks", () => {
  it("through a full life (sign-in, renewals, a race, a replay, logout), no token appears in logs, bodies or headers other than Set-Cookie", async () => {
    const seen = [];
    const keep = (res) => (seen.push(JSON.stringify(res.body ?? ""), ...[...res.headers].filter(([k]) => k !== "set-cookie").map(([k, v]) => `${k}: ${v}`)), res);
    await h.signUp("parent@example.com");
    const login = keep(await h.api.post("/api/auth/login/password", { email: "parent@example.com", password: TEST_PASSWORD }));
    const p = pairOf(login);
    const r1 = keep(await refresh(p.refresh));
    keep(await refresh(p.refresh)); // race
    await pool.query("UPDATE auth_refresh_tokens SET used_at = used_at - interval '1 minute' WHERE used_at IS NOT NULL");
    keep(await refresh(p.refresh)); // replay: revokes
    keep(await h.api.post("/api/auth/logout", undefined, { cookie: pairOf(r1).access }));
    const tokens = [p.access, p.refresh, pairOf(r1).access, pairOf(r1).refresh].map(value);
    const everything = [...seen, ...h.logged].join("\n");
    for (const t of tokens) assert.ok(!everything.includes(t), "a token leaked");
    assert.ok(!everything.includes(TEST_PASSWORD));
    assert.ok(h.logged.some((l) => /refresh token was reused/.test(l)), "the replay was logged");
    for (const l of h.logged) assert.doesNotMatch(l, /parent@example\.com|[0-9a-f]{64}/, "log lines carry no email or hash");
  });

  it("every token response is no-store, and the refresh token never reaches a path outside /api/auth", async () => {
    await h.signUp("parent@example.com");
    const login = await h.api.post("/api/auth/login/password", { email: "parent@example.com", password: TEST_PASSWORD });
    const r = await refresh(pairOf(login).refresh);
    for (const res of [login, r]) {
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.setCookie.find((c) => c.startsWith("pp_refresh=")), /; Path=\/api\/auth;/);
    }
  });
});
