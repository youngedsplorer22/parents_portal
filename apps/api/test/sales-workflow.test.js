import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
const SALES = "priya.sales@example.com";
const PW = "sales-own-password-1";

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
});
afterEach(() => h.close());
after(() => pool.end());

/** The real path a new salesperson takes: added by an admin (pending), sets a password by emailed code, signs in. */
async function newSalesperson(email = SALES) {
  const added = await admin.as.post("/api/admin/staff", { email, name: "Priya Sales" });
  assert.equal(added.status, 201);
  assert.equal(added.body.staff.status, "pending");
  assert.equal((await h.staffSignIn(email, PW)).res.status, 401, "a pending account cannot sign in");
  const set = await h.staffSetPassword(email, PW);
  assert.equal(set.status, 200);
  assert.equal(set.body.firstTime, true);
  const signedIn = await h.staffSignIn(email, PW);
  assert.equal(signedIn.res.status, 200);
  assert.equal(signedIn.res.body.staff.role, "sales");
  return signedIn;
}

describe("Staff workflow, end to end over HTTP (a new salesperson signs in; schools and trips are the admin's)", () => {
  it("a new salesperson sets up their password by email code, signs in, and the role comes from the database", async () => {
    const sales = await newSalesperson();
    const session = await sales.as.get("/api/admin/auth/session");
    assert.deepEqual(session.body.staff, { email: SALES, name: "Priya Sales", role: "sales" });
    // demoting/disabling in the database takes effect on the very next request
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = $1", [SALES]);
    assert.equal((await sales.as.get("/api/admin/itinerary/trips")).status, 401);
  });

  it("creates a school; a duplicate name (any letter case or spacing) is refused", async () => {
    const sales = admin; // creating schools and trips is the admin's
    const made = await sales.as.post("/api/admin/schools", { name: "Sunrise Academy" });
    assert.equal(made.status, 201);
    for (const name of ["Sunrise Academy", "sunrise academy", "  SUNRISE   ACADEMY "]) {
      const dup = await sales.as.post("/api/admin/schools", { name });
      assert.equal(dup.status, 409, name);
      assert.equal(dup.body.error.code, "SCHOOL_EXISTS");
    }
    const list = await sales.as.get("/api/admin/schools");
    assert.deepEqual(list.body.schools.map((s) => s.name), ["Sunrise Academy"]);
  });

  it("creates trips of all four kinds on the existing fields, and each gets the matching form template", async () => {
    const sales = admin; // creating schools and trips is the admin's
    const school = (await sales.as.post("/api/admin/schools", { name: "Sunrise Academy" })).body.school;
    const kinds = [["domestic", "payment"], ["domestic", "none"], ["international", "payment"], ["international", "none"]];
    for (const [tourType, paymentMode] of kinds) {
      const res = await sales.as.post(`/api/admin/schools/${school.id}/trips`, { title: `${tourType} ${paymentMode}`, tourType, paymentMode, academicYear: "2026-27" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.trip.templateKey, `${tourType}_${paymentMode}`);
      assert.equal(res.body.trip.status, "draft");
    }
    const { rows } = await pool.query("SELECT tour_type, payment_mode, template_key FROM trips ORDER BY created_at");
    assert.deepEqual(rows.map((r) => r.template_key), ["domestic_payment", "domestic_none", "international_payment", "international_none"]);
    for (const bad of [{ tourType: "local" }, { paymentMode: "paid" }, { paymentMode: undefined }, { title: "" }]) {
      const res = await sales.as.post(`/api/admin/schools/${school.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none", ...bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });

  it("an admin manages a trip: edit, activate, close, reopen, archive; a salesperson can do none of it (404)", async () => {
    const sales = await newSalesperson();
    const school = (await admin.as.post("/api/admin/schools", { name: "Sunrise Academy" })).body.school;
    const trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Shimla", tourType: "domestic", paymentMode: "none" })).body.trip;
    assert.equal((await admin.as.patch(`/api/admin/trips/${trip.id}`, { paymentMode: "payment" })).body.trip.templateKey, "domestic_payment", "kind can change while draft");
    assert.equal((await sales.as.patch(`/api/admin/trips/${trip.id}`, { paymentMode: "none" })).status, 404);
    assert.equal((await sales.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" })).status, 404);
    assert.equal((await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" })).status, 200);
    assert.equal((await admin.as.patch(`/api/admin/trips/${trip.id}`, { tourType: "international" })).status, 409, "kind is locked once active");
    assert.equal((await sales.as.post(`/api/admin/trips/${trip.id}/status`, { status: "closed" })).status, 404);
    assert.equal((await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "closed" })).status, 200);
    assert.equal((await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" })).status, 200);
    assert.equal((await pool.query("SELECT status FROM trips WHERE id = $1", [trip.id])).rows[0].status, "active");
  });

  it("switches a trip's public page on, and a parent registers from it; no token or link row is ever made", async () => {
    const sales = admin; // creating schools and trips is the admin's
    const school = (await sales.as.post("/api/admin/schools", { name: "Sunrise Academy" })).body.school;
    const trip = (await sales.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Shimla", tourType: "domestic", paymentMode: "none" })).body.trip;
    await sales.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
    const on = await sales.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.trip.publicPath, "/join/sunrise-academy/main/shimla");
    assert.equal(on.body.trip.publicRegistration, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_links")).rows[0].n, 0);

    const join = await h.api.get("/api/join/sunrise-academy/main/shimla");
    assert.deepEqual(join.body, { school: { name: "Sunrise Academy" }, trip: { title: "Shimla", destination: null, tourType: "domestic" }, registrationOpen: true });
    const verificationToken = await h.verifiedToken("parent@example.com", "registration");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("parent@example.com", { role: "Student" }), verificationToken, publicTrip: { school: "sunrise-academy", branch: "main", trip: "shimla" } });
    assert.equal(reg.status, 201);
    const { rows } = await pool.query("SELECT r.school, e.trip_id FROM parent_registrations r JOIN trip_enrolments e ON e.registration_id = r.id");
    assert.deepEqual(rows, [{ school: "Sunrise Academy", trip_id: trip.id }]);
  });

  it("a salesperson can't change a trip's public page, even one in a school they were told about", async () => {
    const sales = await newSalesperson();
    const school = (await admin.as.post("/api/admin/schools", { name: "Sunrise Academy" })).body.school;
    const trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Shimla", tourType: "domestic", paymentMode: "none" })).body.trip;
    await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
    assert.equal((await sales.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: false })).status, 404);
    assert.equal((await pool.query("SELECT public_registration FROM trips WHERE id = $1", [trip.id])).rows[0].public_registration, true);
  });

  it("never reaches staff administration, the audit log or school creation; an admin's actions are recorded under the admin's name", async () => {
    const sales = await newSalesperson();
    for (const [method, path] of [["get", "/api/admin/staff"], ["post", "/api/admin/staff"], ["get", "/api/admin/audit"]]) {
      const res = method === "get" ? await sales.as.get(path) : await sales.as.post(path, { email: "x@example.com", name: "X" });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal((await sales.as.post("/api/admin/schools", { name: "Sunrise Academy" })).status, 404);
    await admin.as.post("/api/admin/schools", { name: "Sunrise Academy" });
    const { rows } = await pool.query("SELECT staff_email, action FROM audit_log WHERE action = 'school.create'");
    assert.deepEqual(rows, [{ staff_email: "admin@example.com", action: "school.create" }]);
  });
});
