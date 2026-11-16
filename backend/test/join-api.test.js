import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables, slugsOf } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let school;
let trip;
const open = async (staff) => {
  h = await startApp({ db: pool, staff });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
};
beforeEach(async () => {
  await resetTables(pool);
  await open();
  school = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "international", destination: "Japan", paymentMode: "payment" })).body.trip;
});
afterEach(() => h.close());
after(() => pool.end());

const activate = (status = "active", t = trip) => admin.as.post(`/api/admin/trips/${t.id}/status`, { status });
const setPublic = (enabled, t = trip) => admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled });
const publish = async (t = trip) => {
  await activate("active", t);
  await setPublic(true, t);
};
const resolveWords = (w, opts) => h.api.get(`/api/join/${w.school}/${w.branch}/${w.trip}`, opts);
const resolve = (t = trip, opts) => resolveWords(slugsOf(t), opts);
const GENERIC = { error: { code: "TRIP_NOT_FOUND", message: "This registration page isn't available. Please check the address with your school." } };

describe("the public page address", () => {
  it("is /join/<school>/<branch>/<trip>: readable words, no token, 'main' when the school has no branch", () => {
    assert.equal(trip.publicPath, "/join/greenfield-public-school/main/winter-trip");
    assert.equal(trip.publicRegistration, false, "off by default");
    assert.equal(trip.publicUrl, "https://parents.example.test/join/greenfield-public-school/main/winter-trip");
  });

  it("uses the branch word when the school has a branch", async () => {
    const s = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School", branch: "Kolkata Branch" })).body.school;
    const t = (await admin.as.post(`/api/admin/schools/${s.id}/trips`, { title: "Winter Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    assert.equal(t.publicPath, "/join/greenfield-public-school/kolkata-branch/winter-trip");
  });

  it("gives no full URL when PUBLIC_BASE_URL isn't configured (the panel then uses its own origin)", async () => {
    await h.close();
    await resetTables(pool);
    await open({ publicBaseUrl: null });
    const s2 = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School" })).body.school;
    const got = (await admin.as.post(`/api/admin/schools/${s2.id}/trips`, { title: "Winter Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    assert.equal(got.publicUrl, null);
    assert.equal(got.publicPath, "/join/greenfield-public-school/main/winter-trip");
  });

  it("duplicate trip titles in one school get distinct words, so each address names exactly one trip", async () => {
    const t2 = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    const t3 = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter  trip!", tourType: "domestic", paymentMode: "none" })).body.trip;
    assert.deepEqual([trip, t2, t3].map((t) => slugsOf(t).trip), ["winter-trip", "winter-trip-2", "winter-trip-3"]);
    for (const t of [trip, t2, t3]) await publish(t);
    assert.equal((await resolve(t2)).body.trip.tourType, "domestic");
    assert.equal((await resolve(trip)).body.trip.tourType, "international");
  });

  it("the same trip title at another school or branch is a different address", async () => {
    const other = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School", branch: "Delhi" })).body.school;
    const t2 = (await admin.as.post(`/api/admin/schools/${other.id}/trips`, { title: "Winter Trip", tourType: "domestic", destination: "Delhi", paymentMode: "none" })).body.trip;
    assert.equal(t2.publicPath, "/join/greenfield-public-school/delhi/winter-trip");
    await publish();
    await publish(t2);
    assert.equal((await resolve(trip)).body.trip.destination, "Japan");
    assert.equal((await resolve(t2)).body.trip.destination, "Delhi");
    assert.deepEqual((await resolve(t2)).body.school, { name: "Greenfield Public School", branch: "Delhi" });
  });

  it("schools whose names make the same words get distinct words", async () => {
    await admin.as.patch(`/api/admin/schools/${school.id}`, { name: "Old Name" }); // frees the name, not the words
    const again = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School!" })).body.school;
    assert.equal(again.slug, "greenfield-public-school-2");
    assert.equal(again.branchSlug, "main");
  });

  it("renaming the school, branch or trip never changes or moves an address", async () => {
    await publish();
    const before = trip.publicPath;
    await admin.as.patch(`/api/admin/schools/${school.id}`, { name: "Renamed School", branch: "North" });
    await admin.as.patch(`/api/admin/trips/${trip.id}`, { title: "Summer Camp" });
    // A NEW trip that takes the old title gets new words, never the old address.
    const newcomer = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    const now = (await admin.as.get(`/api/admin/trips/${trip.id}`)).body.trip;
    assert.equal(now.publicPath, before);
    assert.notEqual(newcomer.publicPath, before);
    const res = await resolve(trip);
    assert.equal(res.status, 200);
    assert.equal(res.body.trip.title, "Summer Camp");
    assert.deepEqual(res.body.school, { name: "Renamed School", branch: "North" });
  });

  it("no token, token hint or link row is created for a trip or its page", async () => {
    await publish();
    await resolve();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trip_links")).rows[0].n, 0);
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(trip.publicPath));
    for (const key of ["token", "tokenHint", "links", "activeLinkCount"]) assert.ok(!(key in trip), key);
  });
});

describe("GET /api/join/:school/:branch/:trip", () => {
  it("returns only what a parent page needs: school, trip, destination, tour type, open/closed", async () => {
    await publish();
    const res = await resolve();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      school: { name: "Greenfield Public School" },
      trip: { title: "Winter Trip", destination: "Japan", tourType: "international" },
      registrationOpen: true,
    });
  });

  it("exposes no ids, payment mode, template, status, dates, staff or parent details", async () => {
    await publish();
    const res = await resolve();
    const text = JSON.stringify(res.body);
    for (const leak of [school.id, trip.id, "payment", "templateKey", "admin@example.com", "createdBy", "status", "publicRegistration", "@"]) {
      assert.ok(!text.includes(leak), leak);
    }
  });

  it("is never cached, needs no login and sets no cookie", async () => {
    await publish();
    const res = await resolve();
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(res.setCookie, []);
  });

  it("an active trip is NOT public until staff switch public registration on, and switching off hides it again", async () => {
    await activate();
    assert.deepEqual((await resolve()).body, GENERIC);
    await setPublic(true);
    assert.equal((await resolve()).status, 200);
    await setPublic(false);
    assert.equal((await resolve()).status, 404);
  });

  it("a draft trip with public registration on is still not shown", async () => {
    await setPublic(true);
    const res = await resolve();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, GENERIC);
  });

  it("a closed public trip shows the page with registration closed, and reopening reopens it", async () => {
    await publish();
    await activate("closed");
    const closed = await resolve();
    assert.equal(closed.status, 200);
    assert.equal(closed.body.registrationOpen, false);
    await activate("active");
    assert.equal((await resolve()).body.registrationOpen, true);
  });

  it("respects the trip's opening and closing times", async () => {
    await publish();
    await pool.query("UPDATE trips SET opens_at = now() + interval '1 day' WHERE id = $1", [trip.id]);
    assert.equal((await resolve()).body.registrationOpen, false, "not yet open");
    await pool.query("UPDATE trips SET opens_at = now() - interval '2 days', closes_at = now() - interval '1 day' WHERE id = $1", [trip.id]);
    assert.equal((await resolve()).body.registrationOpen, false, "already past closing");
    await pool.query("UPDATE trips SET closes_at = now() + interval '1 day' WHERE id = $1", [trip.id]);
    assert.equal((await resolve()).body.registrationOpen, true);
  });

  it("unknown, misspelt, malformed, archived-trip, archived-school and private trips ALL give the same failure", async () => {
    await publish();
    const t2 = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Archived", tourType: "domestic", paymentMode: "none" })).body.trip;
    await publish(t2);
    await activate("archived", t2);
    const s2 = (await admin.as.post("/api/admin/schools", { name: "Other School" })).body.school;
    const t3 = (await admin.as.post(`/api/admin/schools/${s2.id}/trips`, { title: "T3", tourType: "domestic", paymentMode: "none" })).body.trip;
    await publish(t3);
    await admin.as.patch(`/api/admin/schools/${s2.id}`, { status: "archived" });
    const t4 = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Private", tourType: "domestic", paymentMode: "none" })).body.trip;
    await activate("active", t4);

    const w = slugsOf(trip);
    const cases = {
      unknownTrip: { ...w, trip: "nope" }, wrongBranch: { ...w, branch: "delhi" }, wrongSchool: { ...w, school: "other-school" },
      upperCase: { ...w, trip: "Winter-Trip" }, badChars: { ...w, trip: "winter_trip" }, tooLong: { ...w, trip: "a".repeat(71) },
      oldToken: { ...w, trip: "A".repeat(43) },
      archivedTrip: slugsOf(t2), archivedSchool: slugsOf(t3), privateTrip: slugsOf(t4),
    };
    for (const [name, words] of Object.entries(cases)) {
      const res = await resolveWords(words);
      assert.equal(res.status, 404, name);
      assert.deepEqual(res.body, GENERIC, name);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8", name);
    }
  });

  it("the old secret-token address /api/join/<token> no longer resolves anything", async () => {
    await publish();
    const res = await h.api.get(`/api/join/${"A".repeat(43)}`);
    assert.equal(res.status, 404);
    assert.equal(res.body?.trip, undefined);
  });

  it("the address words can't be used as any kind of login", async () => {
    await publish();
    for (const cookie of [`pp_session=${slugsOf(trip).trip}`, `pp_staff_session=${slugsOf(trip).trip}`]) {
      assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 401);
      assert.equal((await h.api.get("/api/admin/schools", { cookie })).status, 401);
    }
  });
});

describe("staff switch for public registration", () => {
  it("admin and the owning salesperson can switch it on and off; each change is audited once; another salesperson can't", async () => {
    const sales = await h.staffUser({ email: "sales@example.com", role: "sales" });
    // the shared trip belongs to an admin's school: a salesperson who didn't create the school gets "not found"
    assert.equal((await sales.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true })).status, 404);
    const own = (await sales.as.post("/api/admin/schools", { name: "Sales School" })).body.school;
    const ownTrip = (await sales.as.post(`/api/admin/schools/${own.id}/trips`, { title: "Own Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    let res = await sales.as.post(`/api/admin/trips/${ownTrip.id}/public-registration`, { enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.trip.publicRegistration, true);
    res = await sales.as.post(`/api/admin/trips/${ownTrip.id}/public-registration`, { enabled: true }); // no change
    assert.equal(res.status, 200);
    res = await setPublic(false, ownTrip);
    assert.equal(res.body.trip.publicRegistration, false);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'trip.public%' ORDER BY created_at", [ownTrip.id]);
    assert.deepEqual(rows.map((r) => r.action), ["trip.public_on", "trip.public_off"]);
  });

  it("is independent of the trip's status and payment mode", async () => {
    await setPublic(true);
    const t = (await admin.as.get(`/api/admin/trips/${trip.id}`)).body.trip;
    assert.equal(t.status, "draft");
    assert.equal(t.paymentMode, "payment");
    await activate();
    await activate("closed");
    assert.equal((await admin.as.get(`/api/admin/trips/${trip.id}`)).body.trip.publicRegistration, true);
  });

  it("needs a staff login; a parent session or no session is refused", async () => {
    assert.equal((await h.api.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true })).status, 401);
    const verificationToken = await h.verifiedToken("p@example.com", "registration");
    const { registrationFields } = await import("./helpers.js");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("p@example.com"), verificationToken });
    const parent = await h.api.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true }, { cookie: h.cookieOf(reg) });
    assert.equal(parent.status, 401);
    assert.equal((await pool.query("SELECT public_registration FROM trips WHERE id = $1", [trip.id])).rows[0].public_registration, false);
  });

  it("an archived trip can't be changed; bad bodies and unknown trips are refused", async () => {
    await activate("archived");
    assert.equal((await setPublic(true)).status, 409);
    for (const body of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      assert.equal((await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await admin.as.post("/api/admin/trips/00000000-0000-4000-8000-000000000000/public-registration", { enabled: true })).status, 404);
    assert.equal((await admin.as.post("/api/admin/trips/not-a-uuid/public-registration", { enabled: true })).status, 404);
  });

  it("the old link management API is gone", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, path] of [["get", `/api/admin/trips/${trip.id}/links`], ["post", `/api/admin/trips/${trip.id}/links`], ["post", `/api/admin/links/${id}/revoke`], ["patch", `/api/admin/links/${id}`]]) {
      const res = await admin.as[method](path, method === "get" ? undefined : {});
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

describe("rate limit on public lookups", () => {
  beforeEach(async () => {
    await h.close();
    await resetTables(pool);
    await open({ joinLookups: { windowSeconds: 60, max: 3 } });
    school = (await admin.as.post("/api/admin/schools", { name: "Rate School" })).body.school;
    trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none" })).body.trip;
    await publish();
  });
  const unknown = () => resolveWords({ school: "rate-school", branch: "main", trip: "nope" });

  it("limits per IP, counting valid and invalid lookups alike", async () => {
    const codes = [];
    for (const f of [() => resolve(), unknown, unknown, () => resolve(), () => resolve()]) codes.push((await f()).status);
    assert.deepEqual(codes, [200, 404, 404, 429, 429]);
    const blocked = await resolve();
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  });

  it("a blocked request reveals nothing about whether the trip exists", async () => {
    for (let i = 0; i < 3; i++) await unknown();
    const a = await resolve();
    const b = await unknown();
    assert.equal(a.status, 429);
    assert.deepEqual(a.body, b.body);
  });

  it("lookups age out of the window", async () => {
    for (let i = 0; i < 3; i++) await unknown();
    assert.equal((await unknown()).status, 429);
    await pool.query("UPDATE trip_link_lookups SET created_at = created_at - interval '61 seconds'");
    assert.equal((await unknown()).status, 404);
  });

  it("parallel lookups cannot slip past the limit", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, unknown));
    assert.equal(results.filter((r) => r.status === 404).length, 3);
    assert.equal(results.filter((r) => r.status === 429).length, 7);
  });

  it("only the IP address and time are recorded, never the address words", async () => {
    await unknown();
    const rows = (await pool.query("SELECT * FROM trip_link_lookups")).rows;
    assert.deepEqual(Object.keys(rows[0]).sort(), ["created_at", "id", "request_ip"]);
  });
});
