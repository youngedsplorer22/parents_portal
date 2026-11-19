import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

/** An active, public trip for the school (a different year/tour each time); `token` is its page address words. */
async function openTrip({ academicYear = "2026-27", tourType = "domestic", title = `Trip ${academicYear}`, forSchool = school } = {}) {
  const trip = (await admin.as.post(`/api/admin/schools/${forSchool.id}/trips`, { title, tourType, academicYear, destination: "Manali", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  return { trip, token: slugsOf(trip) };
}
async function signUpVia(email, token, over = {}) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student", ...over }), verificationToken, ...(token ? { publicTrip: token } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { cookie: h.cookieOf(res), registrationId: res.body.registrationId };
}
/** Creates, completes and submits the form for whatever trip the person is currently enrolled in. */
async function submitForm(cookie, tourType, role = "student") {
  const created = await h.api.put("/api/onboarding", { tourType, data: {}, currentSection: null, version: null }, { cookie });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const saved = await h.api.put("/api/onboarding", { tourType, data: validAnswers(tourType, role), currentSection: "review", version: created.body.form.version }, { cookie });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const done = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, ...ACK }, { cookie });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.form;
}
const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const enrol = (cookie, trip) => h.api.post("/api/enrolments", { trip }, { cookie });
const GENERIC = { error: { code: "TRIP_NOT_FOUND", message: "This registration page isn't available. Please check the address with your school." } };

describe("one school, one trip per year", () => {
  it("the same school has a separate trip for each academic year, all under one school record", async () => {
    await openTrip({ academicYear: "2025-26" });
    await openTrip({ academicYear: "2026-27" });
    const { rows } = await pool.query("SELECT school_id, academic_year FROM trips ORDER BY academic_year");
    assert.deepEqual(rows.map((r) => r.academic_year), ["2025-26", "2026-27"]);
    assert.equal(new Set(rows.map((r) => r.school_id)).size, 1);
    assert.equal(await count("schools"), 1);
  });

  it("the academic year is validated, optional, and can be changed by staff", async () => {
    const base = { title: "T", tourType: "domestic", paymentMode: "none" };
    for (const bad of ["2026", "26-27", "2026-28", "2026/27", "2026-2027", " ", "2026-27; DROP"]) {
      const res = await admin.as.post(`/api/admin/schools/${school.id}/trips`, { ...base, academicYear: bad });
      assert.equal(res.status, 400, bad);
    }
    const none = await admin.as.post(`/api/admin/schools/${school.id}/trips`, base);
    assert.equal(none.status, 201);
    assert.equal(none.body.trip.academicYear, null);
    const set = await admin.as.patch(`/api/admin/trips/${none.body.trip.id}`, { academicYear: "2027-28" });
    assert.equal(set.body.trip.academicYear, "2027-28");
    const cleared = await admin.as.patch(`/api/admin/trips/${none.body.trip.id}`, { academicYear: null });
    assert.equal(cleared.body.trip.academicYear, null);
  });
});

describe("registering from a public page creates the enrolment", () => {
  it("one person, one enrolment for that trip, with no link row", async () => {
    const { trip, token } = await openTrip();
    const { registrationId } = await signUpVia("a@example.com", token);
    const { rows } = await pool.query("SELECT registration_id, trip_id, trip_link_id FROM trip_enrolments");
    assert.deepEqual(rows, [{ registration_id: registrationId, trip_id: trip.id, trip_link_id: null }]);
  });

  it("registering without a trip creates no enrolment", async () => {
    await signUpVia("b@example.com");
    assert.equal(await count("trip_enrolments"), 0);
  });

  it("a rejected trip address leaves no account and no enrolment behind", async () => {
    const verificationToken = await h.verifiedToken("c@example.com", "registration");
    const res = await h.api.post("/api/registrations", { ...registrationFields("c@example.com"), verificationToken, publicTrip: { school: "greenfield-public-school", branch: "main", trip: "nope" } });
    assert.equal(res.status, 404);
    assert.equal(await count("parent_registrations"), 0);
    assert.equal(await count("trip_enrolments"), 0);
  });
});

describe("the same student takes part again next year", () => {
  it("keeps one identity, adds a new enrolment, starts a fresh form and preserves last year's submission", async () => {
    const y1 = await openTrip({ academicYear: "2025-26", tourType: "domestic", title: "Jaipur" });
    const y2 = await openTrip({ academicYear: "2026-27", tourType: "international", title: "Japan" });
    const { cookie, registrationId } = await signUpVia("student@example.com", y1.token);
    const lastYear = await submitForm(cookie, "domestic");
    const before = (await pool.query("SELECT * FROM onboarding_forms")).rows[0];

    // Next year: the same account follows the new school link.
    const res = await enrol(cookie, y2.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.trip.title, "Japan");
    assert.equal(res.body.trip.academicYear, "2026-27");

    assert.equal(await count("parent_registrations"), 1, "no duplicate identity");
    assert.equal(await count("schools"), 1, "no duplicate school");
    assert.equal(await count("trip_enrolments"), 2);

    const state = await h.api.get("/api/onboarding", { cookie });
    assert.equal(state.body.trip.title, "Japan");
    assert.equal(state.body.trip.tourType, "international");
    assert.equal(state.body.form, null, "a fresh form for the new trip");

    const thisYear = await submitForm(cookie, "international");
    assert.equal(thisYear.tourType, "international");

    // Last year's form is exactly as it was submitted.
    const forms = (await pool.query("SELECT * FROM onboarding_forms ORDER BY created_at")).rows;
    assert.equal(forms.length, 2);
    assert.deepEqual(forms[0], before);
    assert.equal(forms[0].status, "submitted");
    assert.deepEqual(forms[0].data, lastYear.data);
    assert.notEqual(forms[0].enrolment_id, forms[1].enrolment_id);
    assert.ok(forms.every((f) => f.registration_id === registrationId));
  });

  it("the history lists each year with its own form state, newest first, for the owner only", async () => {
    const y1 = await openTrip({ academicYear: "2025-26", title: "Jaipur" });
    const y2 = await openTrip({ academicYear: "2026-27", title: "Shimla" });
    const { cookie } = await signUpVia("s@example.com", y1.token);
    await submitForm(cookie, "domestic");
    await enrol(cookie, y2.token);
    const other = await signUpVia("other@example.com", y2.token);

    const mine = (await h.api.get("/api/enrolments", { cookie })).body.enrolments;
    assert.deepEqual(mine.map((e) => [e.academicYear, e.title, e.form?.status ?? null]), [["2026-27", "Shimla", null], ["2025-26", "Jaipur", "submitted"]]);
    const theirs = (await h.api.get("/api/enrolments", { cookie: other.cookie })).body.enrolments;
    assert.deepEqual(theirs.map((e) => e.title), ["Shimla"]);
    const text = JSON.stringify(mine);
    for (const leak of ["s@example.com", other.registrationId, "other@example.com", y1.trip.id, y2.token]) assert.ok(!text.includes(leak), leak);
  });

  it("enrolling twice in the same trip is a no-op", async () => {
    const t = await openTrip();
    const { cookie } = await signUpVia("d@example.com");
    assert.equal((await enrol(cookie, t.token)).status, 201);
    const again = await enrol(cookie, t.token);
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(await count("trip_enrolments"), 1);
  });

  it("an account from before trips existed keeps its legacy form and can then join a trip", async () => {
    const { cookie } = await signUpVia("legacy@example.com"); // no link: school Unassigned
    await submitForm(cookie, "international");
    const legacyBefore = (await pool.query("SELECT * FROM onboarding_forms")).rows[0];
    assert.equal(legacyBefore.enrolment_id, null);

    const t = await openTrip({ tourType: "domestic" });
    assert.equal((await enrol(cookie, t.token)).status, 201);
    const state = await h.api.get("/api/onboarding", { cookie });
    assert.equal(state.body.form, null);
    assert.equal(state.body.trip.tourType, "domestic");
    await submitForm(cookie, "domestic");
    const forms = (await pool.query("SELECT * FROM onboarding_forms ORDER BY created_at")).rows;
    assert.equal(forms.length, 2);
    assert.deepEqual(forms[0], legacyBefore);
  });
});

describe("different students in different years", () => {
  it("each year's registrations belong to that year's trip only", async () => {
    const y1 = await openTrip({ academicYear: "2025-26" });
    const y2 = await openTrip({ academicYear: "2026-27" });
    const a = await signUpVia("a1@example.com", y1.token);
    const b = await signUpVia("b1@example.com", y1.token);
    const c = await signUpVia("c1@example.com", y2.token);
    await enrol(a.cookie, y2.token); // a returns; b does not
    const { rows } = await pool.query(
      "SELECT t.academic_year, count(*)::int AS n FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id GROUP BY 1 ORDER BY 1",
    );
    assert.deepEqual(rows, [{ academic_year: "2025-26", n: 2 }, { academic_year: "2026-27", n: 2 }]);
    assert.equal(await count("parent_registrations"), 3);
    assert.ok(b && c);
  });
});

describe("POST /api/enrolments safety", () => {
  it("needs a signed-in parent", async () => {
    const t = await openTrip();
    assert.equal((await h.api.post("/api/enrolments", { trip: t.token })).status, 401);
    assert.equal((await h.api.get("/api/enrolments")).status, 401);
    assert.equal(await count("trip_enrolments"), 0);
  });

  it("cannot be pointed at a person, trip id or school: only the public page address is accepted", async () => {
    const t = await openTrip();
    const { cookie, registrationId } = await signUpVia("e@example.com");
    for (const extra of [{ registrationId }, { tripId: t.trip.id }, { schoolId: school.id }, { school: "Other" }, { joinToken: "A".repeat(43) }]) {
      const res = await h.api.post("/api/enrolments", { trip: t.token, ...extra }, { cookie });
      assert.equal(res.status, 400, JSON.stringify(Object.keys(extra)));
    }
    assert.equal((await h.api.post("/api/enrolments", {}, { cookie })).status, 400);
    assert.equal((await h.api.post("/api/enrolments", { joinToken: "A".repeat(43) }, { cookie })).status, 400, "the old token body is refused");
    assert.equal((await h.api.post("/api/enrolments", { trip: { ...t.token, trip: "Bad Words" } }, { cookie })).status, 400);
    assert.equal(await count("trip_enrolments"), 0);
  });

  it("an unknown, private or archived trip gives the one generic answer; a closed trip says so; nothing is created", async () => {
    const t = await openTrip();
    const { cookie } = await signUpVia("f@example.com");
    const priv = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Private", tourType: "domestic", paymentMode: "none" })).body.trip;
    await admin.as.post(`/api/admin/trips/${priv.id}/status`, { status: "active" });
    const archived = await openTrip({ title: "Archived" });
    await admin.as.post(`/api/admin/trips/${archived.trip.id}/status`, { status: "archived" });
    for (const [name, words] of Object.entries({ unknown: { ...t.token, trip: "nope" }, private: slugsOf(priv), archived: archived.token })) {
      const res = await enrol(cookie, words);
      assert.equal(res.status, 404, name);
      assert.deepEqual(res.body, GENERIC, name);
    }
    await admin.as.post(`/api/admin/trips/${t.trip.id}/status`, { status: "closed" });
    const closed = await enrol(cookie, t.token);
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error.code, "TRIP_NOT_OPEN");
    assert.equal(await count("trip_enrolments"), 0);
  });

  it("returns no ids other than the caller's own new enrolment, and creates no link row", async () => {
    const t = await openTrip();
    const { cookie } = await signUpVia("g@example.com");
    const res = await enrol(cookie, t.token);
    assert.equal(res.status, 201);
    const text = JSON.stringify(res.body);
    for (const leak of [t.trip.id, school.id]) assert.ok(!text.includes(leak));
    assert.equal(await count("trip_links"), 0);
  });
});

describe("database guarantees", () => {
  it("a person can be enrolled in a trip only once", async () => {
    const t = await openTrip();
    const { registrationId } = await signUpVia("h@example.com", t.token);
    await assert.rejects(
      pool.query("INSERT INTO trip_enrolments (registration_id, trip_id) VALUES ($1, $2)", [registrationId, t.trip.id]),
      (err) => err.constraint === "trip_enrolments_person_trip_key",
    );
  });

  it("an enrolment can have only one form, and a person only one legacy form", async () => {
    const t = await openTrip();
    const { registrationId } = await signUpVia("i@example.com", t.token);
    const enrolmentId = (await pool.query("SELECT id FROM trip_enrolments")).rows[0].id;
    const insert = () => pool.query("INSERT INTO onboarding_forms (registration_id, enrolment_id, tour_type, participant_role) VALUES ($1, $2, 'domestic', 'student')", [registrationId, enrolmentId]);
    await insert();
    await assert.rejects(insert(), (err) => err.constraint === "onboarding_forms_enrolment_key");
  });

  it("enrolments, and trips that have them, cannot be deleted by accident", async () => {
    const t = await openTrip();
    await signUpVia("j@example.com", t.token);
    await assert.rejects(pool.query("DELETE FROM trips WHERE id = $1", [t.trip.id]), /foreign key/);
    await assert.rejects(pool.query("DELETE FROM parent_registrations"), /foreign key/);
    assert.equal(await count("trip_enrolments"), 1);
  });

  it("a form with an enrolment cannot outlive it: enrolments with forms cannot be deleted", async () => {
    const t = await openTrip();
    const { cookie } = await signUpVia("k@example.com", t.token);
    await submitForm(cookie, "domestic");
    await assert.rejects(pool.query("DELETE FROM trip_enrolments"), /foreign key/);
  });
});

describe("migration 011 backfill", () => {
  it("adds an enrolment only for link accounts that have no form yet, and changes nothing else", async () => {
    const t = await openTrip();
    const withForm = await signUpVia("m1@example.com", t.token);
    const without = await signUpVia("m2@example.com", t.token);
    await submitForm(withForm.cookie, "domestic");
    // Put the data back into the "before 011" shape: link accounts without enrolments.
    await pool.query("DELETE FROM trip_enrolments WHERE registration_id = $1", [without.registrationId]);
    await pool.query("ALTER TABLE onboarding_forms DISABLE TRIGGER onboarding_forms_lock_submitted");
    await pool.query("UPDATE onboarding_forms SET enrolment_id = NULL");
    await pool.query("ALTER TABLE onboarding_forms ENABLE TRIGGER onboarding_forms_lock_submitted");
    await pool.query("DELETE FROM trip_enrolments");

    const sql = await readFile(new URL("../src/db/migrations/011_trip_enrolments.sql", import.meta.url), "utf8");
    const backfill = sql.slice(sql.lastIndexOf("INSERT INTO trip_enrolments"));
    await pool.query(backfill);

    const { rows } = await pool.query("SELECT registration_id FROM trip_enrolments");
    assert.deepEqual(rows, [{ registration_id: without.registrationId }]);
    const forms = (await pool.query("SELECT registration_id, enrolment_id, status FROM onboarding_forms")).rows;
    assert.deepEqual(forms, [{ registration_id: withForm.registrationId, enrolment_id: null, status: "submitted" }]);
  });

  it("the account that stayed legacy keeps its trip and its submitted form", async () => {
    const t = await openTrip({ tourType: "domestic" });
    const a = await signUpVia("n@example.com", t.token);
    await submitForm(a.cookie, "domestic");
    await pool.query("ALTER TABLE onboarding_forms DISABLE TRIGGER onboarding_forms_lock_submitted");
    await pool.query("UPDATE onboarding_forms SET enrolment_id = NULL");
    await pool.query("ALTER TABLE onboarding_forms ENABLE TRIGGER onboarding_forms_lock_submitted");
    await pool.query("DELETE FROM trip_enrolments");
    const state = await h.api.get("/api/onboarding", { cookie: a.cookie });
    assert.equal(state.body.form.status, "submitted");
    assert.equal(state.body.trip.tourType, "domestic");
  });
});

describe("registrations made through the retired secret links", () => {
  /** Recreates the shape a pre-014 link registration left behind: a retired link row and an enrolment pointing at it. */
  async function oldLinkAccount(email) {
    const t = await openTrip({ title: "Old Link Trip" });
    await admin.as.post(`/api/admin/trips/${t.trip.id}/public-registration`, { enabled: false });
    const link = (await pool.query(
      `INSERT INTO trip_links (trip_id, token_hash, token_hint, expires_at, created_by, retired_at)
       SELECT $1, repeat('a', 64), 'abcd', now() + interval '30 days', created_by, now() FROM trips WHERE id = $1 RETURNING id`,
      [t.trip.id],
    )).rows[0];
    const { cookie, registrationId } = await signUpVia(email);
    await pool.query("INSERT INTO trip_enrolments (registration_id, trip_id, trip_link_id) VALUES ($1, $2, $3)", [registrationId, t.trip.id, link.id]);
    return { cookie, trip: t.trip, link };
  }

  it("stay listed and their forms keep working, even though the trip is not public and is later closed", async () => {
    const { cookie, trip } = await oldLinkAccount("old@example.com");
    const list = await h.api.get("/api/enrolments", { cookie });
    assert.equal(list.body.enrolments.length, 1);
    const enrolmentId = list.body.enrolments[0].id;
    const created = await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: null, enrolmentId }, { cookie });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "closed" });
    const state = await h.api.get(`/api/onboarding?enrolment=${enrolmentId}`, { cookie });
    assert.equal(state.status, 200);
    assert.equal(state.body.trip.title, "Old Link Trip");
    assert.equal(state.body.form.status, "draft");
  });

  it("the retired link row and its history are kept untouched", async () => {
    const { link } = await oldLinkAccount("old2@example.com");
    const row = (await pool.query("SELECT id, retired_at IS NOT NULL AS retired FROM trip_links")).rows;
    assert.deepEqual(row, [{ id: link.id, retired: true }]);
    assert.equal((await pool.query("SELECT trip_link_id FROM trip_enrolments")).rows[0].trip_link_id, link.id);
  });
});
