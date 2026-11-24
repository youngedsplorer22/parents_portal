import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// Sales are itinerary-only: they may add and edit itinerary items, only for the trip the deployment is configured for
// (portal_deployments). Every other staff route is admin-only. These tests call the API directly, so they prove the
// server refuses, not that a button is hidden.
const pool = createTestPool();
const PORTAL_KEY = "domestic-free-portal-key-0123456789abcdefgh";
let h;
let admin;
let salesA;
let salesB;
let ids; // staff ids by email
let tripA; // the deployment-configured trip (domestic_none)
let tripB; // a different template (domestic_payment) — not configured for this deployment
let school;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, staff: { deploymentTemplateKey: "domestic_none" } });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  salesA = await h.staffUser({ email: "sales-a@example.com", role: "sales", name: "Sales A" });
  salesB = await h.staffUser({ email: "sales-b@example.com", role: "sales", name: "Sales B" });
  const staff = (await admin.as.get("/api/admin/staff")).body.staff;
  ids = Object.fromEntries(staff.map((s) => [s.email, s.id]));
  school = (await admin.as.post("/api/admin/schools", { name: "Delhi Public School" })).body.school;
  tripA = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Jaipur 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripB = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Goa 2027", tourType: "domestic", paymentMode: "payment", academicYear: "2027-28" })).body.trip;
});
afterEach(() => h.close());
after(() => pool.end());

const item = (over = {}) => ({ dayNumber: 1, title: "Arrive in Jaipur", details: "Check in, Amer Fort in the evening.", ...over });
const items = (who, trip) => who.as.get(`/api/admin/trips/${trip.id}/itinerary`);
const add = (who, trip, body = item()) => who.as.post(`/api/admin/trips/${trip.id}/itinerary`, body);
const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe("Sales may use only the itinerary routes: every other staff address does not exist (404)", () => {
  const refused = () => [
    ["get", "/api/admin/schools"],
    ["post", "/api/admin/schools", { name: "Another School" }],
    ["patch", `/api/admin/schools/${school.id}`, { name: "Renamed" }],
    ["delete", `/api/admin/schools/${school.id}/logo`],
    ["get", "/api/admin/trips"],
    ["get", `/api/admin/trips/${tripA.id}`],
    ["post", `/api/admin/schools/${school.id}/trips`, { title: "New", tourType: "domestic", paymentMode: "none" }],
    ["patch", `/api/admin/trips/${tripA.id}`, { title: "Changed" }],
    ["post", `/api/admin/trips/${tripA.id}/status`, { status: "active" }],
    ["post", `/api/admin/trips/${tripA.id}/public-registration`, { enabled: true }],
    ["get", `/api/admin/trips/${tripA.id}/live-location`],
    ["put", `/api/admin/trips/${tripA.id}/live-location/team-lead`, { enrolmentId: "00000000-0000-4000-8000-000000000000" }],
    ["get", "/api/admin/audit"],
    ["get", "/api/admin/staff"],
    ["post", "/api/admin/staff", { email: "x@example.com", name: "X" }],
    ["get", `/api/admin/trips/${tripA.id}/assignments`],
    ["put", `/api/admin/trips/${tripA.id}/assignments/${ids["sales-b@example.com"]}`],
    ["delete", `/api/admin/trips/${tripA.id}/assignments/${ids["sales-a@example.com"]}`],
    ["get", "/api/admin/portal-deployments"],
    ["put", "/api/admin/portal-deployments/domestic_none", { tripId: tripA.id }],
  ];
  it("a Sales user gets 404 NOT_FOUND on every one of them (there is no such route), and nothing changes", async () => {
    const before = { schools: await count("schools"), trips: await count("trips"), staff: await count("staff_users"), assigned: await count("staff_trip_assignments") };
    for (const [method, path, body] of refused()) {
      const res = await salesA.as[method === "delete" ? "del" : method](path, body);
      assert.equal(res.status, 404, `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
    assert.deepEqual(before, { schools: await count("schools"), trips: await count("trips"), staff: await count("staff_users"), assigned: await count("staff_trip_assignments") });
    const [t] = (await pool.query("SELECT title, status, public_registration FROM trips WHERE id = $1", [tripA.id])).rows;
    assert.deepEqual(t, { title: "Jaipur 2027", status: "draft", public_registration: false });
  });

  it("the developer (the test fixture) can still do all of it through the same services", async () => {
    assert.equal((await admin.as.get("/api/admin/schools")).status, 200);
    assert.equal((await admin.as.get("/api/admin/trips")).status, 200);
    assert.equal((await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "active" })).status, 200);
    assert.equal((await admin.as.get("/api/admin/audit")).status, 200);
    assert.equal((await admin.as.get("/api/admin/staff")).status, 200);
  });

  it("without a login every itinerary route is 401", async () => {
    for (const [method, path, body] of [["get", "/api/admin/itinerary/trips"], ["get", `/api/admin/trips/${tripA.id}/itinerary`], ["post", `/api/admin/trips/${tripA.id}/itinerary`, item()]]) {
      assert.equal((await h.api[method](path, body)).status, 401, `${method} ${path}`);
    }
  });
});

describe("Sales reach only the deployment-configured trip", () => {
  beforeEach(async () => {
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripA.id]);
  });

  it("lists the deployment-configured trip, with just what an itinerary editor needs; both Sales users see it", async () => {
    const res = await salesA.as.get("/api/admin/itinerary/trips");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.trips.map((t) => t.id), [tripA.id]);
    assert.deepEqual(Object.keys(res.body.trips[0]).sort(), ["academicYear", "destination", "id", "itineraryCount", "schoolBranch", "schoolName", "status", "title", "tourType"]);
    // salesB has no staff_trip_assignments but sees the same deployment-configured trip
    assert.deepEqual((await salesB.as.get("/api/admin/itinerary/trips")).body.trips.map((t) => t.id), [tripA.id]);
  });

  it("403 on a trip not configured for this deployment, and a trip that does not exist looks the same", async () => {
    const own = (await add(salesA, tripA)).body.item;
    // salesB can access the deployment-configured trip (no assignment needed)
    assert.equal((await items(salesB, tripA)).status, 200, "salesB can access the deployment-configured trip");
    // tripB is domestic_payment — a different deployment, inaccessible
    assert.equal((await items(salesA, tripB)).status, 403, "trip not in this deployment");
    assert.equal((await add(salesA, tripB)).status, 403);
    assert.equal((await items(salesA, { id: "00000000-0000-4000-8000-000000000000" })).status, 403, "unknown id: no hint whether a trip exists");
    assert.equal((await items(salesA, { id: "not-a-uuid" })).status, 403);
    assert.equal((await pool.query("SELECT title FROM trip_itinerary_items WHERE id = $1", [own.id])).rows[0].title, "Arrive in Jaipur");
  });

  it("admin assignment ops still work (idempotent, only to an active Sales account, recorded) but do not gate itinerary access", async () => {
    const put = (staffId, trip = tripB) => admin.as.put(`/api/admin/trips/${trip.id}/assignments/${staffId}`);
    assert.equal((await put(ids["sales-b@example.com"])).status, 200);
    assert.equal((await put(ids["sales-b@example.com"])).status, 200, "again: no error, no duplicate");
    assert.equal((await pool.query("SELECT count(*)::int n FROM staff_trip_assignments WHERE trip_id = $1", [tripB.id])).rows[0].n, 1);
    assert.equal((await put("00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await put("nope")).status, 404);
    assert.equal((await put(ids["sales-a@example.com"], { id: "00000000-0000-4000-8000-000000000000" })).status, 404);
    const list = (await admin.as.get(`/api/admin/trips/${tripB.id}/assignments`)).body.assignments;
    assert.deepEqual(list.map((a) => a.staffId), [ids["sales-b@example.com"]]);
    const audit = (await pool.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id", [tripB.id])).rows.map((r) => r.action);
    assert.ok(audit.includes("trip.assign_sales"));
    // The assignment does NOT grant salesB access to tripB (which is not the deployment-configured trip)
    assert.equal((await items(salesB, tripB)).status, 403);
  });

  it("a deactivated Sales account cannot be assigned (admin API) and cannot sign in", async () => {
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = 'sales-b@example.com'");
    assert.equal((await admin.as.put(`/api/admin/trips/${tripB.id}/assignments/${ids["sales-b@example.com"]}`)).status, 400);
  });
});

describe("itinerary items", () => {
  beforeEach(async () => {
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripA.id]);
  });

  it("Sales add and edit items on an assigned trip, in day order, with the author and times recorded", async () => {
    const a = await add(salesA, tripA, item({ dayNumber: 2, title: "Pushkar" }));
    const b = await add(salesA, tripA, item({ dayNumber: 1, title: "Arrive", position: 0 }));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.body.item.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(a.body.item).sort(), ["createdAt", "dayNumber", "details", "id", "position", "title", "tripId", "updatedAt"]);
    const list = (await items(salesA, tripA)).body.items;
    assert.deepEqual(list.map((i) => i.title), ["Arrive", "Pushkar"]);
    const edited = await salesA.as.patch(`/api/admin/trips/${tripA.id}/itinerary/${a.body.item.id}`, { title: "Pushkar camel fair", details: null });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.item.title, "Pushkar camel fair");
    assert.equal(edited.body.item.details, null);
    assert.equal(edited.body.item.dayNumber, 2, "fields not sent are kept");
    const [row] = (await pool.query("SELECT created_by, updated_by FROM trip_itinerary_items WHERE id = $1", [a.body.item.id])).rows;
    assert.equal(row.created_by, ids["sales-a@example.com"]);
    assert.equal(row.updated_by, ids["sales-a@example.com"]);
    assert.equal(b.status, 201);
  });

  it("validates input on the server: bad days, empty or long titles, control characters, unknown or smuggled fields", async () => {
    const bad = [
      item({ dayNumber: 0 }), item({ dayNumber: 367 }), item({ dayNumber: 1.5 }), item({ dayNumber: "1" }), item({ dayNumber: undefined }),
      item({ title: "" }), item({ title: "   " }), item({ title: "x".repeat(201) }), item({ title: "bad\u0000title" }), item({ title: { a: 1 } }),
      item({ details: "x".repeat(2001) }), item({ position: -1 }), item({ position: 1000 }),
      item({ tripId: tripB.id }), item({ id: "00000000-0000-4000-8000-000000000000" }), item({ createdBy: ids["sales-b@example.com"] }), item({ status: "active" }),
    ];
    for (const body of bad) {
      const res = await add(salesA, tripA, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    assert.equal(await count("trip_itinerary_items"), 0);
    const ok = (await add(salesA, tripA)).body.item;
    for (const patch of [{}, { dayNumber: 0 }, { tripId: tripB.id }, { title: "" }, { updatedBy: "x" }]) {
      assert.equal((await salesA.as.patch(`/api/admin/trips/${tripA.id}/itinerary/${ok.id}`, patch)).status, 400, JSON.stringify(patch));
    }
  });

  it("an item is reachable only through its own trip: a Sales user cannot edit trip B's item through trip A's URL", async () => {
    // Insert an item directly into tripB (tripB is not the deployment-configured trip, so its items cannot be touched via API)
    const { rows } = await pool.query(
      "INSERT INTO trip_itinerary_items (trip_id, day_number, title) VALUES ($1, 1, 'Arrive in Jaipur') RETURNING id",
      [tripB.id],
    );
    const other = { id: rows[0].id };
    const res = await salesA.as.patch(`/api/admin/trips/${tripA.id}/itinerary/${other.id}`, { title: "Cross-trip edit" });
    assert.equal(res.status, 404);
    assert.equal((await pool.query("SELECT title FROM trip_itinerary_items WHERE id = $1", [other.id])).rows[0].title, "Arrive in Jaipur");
    assert.equal((await salesA.as.patch(`/api/admin/trips/${tripA.id}/itinerary/not-a-uuid`, { title: "x" })).status, 404);
  });

  it("there is no way to delete an item through the API, for Sales or for an admin", async () => {
    const it1 = (await add(salesA, tripA)).body.item;
    for (const who of [salesA, admin]) {
      const res = await who.as.del(`/api/admin/trips/${tripA.id}/itinerary/${it1.id}`);
      assert.ok([403, 404, 405].includes(res.status), `delete -> ${res.status}`);
    }
    assert.equal(await count("trip_itinerary_items"), 1);
  });

  it("a closed trip keeps its itinerary and it is still readable", async () => {
    await add(salesA, tripA);
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "closed" });
    assert.equal((await items(salesA, tripA)).body.items.length, 1);
  });

  it("Sales never receive registration, form, PDF or parent data from any itinerary response", async () => {
    await add(salesA, tripA);
    const text = JSON.stringify([(await items(salesA, tripA)).body, (await salesA.as.get("/api/admin/itinerary/trips")).body]);
    assert.doesNotMatch(text, /email|phone|passport|pan|allerg|pdf|registration/i);
  });

  it("a cross-site request is refused", async () => {
    const res = await h.api.post(`/api/admin/trips/${tripA.id}/itinerary`, item(), { cookie: salesA.cookie, headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(await count("trip_itinerary_items"), 0);
  });
});

describe("Sales accounts come only from the admin's list (nothing a visitor does can create one)", () => {
  it("an email that is not on the list cannot sign in, and cannot set a password to get on it", async () => {
    const login = await h.api.post("/api/admin/auth/login", { email: "stranger@example.com", password: "Whatever-pass-1!" });
    assert.equal(login.status, 401);
    const before = await count("staff_users");
    await h.api.post("/api/admin/auth/password/request", { email: "stranger@example.com" });
    const confirm = await h.api.post("/api/admin/auth/password/confirm", { email: "stranger@example.com", verificationToken: "x".repeat(43), password: "Brand-new-pass-12!", confirmPassword: "Brand-new-pass-12!" });
    assert.ok(confirm.status >= 400);
    assert.equal(await count("staff_users"), before);
  });

  it("registering as a parent with that email gives no staff access", async () => {
    const verificationToken = await h.verifiedToken("stranger@example.com", "registration");
    await h.api.post("/api/registrations", { ...registrationFields("stranger@example.com", { role: "Teacher" }), verificationToken });
    assert.equal((await h.api.get("/api/admin/itinerary/trips")).status, 401);
    assert.equal((await h.api.post("/api/admin/auth/login", { email: "stranger@example.com", password: "Whatever-pass-1!" })).status, 401);
    assert.equal(await count("staff_users"), 2);
  });

  it("the admin's staff API can create only Sales accounts, never an admin", async () => {
    const res = await admin.as.post("/api/admin/staff", { email: "new-sales@company.example", name: "New Sales", role: "admin" });
    assert.equal(res.status, 400);
    const ok = await admin.as.post("/api/admin/staff", { email: "New-Sales@Company.example", name: "New Sales" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.staff.role, "sales");
    assert.equal(ok.body.staff.email, "new-sales@company.example", "approval is for the exact address, any domain");
  });
});

describe("portal bindings: a template accepts new registrations only for the trip deployed on it", () => {
  const publish = async (trip) => {
    await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  };
  const bind = (key, trip, who = admin) => who.as.put(`/api/admin/portal-deployments/${key}`, { tripId: trip.id });
  const join = (trip) => { const w = slugsOf(trip); return h.api.get(`/api/join/${w.school}/${w.branch}/${w.trip}`); };
  const register = async (email, trip) => {
    const verificationToken = await h.verifiedToken(email, "registration");
    return h.api.post("/api/registrations", { ...registrationFields(email), verificationToken, publicTrip: slugsOf(trip) });
  };
  let second;
  beforeEach(async () => {
    second = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Udaipur 2027", tourType: "domestic", paymentMode: "none" })).body.trip;
  });

  it("without a binding, nothing changes: an open trip takes registrations (existing behaviour)", async () => {
    await publish(tripA);
    assert.equal((await register("a@example.com", tripA)).status, 201);
  });

  it("with a binding, only the bound trip takes registrations; an older open trip of the same template is closed to them", async () => {
    await publish(tripA);
    await publish(second);
    assert.equal((await bind("domestic_none", second)).status, 200);
    const old = await register("old@example.com", tripA);
    assert.equal(old.status, 409);
    assert.equal(old.body.error.code, "TRIP_NOT_OPEN");
    assert.equal((await register("new@example.com", second)).status, 201);
  });

  it("binding closes the previous trip of that template and switches its public page off; no record is deleted", async () => {
    await publish(tripA);
    const reg = await register("early@example.com", tripA);
    assert.equal(reg.status, 201);
    const before = { regs: await count("parent_registrations"), enrol: await count("trip_enrolments"), trips: await count("trips"), schools: await count("schools") };
    assert.equal((await bind("domestic_none", tripA)).status, 200);
    assert.equal((await bind("domestic_none", second)).status, 200);
    const [old] = (await pool.query("SELECT status, public_registration FROM trips WHERE id = $1", [tripA.id])).rows;
    assert.deepEqual(old, { status: "closed", public_registration: false });
    assert.deepEqual(before, { regs: await count("parent_registrations"), enrol: await count("trip_enrolments"), trips: await count("trips"), schools: await count("schools") });
    assert.equal((await join(tripA)).status, 404, "its public page is off: the one generic 'not available' answer");
  });

  it("a visitor's request cannot pick another trip: words of an unbound trip of the template are refused, not redirected", async () => {
    await publish(tripA);
    await publish(second);
    await bind("domestic_none", second);
    const res = await register("sneaky@example.com", tripA);
    assert.ok([404, 409].includes(res.status));
    assert.equal((await pool.query("SELECT count(*)::int n FROM parent_registrations WHERE email_normalized = 'sneaky@example.com'")).rows[0].n, 0);
  });

  it("an already registered parent keeps their record after the template moves to another school's trip", async () => {
    await publish(tripA);
    await bind("domestic_none", tripA);
    const reg = await register("keeper@example.com", tripA);
    assert.equal(reg.status, 201);
    const cookie = h.cookieOf(reg);
    await bind("domestic_none", second);
    const mine = await h.api.get("/api/enrolments", { cookie });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.match(JSON.stringify(mine.body), /Jaipur 2027/);
    assert.doesNotMatch(JSON.stringify(mine.body), /Udaipur/);
  });

  it("validation: the trip must be of that template, and not archived; only a known template key; only an admin; trips can't be bound twice", async () => {
    assert.equal((await bind("domestic_payment", tripA)).status, 400, "tripA is domestic_none");
    assert.equal((await bind("domestic_none", tripB)).status, 400, "tripB is domestic_payment");
    assert.equal((await bind("not_a_template", tripA)).status, 400);
    assert.equal((await admin.as.put("/api/admin/portal-deployments/domestic_none", { tripId: "00000000-0000-4000-8000-000000000000" })).status, 404);
    assert.equal((await admin.as.put("/api/admin/portal-deployments/domestic_none", { tripId: tripA.id, extra: 1 })).status, 400);
    await admin.as.post(`/api/admin/trips/${second.id}/status`, { status: "archived" });
    assert.equal((await bind("domestic_none", second)).status, 409);
    const list = (await admin.as.get("/api/admin/portal-deployments")).body.deployments;
    assert.deepEqual(list, []);
  });

  it("the public page shows 'not open' for a trip that is not the bound one, but only while its page is on", async () => {
    await publish(tripA);
    await publish(second);
    await bind("domestic_none", second);
    await admin.as.post(`/api/admin/trips/${tripA.id}/public-registration`, { enabled: true });
    const old = await join(tripA);
    assert.equal(old.status, 200);
    assert.equal(old.body.registrationOpen, false);
    assert.equal((await join(second)).body.registrationOpen, true);
  });
});

describe("PORTAL_BINDING_REQUIRED: production can refuse any template that has no binding yet", () => {
  it("when required, an unbound template accepts nobody", async () => {
    await h.close();
    h = await startApp({ db: pool, staff: { requireBinding: true }, portalSecrets: { domestic_none: PORTAL_KEY } });
    admin = await h.staffUser({ email: "admin2@example.com", role: "admin" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${tripA.id}/public-registration`, { enabled: true });
    const w = slugsOf(tripA);
    assert.equal((await h.api.get(`/api/join/${w.school}/${w.branch}/${w.trip}`)).body.registrationOpen, false);
    const verificationToken = await h.verifiedToken("req@example.com", "registration");
    const res = await h.api.post("/api/registrations", { ...registrationFields("req@example.com"), verificationToken, publicTrip: w });
    assert.equal(res.status, 409);
    await admin.as.put("/api/admin/portal-deployments/domestic_none", { tripId: tripA.id });
    assert.equal((await h.api.get(`/api/join/${w.school}/${w.branch}/${w.trip}`)).body.registrationOpen, true);
    const noKey = await h.api.post("/api/registrations", { ...registrationFields("req3@example.com"), verificationToken: await h.verifiedToken("req3@example.com", "registration"), publicTrip: w });
    assert.equal(noKey.status, 409, "bound, but a request with no portal key is not from a portal");
    const ok = await h.api.post("/api/registrations", { ...registrationFields("req2@example.com"), verificationToken: await h.verifiedToken("req2@example.com", "registration"), publicTrip: w }, { headers: { "x-portal-key": PORTAL_KEY } });
    assert.equal(ok.status, 201);
  });

  it("when required, a sign-up with no trip at all is refused too (it would belong to no school), and nothing is created", async () => {
    await h.close();
    h = await startApp({ db: pool, staff: { requireBinding: true } });
    const before = (await pool.query("SELECT count(*)::int n FROM parent_registrations")).rows[0].n;
    const verificationToken = await h.verifiedToken("tripless@example.com", "registration");
    const res = await h.api.post("/api/registrations", { ...registrationFields("tripless@example.com"), verificationToken });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "TRIP_REQUIRED");
    assert.equal((await pool.query("SELECT count(*)::int n FROM parent_registrations")).rows[0].n, before);
  });
});
