import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

// Deployment-based access control for Sales staff: instead of per-user trip assignments,
// the app is configured with a deploymentTemplateKey and reads portal_deployments to find
// which trip is accessible. All authenticated Sales users see the same trip; no
// staff_trip_assignments rows are needed.

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
  // Intentionally do NOT insert any rows into staff_trip_assignments
});

afterEach(() => h.close());
after(() => pool.end());

const item = (over = {}) => ({ dayNumber: 1, title: "Arrive in Jaipur", details: "Check in.", ...over });
const items = (who, trip) => who.as.get(`/api/admin/trips/${trip.id}/itinerary`);
const add = (who, trip, body = item()) => who.as.post(`/api/admin/trips/${trip.id}/itinerary`, body);

describe("deployment-based trip list", () => {
  it("Sales user with zero staff_trip_assignments rows sees the configured trip", async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM staff_trip_assignments");
    assert.equal(rows[0].n, 0, "no staff_trip_assignments rows should exist");

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
    assert.deepEqual(resB.body.trips.map((t) => t.id), [tripA.id], "salesB has no assignments but sees the deployment trip");
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
