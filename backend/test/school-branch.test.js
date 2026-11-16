import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables } from "./helpers.js";

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

const create = (body, who = admin) => who.as.post("/api/admin/schools", body);
async function activeTrip(schoolId, title = "Winter Trip") {
  const trip = (await admin.as.post(`/api/admin/schools/${schoolId}/trips`, { title, tourType: "domestic", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  return trip;
}

describe("school branch", () => {
  it("is saved trimmed and tidied, and shown in school and trip lists", async () => {
    const res = await create({ name: "Greenfield Public School", branch: "  Kolkata   Branch " });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.school.branch, "Kolkata Branch");
    const row = (await pool.query("SELECT branch, branch_normalized FROM schools")).rows[0];
    assert.deepEqual(row, { branch: "Kolkata Branch", branch_normalized: "kolkata branch" });
    await activeTrip(res.body.school.id);
    assert.equal((await admin.as.get("/api/admin/schools")).body.schools[0].branch, "Kolkata Branch");
    assert.equal((await admin.as.get("/api/admin/trips")).body.trips[0].schoolBranch, "Kolkata Branch");
  });

  it("is optional: a school without one is stored with no branch, and an empty value means none", async () => {
    assert.equal((await create({ name: "Alpha School" })).body.school.branch, null);
    assert.equal((await create({ name: "Beta School", branch: "" })).body.school.branch, null);
    assert.deepEqual((await pool.query("SELECT branch_normalized FROM schools ORDER BY name")).rows, [{ branch_normalized: "" }, { branch_normalized: "" }]);
  });

  it("the same school may have several branches; the same school AND branch twice is refused (any letter case or spacing)", async () => {
    assert.equal((await create({ name: "Greenfield Public School", branch: "Kolkata Branch" })).status, 201);
    assert.equal((await create({ name: "Greenfield Public School", branch: "Delhi Branch" })).status, 201);
    assert.equal((await create({ name: "Greenfield Public School" })).status, 201, "a school with no branch is its own entry");
    for (const branch of ["Kolkata Branch", "kolkata branch", "  KOLKATA   BRANCH "]) {
      const dup = await create({ name: "greenfield public school", branch });
      assert.equal(dup.status, 409, branch);
      assert.equal(dup.body.error.code, "SCHOOL_EXISTS");
    }
    assert.equal((await create({ name: "Greenfield Public School" })).status, 409, "and the no-branch entry can't be added twice either");
  });

  it("validates the branch like the name", async () => {
    for (const branch of ["x".repeat(101), "Bad\u0007Branch", 5, { a: 1 }]) assert.equal((await create({ name: "Alpha School", branch })).status, 400, JSON.stringify(branch));
  });

  it("an admin can add, change or clear a branch; sales cannot edit schools", async () => {
    const school = (await create({ name: "Alpha School" })).body.school;
    assert.equal((await admin.as.patch(`/api/admin/schools/${school.id}`, { branch: "Kolkata Branch" })).body.school.branch, "Kolkata Branch");
    assert.equal((await admin.as.patch(`/api/admin/schools/${school.id}`, { branch: "Salt Lake Branch" })).body.school.branch, "Salt Lake Branch");
    assert.equal((await admin.as.patch(`/api/admin/schools/${school.id}`, { name: "Alpha Academy" })).body.school.branch, "Salt Lake Branch", "renaming keeps the branch");
    assert.equal((await admin.as.patch(`/api/admin/schools/${school.id}`, { branch: null })).body.school.branch, null);
    await h.makeStaff({ email: "sam@example.com", role: "sales", name: "Sam" });
    const sales = await h.staffSignIn("sam@example.com");
    assert.equal((await sales.as.patch(`/api/admin/schools/${school.id}`, { branch: "X" })).status, 403);
    const { rows } = await pool.query("SELECT details FROM audit_log WHERE action = 'school.update' ORDER BY id LIMIT 1");
    assert.deepEqual(rows[0].details, { branch: "Kolkata Branch", previousBranch: null });
  });

  it("moving a school to a branch that already exists for that name is refused", async () => {
    await create({ name: "Greenfield", branch: "Kolkata" });
    const other = (await create({ name: "Greenfield", branch: "Delhi" })).body.school;
    const res = await admin.as.patch(`/api/admin/schools/${other.id}`, { branch: "Kolkata" });
    assert.equal(res.status, 409);
  });

  it("a trip's address uses the saved branch as its own word, and the public page shows it", async () => {
    const school = (await create({ name: "Greenfield Public School", branch: "Kolkata Branch" })).body.school;
    const trip = await activeTrip(school.id);
    await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
    assert.equal(trip.publicPath, "/join/greenfield-public-school/kolkata-branch/winter-trip");
    const join = await h.api.get("/api/join/greenfield-public-school/kolkata-branch/winter-trip");
    assert.deepEqual(join.body.school, { name: "Greenfield Public School", branch: "Kolkata Branch" });
  });

  it("two branches with the same trip name stay separate: each address finds its own branch and a parent lands on the right one", async () => {
    const kolkata = (await create({ name: "Greenfield", branch: "Kolkata" })).body.school;
    const delhi = (await create({ name: "Greenfield", branch: "Delhi" })).body.school;
    const tk = await activeTrip(kolkata.id, "Annual Trip");
    const td = await activeTrip(delhi.id, "Annual Trip");
    for (const t of [tk, td]) await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    assert.equal((await h.api.get("/api/join/greenfield/kolkata/annual-trip")).body.school.branch, "Kolkata");
    assert.equal((await h.api.get("/api/join/greenfield/delhi/annual-trip")).body.school.branch, "Delhi");
    const verificationToken = await h.verifiedToken("p@example.com", "registration");
    await h.api.post("/api/registrations", { ...registrationFields("p@example.com", { role: "Student" }), verificationToken, publicTrip: { school: "greenfield", branch: "delhi", trip: "annual-trip" } });
    const { rows } = await pool.query("SELECT e.trip_id FROM trip_enrolments e");
    assert.deepEqual(rows, [{ trip_id: td.id }]);
  });

  it("editing the branch later doesn't change the address", async () => {
    const school = (await create({ name: "Greenfield", branch: "Kolkata" })).body.school;
    const trip = await activeTrip(school.id);
    await admin.as.patch(`/api/admin/schools/${school.id}`, { branch: "Salt Lake" });
    assert.equal((await admin.as.get(`/api/admin/trips/${trip.id}`)).body.trip.publicPath, "/join/greenfield/kolkata/winter-trip");
  });

  it("schools that existed before branches keep working unchanged", async () => {
    await pool.query("INSERT INTO schools (name, name_normalized, slug, branch_slug) VALUES ('Old School', 'old school', 'old-school', 'main')");
    const listed = (await admin.as.get("/api/admin/schools")).body.schools;
    assert.deepEqual(listed.map((s) => [s.name, s.branch]), [["Old School", null]]);
    assert.equal((await create({ name: "Old School" })).status, 409, "the old name is still protected");
    assert.equal((await create({ name: "Old School", branch: "Kolkata" })).status, 201, "and a branch of it can now be added");
  });
});
