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

async function publicTrip(title) {
  const trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title, tourType: "domestic", destination: title, paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  return trip;
}
async function parentVia(email, trip) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, ...(trip ? { publicTrip: slugsOf(trip) } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return h.cookieOf(res);
}
const resume = (cookie) => h.api.get("/api/enrolments/resume", { cookie });

describe("GET /api/enrolments/resume: which registration to open after a homepage login", () => {
  it("needs a signed-in parent", async () => {
    assert.equal((await h.api.get("/api/enrolments/resume")).status, 401);
  });

  it("none: a parent with no registration gets nothing to open (no trip is invented)", async () => {
    await publicTrip("Jaipur"); // a public trip exists, but this parent didn't come from it
    const cookie = await parentVia("p@example.com");
    assert.deepEqual((await resume(cookie)).body, { status: "none" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_enrolments")).rows[0].n, 0);
  });

  it("one: the parent's only trip registration, whether a draft or submitted", async () => {
    const trip = await publicTrip("Jaipur");
    const cookie = await parentVia("p@example.com", trip);
    const r = (await resume(cookie)).body;
    assert.equal(r.status, "one");
    const enrolmentId = (await pool.query("SELECT id FROM trip_enrolments")).rows[0].id;
    assert.equal(r.enrolmentId, enrolmentId);
    // submit it: still "one", the same registration
    const created = await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: "review", version: null, enrolmentId }, { cookie });
    await h.api.post("/api/onboarding/submit", { version: created.body.form.version, enrolmentId, ...ACK }, { cookie });
    assert.deepEqual((await resume(cookie)).body, { status: "one", enrolmentId });
  });

  it("one: a form from before trips counts as the parent's registration", async () => {
    const cookie = await parentVia("p@example.com");
    await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: "personal", version: null }, { cookie });
    assert.deepEqual((await resume(cookie)).body, { status: "one", enrolmentId: "legacy" });
  });

  it("several: says only that there are several, never picks one or lists them, and changes nothing", async () => {
    const a = await publicTrip("Jaipur");
    const b = await publicTrip("Shimla");
    const cookie = await parentVia("p@example.com", a);
    await h.api.post("/api/enrolments", { trip: slugsOf(b) }, { cookie });
    const before = (await pool.query("SELECT count(*)::int AS n FROM trip_enrolments")).rows[0].n;
    // only the fact that there are several: no list of trips (the parent is asked to use their school's link)
    assert.deepEqual((await resume(cookie)).body, { status: "several" });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_enrolments")).rows[0].n, before);
  });

  it("only ever the caller's own registrations", async () => {
    const trip = await publicTrip("Jaipur");
    await parentVia("other@example.com", trip);
    const mine = await parentVia("p@example.com");
    assert.deepEqual((await resume(mine)).body, { status: "none" });
  });

  it("reopening a trip page you already registered for returns the same registration (no duplicate)", async () => {
    const trip = await publicTrip("Jaipur");
    const cookie = await parentVia("p@example.com", trip);
    const first = await h.api.post("/api/enrolments", { trip: slugsOf(trip) }, { cookie });
    const second = await h.api.post("/api/enrolments", { trip: slugsOf(trip) }, { cookie });
    assert.deepEqual([first.status, first.body.created, second.status, second.body.created], [200, false, 200, false]);
    assert.equal(first.body.enrolmentId, second.body.enrolmentId);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_enrolments")).rows[0].n, 1);
  });
});
