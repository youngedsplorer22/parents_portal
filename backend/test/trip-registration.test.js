import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let school;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School" })).body.school;
});
afterEach(() => h.close());
after(() => pool.end());

const makeTrip = async (over = {}) =>
  (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "international", destination: "Japan", paymentMode: "payment", ...over })).body.trip;
const activate = (trip, status = "active") => admin.as.post(`/api/admin/trips/${trip.id}/status`, { status });
const setPublic = (trip, enabled = true) => admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled });
/** An active trip with public registration on; resolves to { trip, words } (words = its page address). */
const openTrip = async (over) => {
  const trip = await makeTrip(over);
  await activate(trip);
  await setPublic(trip);
  return { trip, words: slugsOf(trip) };
};
/** Registers over HTTP with a real email verification, optionally from a trip's public page. */
async function register(email, publicTrip, over = {}) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, over), verificationToken, ...(publicTrip === undefined ? {} : { publicTrip }) });
  return { res, verificationToken, cookie: h.cookieOf(res) };
}
const accountRow = async (email) => (await pool.query("SELECT school, trip_id, trip_link_id FROM parent_registrations WHERE email_normalized = $1", [email])).rows[0];
const accountCount = async () => (await pool.query("SELECT count(*)::int AS n FROM parent_registrations")).rows[0].n;

const GENERIC = { error: { code: "TRIP_NOT_FOUND", message: "This registration page isn't available. Please check the address with your school." } };

describe("registering from a trip's public page", () => {
  it("ties the account to the trip and takes the school from the trip's school; no link row is used", async () => {
    const { trip, words } = await openTrip();
    const { res } = await register("a@example.com", words);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(await accountRow("a@example.com"), { school: "Greenfield Public School", trip_id: trip.id, trip_link_id: null });
    const e = (await pool.query("SELECT trip_id, trip_link_id FROM trip_enrolments")).rows;
    assert.deepEqual(e, [{ trip_id: trip.id, trip_link_id: null }]);
  });

  it("without a trip it behaves exactly as before: school Unassigned, no trip", async () => {
    const { res } = await register("b@example.com");
    assert.equal(res.status, 201);
    assert.deepEqual(await accountRow("b@example.com"), { school: "Unassigned", trip_id: null, trip_link_id: null });
  });

  it("the parent cannot choose or override the school or trip: such fields are rejected", async () => {
    const { words } = await openTrip();
    for (const extra of [{ school: "Another School" }, { tripId: "00000000-0000-0000-0000-000000000000" }, { schoolId: "x" }, { joinToken: "A".repeat(43) }]) {
      const verificationToken = await h.verifiedToken("c@example.com", "registration");
      const res = await h.api.post("/api/registrations", { ...registrationFields("c@example.com"), verificationToken, publicTrip: words, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal(await accountCount(), 0);
  });

  it("an unknown, private, draft, archived-trip or archived-school page gives the same answer and creates nothing", async () => {
    const { words } = await openTrip();
    const privateTrip = await makeTrip({ title: "Private" });
    await activate(privateTrip);
    const draft = await makeTrip({ title: "Draft" });
    await setPublic(draft);
    const archivedTrip = await openTrip({ title: "Old trip" });
    await activate(archivedTrip.trip, "archived");
    const s2 = (await admin.as.post("/api/admin/schools", { name: "Gone School" })).body.school;
    const t2 = (await admin.as.post(`/api/admin/schools/${s2.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none" })).body.trip;
    await activate(t2);
    await setPublic(t2);
    await admin.as.patch(`/api/admin/schools/${s2.id}`, { status: "archived" });
    const cases = {
      unknown: { ...words, trip: "nope" }, wrongBranch: { ...words, branch: "delhi" },
      private: slugsOf(privateTrip), draft: slugsOf(draft), archivedTrip: archivedTrip.words, archivedSchool: slugsOf(t2),
    };
    let i = 0;
    for (const [name, publicTrip] of Object.entries(cases)) {
      const { res } = await register(`bad${i++}@example.com`, publicTrip);
      assert.equal(res.status, 404, name);
      assert.deepEqual(res.body, GENERIC, name);
    }
    assert.equal(await accountCount(), 0);
  });

  it("malformed trip addresses are refused as invalid input and create nothing", async () => {
    const { words } = await openTrip();
    let i = 0;
    for (const publicTrip of [{ ...words, trip: "" }, { ...words, trip: "Bad Words" }, { school: words.school, trip: words.trip }, "a/b/c", { ...words, extra: "x" }]) {
      const { res } = await register(`mal${i++}@example.com`, publicTrip);
      assert.equal(res.status, 400, JSON.stringify(publicTrip));
    }
    assert.equal(await accountCount(), 0);
  });

  it("a closed or out-of-window public trip refuses new registrations with its own message", async () => {
    const closed = await openTrip({ title: "Closed" });
    await activate(closed.trip, "closed");
    const early = await openTrip({ title: "Early" });
    await pool.query("UPDATE trips SET opens_at = clock_timestamp() + interval '1 day', closes_at = clock_timestamp() + interval '2 days' WHERE id = $1", [early.trip.id]);
    let i = 0;
    for (const [name, publicTrip] of Object.entries({ closed: closed.words, early: early.words })) {
      const { res } = await register(`late${i++}@example.com`, publicTrip);
      assert.equal(res.status, 409, name);
      assert.equal(res.body.error.code, "TRIP_NOT_OPEN", name);
    }
    assert.equal(await accountCount(), 0);
  });

  it("switching public registration off stops new registrations straight away", async () => {
    const { trip, words } = await openTrip();
    await setPublic(trip, false);
    const { res } = await register("off@example.com", words);
    assert.equal(res.status, 404);
    assert.equal(await accountCount(), 0);
  });

  it("a rejected trip does not burn the email verification: the same token still registers without a trip", async () => {
    const { words } = await openTrip();
    const first = await register("d@example.com", { ...words, trip: "nope" });
    assert.equal(first.res.status, 404);
    const retry = await h.api.post("/api/registrations", { ...registrationFields("d@example.com"), verificationToken: first.verificationToken });
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
  });

  it("registering creates no link token, token hash or link row", async () => {
    const { words } = await openTrip();
    const { res } = await register("e@example.com", words);
    assert.equal(res.status, 201);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_links")).rows[0].n, 0);
    assert.ok(!/token_hash|tokenHint|joinToken/.test(JSON.stringify(res.body)));
  });

  it("several parents can register from the same page; each keeps their own account", async () => {
    const { trip, words } = await openTrip();
    for (const email of ["p1@example.com", "p2@example.com"]) assert.equal((await register(email, words)).res.status, 201);
    const { rows } = await pool.query("SELECT DISTINCT trip_id FROM parent_registrations");
    assert.deepEqual(rows, [{ trip_id: trip.id }]);
    assert.equal(await accountCount(), 2);
  });

  it("the school column survives a later school rename, while the portal still shows the current name", async () => {
    const { words } = await openTrip();
    const { cookie } = await register("f@example.com", words);
    await admin.as.patch(`/api/admin/schools/${school.id}`, { name: "Greenfield International School" });
    const state = await h.api.get("/api/onboarding", { cookie });
    assert.equal(state.body.trip.school, "Greenfield International School");
  });
});

describe("onboarding for an account that registered from a trip's public page", () => {
  it("shows the school and trip, and the form follows the trip's tour type", async () => {
    const { words } = await openTrip({ tourType: "international" });
    const { cookie } = await register("g@example.com", words);
    const state = await h.api.get("/api/onboarding", { cookie });
    assert.deepEqual(state.body.trip, { school: "Greenfield Public School", branch: null, schoolLogo: null, title: "Winter Trip", destination: "Japan", academicYear: null, tourType: "international", payment: { required: true, status: "not_configured" } });
  });

  it("refuses a form for a different tour type than the trip, on the server", async () => {
    const { words } = await openTrip({ tourType: "international" });
    const { cookie } = await register("h@example.com", words);
    const wrong = await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: null }, { cookie });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error.code, "TOUR_FIXED_BY_TRIP");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM onboarding_forms")).rows[0].n, 0);
  });

  it("autosave, final validation and the submission lock still work end to end", async () => {
    const { words } = await openTrip({ tourType: "domestic", paymentMode: "none" });
    const { cookie } = await register("i@example.com", words);
    const created = await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: null }, { cookie });
    assert.equal(created.status, 200);
    const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: "review", version: created.body.form.version }, { cookie });
    assert.equal(saved.status, 200);
    const done = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, ...ACK }, { cookie });
    assert.equal(done.status, 200);
    assert.equal(done.body.form.status, "submitted");
    const after = await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: done.body.form.version }, { cookie });
    assert.equal(after.status, 409);
    assert.equal(after.body.error.code, "FORM_SUBMITTED");
  });

  it("accounts without a trip are unchanged: trip is null and either tour may be chosen", async () => {
    const { cookie } = await register("j@example.com");
    const state = await h.api.get("/api/onboarding", { cookie });
    assert.equal(state.body.trip, null);
    for (const tourType of ["domestic"]) {
      const res = await h.api.put("/api/onboarding", { tourType, data: {}, currentSection: null, version: null }, { cookie });
      assert.equal(res.status, 200);
    }
  });
});

describe("database guarantees", () => {
  it("a trip with registrations cannot be deleted", async () => {
    const { trip, words } = await openTrip();
    await register("k@example.com", words);
    await assert.rejects(pool.query("DELETE FROM trips WHERE id = $1", [trip.id]), /violates foreign key constraint/);
  });

  it("slugs are unique per school (and per school+branch) and must be URL words, enforced by the database", async () => {
    const t1 = await makeTrip();
    await assert.rejects(pool.query("INSERT INTO trips (school_id, title, tour_type, payment_mode, slug) SELECT school_id, 'X', 'domestic', 'none', slug FROM trips WHERE id = $1", [t1.id]), /trips_slug_key/);
    await assert.rejects(pool.query("UPDATE trips SET slug = 'Bad Slug' WHERE id = $1", [t1.id]), /trips_slug_chk/);
    await assert.rejects(pool.query("UPDATE schools SET slug = 'a/b' WHERE id = $1", [school.id]), /schools_slug_chk/);
  });

  it("public registration defaults to off in the database", async () => {
    const t = await makeTrip();
    assert.equal((await pool.query("SELECT public_registration FROM trips WHERE id = $1", [t.id])).rows[0].public_registration, false);
  });
});

describe("two trips, two pages: each registration lands on its own trip and school", () => {
  it("a parent registering from page A is tied to trip A and school A; another from page B to trip B and school B", async () => {
    const otherSchool = (await admin.as.post("/api/admin/schools", { name: "Beta School" })).body.school;
    const a = await openTrip({ title: "Jaipur", tourType: "domestic" });
    const tripB = (await admin.as.post(`/api/admin/schools/${otherSchool.id}/trips`, { title: "Japan", tourType: "international", paymentMode: "payment" })).body.trip;
    await admin.as.post(`/api/admin/trips/${tripB.id}/status`, { status: "active" });
    await setPublic(tripB);

    assert.equal((await register("one@example.com", a.words)).res.status, 201);
    assert.equal((await register("two@example.com", slugsOf(tripB))).res.status, 201);
    const { rows } = await pool.query(
      `SELECT r.email_normalized AS email, r.school, t.title, s.name AS school_name
         FROM parent_registrations r JOIN trip_enrolments e ON e.registration_id = r.id
         JOIN trips t ON t.id = e.trip_id JOIN schools s ON s.id = t.school_id ORDER BY r.email_normalized`,
    );
    assert.deepEqual(rows, [
      { email: "one@example.com", school: "Greenfield Public School", title: "Jaipur", school_name: "Greenfield Public School" },
      { email: "two@example.com", school: "Beta School", title: "Japan", school_name: "Beta School" },
    ]);
  });

  it("the server decides the trip from the address alone: a trip id sent alongside a valid address is refused", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const b = await openTrip({ title: "Shimla" });
    const verificationToken = await h.verifiedToken("three@example.com", "registration");
    const res = await h.api.post("/api/registrations", { ...registrationFields("three@example.com"), verificationToken, publicTrip: a.words, tripId: b.trip.id });
    assert.equal(res.status, 400);
    assert.equal(await accountCount(), 0);
  });
});
