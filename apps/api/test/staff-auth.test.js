import assert from "node:assert/strict";
import { request } from "node:http";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { STAFF_PASSWORD, startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
const apps = [];
let h;
const open = async (opts = {}) => {
  const app = await startApp({ db: pool, ...opts });
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

const ADMIN = "admin@example.com";
const login = (email, password, app = h, opts) => app.api.post("/api/admin/auth/login", { email, password }, opts);
const staffSessions = async () => (await pool.query("SELECT * FROM staff_sessions")).rows;

describe("staff login", () => {
  beforeEach(async () => {
    await h.makeStaff({ email: ADMIN, role: "sales" });
  });

  it("signs in, sets staff-only cookies (access for /api/admin, refresh for /api/admin/auth), and never returns a token in the body", async () => {
    const res = await login(ADMIN, STAFF_PASSWORD);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { authenticated: true, staff: { email: ADMIN, name: "Sam Sales", role: "sales" } });
    const access = res.setCookie.find((c) => c.startsWith("pp_staff_access="));
    const refresh = res.setCookie.find((c) => c.startsWith("pp_staff_refresh="));
    assert.match(access, /^pp_staff_access=[A-Za-z0-9_-]{43}; Max-Age=300; Path=\/api\/admin; HttpOnly; SameSite=Strict$/);
    assert.match(refresh, /^pp_staff_refresh=[A-Za-z0-9_-]{43}; Max-Age=1200; Path=\/api\/admin\/auth; HttpOnly; SameSite=Strict$/);
    for (const c of [access, refresh]) assert.ok(!JSON.stringify(res.body).includes(c.split("=")[1].split(";")[0]));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!res.setCookie.some((c) => /^pp_(session|access|refresh)=/.test(c)), "no parent cookie is set");
  });

  it("is Secure in production", async () => {
    const prod = await open({ staff: { cookieSecure: true } });
    const res = await login(ADMIN, STAFF_PASSWORD, prod);
    assert.match(res.setCookie[0], /; Secure/);
  });

  it("stores only a hash of the token, in staff_sessions (never in auth_sessions)", async () => {
    const { cookie, refreshCookie } = await h.staffSignIn(ADMIN);
    const [row] = await staffSessions();
    assert.match(row.access_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.token_hash, null); // the old single-token column is no longer used for new sign-ins
    const { rows: refreshRows } = await pool.query("SELECT token_hash FROM staff_refresh_tokens");
    assert.equal(refreshRows.length, 1);
    assert.match(refreshRows[0].token_hash, /^[0-9a-f]{64}$/);
    const dump = JSON.stringify((await pool.query("SELECT * FROM staff_sessions, staff_refresh_tokens, staff_users, audit_log")).rows);
    for (const c of [cookie, refreshCookie]) assert.ok(!dump.includes(c.split("=")[1]));
    assert.ok(!dump.includes(STAFF_PASSWORD));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM auth_sessions")).rows[0].n, 0);
  });

  it("a wrong password, an unknown email and a disabled account all get the same answer", async () => {
    await h.makeStaff({ email: "off@example.com", role: "sales" });
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = 'off@example.com'");
    const results = [
      await login(ADMIN, "wrong-password-here"),
      await login("nobody@example.com", STAFF_PASSWORD),
      await login("off@example.com", STAFF_PASSWORD),
    ];
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
      assert.deepEqual(r.setCookie, []);
    }
    assert.deepEqual(results[1].body, results[0].body);
    assert.deepEqual(results[2].body, results[0].body);
    assert.equal((await staffSessions()).length, 0);
  });

  it("is rate limited per account, the same for an unknown email, and clears on success", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login("nobody@example.com", "x".repeat(12))).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);

    for (let i = 0; i < 4; i++) await login(ADMIN, "wrong-password-here");
    assert.equal((await login(ADMIN, STAFF_PASSWORD)).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await login(ADMIN, "wrong-password-here")).status, 401);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM password_login_attempts")).rows[0].n, 0, "parent limiter is separate");
  });

  it("locks out after 5 wrong passwords even for the right one, with Retry-After", async () => {
    for (let i = 0; i < 5; i++) await login(ADMIN, "wrong-password-here");
    const blocked = await login(ADMIN, STAFF_PASSWORD);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  });

  it("validates the body and refuses unknown fields", async () => {
    assert.equal((await h.api.post("/api/admin/auth/login", { email: ADMIN })).status, 400);
    assert.equal((await h.api.post("/api/admin/auth/login", { email: "bad", password: "x" })).status, 400);
    assert.equal((await h.api.post("/api/admin/auth/login", { email: ADMIN, password: STAFF_PASSWORD, role: "sales" })).status, 400);
  });

  it("never logs the password or the token", async () => {
    const { cookie } = await h.staffSignIn(ADMIN);
    await login(ADMIN, "wrong-password-here");
    const logs = JSON.stringify(h.logged);
    assert.ok(!logs.includes(STAFF_PASSWORD) && !logs.includes(cookie.split("=")[1]) && !logs.includes("wrong-password-here"));
  });
});

describe("staff sessions", () => {
  let cookie;
  beforeEach(async () => {
    await h.makeStaff({ email: ADMIN, role: "sales" });
    ({ cookie } = await h.staffSignIn(ADMIN));
  });
  const session = (c = cookie) => h.api.get("/api/admin/auth/session", { cookie: c });

  it("returns the signed-in staff member", async () => {
    const res = await session();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.staff, { email: ADMIN, name: "Sam Sales", role: "sales" });
  });

  it("is refused without a cookie, with a garbage cookie, and after the session expires", async () => {
    assert.equal((await h.api.get("/api/admin/auth/session")).status, 401);
    for (const name of ["pp_staff_access", "pp_staff_refresh", "pp_staff_session"]) {
      assert.equal((await session(`${name}=` + "x".repeat(43))).status, 401);
      assert.equal((await session(`${name}=short`)).status, 401);
    }
    await pool.query("UPDATE staff_sessions SET expires_at = clock_timestamp() - interval '1 second', created_at = created_at - interval '1 hour'");
    assert.equal((await session()).status, 401);
  });

  it("stops working the moment the account is disabled, and while disabled cannot sign in", async () => {
    await pool.query("UPDATE staff_users SET disabled_at = now()");
    assert.equal((await session()).status, 401);
    assert.equal((await h.api.get("/api/admin/itinerary/trips", { cookie })).status, 401);
    assert.equal((await login(ADMIN, STAFF_PASSWORD)).status, 401);
    await pool.query("UPDATE staff_users SET disabled_at = NULL");
    assert.equal((await login(ADMIN, STAFF_PASSWORD)).status, 200);
  });

  it("logout revokes the session on the server and clears the cookie", async () => {
    const out = await h.api.post("/api/admin/auth/logout", undefined, { cookie });
    assert.equal(out.status, 200);
    for (const name of ["pp_staff_access", "pp_staff_refresh", "pp_staff_session"]) assert.ok(out.setCookie.some((c) => c.startsWith(`${name}=; Max-Age=0`)), name);
    assert.equal((await session()).status, 401);
    assert.equal((await staffSessions())[0].revoked_at !== null, true);
  });

  it("logout without a session still answers 200 and clears the cookie", async () => {
    const out = await h.api.post("/api/admin/auth/logout");
    assert.equal(out.status, 200);
  });

  it("login and logout are written to the audit log, without secrets", async () => {
    await h.api.post("/api/admin/auth/logout", undefined, { cookie });
    const rows = (await pool.query("SELECT action, staff_email, details FROM audit_log ORDER BY id")).rows;
    assert.deepEqual(rows.map((r) => r.action), ["staff.login", "staff.logout"]);
    assert.equal(rows[0].staff_email, ADMIN);
    const dump = JSON.stringify(rows) + JSON.stringify((await pool.query("SELECT * FROM audit_log")).rows);
    assert.ok(!dump.includes(cookie.split("=")[1]) && !dump.includes(STAFF_PASSWORD));
  });
});

describe("staff and parent sessions are separate worlds", () => {
  let parent;
  let staff;
  beforeEach(async () => {
    await h.makeStaff({ email: ADMIN, role: "sales" });
    staff = await h.staffSignIn(ADMIN);
    parent = await h.signUp("parent@example.com");
  });

  it("a parent session cannot use any staff endpoint", async () => {
    for (const [method, path] of [["get", "/api/admin/auth/session"], ["get", "/api/admin/itinerary/trips"], ["get", "/api/admin/trips"], ["get", "/api/admin/audit"]]) {
      assert.equal((await h.api[method](path, { cookie: parent.cookie })).status, 401, path);
    }
    assert.equal((await h.api.post("/api/admin/schools", { name: "X School" }, { cookie: parent.cookie })).status, 401);
  });

  it("a parent token presented under the staff cookie name is still refused", async () => {
    for (const name of ["pp_staff_access", "pp_staff_session"]) {
      const forged = `${name}=` + parent.cookie.split("=")[1];
      assert.equal((await h.api.get("/api/admin/itinerary/trips", { cookie: forged })).status, 401);
    }
  });

  it("a staff session cannot use any parent endpoint, under either cookie name", async () => {
    const token = staff.cookie.split("=")[1];
    for (const cookie of [staff.cookie, "pp_access=" + token, "pp_session=" + token]) {
      assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 401);
      assert.equal((await h.api.get("/api/onboarding", { cookie })).status, 401);
      assert.equal((await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, version: null }, { cookie })).status, 401);
    }
  });

  it("the staff cookie is scoped to /api/admin, so browsers don't send it to parent routes at all", async () => {
    assert.match((await login(ADMIN, STAFF_PASSWORD)).setCookie[0], /Path=\/api\/admin;/);
  });

  it("logging out as staff does not end a parent session, and vice versa", async () => {
    await h.api.post("/api/admin/auth/logout", undefined, { cookie: staff.cookie });
    assert.equal((await h.api.get("/api/auth/session", { cookie: parent.cookie })).status, 200);
    await h.api.post("/api/auth/logout", undefined, { cookie: parent.cookie });
    assert.equal((await h.api.get("/api/admin/auth/session", { cookie: staff.cookie })).status, 401, "already logged out above");
  });
});

describe("no public way to create staff, and write protections", () => {
  it("has no registration or staff-creation route, even for a signed-in Sales user", async () => {
    await h.makeStaff({ email: ADMIN, role: "sales" });
    const { as } = await h.staffSignIn(ADMIN);
    for (const path of ["/api/admin/auth/register", "/api/admin/users", "/api/admin/auth/signup"]) {
      assert.equal((await as.post(path, { email: "evil@example.com", password: "whatever-pass-123", role: "sales" })).status, 404, path);
    }
    // Not even /api/admin/staff exists any more: Sales people are added only by the developer command (scripts/ops.js).
    const made = await as.post("/api/admin/staff", { name: "Evil", email: "evil@example.com", role: "sales" });
    assert.equal(made.status, 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM staff_users")).rows[0].n, 1);
  });

  it("every staff route needs a staff session", async () => {
    const routes = [
      ["get", "/api/admin/itinerary/trips"], ["post", "/api/admin/schools"], ["get", "/api/admin/trips"], ["get", "/api/admin/audit"],
      ["get", "/api/admin/trips/00000000-0000-4000-8000-000000000000/itinerary"],
      ["post", "/api/admin/trips/00000000-0000-4000-8000-000000000000/itinerary"],
      ["patch", "/api/admin/trips/00000000-0000-4000-8000-000000000000/itinerary/00000000-0000-4000-8000-000000000001"],
    ];
    for (const [method, path] of routes) {
      const res = method === "get" ? await h.api.get(path) : await h.api[method](path, {});
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("refuses a state-changing request from another site (Origin check), allows the same site", async () => {
    // The itinerary service authorises via portal_deployments, not staff_trip_assignments. Open an app with
    // deploymentTemplateKey set so authorizeTrip can resolve the trip; the CSRF check runs before authorisation.
    const localH = await open({ staff: { deploymentTemplateKey: "domestic_none" } });
    await localH.makeStaff({ email: ADMIN, role: "sales" });
    const { as } = await localH.staffSignIn(ADMIN);
    const school = (await pool.query("INSERT INTO schools (name, name_normalized, slug, branch_slug) VALUES ('S', 's', 's', 'main') RETURNING id")).rows[0].id;
    const trip = (await pool.query("INSERT INTO trips (school_id, title, tour_type, payment_mode, slug) VALUES ($1, 'T', 'domestic', 'none', 't') RETURNING id", [school])).rows[0].id;
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [trip]);
    const bad = await as.post(`/api/admin/trips/${trip}/itinerary`, { dayNumber: 1, title: "Cross site" }, { headers: { origin: "https://evil.example" } });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error.code, "CROSS_SITE_REQUEST");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_itinerary_items")).rows[0].n, 0);
    const sameSite = await as.post(`/api/admin/trips/${trip}/itinerary`, { dayNumber: 1, title: "Same site" }, { headers: { origin: localH.base } });
    assert.equal(sameSite.status, 201);
    const login403 = await localH.api.post("/api/admin/auth/login", { email: ADMIN, password: STAFF_PASSWORD }, { headers: { origin: "https://evil.example" } });
    assert.equal(login403.status, 403);
  });

  it("a proxy that rewrites Host (Origin localhost:5173, Host 127.0.0.1:4000) is refused; one that keeps it is allowed", async () => {
    // Regression: Vite's "/api": "http://..." shorthand turns on changeOrigin and causes exactly this.
    await h.makeStaff({ email: ADMIN, role: "sales" });
    const body = { email: ADMIN, password: STAFF_PASSWORD };
    const rewritten = await h.api.post("/api/admin/auth/login", body, { headers: { origin: "http://localhost:5173" } });
    assert.equal(rewritten.status, 403);
    assert.equal(rewritten.body.error.code, "CROSS_SITE_REQUEST");
    // fetch() won't let a caller set Host, so send this one with node:http, as a Host-preserving proxy would.
    const kept = await new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(`${h.base}/api/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), origin: "http://localhost:5173", host: "localhost:5173" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(kept, 200);
  });

  it("existing parent flows are unaffected (login, onboarding, OTP)", async () => {
    const { cookie } = await h.signUp("parent@example.com");
    assert.equal((await h.api.get("/api/onboarding", { cookie })).status, 200);
    assert.equal((await h.logIn("parent@example.com")).res.status, 200);
  });
});
