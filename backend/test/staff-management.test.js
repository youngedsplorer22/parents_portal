import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { STAFF_PASSWORD, startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
});
afterEach(() => h.close());
after(() => pool.end());

const NEW = { email: "Priya@Example.com", name: "Priya  Sharma" };
const create = (over = {}, who = admin) => who.as.post("/api/admin/staff", { ...NEW, ...over });
const list = (who = admin) => who.as.get("/api/admin/staff");
const patch = (id, body, who = admin) => who.as.patch(`/api/admin/staff/${id}`, body);
const row = async (email) => (await pool.query("SELECT * FROM staff_users WHERE email_normalized = $1", [email])).rows[0];
const count = async () => (await pool.query("SELECT count(*)::int AS n FROM staff_users")).rows[0].n;

describe("who may manage staff", () => {
  it("is for signed-in admins only: no session is 401, a parent session is 401, sales is 403", async () => {
    await h.makeStaff({ email: "sales@example.com", role: "sales", name: "Sam Sales" });
    const sales = await h.staffSignIn("sales@example.com");
    const parent = await h.signUp("parent@example.com");
    const target = (await create()).body.staff;
    for (const [name, call] of Object.entries({
      list: (o) => h.api.get("/api/admin/staff", o),
      create: (o) => h.api.post("/api/admin/staff", NEW, o),
      patch: (o) => h.api.patch(`/api/admin/staff/${target.id}`, { active: false }, o),
    })) {
      assert.equal((await call({})).status, 401, `${name} without a session`);
      assert.equal((await call({ cookie: parent.cookie })).status, 401, `${name} with a parent session`);
      const denied = await call({ cookie: sales.cookie });
      assert.equal(denied.status, 403, `${name} as sales`);
      assert.equal(denied.body.error.code, "FORBIDDEN");
    }
    assert.equal((await row("sales@example.com")).role, "sales");
    assert.equal((await row(target.email)).disabled_at, null, "sales could not deactivate anyone");
  });

  it("there is no public way to register as staff", async () => {
    for (const path of ["/api/staff", "/api/staff/register", "/api/admin/staff/register", "/api/admin/auth/register"]) {
      const res = await h.api.post(path, NEW);
      assert.ok([401, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal(await count(), 1);
  });

  it("a cross-site request is refused", async () => {
    const res = await h.api.post("/api/admin/staff", NEW, { cookie: admin.cookie, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CROSS_SITE_REQUEST");
  });
});

describe("adding a sales account (no password)", () => {
  it("creates a pending sales account with no password stored", async () => {
    const res = await create();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.staff).sort(), ["createdAt", "email", "id", "name", "role", "status"]);
    assert.equal(res.body.staff.email, "priya@example.com");
    assert.equal(res.body.staff.name, "Priya Sharma");
    assert.equal(res.body.staff.role, "sales");
    assert.equal(res.body.staff.status, "pending");
    assert.equal((await row("priya@example.com")).password_hash, null);
  });

  it("refuses any password field: nobody but the owner ever chooses the password", async () => {
    for (const extra of [{ password: "a-strong-pass-123" }, { confirmPassword: "x" }, { passwordHash: "scrypt$1$1$1$a$b" }, { password_hash: "x" }]) {
      assert.equal((await create(extra)).status, 400, JSON.stringify(Object.keys(extra)));
    }
    assert.equal(await count(), 1);
  });

  it("only sales can be created: another role, or any other field, is refused", async () => {
    for (const role of ["admin", "root", "Sales ", 1, null]) assert.equal((await create({ role })).status, 400, JSON.stringify(role));
    for (const extra of [{ disabled_at: null }, { id: "1" }, { active: false }, { status: "active" }]) {
      assert.equal((await create(extra)).status, 400, JSON.stringify(extra));
    }
    assert.equal((await create({ role: "sales" })).status, 201, "naming the supported role is fine");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM staff_users WHERE role = 'admin'")).rows[0].n, 1);
  });

  it("applies the usual input checks", async () => {
    for (const over of [{ email: "not-an-email" }, { email: undefined }, { name: "" }, { name: "x".repeat(101) }, { name: "Bad\u0007Name" }, { name: undefined }]) {
      assert.equal((await create(over)).status, 400, JSON.stringify(over));
    }
    assert.equal(await count(), 1);
  });

  it("an email that exists is refused, even in another letter case, and nothing is overwritten", async () => {
    await create();
    const before = await row("priya@example.com");
    for (const email of ["priya@example.com", "PRIYA@EXAMPLE.COM", "admin@example.com"]) {
      const res = await create({ email, name: "Someone Else" });
      assert.equal(res.status, 409, email);
      assert.equal(res.body.error.code, "STAFF_EXISTS");
    }
    assert.deepEqual(await row("priya@example.com"), before);
  });

  it("two simultaneous requests for one email create exactly one account", async () => {
    const results = await Promise.all([create(), create()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });

  it("a pending account cannot sign in, with the same answer as an unknown email", async () => {
    await create();
    const pending = await h.staffSignIn("priya@example.com", "a-strong-pass-123");
    const unknown = await h.staffSignIn("nobody@example.com", "a-strong-pass-123");
    assert.equal(pending.res.status, 401);
    assert.deepEqual(pending.res.body, unknown.res.body);
    assert.deepEqual(pending.res.setCookie, []);
  });
});

describe("viewing staff", () => {
  it("lists everyone with role and status (pending, active, inactive) and nothing sensitive", async () => {
    await create();
    await h.makeStaff({ email: "set@example.com", role: "sales", name: "Existing Account" });
    const off = await h.makeStaff({ email: "off@example.com", role: "sales", name: "Switched Off" });
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = $1", [off.email]);
    const res = await list();
    assert.equal(res.status, 200);
    const status = Object.fromEntries(res.body.staff.map((s) => [s.email, s.status]));
    assert.deepEqual(status, { "admin@example.com": "active", "off@example.com": "inactive", "priya@example.com": "pending", "set@example.com": "active" });
    const text = JSON.stringify(res.body).toLowerCase();
    for (const leak of ["password", "scrypt", "token", "hash", "disabled_at", "session"]) assert.ok(!text.includes(leak), leak);
  });
});

describe("activating and deactivating", () => {
  it("deactivating ends that person's session at once and blocks sign-in; reactivating allows it again", async () => {
    await h.makeStaff({ email: "priya@example.com", role: "sales", name: "Priya Sharma" });
    const id = (await row("priya@example.com")).id;
    const sales = await h.staffSignIn("priya@example.com", STAFF_PASSWORD);
    assert.equal((await sales.as.get("/api/admin/schools")).status, 200);

    const off = await patch(id, { active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.staff.status, "inactive");
    assert.equal((await sales.as.get("/api/admin/schools")).status, 401, "existing session stops working");
    assert.equal((await h.staffSignIn("priya@example.com", STAFF_PASSWORD)).res.status, 401);

    const on = await patch(id, { active: true });
    assert.equal(on.body.staff.status, "active");
    assert.equal((await h.staffSignIn("priya@example.com", STAFF_PASSWORD)).res.status, 200);
  });

  it("a pending account that is deactivated and reactivated is pending again, never active without a password", async () => {
    const id = (await create()).body.staff.id;
    assert.equal((await patch(id, { active: false })).body.staff.status, "inactive");
    assert.equal((await patch(id, { active: true })).body.staff.status, "pending");
    assert.equal((await row("priya@example.com")).password_hash, null);
  });

  it("admin accounts, including your own, cannot be changed here", async () => {
    const adminRow = await row("admin@example.com");
    const res = await patch(adminRow.id, { active: false });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "STAFF_PROTECTED");
    assert.equal((await row("admin@example.com")).disabled_at, null);
    assert.equal((await admin.as.get("/api/admin/schools")).status, 200, "still signed in");
  });

  it("an unknown or malformed id is a plain 404, and the body must be exactly {active: boolean}", async () => {
    const id = (await create()).body.staff.id;
    for (const bad of ["00000000-0000-4000-8000-000000000000", "abc", "1; DROP TABLE staff_users"]) {
      assert.equal((await patch(bad, { active: false })).status, 404, bad);
    }
    for (const body of [{}, { active: "no" }, { active: false, role: "admin" }, { role: "admin" }, { disabled_at: null }]) {
      assert.equal((await patch(id, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await row("priya@example.com")).role, "sales");
  });
});

describe("audit trail", () => {
  it("records create, deactivate and activate with who did it, and no secrets", async () => {
    const id = (await create()).body.staff.id;
    await patch(id, { active: false });
    await patch(id, { active: true });
    const { rows } = await pool.query("SELECT action, staff_email, entity_type, entity_id, details FROM audit_log WHERE action LIKE 'staff.%' AND action <> 'staff.login' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action), ["staff.create", "staff.deactivate", "staff.activate"]);
    assert.ok(rows.every((r) => r.staff_email === "admin@example.com" && r.entity_type === "staff" && r.entity_id === id));
    assert.deepEqual(rows[0].details, { email: "priya@example.com", role: "sales" });
  });

  it("a refused change leaves no audit row and no change behind", async () => {
    await create({ role: "admin" });
    await create({ password: "x" });
    const adminRow = await row("admin@example.com");
    await patch(adminRow.id, { active: false });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('staff.create','staff.deactivate','staff.activate')")).rows[0].n, 0);
  });
});

describe("individual work accounts", () => {
  it("accepts ordinary work-email shapes, stores them lower-case, and each owner sets their own password", async () => {
    const people = [
      { name: "First Person", email: "First.Person@Company.Example.com", password: "first-person-pass-1" },
      { name: "Second Person", email: "second+sales@sub.company.example", password: "second-person-pass-2" },
    ];
    for (const p of people) {
      const res = await create({ name: p.name, email: p.email });
      assert.equal(res.status, 201, p.email);
      assert.equal(res.body.staff.email, p.email.toLowerCase());
      assert.equal(res.body.staff.status, "pending");
    }
    for (const p of people) assert.equal((await h.staffSetPassword(p.email.toLowerCase(), p.password)).status, 200);
    for (const p of people) {
      const signedIn = await h.staffSignIn(p.email.toLowerCase(), p.password);
      assert.equal(signedIn.res.status, 200);
      assert.equal(signedIn.res.body.staff.name, p.name);
      assert.equal(signedIn.res.body.staff.role, "sales");
    }
    assert.equal((await h.staffSignIn("second+sales@sub.company.example", "first-person-pass-1")).res.status, 401, "one person's password does not open the other's account");
  });

  it("a created sales account can use the sales tools but nothing admin-only", async () => {
    await create();
    await h.staffSetPassword("priya@example.com", "a-strong-pass-123");
    const sales = await h.staffSignIn("priya@example.com", "a-strong-pass-123");
    assert.equal((await sales.as.get("/api/admin/schools")).status, 200);
    const school = (await sales.as.post("/api/admin/schools", { name: "Sales Made School" })).body.school;
    assert.ok(school.id);
    for (const [name, res] of Object.entries({
      "audit log": await sales.as.get("/api/admin/audit"),
      "rename school": await sales.as.patch(`/api/admin/schools/${school.id}`, { name: "Renamed" }),
      "list staff": await sales.as.get("/api/admin/staff"),
      "create staff": await sales.as.post("/api/admin/staff", NEW),
    })) {
      assert.equal(res.status, 403, name);
    }
  });
});

describe("the command-line tool and the admin panel share one table", () => {
  it("accounts made by the tool (with a password) and here (pending) all appear, and the tool's sign-in still works", async () => {
    await h.makeStaff({ email: "cli@example.com", role: "sales", name: "Cli User" });
    await create();
    assert.deepEqual((await list()).body.staff.map((s) => s.email).sort(), ["admin@example.com", "cli@example.com", "priya@example.com"]);
    assert.equal((await h.staffSignIn("cli@example.com", STAFF_PASSWORD)).res.status, 200);
  });
});
