import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { safeDetails } from "../src/modules/staff/audit.js";
import { STAFF_PASSWORD, startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let sales;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin", name: "Alex Admin" });
  sales = await h.staffUser({ email: "sales@example.com", role: "sales", name: "Sam Sales" });
});
afterEach(() => h.close());
after(() => pool.end());

const school = async (as = admin.as, name = "Greenfield Public School") => (await as.post("/api/admin/schools", { name })).body.school;
const TRIP = { title: "Winter Trip", tourType: "domestic", destination: "Manali", paymentMode: "none" };
const trip = async (schoolId, over = {}, as = admin.as) => (await as.post(`/api/admin/schools/${schoolId}/trips`, { ...TRIP, ...over })).body.trip;
const audit = async () => (await pool.query("SELECT * FROM audit_log ORDER BY id")).rows;
const NIL = "00000000-0000-4000-8000-000000000000";

describe("schools", () => {
  it("creates and lists schools, with the staff member recorded", async () => {
    const res = await admin.as.post("/api/admin/schools", { name: "  Greenfield   Public School " });
    assert.equal(res.status, 201);
    assert.equal(res.body.school.name, "Greenfield Public School", "trimmed and whitespace-collapsed");
    assert.equal(res.body.school.status, "active");
    const list = await admin.as.get("/api/admin/schools");
    assert.deepEqual(list.body.schools.map((s) => s.name), ["Greenfield Public School"]);
    assert.deepEqual((await sales.as.get("/api/admin/schools")).body.schools, [], "a salesperson sees only schools they created");
    assert.equal(list.body.schools[0].tripCount, 0);
  });

  it("rejects a duplicate name regardless of case and spacing", async () => {
    await school();
    for (const name of ["greenfield public school", "GREENFIELD   PUBLIC SCHOOL", " Greenfield Public School "]) {
      const res = await admin.as.post("/api/admin/schools", { name });
      assert.equal(res.status, 409, name);
      assert.equal(res.body.error.code, "SCHOOL_EXISTS");
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schools")).rows[0].n, 1);
  });

  it("two simultaneous creations of the same name: one wins", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.as.post("/api/admin/schools", { name: "Race School" })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 4);
  });

  it("validates the name and refuses unknown fields", async () => {
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(151) }, { name: "Bad\u0000Name" }, { name: 5 }, { name: "Ok", status: "archived" }, { name: "Ok", id: NIL }]) {
      const res = await admin.as.post("/api/admin/schools", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schools")).rows[0].n, 0);
  });

  it("the database refuses invalid rows by itself", async () => {
    await assert.rejects(pool.query("INSERT INTO schools (slug, branch_slug, name, name_normalized) VALUES ('x', 'main', 'A', 'B')"), /schools_name_normalized_chk/);
    await assert.rejects(pool.query("INSERT INTO schools (slug, branch_slug, name, name_normalized, status) VALUES ('x', 'main', 'A', 'a', 'weird')"), /schools_status_chk/);
    await assert.rejects(pool.query("INSERT INTO schools (slug, branch_slug, name, name_normalized) VALUES ('x', 'main', '', '')"), /schools_name_chk/);
  });

  it("only an admin may rename or archive; sales gets 403, and nothing changes", async () => {
    const s = await school();
    assert.equal((await sales.as.patch(`/api/admin/schools/${s.id}`, { name: "Renamed" })).status, 403);
    assert.equal((await admin.as.patch(`/api/admin/schools/${s.id}`, { name: "Renamed School" })).body.school.name, "Renamed School");
    const archived = await admin.as.patch(`/api/admin/schools/${s.id}`, { status: "archived" });
    assert.equal(archived.body.school.status, "archived");
    assert.ok(archived.body.school.archivedAt);
    assert.deepEqual((await admin.as.get("/api/admin/schools")).body.schools, []);
    assert.equal((await admin.as.get("/api/admin/schools?includeArchived=true")).body.schools.length, 1);
    assert.equal((await admin.as.patch(`/api/admin/schools/${NIL}`, { name: "Nope" })).status, 404);
    assert.equal((await admin.as.patch(`/api/admin/schools/not-a-uuid`, { name: "Nope" })).status, 404);
  });

  it("renaming onto another school's name is refused", async () => {
    const a = await school(admin.as, "School A");
    await school(admin.as, "School B");
    assert.equal((await admin.as.patch(`/api/admin/schools/${a.id}`, { name: "school b" })).status, 409);
  });
});

describe("trips", () => {
  let s;
  beforeEach(async () => {
    s = await school();
  });

  it("creates a draft trip and derives the template from tour type + payment mode", async () => {
    const expected = {
      "domestic/none": "domestic_none", "domestic/payment": "domestic_payment",
      "international/none": "international_none", "international/payment": "international_payment",
    };
    for (const [combo, key] of Object.entries(expected)) {
      const [tourType, paymentMode] = combo.split("/");
      const t = await trip(s.id, { tourType, paymentMode, title: `T ${combo}` });
      assert.equal(t.status, "draft");
      assert.equal(t.templateKey, key);
      assert.equal(t.schoolName, "Greenfield Public School");
    }
    assert.equal((await admin.as.get(`/api/admin/trips?schoolId=${s.id}`)).body.trips.length, 4, "one school, many trips");
  });

  it("never accepts a status, template or school from the body", async () => {
    for (const extra of [{ status: "active" }, { templateKey: "domestic_none" }, { template_key: "x" }, { schoolId: NIL }, { createdBy: NIL }]) {
      const res = await admin.as.post(`/api/admin/schools/${s.id}/trips`, { ...TRIP, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
  });

  it("validates the fields", async () => {
    const bad = [
      { title: "" }, { title: "x".repeat(151) }, { tourType: "abroad" }, { tourType: undefined }, { paymentMode: "card" }, { paymentMode: undefined },
      { destination: "x".repeat(101) }, { destination: "Ba\u0007d" }, { opensAt: "tomorrow" }, { closesAt: 12 },
      { opensAt: "2030-02-01T00:00:00Z", closesAt: "2030-01-01T00:00:00Z" }, { opensAt: "2030-01-01T00:00:00Z", closesAt: "2030-01-01T00:00:00Z" },
    ];
    for (const over of bad) {
      const res = await admin.as.post(`/api/admin/schools/${s.id}/trips`, { ...TRIP, ...over });
      assert.equal(res.status, 400, JSON.stringify(over));
    }
    const ok = await admin.as.post(`/api/admin/schools/${s.id}/trips`, { title: "No dest", tourType: "international", paymentMode: "payment", opensAt: "2030-01-01T00:00:00Z", closesAt: "2030-02-01T00:00:00Z" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.trip.destination, null);
  });

  it("the database enforces the same rules and generates the template itself", async () => {
    const insert = (cols, vals) => pool.query(`INSERT INTO trips (slug, school_id, title, tour_type, payment_mode ${cols}) VALUES ('x', $1, 'T', $2, $3 ${vals})`, [s.id, "domestic", "none"]);
    await assert.rejects(pool.query("INSERT INTO trips (slug, school_id, title, tour_type, payment_mode) VALUES ('x', $1, 'T', 'abroad', 'none')", [s.id]), /trips_tour_type_chk/);
    await assert.rejects(pool.query("INSERT INTO trips (slug, school_id, title, tour_type, payment_mode) VALUES ('x', $1, 'T', 'domestic', 'card')", [s.id]), /trips_payment_mode_chk/);
    await assert.rejects(pool.query("INSERT INTO trips (slug, school_id, title, tour_type, payment_mode, status) VALUES ('x', $1, 'T', 'domestic', 'none', 'live')", [s.id]), /trips_status_chk/);
    await assert.rejects(pool.query("INSERT INTO trips (slug, school_id, title, tour_type, payment_mode, opens_at, closes_at) VALUES ('x', $1, 'T', 'domestic', 'none', now(), now() - interval '1 day')", [s.id]), /trips_window_chk/);
    await assert.rejects(insert(", template_key", ", 'anything'"), /cannot insert a non-DEFAULT value into column "template_key"/);
    await assert.rejects(pool.query("INSERT INTO trips (slug, school_id, title, tour_type, payment_mode) VALUES ('x', $1, '', 'domestic', 'none')", [s.id]), /trips_title_chk/);
  });

  it("a school with trips can't be deleted out from under them", async () => {
    await trip(s.id);
    await assert.rejects(pool.query("DELETE FROM schools WHERE id = $1", [s.id]), /foreign key|violates/);
  });

  it("unknown school or id: 404", async () => {
    assert.equal((await admin.as.post(`/api/admin/schools/${NIL}/trips`, TRIP)).status, 404);
    assert.equal((await admin.as.get(`/api/admin/trips/${NIL}`)).status, 404);
    assert.equal((await admin.as.get(`/api/admin/trips/xyz`)).status, 404);
    assert.equal((await admin.as.get(`/api/admin/trips?schoolId=xyz`)).status, 404);
  });

  it("an archived school takes no new trips", async () => {
    await admin.as.patch(`/api/admin/schools/${s.id}`, { status: "archived" });
    const res = await admin.as.post(`/api/admin/schools/${s.id}/trips`, TRIP);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SCHOOL_ARCHIVED");
  });

  it("edits fields; tour type and payment mode only while a draft", async () => {
    const t = await trip(s.id);
    const ok = await admin.as.patch(`/api/admin/trips/${t.id}`, { title: "Renamed", destination: null, paymentMode: "payment" });
    assert.equal(ok.body.trip.title, "Renamed");
    assert.equal(ok.body.trip.destination, null);
    assert.equal(ok.body.trip.templateKey, "domestic_payment");

    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    const locked = await admin.as.patch(`/api/admin/trips/${t.id}`, { tourType: "international" });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, "TRIP_LOCKED");
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, { tourType: "domestic", title: "Still fine" })).status, 200, "same value is not a change");
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, { templateKey: "x" })).status, 400);
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, {})).status, 400);
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, { opensAt: "2031-01-01T00:00:00Z", closesAt: "2030-01-01T00:00:00Z" })).status, 400);
  });

  it("status changes follow the rules, and the roles", async () => {
    const own = await school(sales.as, "Sales Own School"); // a salesperson works on the schools they created
    const t = await trip(own.id, {}, sales.as);
    const change = (as, status) => as.post(`/api/admin/trips/${t.id}/status`, { status });
    assert.equal((await change(sales.as, "closed")).status, 409, "a draft can't be closed");
    assert.equal((await change(sales.as, "bogus")).status, 400);
    assert.equal((await change(sales.as, "archived")).status, 403, "sales can't archive");
    assert.equal((await change(sales.as, "active")).body.trip.status, "active");
    assert.equal((await change(sales.as, "closed")).body.trip.status, "closed");
    assert.equal((await change(sales.as, "active")).status, 403, "sales can't reopen");
    assert.equal((await change(admin.as, "active")).body.trip.status, "active", "admin can reopen");
    assert.equal((await change(admin.as, "closed")).status, 200);
    assert.equal((await change(admin.as, "archived")).body.trip.status, "archived");
    for (const status of ["draft", "active", "closed"]) assert.equal((await change(admin.as, status)).status, 409, `archived -> ${status}`);
    assert.equal((await admin.as.patch(`/api/admin/trips/${t.id}`, { title: "x" })).status, 409, "archived is read-only");
  });

  it("activating a trip of an archived school is refused", async () => {
    const own = await school(sales.as, "Sales Own School");
    const t = await trip(own.id, {}, sales.as);
    await admin.as.patch(`/api/admin/schools/${own.id}`, { status: "archived" });
    assert.equal((await sales.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" })).status, 409);
  });
});

describe("public registration page (staff view)", () => {
  let t;
  beforeEach(async () => {
    const s = await school(sales.as); // owned by the salesperson, so both they and an admin may manage it
    t = await trip(s.id, {}, sales.as);
  });
  const setPublic = (enabled, as = admin.as, id = t.id) => as.post(`/api/admin/trips/${id}/public-registration`, { enabled });

  it("every trip carries its fixed address words, the public flag (off) and the token-free address", async () => {
    assert.equal(t.slug, "winter-trip");
    assert.equal(t.publicRegistration, false);
    assert.equal(t.publicPath, "/join/greenfield-public-school/main/winter-trip");
    assert.equal(t.publicUrl, "https://parents.example.test/join/greenfield-public-school/main/winter-trip");
    const listed = (await sales.as.get("/api/admin/trips")).body.trips[0];
    assert.equal(listed.publicPath, t.publicPath);
    assert.equal("activeLinkCount" in listed, false);
  });

  it("schools carry their fixed address words", async () => {
    const list = (await admin.as.get("/api/admin/schools")).body.schools;
    assert.deepEqual([list[0].slug, list[0].branchSlug], ["greenfield-public-school", "main"]);
  });

  it("trips created at the same moment with the same title still get distinct words", async () => {
    const s2 = await school(admin.as, "Parallel School");
    const made = await Promise.all(Array.from({ length: 5 }, () => trip(s2.id)));
    assert.deepEqual(made.map((x) => x.slug).sort(), ["winter-trip", "winter-trip-2", "winter-trip-3", "winter-trip-4", "winter-trip-5"]);
  });

  it("a title with no letters or digits still gets a valid word", async () => {
    const x = await trip(t.schoolId, { title: "!!!" });
    assert.equal(x.slug, "trip");
  });

  it("switching it on or off writes an audit entry naming the staff member, and never touches status or payment", async () => {
    await setPublic(true, sales.as);
    await setPublic(false);
    const rows = (await audit()).filter((a) => a.action.startsWith("trip.public"));
    assert.deepEqual(rows.map((r) => r.action), ["trip.public_on", "trip.public_off"]);
    const now = (await admin.as.get(`/api/admin/trips/${t.id}`)).body.trip;
    assert.deepEqual([now.status, now.paymentMode], ["draft", "none"]);
  });

  it("refuses archived and unknown trips", async () => {
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "archived" });
    const res = await setPublic(true);
    assert.equal(res.status, 409);
    assert.equal((await setPublic(true, admin.as, NIL)).status, 404);
  });
});

describe("audit trail", () => {
  it("records admin changes with who/what, and is admin-only", async () => {
    const s = await school(sales.as);
    const t = await trip(s.id, {}, sales.as);
    await sales.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await sales.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: false });

    assert.equal((await sales.as.get("/api/admin/audit")).status, 403);
    const res = await admin.as.get("/api/admin/audit");
    assert.equal(res.status, 200);
    const actions = res.body.entries.map((e) => e.action).reverse();
    assert.deepEqual(actions.slice(-5), ["school.create", "trip.create", "trip.status_change", "trip.public_on", "trip.public_off"]);
    const status = res.body.entries.find((e) => e.action === "trip.status_change");
    assert.equal(status.staffEmail, "sales@example.com");
    assert.deepEqual(status.details, { from: "draft", to: "active" });
    assert.equal(status.entityId, t.id);
  });

  it("holds no passwords or session tokens", async () => {
    const s = await school();
    const t = await trip(s.id);
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    const dump = JSON.stringify((await audit()));
    for (const secret of [STAFF_PASSWORD, admin.cookie.split("=")[1], sales.cookie.split("=")[1]]) assert.ok(!dump.includes(secret));
    assert.ok(!JSON.stringify((await admin.as.get("/api/admin/audit")).body).includes(STAFF_PASSWORD));
  });

  it("safeDetails drops secret-looking keys and non-plain values", () => {
    assert.deepEqual(
      safeDetails({ name: "x", token: "t", linkToken: "t", password: "p", sessionCookie: "c", tokenHash: "h", authorization: "a", nested: { a: 1 }, list: [1], n: 3, ok: true, none: null, undef: undefined }),
      { name: "x", n: 3, ok: true, none: null },
    );
    assert.equal(safeDetails({ long: "x".repeat(500) }).long.length, 200);
  });

  it("is append-only: the database refuses updates and deletes", async () => {
    await school();
    await assert.rejects(pool.query("UPDATE audit_log SET action = 'school.hack'"), /append-only/);
    await assert.rejects(pool.query("DELETE FROM audit_log"), /append-only/);
  });

  it("a failed change leaves no audit row (they commit together)", async () => {
    await school();
    await admin.as.post("/api/admin/schools", { name: "greenfield public school" }); // duplicate
    assert.equal((await audit()).filter((a) => a.action === "school.create").length, 1);
  });
});
