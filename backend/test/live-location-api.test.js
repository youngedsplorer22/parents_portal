import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { TEST_PASSWORD, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// Live location over HTTP: staff choose a trip's team lead; the team lead starts, sends and stops; that trip's parents
// read the latest position. Every permission is checked from the session, never from what the browser says.

const pool = createTestPool();
let h;
let admin;
let salesA;
let salesB;
let tripA;
let tripB;
let lead; // Team Leader registered for trip A
let parent; // Student registered for trip A
let otherParent; // Student registered for trip B (another school)
let otherLead; // Team Leader registered for trip B

const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const DELHI = { latitude: 28.6139, longitude: 77.209 };

async function openTrip(staff, schoolName) {
  const school = (await staff.as.post("/api/admin/schools", { name: schoolName })).body.school;
  const trip = (await staff.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "domestic", destination: "Manali", paymentMode: "none" })).body.trip;
  assert.equal((await staff.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" })).status, 200);
  await staff.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  return trip;
}
async function person(email, trip, role) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = h.cookieOf(res);
  const enrolmentId = (await h.api.get("/api/enrolments", { cookie })).body.enrolments[0].id;
  return { email, cookie, enrolmentId };
}
const view = (p, enrolmentId = p.enrolmentId) => h.api.get(`/api/live-location?enrolment=${enrolmentId}`, { cookie: p.cookie });
const start = (p, enrolmentId = p.enrolmentId) => h.api.post("/api/live-location/start", { enrolmentId }, { cookie: p.cookie });
const stop = (p, enrolmentId = p.enrolmentId) => h.api.post("/api/live-location/stop", { enrolmentId }, { cookie: p.cookie });
const send = (p, fix = {}, enrolmentId = p.enrolmentId) =>
  h.api.post("/api/live-location/location", { enrolmentId, ...DELHI, accuracy: 25, capturedAt: now(), ...fix }, { cookie: p.cookie });
const assign = (staff, trip, enrolmentId) => staff.as.put(`/api/admin/trips/${trip.id}/live-location/team-lead`, { enrolmentId });
const row = async (trip) => (await pool.query("SELECT * FROM trip_live_locations WHERE trip_id = $1", [trip.id])).rows[0];

beforeEach(async () => {
  await resetTables(pool);
  // updates may follow each other immediately in most tests (the spacing rule has its own test)
  h = await startApp({ db: pool, liveLocation: { policy: { minUpdateGapSeconds: 0 } } });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  salesA = await h.staffUser({ email: "sales-a@example.com", role: "sales" });
  salesB = await h.staffUser({ email: "sales-b@example.com", role: "sales" });
  tripA = await openTrip(salesA, "Greenfield Public School");
  tripB = await openTrip(salesB, "Riverside School");
  lead = await person("lead@example.com", tripA, "Team Leader");
  parent = await person("parent@example.com", tripA, "Student");
  otherParent = await person("other@example.com", tripB, "Student");
  otherLead = await person("lead-b@example.com", tripB, "Team Leader");
});
afterEach(() => h.close());
after(() => pool.end());

describe("before a team lead is chosen", () => {
  it("parents see 'not started' and no position; nobody can share (not even a Team Leader)", async () => {
    const v = await view(parent);
    assert.equal(v.status, 200);
    assert.equal(v.body.state, "not_started");
    assert.equal(v.body.location, null);
    assert.equal(v.body.teamLead, null);
    assert.deepEqual(v.body.trip, { title: "Winter Trip", destination: "Manali", school: "Greenfield Public School", branch: null, status: "active" });
    assert.deepEqual(v.body.policy, { updateIntervalSeconds: 300, staleAfterSeconds: 720 });
    assert.equal((await start(lead)).body.error.code, "NOT_TEAM_LEAD"); // registering as "Team Leader" alone grants nothing
    assert.equal(await row(tripA), undefined);
  });
});

describe("staff choose the team lead", () => {
  it("the salesperson managing the trip sees the trip's Team Leaders and chooses one (audited)", async () => {
    const v = await salesA.as.get(`/api/admin/trips/${tripA.id}/live-location`);
    assert.equal(v.status, 200);
    assert.deepEqual(v.body.candidates, [{ enrolmentId: lead.enrolmentId, name: "Asha Rao", email: "lead@example.com" }]);
    assert.equal(v.body.teamLeadEnrolmentId, null);
    const a = await assign(salesA, tripA, lead.enrolmentId);
    assert.equal(a.status, 200);
    assert.equal(a.body.teamLeadEnrolmentId, lead.enrolmentId);
    const audit = (await pool.query("SELECT action, entity_id, staff_email FROM audit_log WHERE action = 'trip.team_lead_assign'")).rows;
    assert.deepEqual(audit, [{ action: "trip.team_lead_assign", entity_id: tripA.id, staff_email: "sales-a@example.com" }]);
    assert.equal((await view(lead)).body.teamLead.canShare, true);
  });

  it("only a Team Leader registered for THIS trip can be chosen", async () => {
    assert.equal((await assign(salesA, tripA, parent.enrolmentId)).body.error.code, "NOT_A_TEAM_LEADER"); // a Student
    assert.equal((await assign(salesA, tripA, otherLead.enrolmentId)).body.error.code, "NOT_A_TEAM_LEADER"); // another trip's
    assert.equal((await assign(salesA, tripA, "00000000-0000-4000-8000-000000000000")).status, 400);
  });

  it("another salesperson's trip is 'not found' (read and write); parents and visitors can't use the staff routes", async () => {
    assert.equal((await salesB.as.get(`/api/admin/trips/${tripA.id}/live-location`)).status, 404);
    assert.equal((await assign(salesB, tripA, lead.enrolmentId)).status, 404);
    assert.equal((await h.api.get(`/api/admin/trips/${tripA.id}/live-location`, { cookie: lead.cookie })).status, 401);
    assert.equal((await h.api.get(`/api/admin/trips/${tripA.id}/live-location`)).status, 401);
    assert.equal((await admin.as.get(`/api/admin/trips/${tripA.id}/live-location`)).status, 200); // admins manage every trip
    assert.equal((await salesA.as.get("/api/admin/trips/not-a-uuid/live-location")).status, 404);
  });
});

describe("sharing: start, send, stop", () => {
  beforeEach(async () => {
    await assign(salesA, tripA, lead.enrolmentId);
  });

  it("start -> waiting; a position -> parents see it live, exactly as sent, with the real capture time", async () => {
    const s = await start(lead);
    assert.equal(s.status, 200);
    assert.equal(s.body.state, "waiting");
    assert.equal(s.body.teamLead.sharingHere, true);
    assert.equal((await view(parent)).body.state, "waiting");
    const capturedAt = ago(30);
    const sent = await send(lead, { capturedAt, accuracy: 18.4 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const v = (await view(parent)).body;
    assert.equal(v.state, "live");
    assert.equal(v.location.latitude, DELHI.latitude);
    assert.equal(v.location.longitude, DELHI.longitude);
    assert.equal(v.location.accuracyM, 18);
    assert.equal(new Date(v.location.capturedAt).toISOString(), capturedAt);
    assert.ok(new Date(v.location.receivedAt) >= new Date(capturedAt));
    assert.ok(v.sharingSince);
    assert.equal(v.teamLead, null); // a parent gets no sharing controls
    assert.equal((await salesA.as.get(`/api/admin/trips/${tripA.id}/live-location`)).body.state, "live");
  });

  it("only the latest position is kept: one row per trip, overwritten (no route history)", async () => {
    await start(lead);
    await send(lead, { latitude: 28.6, longitude: 77.2, capturedAt: ago(120) });
    await send(lead, { latitude: 28.7, longitude: 77.3, capturedAt: ago(10) });
    assert.equal((await pool.query("SELECT count(*)::int n FROM trip_live_locations")).rows[0].n, 1);
    const r = await row(tripA);
    assert.deepEqual([r.latitude, r.longitude], [28.7, 77.3]);
  });

  it("an overdue position is shown as stale, with its real time; it is never presented as live", async () => {
    await start(lead);
    await send(lead);
    await pool.query("UPDATE trip_live_locations SET captured_at = now() - interval '20 minutes', received_at = now() - interval '20 minutes'");
    const v = (await view(parent)).body;
    assert.equal(v.state, "stale");
    assert.equal(v.location.latitude, DELHI.latitude); // the last known place, with its warning, rather than nothing
  });

  it("stop wipes the position at once; parents see 'stopped' and no map; further updates are refused", async () => {
    await start(lead);
    await send(lead);
    const s = await stop(lead);
    assert.equal(s.status, 200);
    assert.equal(s.body.state, "stopped");
    const r = await row(tripA);
    assert.deepEqual([r.status, r.latitude, r.longitude, r.captured_at, r.stop_reason], ["off", null, null, null, "team_lead_stopped"]);
    const v = (await view(parent)).body;
    assert.equal(v.state, "stopped");
    assert.equal(v.location, null);
    assert.equal((await send(lead)).body.error.code, "NOT_SHARING");
    assert.equal((await stop(lead)).status, 200); // stopping twice is harmless
  });

  it("starting again after stopping begins fresh (no old position comes back)", async () => {
    await start(lead);
    await send(lead);
    await stop(lead);
    const again = await start(lead);
    assert.equal(again.body.state, "waiting");
    assert.equal(again.body.location, null);
  });

  it("the trip ending (closed) stops sharing and wipes the position, whatever changed it; it can't be restarted", async () => {
    await start(lead);
    await send(lead);
    assert.equal((await salesA.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "closed" })).status, 200);
    const r = await row(tripA);
    assert.deepEqual([r.status, r.latitude, r.stop_reason], ["off", null, "trip_ended"]);
    const v = (await view(parent)).body;
    assert.equal(v.state, "ended");
    assert.equal(v.location, null);
    assert.equal((await start(lead)).body.error.code, "TRIP_NOT_ACTIVE");
    assert.equal((await send(lead)).body.error.code, "TRIP_NOT_ACTIVE");
    assert.equal((await view(lead)).body.teamLead.canShare, false);
  });

  it("a trip ended directly in SQL (by IT) is caught by the database trigger too", async () => {
    await start(lead);
    await send(lead);
    await pool.query("UPDATE trips SET status = 'archived' WHERE id = $1", [tripA.id]);
    assert.equal((await row(tripA)).latitude, null);
  });

  it("signing out ends sharing: parents see 'stopped' straight away, and housekeeping wipes the position", async () => {
    await start(lead);
    await send(lead);
    await h.api.post("/api/auth/logout", undefined, { cookie: lead.cookie });
    const v = (await view(parent)).body;
    assert.equal(v.state, "stopped");
    assert.equal(v.location, null);
    await h.services.liveLocation.purgeExpired();
    const r = await row(tripA);
    assert.deepEqual([r.status, r.latitude, r.stop_reason], ["off", null, "expired"]);
  });

  it("starting on a second device takes over; the first device's updates are then refused", async () => {
    await start(lead);
    const second = await h.api.post("/api/auth/login/password", { email: lead.email, password: TEST_PASSWORD });
    const lead2 = { ...lead, cookie: h.cookieOf(second) };
    assert.equal((await start(lead2)).body.teamLead.sharingHere, true);
    assert.equal((await send(lead)).body.error.code, "NOT_SHARING");
    assert.equal((await send(lead2)).status, 200);
    assert.equal((await view(lead)).body.teamLead.sharingHere, false);
  });

  it("changing the team lead ends the current sharing and wipes the position", async () => {
    await start(lead);
    await send(lead);
    await assign(salesA, tripA, null);
    const r = await row(tripA);
    assert.deepEqual([r.status, r.latitude, r.tracker_enrolment_id, r.stop_reason], ["off", null, null, "team_lead_changed"]);
    assert.equal((await send(lead)).body.error.code, "NOT_TEAM_LEAD");
  });

  it("sharing with no update for 24 hours is ended by housekeeping", async () => {
    await start(lead);
    await send(lead);
    await pool.query("UPDATE trip_live_locations SET captured_at = now() - interval '25 hours', received_at = now() - interval '25 hours', started_at = now() - interval '26 hours'");
    assert.equal((await view(parent)).body.state, "stopped"); // never shown, even before housekeeping runs
    await h.services.liveLocation.purgeExpired();
    assert.equal((await row(tripA)).latitude, null);
  });
});

describe("who may do what", () => {
  beforeEach(async () => {
    await assign(salesA, tripA, lead.enrolmentId);
    await start(lead);
    await send(lead);
  });

  it("without a sign-in every route is 401", async () => {
    assert.equal((await h.api.get(`/api/live-location?enrolment=${parent.enrolmentId}`)).status, 401);
    for (const path of ["start", "location", "stop"]) {
      assert.equal((await h.api.post(`/api/live-location/${path}`, { enrolmentId: lead.enrolmentId })).status, 401, path);
    }
  });

  it("a parent who isn't the chosen team lead can't start, send or stop", async () => {
    assert.equal((await start(parent)).body.error.code, "NOT_TEAM_LEAD");
    assert.equal((await send(parent)).body.error.code, "NOT_TEAM_LEAD");
    assert.equal((await stop(parent)).body.error.code, "NOT_TEAM_LEAD");
    assert.equal((await view(parent)).body.state, "live"); // nothing they tried changed anything
  });

  it("another trip's parent can't read this trip by using one of its enrolment ids (404), and sees only their own trip", async () => {
    assert.equal((await view(otherParent, parent.enrolmentId)).status, 404);
    assert.equal((await view(otherParent, lead.enrolmentId)).status, 404);
    const own = (await view(otherParent)).body;
    assert.equal(own.trip.school, "Riverside School");
    assert.equal(own.state, "not_started");
    assert.equal(own.location, null);
  });

  it("another trip's team lead can't send or stop for this trip, even when chosen for their own", async () => {
    await assign(salesB, tripB, otherLead.enrolmentId);
    assert.equal((await send(otherLead, {}, lead.enrolmentId)).status, 404);
    assert.equal((await stop(otherLead, lead.enrolmentId)).status, 404);
    assert.equal((await start(otherLead)).status, 200); // their own trip works
    assert.equal((await view(otherParent)).body.state, "waiting");
    assert.equal((await view(parent)).body.state, "live"); // trip A untouched
  });

  it("a trip id, registration id or school in the body is refused outright (only the caller's enrolment counts)", async () => {
    for (const extra of [{ tripId: tripB.id }, { registrationId: "x" }, { school: "Riverside School" }]) {
      assert.equal((await send(lead, extra)).status, 400, JSON.stringify(extra));
    }
  });
});

describe("validation of every position", () => {
  beforeEach(async () => {
    await assign(salesA, tripA, lead.enrolmentId);
    await start(lead);
  });

  it("impossible, malformed or missing coordinates are refused and nothing is stored", async () => {
    const bad = [
      { latitude: 90.0001 }, { latitude: -91 }, { longitude: 180.5 }, { longitude: -181 },
      { latitude: "28.6" }, { longitude: null }, { latitude: 0, longitude: 0 },
      { accuracy: -1 }, { accuracy: 20000 }, { accuracy: "10" },
      { capturedAt: "yesterday" }, { capturedAt: 1761555600000 }, { capturedAt: "" },
    ];
    for (const fix of bad) assert.equal((await send(lead, fix)).status, 400, JSON.stringify(fix));
    const missing = await h.api.post("/api/live-location/location", { enrolmentId: lead.enrolmentId, ...DELHI }, { cookie: lead.cookie });
    assert.equal(missing.status, 400);
    assert.equal((await row(tripA)).latitude, null);
  });

  it("forged or wrong capture times are refused: the future, too old, or older than the last one", async () => {
    assert.equal((await send(lead, { capturedAt: new Date(Date.now() + 10 * 60_000).toISOString() })).body.error.code, "INVALID_LOCATION");
    assert.equal((await send(lead, { capturedAt: ago(20 * 60) })).body.error.code, "INVALID_LOCATION");
    assert.equal((await send(lead, { capturedAt: ago(60) })).status, 200);
    assert.equal((await send(lead, { capturedAt: ago(120) })).body.error.code, "INVALID_LOCATION"); // replay of an older reading
    assert.equal((await send(lead, { capturedAt: "2026-10-27T10:00:00+05:30", latitude: 1 })).status, 400); // valid format, but hours old
  });

  it("the edges of the world are valid", async () => {
    assert.equal((await send(lead, { latitude: 90, longitude: 180, accuracy: 0, capturedAt: ago(3) })).status, 200);
    assert.equal((await send(lead, { latitude: -90, longitude: -180, accuracy: null, capturedAt: ago(2) })).status, 200);
    assert.equal((await send(lead, { accuracy: undefined, capturedAt: ago(1) })).status, 200);
  });
});

describe("protection of the endpoints", () => {
  it("updates closer together than the minimum gap are refused (429) with a retry time; the stored position stays", async () => {
    const strict = await startApp({ db: pool });
    try {
      await assign(salesA, tripA, lead.enrolmentId);
      const s = (p) => strict.api.post("/api/live-location/start", { enrolmentId: p.enrolmentId }, { cookie: p.cookie });
      const f = (fix) => strict.api.post("/api/live-location/location", { enrolmentId: lead.enrolmentId, ...DELHI, capturedAt: now(), ...fix }, { cookie: lead.cookie });
      await s(lead);
      assert.equal((await f({ capturedAt: ago(2) })).status, 200);
      const again = await f({ latitude: 10 });
      assert.equal(again.status, 429);
      assert.equal(again.body.error.code, "TOO_FREQUENT");
      assert.ok(again.body.error.retryAfterSeconds > 0);
      assert.equal((await row(tripA)).latitude, DELHI.latitude);
    } finally {
      await strict.close();
    }
  });

  it("JSON only (a cross-site HTML form is refused), same-origin only, and never cached", async () => {
    await assign(salesA, tripA, lead.enrolmentId);
    const form = await h.api.post("/api/live-location/start", `enrolmentId=${lead.enrolmentId}`, { cookie: lead.cookie, raw: true, headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415);
    const cross = await h.api.post("/api/live-location/start", { enrolmentId: lead.enrolmentId }, { cookie: lead.cookie, headers: { origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal((await row(tripA)).status, "off");
    assert.equal((await view(parent)).headers.get("cache-control"), "no-store");
  });

  it("a malformed enrolment id is a 400, never a server error", async () => {
    assert.equal((await h.api.get("/api/live-location?enrolment=1%27%20OR%201=1", { cookie: parent.cookie })).status, 400);
    assert.equal((await h.api.get("/api/live-location", { cookie: parent.cookie })).status, 400);
  });
});
