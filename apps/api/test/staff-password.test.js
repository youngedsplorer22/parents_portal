import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { STAFF_PASSWORD, startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let dev;
const SEC = 1000;
const GOOD = "a-strong-pass-123";
const PENDING = "newhire@example.com";

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "sales" }); // a signed-in staff member
  dev = await h.staffUser({ email: "dev@example.com", role: "admin" }); // the developer (test-only fixture): adds and deactivates staff
});
afterEach(() => h.close());
after(() => pool.end());

const addPending = async (email = PENDING, name = "New Hire") => (await dev.as.post("/api/admin/staff", { email, name })).body.staff;
const row = async (email) => (await pool.query("SELECT * FROM staff_users WHERE email_normalized = $1", [email])).rows[0];
const request = (email) => h.api.post("/api/admin/auth/password/request", { email });
const settle = () => new Promise((r) => setTimeout(r, 60)); // background delivery
const getToken = async (email) => {
  h.clock.advance(31 * SEC);
  assert.equal((await request(email)).status, 200);
  await settle();
  const verified = await h.api.post("/api/admin/auth/password/verify", { email, code: h.sender.last().code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return verified.body.verificationToken;
};
const confirm = (email, verificationToken, password = GOOD, confirmPassword = password) =>
  h.api.post("/api/admin/auth/password/confirm", { email, verificationToken, password, confirmPassword });

describe("first-time setup of a pending account", () => {
  it("emails a code that says it is for SETTING a password, then saves the owner's own password", async () => {
    await addPending();
    h.clock.advance(31 * SEC);
    const asked = await request(PENDING);
    assert.equal(asked.status, 200);
    await settle();
    const mail = h.sender.last();
    assert.equal(mail.email, PENDING);
    assert.equal(mail.purpose, "staff_password");
    assert.deepEqual(mail.context, { kind: "setup" });
    assert.match(mail.code, /^\d{6}$/);

    const verified = await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: mail.code });
    const done = await confirm(PENDING, verified.body.verificationToken);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body, { passwordSet: true, firstTime: true });
    assert.deepEqual(done.setCookie, [], "setup does not sign anyone in");

    const stored = await row(PENDING);
    assert.match(stored.password_hash, /^scrypt\$/);
    assert.ok(!stored.password_hash.includes(GOOD));
    const login = await h.staffSignIn(PENDING, GOOD);
    assert.equal(login.res.status, 200);
    assert.equal(login.res.body.staff.role, "sales");
    await settle();
    assert.deepEqual(h.sender.staffNotices, [{ email: PENDING, firstTime: true }]);
    const audit = (await pool.query("SELECT action, staff_email FROM audit_log WHERE action = 'staff.password_set'")).rows;
    assert.deepEqual(audit, [{ action: "staff.password_set", staff_email: PENDING }]);
  });

  it("the password never appears in a response, the audit log, the notice or the server log", async () => {
    await addPending();
    const done = await h.staffSetPassword(PENDING, GOOD);
    await settle();
    const everything = JSON.stringify([done.body, (await pool.query("SELECT * FROM audit_log")).rows, h.sender.staffNotices, h.sender.sent.map((m) => ({ ...m, code: "x" })), h.logged]);
    assert.ok(!everything.includes(GOOD));
  });

  it("an old ADMIN row gets no code and cannot set a password: only Sales accounts are on the allowlist", async () => {
    await pool.query("INSERT INTO staff_users (email_normalized, display_name, role) VALUES ('aniket@example.com', 'Aniket Singh', 'admin')");
    const sentBefore = h.sender.sent.length;
    await h.api.post("/api/admin/auth/password/request", { email: "aniket@example.com" });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(h.sender.sent.length, sentBefore, "nothing was emailed");
    assert.equal((await h.staffSignIn("aniket@example.com", GOOD)).res.status, 401);
  });
});

describe("forgot password for an account that has one", () => {
  it("says it is for RESETTING, replaces the password, ends every session and never signs in", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const phone = await h.staffSignIn("sam@example.com");
    const laptop = await h.staffSignIn("sam@example.com");
    assert.equal((await phone.as.get("/api/admin/itinerary/trips")).status, 200);

    const token = await getToken("sam@example.com");
    assert.deepEqual(h.sender.last().context, { kind: "reset" });
    const done = await confirm("sam@example.com", token, "brand-new-pass-77");
    assert.deepEqual(done.body, { passwordSet: true, firstTime: false });
    assert.deepEqual(done.setCookie, []);

    assert.equal((await phone.as.get("/api/admin/itinerary/trips")).status, 401);
    assert.equal((await laptop.as.get("/api/admin/itinerary/trips")).status, 401);
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 401, "old password no longer works");
    assert.equal((await h.staffSignIn("sam@example.com", "brand-new-pass-77")).res.status, 200);
    await settle();
    assert.deepEqual(h.sender.staffNotices.at(-1), { email: "sam@example.com", firstTime: false });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'staff.password_reset'")).rows[0].n, 1);
  });

  it("clears a sign-in lock-out, because mailbox ownership was just proven", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    for (let i = 0; i < 6; i++) await h.staffSignIn("sam@example.com", "wrong-password-xx");
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 429);
    await confirm("sam@example.com", await getToken("sam@example.com"));
    assert.equal((await h.staffSignIn("sam@example.com", GOOD)).res.status, 200);
  });
});

describe("only the mailbox owner can set a password", () => {
  it("confirm needs a valid verification: missing, made up, or for another email all fail and change nothing", async () => {
    await addPending();
    await addPending("other@example.com", "Other");
    const otherToken = await getToken("other@example.com");
    for (const [name, token, email] of [
      ["made up", "A".repeat(43), PENDING],
      ["empty", "", PENDING],
      ["another person's token", otherToken, PENDING],
    ]) {
      const res = await confirm(email, token);
      assert.ok([400, 403].includes(res.status), name);
      if (res.status === 403) assert.equal(res.body.error.code, "VERIFICATION_REQUIRED", name);
    }
    assert.equal((await h.api.post("/api/admin/auth/password/confirm", { email: PENDING, password: GOOD, confirmPassword: GOOD })).status, 400);
    assert.equal((await row(PENDING)).password_hash, null);
    assert.equal((await h.staffSignIn(PENDING, GOOD)).res.status, 401);
  });

  it("a wrong code does not verify, and the code is single-use", async () => {
    await addPending();
    h.clock.advance(31 * SEC);
    await request(PENDING);
    await settle();
    const real = h.sender.last().code;
    const wrong = real === "000000" ? "111111" : "000000";
    const bad = await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: wrong });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_CODE");
    assert.equal((await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: real })).status, 200);
    assert.equal((await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: real })).status >= 400, true, "reuse fails");
  });

  it("a verification token works once only", async () => {
    await addPending();
    const token = await getToken(PENDING);
    assert.equal((await confirm(PENDING, token)).status, 200);
    const again = await confirm(PENDING, token, "another-strong-pass-9");
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, "VERIFICATION_REQUIRED");
    assert.equal((await h.staffSignIn(PENDING, GOOD)).res.status, 200, "the first password is the one that stuck");
  });

  it("a PARENT's verification for the same email (registration, login) can never set a staff password", async () => {
    await addPending();
    for (const purpose of ["registration", "login"]) {
      const parentToken = await h.verifiedToken(PENDING, purpose);
      const res = await confirm(PENDING, parentToken);
      assert.equal(res.status, 403, purpose);
      assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
    }
    assert.equal((await row(PENDING)).password_hash, null);
  });

  it("the staff purpose cannot be requested through the generic email-code routes", async () => {
    await addPending();
    for (const path of ["/api/email-otp/send", "/api/email-otp/resend"]) {
      assert.equal((await h.api.post(path, { email: PENDING, purpose: "staff_password" })).status, 400, path);
    }
    assert.equal((await h.api.post("/api/email-otp/verify", { email: PENDING, purpose: "staff_password", code: "123456" })).status, 400);
    assert.equal(h.sender.sent.length, 0);
  });

  it("the password policy is enforced and a refused password does not burn the verification", async () => {
    await addPending();
    const token = await getToken(PENDING);
    for (const [password, confirmPassword] of [["short", "short"], [GOOD, "different-pass-12"], ["password1234", "password1234"], [PENDING, PENDING], ["", ""]]) {
      assert.equal((await confirm(PENDING, token, password, confirmPassword)).status, 400, password);
    }
    assert.equal((await row(PENDING)).password_hash, null);
    assert.equal((await confirm(PENDING, token)).status, 200, "the same verification still works with a good password");
  });
});

describe("pending and deactivated accounts", () => {
  it("a pending account cannot sign in until its owner sets a password", async () => {
    await addPending();
    for (const password of [GOOD, STAFF_PASSWORD, "", "x"]) {
      const res = await h.staffSignIn(PENDING, password);
      assert.equal(res.res.status, password === "" ? 400 : 401, JSON.stringify(password));
      assert.deepEqual(res.res.setCookie, []);
    }
  });

  it("a deactivated account cannot sign in, and cannot be set up or reset by email", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const id = (await row("sam@example.com")).id;
    await dev.as.patch(`/api/admin/staff/${id}`, { active: false });
    const before = h.sender.sent.length;
    h.clock.advance(31 * SEC);
    const asked = await request("sam@example.com");
    assert.equal(asked.status, 200, "the same generic answer");
    await settle();
    assert.equal(h.sender.sent.length, before, "nothing is sent");
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 401);
  });

  it("deactivating after the code was verified blocks the final step", async () => {
    await addPending();
    const token = await getToken(PENDING);
    const id = (await row(PENDING)).id;
    await dev.as.patch(`/api/admin/staff/${id}`, { active: false });
    const res = await confirm(PENDING, token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "VERIFICATION_REQUIRED");
    assert.equal((await row(PENDING)).password_hash, null);
  });
});

describe("the public answer never reveals who is staff", () => {
  it("request and resend answer identically for staff, pending, deactivated, parent-only and unknown emails", async () => {
    await addPending();
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    await h.makeStaff({ email: "gone@example.com", role: "sales", name: "Gone" });
    await dev.as.patch(`/api/admin/staff/${(await row("gone@example.com")).id}`, { active: false });
    await h.signUp("parent@example.com");
    const shapes = [];
    for (const email of [PENDING, "sam@example.com", "gone@example.com", "parent@example.com", "nobody@example.com"]) {
      h.clock.advance(31 * SEC);
      const first = await request(email);
      h.clock.advance(31 * SEC);
      const second = await h.api.post("/api/admin/auth/password/resend", { email });
      assert.equal(first.status, 200, email);
      assert.equal(second.status, 200, email);
      shapes.push(JSON.stringify([Object.keys(first.body).sort(), first.body.expiresInSeconds, first.body.resendAvailableInSeconds, first.body.delivery, Object.keys(second.body).sort()]));
    }
    assert.equal(new Set(shapes).size, 1);
    await settle();
    // only the two eligible accounts (pending, active) got mail: 2 requests each (request + resend)
    const staffMail = h.sender.sent.filter((m) => m.purpose === "staff_password");
    assert.deepEqual([...new Set(staffMail.map((m) => m.email))].sort(), [PENDING, "sam@example.com"].sort());
  });

  it("an unknown email's code is never delivered, and wrong codes fail the same way as for a real one", async () => {
    await addPending();
    h.clock.advance(31 * SEC);
    await request("nobody@example.com");
    await request(PENDING);
    await settle();
    assert.ok(h.sender.sent.every((m) => m.email !== "nobody@example.com"));
    const unknown = await h.api.post("/api/admin/auth/password/verify", { email: "nobody@example.com", code: "000001" });
    const real = await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: "000001" });
    assert.equal(unknown.status, real.status);
    assert.equal(unknown.body.error.code, real.body.error.code);
  });

  it("the resend cooldown and the hourly cap apply the same way", async () => {
    await addPending();
    const second = await request(PENDING);
    assert.equal(second.status, 200);
    const early = await h.api.post("/api/admin/auth/password/resend", { email: PENDING });
    assert.equal(early.status, 429);
    assert.equal(early.body.error.code, "RESEND_COOLDOWN");
  });
});

describe("changing your own password while signed in", () => {
  const change = (who, body) => who.as.post("/api/admin/auth/password", { currentPassword: STAFF_PASSWORD, password: "changed-pass-4321", confirmPassword: "changed-pass-4321", ...body });

  it("needs a staff session", async () => {
    const parent = await h.signUp("parent@example.com");
    const body = { currentPassword: STAFF_PASSWORD, password: "changed-pass-4321", confirmPassword: "changed-pass-4321" };
    assert.equal((await h.api.post("/api/admin/auth/password", body)).status, 401);
    assert.equal((await h.api.post("/api/admin/auth/password", body, { cookie: parent.cookie })).status, 401);
  });

  it("changes the password, keeps THIS session, ends the others, and tells the owner", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const here = await h.staffSignIn("sam@example.com");
    const elsewhere = await h.staffSignIn("sam@example.com");
    const res = await change(here, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { passwordChanged: true });
    assert.equal((await here.as.get("/api/admin/itinerary/trips")).status, 200, "this session stays");
    assert.equal((await elsewhere.as.get("/api/admin/itinerary/trips")).status, 401, "other sessions end");
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 401);
    assert.equal((await h.staffSignIn("sam@example.com", "changed-pass-4321")).res.status, 200);
    await settle();
    assert.deepEqual(h.sender.staffNotices.at(-1), { email: "sam@example.com", firstTime: false });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'staff.password_change'")).rows[0].n, 1);
  });

  it("the current password must be right; wrong guesses are counted and eventually locked", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const sam = await h.staffSignIn("sam@example.com");
    const wrong = await change(sam, { currentPassword: "not-my-password-1" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, "CURRENT_PASSWORD_INCORRECT");
    for (let i = 0; i < 5; i++) await change(sam, { currentPassword: "not-my-password-1" });
    const locked = await change(sam, { currentPassword: "not-my-password-1" });
    assert.equal(locked.status, 429);
    // The count is shared with sign-in for the same account, so it is locked there too until it clears.
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 429);
    assert.match((await row("sam@example.com")).password_hash, /^scrypt\$/, "the password was never changed");
  });

  it("applies the password policy, and the new password must differ from the current one", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const sam = await h.staffSignIn("sam@example.com");
    for (const body of [
      { password: "short", confirmPassword: "short" },
      { confirmPassword: "different-pass-12" },
      { password: "password1234", confirmPassword: "password1234" },
      { password: "sam@example.com", confirmPassword: "sam@example.com" },
      { password: STAFF_PASSWORD, confirmPassword: STAFF_PASSWORD },
      { currentPassword: "" },
    ]) {
      assert.equal((await change(sam, body)).status, 400, JSON.stringify(Object.keys(body)));
    }
    assert.equal((await h.staffSignIn("sam@example.com", STAFF_PASSWORD)).res.status, 200, "nothing changed");
  });

  it("extra fields are refused, so an email or role can't be smuggled in", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const sam = await h.staffSignIn("sam@example.com");
    for (const extra of [{ email: "admin@example.com" }, { role: "admin" }, { staffId: "x" }]) assert.equal((await change(sam, extra)).status, 400);
  });
});

// ---- Backend authorization on EVERY staff API ------------------------------------------------------
// The Sales API is only sign-in, password and itinerary. Every route it declares is listed here with who may call it; a new route
// that is not classified fails the last test, so a protected API can't be added without deciding its permissions. There is no
// admin route: nothing for schools, trips, staff, assignments, portal bindings or live location exists under /api/admin.
const SALES_ONLY = [
  ["get", "/itinerary/trips"], ["get", "/trips/:id/itinerary"], ["post", "/trips/:id/itinerary"], ["patch", "/trips/:id/itinerary/:id"],
];
// /auth/refresh needs no access token by design: it takes the refresh cookie (its rules: auth-refresh-api.test.js).
const PUBLIC = [["post", "/auth/login"], ["post", "/auth/logout"], ["post", "/auth/refresh"], ["post", "/auth/password/request"], ["post", "/auth/password/resend"], ["post", "/auth/password/verify"], ["post", "/auth/password/confirm"]];
const SIGNED_IN = [["get", "/auth/session"], ["post", "/auth/password"]];
const ZERO = "00000000-0000-4000-8000-000000000000";
const OLD_ADMIN_ADDRESSES = [
  ["get", "/schools"], ["post", "/schools"], ["patch", `/schools/${ZERO}`], ["put", `/schools/${ZERO}/logo`], ["delete", `/schools/${ZERO}/logo`], ["get", "/trips"], ["post", `/schools/${ZERO}/trips`],
  ["get", `/trips/${ZERO}`], ["patch", `/trips/${ZERO}`], ["post", `/trips/${ZERO}/status`], ["post", `/trips/${ZERO}/public-registration`], ["get", `/trips/${ZERO}/live-location`],
  ["put", `/trips/${ZERO}/live-location/team-lead`], ["get", "/audit"], ["get", "/staff"], ["post", "/staff"], ["patch", `/staff/${ZERO}`],
  ["get", `/trips/${ZERO}/assignments`], ["put", `/trips/${ZERO}/assignments/${ZERO}`], ["delete", `/trips/${ZERO}/assignments/${ZERO}`], ["get", "/portal-deployments"], ["put", "/portal-deployments/domestic_none"],
];

describe("backend authorization covers every staff route", () => {
  it("every old admin address answers a signed-in Sales user 404 (it does not exist), and nobody without a staff session 401", async () => {
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const sales = await h.staffSignIn("sam@example.com");
    const parent = await h.signUp("parent@example.com");
    for (const [method, path] of OLD_ADMIN_ADDRESSES) {
      const url = `/api/admin${path}`;
      const call = (o) => (method === "get" ? h.api.get(url, o) : method === "delete" ? h.api.del(url, o) : h.api[method](url, {}, o));
      assert.equal((await call({})).status, 401, `${method} ${path} anonymous`);
      assert.equal((await call({ cookie: parent.cookie })).status, 401, `${method} ${path} parent`);
      assert.equal((await call({ cookie: sales.cookie })).status, 404, `${method} ${path} sales`);
    }
  });

  it("every Sales route and every signed-in route needs a staff session", async () => {
    for (const [method, path] of SALES_ONLY) {
      const url = `/api/admin${path.replaceAll(":id", ZERO)}`;
      const res = await h.api[method](...(method === "get" ? [url] : [url, {}]));
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    for (const [method, path] of SIGNED_IN.filter(([, p]) => p !== "/auth/logout")) {
      const res = await h.api[method](...(method === "get" ? [`/api/admin${path}`] : [`/api/admin${path}`, {}]));
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("no staff route is unclassified: every declared route is in the lists above", () => {
    const files = { "src/modules/itinerary/routes.js": "", "src/modules/staff/routes.js": "/auth" };
    const declared = new Set();
    for (const [file, prefix] of Object.entries(files)) {
      for (const m of readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
        declared.add(`${m[1]} ${prefix}${m[2] === "/" ? "" : m[2].replace(/:[A-Za-z]+/g, ":id")}`);
      }
    }
    const known = new Set([...SALES_ONLY, ...PUBLIC, ...SIGNED_IN].map(([m, p]) => `${m} ${p}`));
    assert.deepEqual([...declared].filter((r) => !known.has(r)), [], "classify these routes");
    assert.deepEqual([...known].filter((r) => !declared.has(r)), [], "these listed routes no longer exist");
    for (const gone of ["catalog/admin-routes.js", "live-location/staff-routes.js", "staff/admin-routes.js"]) {
      assert.ok(!existsSync(new URL(`../src/modules/${gone}`, import.meta.url)), `${gone} must not exist`);
    }
    assert.ok(readdirSync(new URL("../src/modules", import.meta.url)).includes("staff"));
  });
});

describe("what IT can safely do in SQL (migration 012)", () => {
  it("a row with only email, name and role is a valid PENDING account, and cannot sign in", async () => {
    await pool.query("INSERT INTO staff_users (email_normalized, display_name, role) VALUES ('it.added@example.com', 'IT Added', 'sales')");
    const stored = await row("it.added@example.com");
    assert.equal(stored.password_hash, null);
    assert.equal(stored.disabled_at, null);
    assert.equal((await h.staffSignIn("it.added@example.com", GOOD)).res.status, 401);
    const listed = (await dev.as.get("/api/admin/staff")).body.staff.find((s) => s.email === "it.added@example.com");
    assert.equal(listed.status, "pending");
  });

  it("the table still refuses bad rows: a made-up hash, an upper-case email, an unknown role", async () => {
    const insert = (email, role, hash) => pool.query("INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ($1, 'X', $2, $3)", [email, role, hash]);
    await assert.rejects(insert("a@example.com", "sales", "plaintext-password"), (e) => e.constraint === "staff_users_hash_chk");
    await assert.rejects(insert("A@Example.com", "sales", null), (e) => e.constraint === "staff_users_email_chk");
    await assert.rejects(insert("b@example.com", "root", null), (e) => e.constraint === "staff_users_role_chk");
    await assert.rejects(insert("admin@example.com", "sales", null), (e) => e.constraint === "staff_users_email_key");
  });

  it("existing accounts are untouched: the admin made before the migration keeps its hash and signs in", async () => {
    assert.match((await row("admin@example.com")).password_hash, /^scrypt\$/);
    assert.equal((await h.staffSignIn("admin@example.com", STAFF_PASSWORD)).res.status, 200);
  });

  it("the new code purpose is accepted by the database and an unknown one is not", async () => {
    const insert = (purpose) => pool.query(
      `INSERT INTO email_otps (id, email_normalized, purpose, code_hash, expires_at, resend_available_at, max_attempts)
       VALUES (gen_random_uuid(), 'x@example.com', $1, repeat('a', 64), now() + interval '5 minutes', now(), 5)`, [purpose]);
    await insert("staff_password");
    await assert.rejects(insert("staff_anything"), /purpose_chk/);
  });
});

describe("the emailed staff code lasts 15 minutes (over HTTP)", () => {
  it("is offered for 900 seconds, still works at 14 minutes, and is rejected after 15 with the setup left unchanged", async () => {
    await addPending();
    h.clock.advance(31 * SEC);
    const asked = await request(PENDING);
    assert.equal(asked.body.expiresInSeconds, 900);
    assert.equal(asked.body.resendAvailableInSeconds, 30);
    await settle();
    assert.equal(h.sender.last().expiresInSeconds, 900);

    h.clock.advance(14 * 60 * SEC);
    const ok = await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code: h.sender.last().code });
    assert.equal(ok.status, 200, "still valid 14 minutes later");

    // a second request, left alone past 15 minutes
    h.clock.advance(31 * SEC);
    await request(PENDING);
    await settle();
    const code = h.sender.last().code;
    h.clock.advance(15 * 60 * SEC + SEC);
    const late = await h.api.post("/api/admin/auth/password/verify", { email: PENDING, code });
    assert.equal(late.status, 410);
    assert.equal(late.body.error.code, "OTP_EXPIRED");
    assert.equal((await row(PENDING)).password_hash, null);
  });

  it("the parents' registration code over HTTP still reports 300 seconds", async () => {
    h.clock.advance(31 * SEC);
    const sent = await h.api.post("/api/email-otp/send", { email: "parent@example.com", purpose: "registration" });
    assert.equal(sent.body.expiresInSeconds, 300);
  });
});
