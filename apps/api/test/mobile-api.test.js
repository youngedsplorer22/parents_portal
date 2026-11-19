import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { TEST_PASSWORD, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// The Team Leader mobile app's API (/api/mobile): bearer tokens in the body (for the phone's secure storage), the
// trips staff assigned to this person, and start / send / stop through the same Live Location rules as the website.

const pool = createTestPool();
let h;
let salesA;
let salesB;
let tripA;
let tripB;
let lead; // Team Leader for trip A (web cookie + enrolment)
let parent; // Student, trip A
let leadB; // Team Leader for trip B

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const FIX = { latitude: 22.5726, longitude: 88.3639, accuracy: 12 };

async function openTrip(staff, name) {
  const school = (await staff.as.post("/api/admin/schools", { name })).body.school;
  const trip = (await staff.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Paris 2027", tourType: "international", destination: "Paris", paymentMode: "none" })).body.trip;
  await staff.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await staff.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  return trip;
}
async function person(email, trip, role) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = h.cookieOf(res);
  return { email, cookie, enrolmentId: (await h.api.get("/api/enrolments", { cookie })).body.enrolments[0].id };
}
const login = (email, password = TEST_PASSWORD, o = {}) => h.api.post("/api/mobile/auth/login", { email, password }, o);
const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });
async function app(email) {
  const r = await login(email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const assign = (staff, trip, enrolmentId) => staff.as.put(`/api/admin/trips/${trip.id}/live-location/team-lead`, { enrolmentId });
const mget = (t, path) => h.api.get(`/api/mobile${path}`, bearer(t));
const mpost = (t, path, body = {}) => h.api.post(`/api/mobile${path}`, body, bearer(t));

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, liveLocation: { policy: { minUpdateGapSeconds: 0 } } });
  const admin = await h.staffUser({ email: "admin@example.com", role: "admin" }); // schools, trips and team leads are the admin's
  salesA = admin;
  salesB = admin;
  tripA = await openTrip(admin, "J N Roy School");
  tripB = await openTrip(admin, "Riverside School");
  lead = await person("lead@example.com", tripA, "Team Leader");
  parent = await person("parent@example.com", tripA, "Student");
  leadB = await person("lead-b@example.com", tripB, "Team Leader");
});
afterEach(() => h.close());
after(() => pool.end());

describe("signing in to the app", () => {
  it("returns a bearer token pair in the body (for secure storage) and sets no cookie", async () => {
    const r = await login("lead@example.com");
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenType, "Bearer");
    assert.match(r.body.accessToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.body.refreshToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r.body.accessToken, r.body.refreshToken);
    assert.equal(r.body.accessExpiresIn, 300); // the test policy's access lifetime
    assert.equal(r.body.refreshExpiresIn, 1800);
    assert.deepEqual(r.body.user, { email: "lead@example.com", firstName: "Asha", lastName: "Rao", role: "Team Leader" });
    assert.equal(r.setCookie.length, 0);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const stored = JSON.stringify((await pool.query("SELECT * FROM auth_sessions, auth_refresh_tokens")).rows);
    assert.ok(!stored.includes(r.body.accessToken) && !stored.includes(r.body.refreshToken), "only hashes are stored");
  });

  it("a wrong password and an unknown email get the same answer as on the website; attempts are throttled", async () => {
    const wrong = await login("lead@example.com", "not-the-password");
    const unknown = await login("nobody@example.com", "not-the-password");
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");
    for (let i = 0; i < 6; i++) await login("lead@example.com", "wrong-again");
    assert.equal((await login("lead@example.com")).status, 429); // the same lock-out as web sign-in (5 per email)
  });

  it("app tokens and website cookies never cross over", async () => {
    const t = await app("lead@example.com");
    assert.equal((await h.api.get("/api/auth/session", { cookie: `pp_access=${t.accessToken}` })).status, 401);
    assert.equal((await h.api.get("/api/onboarding", { cookie: `pp_access=${t.accessToken}` })).status, 401);
    const webToken = lead.cookie.split("=")[1];
    assert.equal((await mget(webToken, "/me")).status, 401);
    assert.equal((await h.api.get("/api/mobile/me", { cookie: lead.cookie })).status, 401); // cookies are ignored here
    assert.equal((await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.accessToken })).status, 401);
  });

  it("every app route except sign-in needs a valid bearer token; a malformed one is 401 with WWW-Authenticate", async () => {
    for (const path of ["/me", "/trips", `/trips/${lead.enrolmentId}`]) {
      assert.equal((await h.api.get(`/api/mobile${path}`)).status, 401, path);
      const junk = await h.api.get(`/api/mobile${path}`, { headers: { authorization: "Bearer not-a-token" } });
      assert.equal(junk.status, 401);
      assert.match(junk.headers.get("www-authenticate"), /^Bearer/);
    }
    for (const path of ["start", "location", "stop"]) assert.equal((await h.api.post(`/api/mobile/trips/${lead.enrolmentId}/${path}`, {})).status, 401, path);
  });
});

describe("tokens: renewal, logout, expiry", () => {
  it("refresh rotates the pair; reusing a spent refresh token (later) ends the sign-in", async () => {
    const t = await app("lead@example.com");
    const r = await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.accessToken, t.accessToken);
    assert.equal((await mget(t.accessToken, "/me")).status, 401, "the old access token is replaced");
    assert.equal((await mget(r.body.accessToken, "/me")).status, 200);
    await pool.query("UPDATE auth_refresh_tokens SET used_at = used_at - interval '1 minute' WHERE used_at IS NOT NULL");
    assert.equal((await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken })).status, 401);
    assert.equal((await mget(r.body.accessToken, "/me")).status, 401, "replay revoked the whole sign-in");
    assert.ok(h.logged.some((l) => /mobile app sign-in was ended/.test(l)));
  });

  it("two refreshes at the same moment: one gets the new pair, the other 409 (nothing issued, nothing revoked)", async () => {
    const t = await app("lead@example.com");
    const [a, b] = await Promise.all([1, 2].map(() => h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken })));
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? a : b;
    assert.equal((await mget(winner.body.accessToken, "/me")).status, 200);
  });

  it("an expired access token is refused, and the refresh token renews it", async () => {
    const t = await app("lead@example.com");
    await pool.query("UPDATE auth_sessions SET access_expires_at = now() - interval '1 second'");
    assert.equal((await mget(t.accessToken, "/me")).status, 401);
    const r = await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken });
    assert.equal((await mget(r.body.accessToken, "/me")).status, 200);
  });

  it("logout (with just the refresh token) ends the app sign-in; and ends its live sharing for parents", async () => {
    await assign(salesA, tripA, lead.enrolmentId);
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(5) });
    assert.equal((await h.api.get(`/api/live-location?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie })).body.state, "live");
    assert.equal((await h.api.post("/api/mobile/auth/logout", { refreshToken: t.refreshToken })).status, 200);
    assert.equal((await mget(t.accessToken, "/me")).status, 401);
    assert.equal((await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken })).status, 401);
    assert.equal((await h.api.get(`/api/live-location?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie })).body.state, "stopped");
  });

  it("a password reset (done on the website) ends the app's sign-in too", async () => {
    const t = await app("lead@example.com");
    h.clock.advance(31_000);
    await h.api.post("/api/auth/password-reset/request", { email: "lead@example.com" });
    const verified = await h.api.post("/api/auth/password-reset/verify", { email: "lead@example.com", code: h.sender.last().code });
    const reset = await h.api.post("/api/auth/password-reset/confirm", { email: "lead@example.com", verificationToken: verified.body.verificationToken, password: "a-new-passphrase-99", confirmPassword: "a-new-passphrase-99" });
    assert.equal(reset.status, 200);
    assert.equal((await mget(t.accessToken, "/me")).status, 401);
    assert.equal((await h.api.post("/api/mobile/auth/refresh", { refreshToken: t.refreshToken })).status, 401);
  });
});

describe("assigned trips only", () => {
  it("a Team Leader not chosen by staff sees no trips and can't share (registering as Team Leader grants nothing)", async () => {
    const t = await app("lead@example.com");
    assert.deepEqual((await mget(t.accessToken, "/trips")).body, { trips: [] });
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`)).body.error.code, "NOT_TEAM_LEAD");
  });

  it("once chosen, the trip is listed with its state; other trips and other people's assignments never appear", async () => {
    await assign(salesA, tripA, lead.enrolmentId);
    await assign(salesB, tripB, leadB.enrolmentId);
    const t = await app("lead@example.com");
    const { trips } = (await mget(t.accessToken, "/trips")).body;
    assert.equal(trips.length, 1);
    assert.equal(trips[0].enrolmentId, lead.enrolmentId);
    assert.equal(trips[0].trip.school, "J N Roy School");
    assert.equal(trips[0].state, "not_started");
    assert.deepEqual(trips[0].teamLead, { canShare: true, sharingHere: false });
    const p = await app("parent@example.com");
    assert.deepEqual((await mget(p.accessToken, "/trips")).body, { trips: [] }); // a parent of the same trip: nothing
  });
});

describe("sharing from the app", () => {
  beforeEach(async () => {
    await assign(salesA, tripA, lead.enrolmentId);
  });

  it("start, send, stop: parents on the website see it live, then stopped (one implementation for both)", async () => {
    const t = await app("lead@example.com");
    const s = await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    assert.equal(s.status, 200);
    assert.equal(s.body.teamLead.sharingHere, true);
    const sent = await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(20) });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const seen = (await h.api.get(`/api/live-location?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie })).body;
    assert.equal(seen.state, "live");
    assert.deepEqual([seen.location.latitude, seen.location.longitude], [FIX.latitude, FIX.longitude]);
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/stop`)).body.state, "stopped");
    assert.equal((await h.api.get(`/api/live-location?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie })).body.location, null);
  });

  it("another trip's Team Leader, a parent, or a made-up id can't touch this trip", async () => {
    await assign(salesB, tripB, leadB.enrolmentId);
    const b = await app("lead-b@example.com");
    for (const path of ["start", "stop"]) assert.equal((await mpost(b.accessToken, `/trips/${lead.enrolmentId}/${path}`)).status, 404, path);
    assert.equal((await mpost(b.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(5) })).status, 404);
    assert.equal((await mget(b.accessToken, `/trips/${lead.enrolmentId}`)).status, 404);
    const p = await app("parent@example.com");
    assert.equal((await mpost(p.accessToken, `/trips/${parent.enrolmentId}/start`)).body.error.code, "NOT_TEAM_LEAD");
    assert.equal((await mpost(p.accessToken, `/trips/${lead.enrolmentId}/start`)).status, 404);
    const t = await app("lead@example.com");
    assert.equal((await mpost(t.accessToken, "/trips/00000000-0000-4000-8000-000000000000/start")).status, 404);
    assert.equal((await mpost(t.accessToken, "/trips/not-a-uuid/start")).status, 404);
  });

  it("invalid GPS data, forged times and smuggled identity fields are refused", async () => {
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    const bad = [
      { ...FIX, latitude: 91, capturedAt: ago(1) }, { ...FIX, longitude: -200, capturedAt: ago(1) }, { ...FIX, latitude: 0, longitude: 0, capturedAt: ago(1) },
      { ...FIX, accuracy: -5, capturedAt: ago(1) }, { ...FIX, capturedAt: "later" }, { ...FIX },
      { ...FIX, capturedAt: new Date(Date.now() + 600_000).toISOString() }, { ...FIX, capturedAt: ago(3600) },
      { ...FIX, capturedAt: ago(1), enrolmentId: leadB.enrolmentId }, { ...FIX, capturedAt: ago(1), tripId: tripB.id },
    ];
    for (const body of bad) assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, body)).status, 400, JSON.stringify(body));
    assert.equal((await pool.query("SELECT latitude FROM trip_live_locations")).rows[0].latitude, null);
  });

  it("offline recovery: a reading taken a few minutes ago is accepted; one older than the last is refused", async () => {
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(8 * 60) })).status, 200); // queued while offline
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(9 * 60) })).body.error.code, "INVALID_LOCATION");
  });

  it("reassignment: once staff choose someone else, the app is refused and the trip leaves its list", async () => {
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    await assign(salesA, tripA, null);
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(1) })).body.error.code, "NOT_TEAM_LEAD");
    assert.deepEqual((await mget(t.accessToken, "/trips")).body.trips, []);
  });

  it("trip closure: sharing ends, the app is refused, and the trip shows as ended (it can't be restarted)", async () => {
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(1) });
    await salesA.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "closed" });
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: new Date().toISOString() })).body.error.code, "TRIP_NOT_ACTIVE");
    const listed = (await mget(t.accessToken, "/trips")).body.trips[0];
    assert.equal(listed.state, "ended");
    assert.equal(listed.teamLead.canShare, false);
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`)).body.error.code, "TRIP_NOT_ACTIVE");
  });

  it("the app and the website can't both share: starting on one takes over and the other is refused", async () => {
    const t = await app("lead@example.com");
    await mpost(t.accessToken, `/trips/${lead.enrolmentId}/start`);
    await h.api.post("/api/live-location/start", { enrolmentId: lead.enrolmentId }, { cookie: lead.cookie });
    assert.equal((await mpost(t.accessToken, `/trips/${lead.enrolmentId}/location`, { ...FIX, capturedAt: ago(1) })).body.error.code, "NOT_SHARING");
  });

  it("compressed request bodies are refused before any decompression (body-parser advisory GHSA-27r3-jxmh-p828 can't apply)", async () => {
    const { gzipSync } = await import("node:zlib");
    const body = Buffer.concat([gzipSync(JSON.stringify({ email: "lead@example.com", password: "x" })), Buffer.from("trailing")]);
    const gz = { "content-type": "application/json", "content-encoding": "gzip" };
    for (const path of ["/api/mobile/auth/login", "/api/auth/login/password"]) {
      assert.equal((await h.api.post(path, body, { raw: true, headers: gz })).status, 415, path);
    }
    // signed in, so the body parser really runs: still refused
    const t = await app("lead@example.com");
    assert.equal((await h.api.post(`/api/mobile/trips/${lead.enrolmentId}/start`, body, { raw: true, headers: { ...gz, authorization: `Bearer ${t.accessToken}` } })).status, 415);
    assert.equal((await h.api.post("/api/live-location/start", body, { raw: true, cookie: lead.cookie, headers: gz })).status, 415);
    // and without a sign-in the browser routes never read the body at all
    assert.equal((await h.api.post("/api/live-location/start", body, { raw: true, headers: gz })).status, 401);
  });

  it("JSON only, and a browser page from another site is refused (403)", async () => {
    const t = await app("lead@example.com");
    const form = await h.api.post(`/api/mobile/trips/${lead.enrolmentId}/start`, "x=1", { raw: true, headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${t.accessToken}` } });
    assert.equal(form.status, 415);
    const cross = await h.api.post(`/api/mobile/trips/${lead.enrolmentId}/start`, {}, { headers: { authorization: `Bearer ${t.accessToken}`, origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
  });
});
