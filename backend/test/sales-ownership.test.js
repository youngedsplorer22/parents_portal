import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let alice; // sales
let bob; // sales
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  alice = await h.staffUser({ email: "alice@example.com", role: "sales" });
  bob = await h.staffUser({ email: "bob@example.com", role: "sales" });
});
afterEach(() => h.close());
after(() => pool.end());

const school = async (as, name) => (await as.post("/api/admin/schools", { name })).body.school;
const trip = async (as, schoolId, title = "Winter Trip") => as.post(`/api/admin/schools/${schoolId}/trips`, { title, tourType: "domestic", paymentMode: "none" });

describe("a salesperson manages only the schools they created, and those schools' trips", () => {
  it("lists only their own schools; an admin sees every school", async () => {
    await school(alice.as, "Alice School");
    await school(bob.as, "Bob School");
    await school(admin.as, "Admin School");
    const names = async (as) => (await as.get("/api/admin/schools")).body.schools.map((s) => s.name).sort();
    assert.deepEqual(await names(alice.as), ["Alice School"]);
    assert.deepEqual(await names(bob.as), ["Bob School"]);
    assert.deepEqual(await names(admin.as), ["Admin School", "Alice School", "Bob School"]);
  });

  it("creates trips only under their own schools; another's school is 'not found' and nothing is created", async () => {
    const mine = await school(alice.as, "Alice School");
    const theirs = await school(bob.as, "Bob School");
    assert.equal((await trip(alice.as, mine.id)).status, 201);
    const res = await trip(alice.as, theirs.id);
    assert.equal(res.status, 404);
    assert.equal((await pool.query("SELECT count(*)::int n FROM trips WHERE school_id = $1", [theirs.id])).rows[0].n, 0);
  });

  it("lists only trips of their own schools, including trips an admin created there; a tampered schoolId shows nothing", async () => {
    const mine = await school(alice.as, "Alice School");
    const theirs = await school(bob.as, "Bob School");
    await trip(alice.as, mine.id, "Alice Trip");
    await trip(admin.as, mine.id, "Admin Trip On Alice School");
    await trip(bob.as, theirs.id, "Bob Trip");
    const titles = async (as, q = "") => (await as.get(`/api/admin/trips${q}`)).body.trips.map((t) => t.title).sort();
    assert.deepEqual(await titles(alice.as), ["Admin Trip On Alice School", "Alice Trip"]);
    assert.deepEqual(await titles(alice.as, `?schoolId=${theirs.id}`), []);
    assert.deepEqual(await titles(admin.as), ["Admin Trip On Alice School", "Alice Trip", "Bob Trip"]);
  });

  it("can't read, edit, change the status of, or publish another salesperson's trip (404, nothing changes)", async () => {
    const theirs = await school(bob.as, "Bob School");
    const t = (await trip(bob.as, theirs.id)).body.trip;
    assert.equal((await alice.as.get(`/api/admin/trips/${t.id}`)).status, 404);
    assert.equal((await alice.as.patch(`/api/admin/trips/${t.id}`, { title: "Hijacked" })).status, 404);
    assert.equal((await alice.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" })).status, 404);
    assert.equal((await alice.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true })).status, 404);
    const row = (await pool.query("SELECT title, status, public_registration FROM trips WHERE id = $1", [t.id])).rows[0];
    assert.deepEqual(row, { title: "Winter Trip", status: "draft", public_registration: false });
  });

  it("the owner and an admin can still do all of it", async () => {
    const mine = await school(alice.as, "Alice School");
    const t = (await trip(alice.as, mine.id)).body.trip;
    assert.equal((await alice.as.get(`/api/admin/trips/${t.id}`)).status, 200);
    assert.equal((await alice.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" })).status, 200);
    assert.equal((await alice.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true })).status, 200);
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, { title: "Renamed by admin" })).status, 200);
    assert.equal((await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "closed" })).status, 200);
  });
});

describe("cross-role access attempts", () => {
  it("sales gets 403 on every admin-only API, whatever the path id", async () => {
    const s = await school(admin.as, "Admin School");
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [m, path, body] of [
      ["get", "/api/admin/staff"], ["post", "/api/admin/staff", { name: "X", email: "x@example.com" }], ["patch", `/api/admin/staff/${id}`, { active: false }],
      ["get", "/api/admin/audit"], ["patch", `/api/admin/schools/${s.id}`, { name: "Renamed" }], ["del", `/api/admin/schools/${s.id}/logo`],
    ]) {
      const res = m === "get" || m === "del" ? await alice.as[m](path) : await alice.as[m](path, body);
      assert.equal(res.status, 403, `${m} ${path}`);
    }
    assert.equal((await pool.query("SELECT name FROM schools WHERE id = $1", [s.id])).rows[0].name, "Admin School");
  });

  it("a parent session has no staff access at all (401), and a staff session has no parent access (401)", async () => {
    const parent = await h.signUp("parent@example.com");
    assert.equal((await h.api.get("/api/admin/schools", { cookie: parent.cookie })).status, 401);
    assert.equal((await h.api.post("/api/admin/schools", { name: "X" }, { cookie: parent.cookie })).status, 401);
    assert.equal((await h.api.get("/api/onboarding", { cookie: alice.cookie })).status, 401);
    assert.equal((await h.api.get("/api/enrolments/resume", { cookie: admin.cookie })).status, 401);
  });

  it("the audit log still records changes (its admin API is kept, only the panel page is gone)", async () => {
    await school(alice.as, "Alice School");
    const res = await admin.as.get("/api/admin/audit");
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.some((e) => e.action === "school.create" && e.staffEmail === "alice@example.com"));
  });
});
