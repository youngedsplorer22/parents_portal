import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// A participant (Student, Teacher or Team Lead) reads the itinerary of THEIR OWN registration's trip, read-only, even after the
// trip is closed. The server finds the trip from the registration; the browser cannot name a trip or another person's id.
const pool = createTestPool();
let h;
let admin;
let sales;
let tripA;
let tripB;
const MISSING = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "dev@example.com", role: "admin" });
  sales = await h.staffUser({ email: "sales@company.example", role: "sales" });
  const school = (await admin.as.post("/api/admin/schools", { name: "ABC School" })).body.school;
  const make = async (title) => (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title, tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripA = await make("Jaipur 2027");
  tripB = await make("Goa 2027");
  for (const t of [tripA, tripB]) {
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
  }
  const staffId = (await pool.query("SELECT id FROM staff_users WHERE email_normalized = 'sales@company.example'")).rows[0].id;
  await admin.as.put(`/api/admin/trips/${tripA.id}/assignments/${staffId}`);
});
afterEach(() => h.close());
after(() => pool.end());

const join = async (email, trip, role = "Student") => {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = h.cookieOf(res);
  const enrolmentId = (await h.api.get("/api/enrolments", { cookie })).body.enrolments[0].id;
  return { cookie, enrolmentId };
};
const itin = (p, who) => h.api.get(`/api/enrolments/${who.enrolmentId ?? p}/itinerary`, { cookie: who.cookie });
const tripAId = async () => (await sales.as.get("/api/admin/itinerary/trips")).body.trips[0].id;
const add = async (body) => sales.as.post(`/api/admin/trips/${await tripAId()}/itinerary`, body);

describe("a participant reads their own trip's itinerary", () => {
  for (const role of ["Student", "Teacher", "Team Leader"]) {
    it(`${role}: sees what Sales entered, in day order, with only day, title, details and time`, async () => {
      const me = await join(`${role.replace(" ", "")}@example.com`, tripA, role);
      assert.deepEqual((await itin(null, me)).body.items, []);
      await add({ dayNumber: 2, title: "Amer Fort", details: "Morning." });
      await add({ dayNumber: 1, title: "Arrive in Jaipur" });
      const res = await itin(null, me);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(res.body.items.map((i) => i.title), ["Arrive in Jaipur", "Amer Fort"]);
      assert.deepEqual(Object.keys(res.body.items[0]).sort(), ["dayNumber", "details", "id", "position", "title", "updatedAt"]);
      assert.deepEqual(res.body.trip, { title: "Jaipur 2027", destination: null });
      assert.doesNotMatch(JSON.stringify(res.body), /created|staff|email|tripId|assigned/i);
    });
  }

  it("a Sales update shows up at the next request, with no new login", async () => {
    const me = await join("a@example.com", tripA);
    const created = (await add({ dayNumber: 1, title: "Arrive" })).body.item;
    assert.equal((await itin(null, me)).body.items[0].title, "Arrive");
    await sales.as.patch(`/api/admin/trips/${created.tripId}/itinerary/${created.id}`, { title: "Arrive and check in" });
    assert.equal((await itin(null, me)).body.items[0].title, "Arrive and check in");
  });

  it("after the trip is closed (and its page switched off) the participant can still read it", async () => {
    const me = await join("b@example.com", tripA);
    await add({ dayNumber: 1, title: "Arrive" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "closed" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/public-registration`, { enabled: false });
    const res = await itin(null, me);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
  });
});

describe("a participant cannot reach anyone else's itinerary", () => {
  it("another participant's enrolment id, another trip's, an unknown or malformed id: all a plain 404 with no data", async () => {
    const mine = await join("c@example.com", tripA);
    const other = await join("d@example.com", tripB);
    await add({ dayNumber: 1, title: "Secret plan for Jaipur" });
    for (const id of [other.enrolmentId, MISSING, "not-a-uuid", "1", "%00", "legacy", "../x"]) {
      const res = await h.api.get(`/api/enrolments/${encodeURIComponent(id)}/itinerary`, { cookie: mine.cookie });
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error.code, "NOT_FOUND");
      assert.doesNotMatch(JSON.stringify(res.body), /Secret plan|Jaipur|Goa/);
    }
    assert.equal((await h.api.get(`/api/enrolments/${mine.enrolmentId}/itinerary`, { cookie: other.cookie })).status, 404);
  });

  it("the trip comes from the registration: a participant of another trip sees that trip's itinerary only", async () => {
    const mine = await join("e@example.com", tripA);
    const other = await join("f@example.com", tripB);
    await add({ dayNumber: 1, title: "Jaipur plan" });
    assert.equal((await itin(null, other)).body.items.length, 0);
    assert.equal((await itin(null, mine)).body.items.length, 1);
  });

  it("needs a participant session: none, a Sales session or a staff cookie is 401", async () => {
    const mine = await join("g@example.com", tripA);
    assert.equal((await h.api.get(`/api/enrolments/${mine.enrolmentId}/itinerary`)).status, 401);
    assert.equal((await h.api.get(`/api/enrolments/${mine.enrolmentId}/itinerary`, { cookie: sales.cookie })).status, 401);
  });

  it("read-only: no write method exists for a participant on it", async () => {
    const mine = await join("h@example.com", tripA);
    for (const method of ["post", "put", "patch", "del"]) {
      const res = method === "del" ? await h.api.del(`/api/enrolments/${mine.enrolmentId}/itinerary`, { cookie: mine.cookie }) : await h.api[method](`/api/enrolments/${mine.enrolmentId}/itinerary`, { dayNumber: 1, title: "Hacked" }, { cookie: mine.cookie });
      assert.ok([404, 405].includes(res.status), `${method} -> ${res.status}`);
    }
    assert.equal((await pool.query("SELECT count(*)::int n FROM trip_itinerary_items")).rows[0].n, 0);
  });
});
