import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// Deployment-based access control for Sales staff: the app is configured with a deploymentTemplateKey
// and reads portal_deployments to find which trip is accessible. All authenticated Sales users see
// the same trip; no per-user assignment is needed.

const pool = createTestPool();
let h;
let admin;
let salesA;
let salesB;
let tripA; // domestic_none — the configured deployment trip
let tripB; // domestic_payment — a different template, NOT configured for this deployment
let school;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, staff: { deploymentTemplateKey: "domestic_none" } });
  admin = await h.staffUser({ role: "admin" });
  salesA = await h.staffUser({ email: "sales-a@example.com", role: "sales", name: "Sales A" });
  salesB = await h.staffUser({ email: "sales-b@example.com", role: "sales", name: "Sales B" });
  school = (await admin.as.post("/api/admin/schools", { name: "Delhi Public School" })).body.school;
  tripA = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Jaipur 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripB = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Goa 2027", tourType: "domestic", paymentMode: "payment", academicYear: "2027-28" })).body.trip;
  // Insert into portal_deployments: this deployment is configured for tripA (domestic_none)
  await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripA.id]);
});

afterEach(() => h.close());
after(() => pool.end());

const item = (over = {}) => ({ dayNumber: 1, title: "Arrive in Jaipur", details: "Check in.", ...over });
const items = (who, trip) => who.as.get(`/api/admin/trips/${trip.id}/itinerary`);
const add = (who, trip, body = item()) => who.as.post(`/api/admin/trips/${trip.id}/itinerary`, body);

describe("deployment-based trip list", () => {
  it("Sales user sees the configured trip with no per-user assignment needed", async () => {
    const res = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips.map((t) => t.id), [tripA.id]);
  });

  it("all authenticated Sales users see the same configured trip, regardless of individual assignments", async () => {
    const resA = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(resA.status, 200);
    assert.deepEqual(resA.body.trips.map((t) => t.id), [tripA.id]);

    const resB = await salesB.as.get("/api/admin/itinerary/trips");
    assert.equal(resB.status, 200);
    assert.deepEqual(resB.body.trips.map((t) => t.id), [tripA.id], "salesB sees the deployment trip");
  });

  it("when portal_deployments has no row for the template, trip list is empty", async () => {
    await pool.query("DELETE FROM portal_deployments WHERE template_key = 'domestic_none'");

    const res = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips, []);
  });

  it("a disabled Sales user is denied (401) even if the deployment is configured", async () => {
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = 'sales-a@example.com'");

    const res = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 401);
  });

  it("unauthenticated request is denied (401)", async () => {
    const res = await h.api.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 401);
  });
});

describe("deployment-based itinerary authorization", () => {
  it("Sales user can read the configured trip's itinerary without an assignment row", async () => {
    const res = await items(salesA, tripA);
    assert.equal(res.status, 200);
  });

  it("Sales user can add an itinerary item to the configured trip without an assignment row", async () => {
    const res = await add(salesA, tripA);
    assert.equal(res.status, 201);
  });

  it("Sales user can edit an itinerary item on the configured trip", async () => {
    const added = await add(salesA, tripA);
    assert.equal(added.status, 201);
    const itemId = added.body.item.id;

    const edited = await salesA.as.patch(`/api/admin/trips/${tripA.id}/itinerary/${itemId}`, { title: "Updated Arrival" });
    assert.equal(edited.status, 200);
  });
});

describe("deployment isolation / IDOR prevention", () => {
  it("a trip not configured for this deployment is inaccessible (read)", async () => {
    const res = await items(salesA, tripB);
    assert.equal(res.status, 403);
  });

  it("a trip not configured for this deployment is inaccessible (write)", async () => {
    const res = await add(salesA, tripB);
    assert.equal(res.status, 403);
  });

  it("a known trip UUID from another deployment cannot bypass authorization", async () => {
    // Create tripC under a different template key (international_none)
    const tripC = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Kolkata 2027", tourType: "international", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('international_none', $1)", [tripC.id]);

    // salesA is authenticated against the domestic_none deployment; tripC belongs to international_none
    const readRes = await items(salesA, tripC);
    assert.equal(readRes.status, 403, "cannot read a trip from a different deployment");

    const writeRes = await add(salesA, tripC);
    assert.equal(writeRes.status, 403, "cannot write to a trip from a different deployment");
  });

  it("changing the portal_deployments binding changes which trip is accessible (developer redeployment)", async () => {
    // Create tripC with the same template key (domestic_none) — a new trip for a re-deployment
    const tripC = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Delhi 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;

    // Re-bind domestic_none to tripC
    await pool.query("UPDATE portal_deployments SET trip_id = $1 WHERE template_key = 'domestic_none'", [tripC.id]);

    // Trip list should now return tripC, not tripA
    const listRes = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(listRes.status, 200);
    assert.deepEqual(listRes.body.trips.map((t) => t.id), [tripC.id], "deployment now points to tripC");

    // tripA is no longer accessible
    const oldRead = await items(salesA, tripA);
    assert.equal(oldRead.status, 403, "old trip is no longer accessible after rebinding");

    // tripC is now accessible
    const newRead = await items(salesA, tripC);
    assert.equal(newRead.status, 200, "new trip is accessible after rebinding");
  });

  it("a Sales user cannot change a trip ID in their request to access another trip", async () => {
    // tripB is a known trip but not the configured deployment trip
    const resB = await items(salesA, tripB);
    assert.equal(resB.status, 403, "known trip that is not the deployment trip is refused");

    // Non-existent UUID
    const resUnknown = await items(salesA, { id: "00000000-0000-4000-8000-000000000000" });
    assert.equal(resUnknown.status, 403, "non-existent UUID gives no hint whether a trip exists");

    // Malformed UUID
    const resBad = await items(salesA, { id: "not-a-uuid" });
    assert.equal(resBad.status, 403, "non-UUID string is refused");
  });
});

describe("portal-key-based trip resolution (combined public+staff deployment)", () => {
  // A combined deployment has no STAFF_DEPLOYMENT_TEMPLATE_KEY env var; instead the portal web server
  // adds x-portal-key to every request it forwards. portalIdentity resolves that to a template key,
  // which the itinerary service uses to look up portal_deployments.
  let h2;
  let salesC;
  let tripC;
  let tripD;
  const PORTAL_SECRET = "test-portal-secret-domestic-none";
  const OTHER_SECRET = "test-portal-secret-domestic-payment";

  beforeEach(async () => {
    await resetTables(pool);
    // No deploymentTemplateKey; portal identity comes from portalSecrets + x-portal-key header
    h2 = await startApp({
      db: pool,
      staff: {},
      portalSecrets: { domestic_none: PORTAL_SECRET, domestic_payment: OTHER_SECRET },
    });
    const admin2 = await h2.staffUser({ role: "admin" });
    salesC = await h2.staffUser({ email: "sales-c@example.com", role: "sales", name: "Sales C" });
    const school2 = (await admin2.as.post("/api/admin/schools", { name: "Portal Key School" })).body.school;
    tripC = (await admin2.as.post(`/api/admin/schools/${school2.id}/trips`, { title: "Jaipur 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    tripD = (await admin2.as.post(`/api/admin/schools/${school2.id}/trips`, { title: "Goa 2027", tourType: "domestic", paymentMode: "payment", academicYear: "2027-28" })).body.trip;
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripC.id]);
  });
  afterEach(() => h2.close());

  const withKey = (secret) => ({ headers: { "x-portal-key": secret } });

  it("Sales resolves the deployment trip via portal key when no deploymentTemplateKey env var is set", async () => {
    const res = await salesC.as.get("/api/admin/itinerary/trips", withKey(PORTAL_SECRET));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips.map((t) => t.id), [tripC.id]);
  });

  it("Sales can add an itinerary item using portal-key-based resolution", async () => {
    const res = await salesC.as.post(`/api/admin/trips/${tripC.id}/itinerary`, { dayNumber: 1, title: "Arrive in Jaipur" }, withKey(PORTAL_SECRET));
    assert.equal(res.status, 201);
    assert.equal(res.body.item.title, "Arrive in Jaipur");
  });

  it("Sales can edit an itinerary item using portal-key-based resolution", async () => {
    const added = await salesC.as.post(`/api/admin/trips/${tripC.id}/itinerary`, { dayNumber: 1, title: "Arrive" }, withKey(PORTAL_SECRET));
    assert.equal(added.status, 201);
    const edited = await salesC.as.patch(`/api/admin/trips/${tripC.id}/itinerary/${added.body.item.id}`, { title: "Arrive and check in" }, withKey(PORTAL_SECRET));
    assert.equal(edited.status, 200);
    assert.equal(edited.body.item.title, "Arrive and check in");
  });

  it("a trip from a different deployment's template key is inaccessible even with the correct portal key", async () => {
    // tripD is bound to domestic_payment; the portal key for domestic_none cannot reach it
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_payment', $1)", [tripD.id]);
    const res = await salesC.as.get(`/api/admin/trips/${tripD.id}/itinerary`, withKey(PORTAL_SECRET));
    assert.equal(res.status, 403);
  });

  it("a different portal key (another deployment's secret) cannot see this deployment's trip", async () => {
    // OTHER_SECRET maps to domestic_payment, which has no portal_deployments row yet → empty list
    const res = await salesC.as.get("/api/admin/itinerary/trips", withKey(OTHER_SECRET));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips, []);
  });

  it("no portal key and no deploymentTemplateKey → empty trip list (safely fails)", async () => {
    // Request carries no x-portal-key header
    const res = await salesC.as.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips, []);
  });

  it("an invalid portal key is treated as no key (safely fails)", async () => {
    const res = await salesC.as.get("/api/admin/itinerary/trips", { headers: { "x-portal-key": "wrong-secret" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips, []);
  });

  it("a parent registered for the trip sees an itinerary item that Sales added via portal key", async () => {
    // Open tripC so parents can register for it
    const admin2 = await h2.staffUser({ role: "admin" });
    await admin2.as.post(`/api/admin/trips/${tripC.id}/status`, { status: "active" });
    await admin2.as.post(`/api/admin/trips/${tripC.id}/public-registration`, { enabled: true });

    // Parent registers for tripC (no portal key needed: PORTAL_BINDING_REQUIRED is not set in tests)
    const verificationToken = await h2.verifiedToken("parent@example.com", "registration");
    const reg = await h2.api.post("/api/registrations", { ...registrationFields("parent@example.com"), verificationToken, publicTrip: slugsOf(tripC) });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cookie = h2.cookieOf(reg);
    const { enrolments } = (await h2.api.get("/api/enrolments", { cookie })).body;
    const enrolmentId = enrolments[0].id;

    // Sales adds an itinerary item using portal-key-based resolution
    const added = await salesC.as.post(`/api/admin/trips/${tripC.id}/itinerary`, { dayNumber: 1, title: "Arrive in Jaipur" }, withKey(PORTAL_SECRET));
    assert.equal(added.status, 201);

    // Parent sees that exact item through the participant-facing itinerary endpoint
    const itin = await h2.api.get(`/api/enrolments/${enrolmentId}/itinerary`, { cookie });
    assert.equal(itin.status, 200);
    assert.equal(itin.body.items.length, 1);
    assert.equal(itin.body.items[0].title, "Arrive in Jaipur");
  });
});

describe("closed trip behavior", () => {
  it("a closed trip that is still the deployment-configured trip remains readable", async () => {
    // Add an itinerary item first
    const added = await add(salesA, tripA);
    assert.equal(added.status, 201);

    // Admin closes the trip via status transitions
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "closed" });

    // The closed trip is still the deployment-configured trip and must remain readable
    const res = await items(salesA, tripA);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0, "itinerary items are still present on the closed trip");
  });
});
