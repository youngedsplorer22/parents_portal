import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// The backend knows WHICH public portal a registration came from, from a secret that portal's web server adds (never from the
// browser), and accepts it only for the trip bound to that portal. These tests talk to the API directly, as an attacker would.
const pool = createTestPool();
const SECRET_DOMESTIC = "domestic-free-portal-secret-0123456789abcdef";
const SECRET_INTL = "international-free-portal-secret-0123456789abcd";
const SECRETS = { domestic_none: SECRET_DOMESTIC, international_none: SECRET_INTL, domestic_payment: null, international_payment: null };

let h;
let admin;
let tripD; // domestic_none, bound
let tripI; // international_none, bound

async function open({ required = true } = {}) {
  h = await startApp({ db: pool, staff: { requireBinding: required }, portalSecrets: SECRETS });
  admin = await h.staffUser({ email: "dev@example.com", role: "admin" });
  const school = (await admin.as.post("/api/admin/schools", { name: "ABC School" })).body.school;
  const make = async (title, tourType) => (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title, tourType, paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripD = await make("Jaipur 2027", "domestic");
  tripI = await make("Tokyo 2027", "international");
  for (const t of [tripD, tripI]) {
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    await admin.as.put(`/api/admin/portal-deployments/${t.templateKey}`, { tripId: t.id });
  }
}
beforeEach(async () => {
  await resetTables(pool);
});
afterEach(() => h?.close());
after(() => pool.end());

const register = async (email, trip, key, extra = {}) => {
  const verificationToken = await h.verifiedToken(email, "registration");
  return h.api.post("/api/registrations", { ...registrationFields(email), verificationToken, ...(trip ? { publicTrip: slugsOf(trip) } : {}), ...extra }, { headers: key === undefined ? {} : { "x-portal-key": key } });
};
const accounts = async () => (await pool.query("SELECT count(*)::int n FROM parent_registrations")).rows[0].n;

describe("PORTAL_BINDING_REQUIRED=true: only the right portal, only its bound trip", () => {
  beforeEach(() => open({ required: true }));

  it("a registration from the domestic portal for its own bound trip is accepted", async () => {
    const res = await register("a@example.com", tripD, SECRET_DOMESTIC);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await pool.query("SELECT trip_id FROM trip_enrolments")).rows[0].trip_id, tripD.id);
  });

  it("the same portal cannot register anyone on another template's trip, even a bound and open one", async () => {
    const res = await register("b@example.com", tripI, SECRET_DOMESTIC);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "TRIP_NOT_OPEN");
    assert.equal(await accounts(), 0);
  });

  it("the other portal's secret works for its own trip and not for this one", async () => {
    assert.equal((await register("c@example.com", tripI, SECRET_INTL)).status, 201);
    assert.equal((await register("d@example.com", tripD, SECRET_INTL)).status, 409);
  });

  it("a direct call with no portal key, a wrong key, an empty key or a guessed key is refused and creates nothing", async () => {
    for (const key of [undefined, "", "wrong", SECRET_DOMESTIC.slice(0, -1), "domestic_none", "0".repeat(400)]) {
      const res = await register(`x${Math.abs(String(key).length)}@example.com`, tripD, key);
      assert.equal(res.status, 409, `key ${JSON.stringify(key)?.slice(0, 30)}`);
      assert.equal(res.body.error.code, "TRIP_NOT_OPEN");
    }
    assert.equal(await accounts(), 0);
  });

  it("a request cannot name its portal in the body or in another header: only the secret counts", async () => {
    const res = await register("e@example.com", tripD, undefined, { portal: "domestic_none", templateKey: "domestic_none" });
    assert.ok([400, 409].includes(res.status), String(res.status));
    const viaHeader = await h.api.post("/api/registrations", { ...registrationFields("f@example.com"), verificationToken: await h.verifiedToken("f@example.com", "registration"), publicTrip: slugsOf(tripD) }, { headers: { "x-portal": "domestic_none", "x-portal-template": "domestic_none", "x-forwarded-host": "domestic-free" } });
    assert.equal(viaHeader.status, 409);
    assert.equal(await accounts(), 0);
  });

  it("a sign-up with a valid portal but no trip is refused: a portal registers people for its trip only", async () => {
    const res = await register("g@example.com", null, SECRET_DOMESTIC);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "TRIP_REQUIRED");
  });

  it("a trip that is no longer bound (an older school) refuses everyone, whatever the key", async () => {
    const second = (await admin.as.post(`/api/admin/schools/${tripD.schoolId}/trips`, { title: "Jaipur 2028", tourType: "domestic", paymentMode: "none", academicYear: "2028-29" })).body.trip;
    await admin.as.put(`/api/admin/portal-deployments/domestic_none`, { tripId: second.id });
    const res = await register("h@example.com", tripD, SECRET_DOMESTIC);
    assert.ok([404, 409].includes(res.status));
    assert.equal(await accounts(), 0);
  });

  it("an already registered person can enrol in another trip only through that trip's portal", async () => {
    const first = await register("i@example.com", tripD, SECRET_DOMESTIC);
    const cookie = h.cookieOf(first);
    const enrol = (trip, key) => h.api.post("/api/enrolments", { trip: slugsOf(trip) }, { cookie, headers: key === undefined ? {} : { "x-portal-key": key } });
    assert.equal((await enrol(tripI, SECRET_DOMESTIC)).status, 409, "wrong portal for that trip");
    assert.equal((await enrol(tripI, undefined)).status, 409, "no portal at all");
    assert.equal((await enrol(tripI, SECRET_INTL)).status, 201);
    assert.equal((await pool.query("SELECT count(*)::int n FROM trip_enrolments")).rows[0].n, 2);
  });

  it("people who already registered still sign in, read their registration and itinerary with no portal key at all", async () => {
    const first = await register("j@example.com", tripD, SECRET_DOMESTIC);
    const cookie = h.cookieOf(first);
    assert.equal((await h.api.get("/api/enrolments", { cookie })).status, 200);
    assert.equal((await h.api.get("/api/onboarding", { cookie })).status, 200);
    const mine = (await h.api.get("/api/enrolments", { cookie })).body.enrolments[0].id;
    assert.equal((await h.api.get(`/api/enrolments/${mine}/itinerary`, { cookie })).status, 200);
    const login = await h.logIn("j@example.com");
    assert.equal(login.res.status, 200);
  });
});

describe("PORTAL_BINDING_REQUIRED=false (local use and the combined app)", () => {
  beforeEach(() => open({ required: false }));

  it("a request with no key still works, exactly as before", async () => {
    assert.equal((await register("k@example.com", tripD, undefined)).status, 201);
  });

  it("a request WITH a valid key is still held to its own template's trip", async () => {
    assert.equal((await register("l@example.com", tripI, SECRET_DOMESTIC)).status, 409);
    assert.equal((await register("m@example.com", tripD, SECRET_DOMESTIC)).status, 201);
  });

  it("a wrong key is simply ignored (it proves nothing and grants nothing)", async () => {
    assert.equal((await register("n@example.com", tripD, "wrong-key")).status, 201);
  });
});

describe("configuration of the portal secrets", () => {
  const env = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://parents_portal_app:pw@localhost:5432/parents_portal_dev",
    OTP_HMAC_SECRET: "a".repeat(64),
    OTP_DELIVERY: "dev-console",
  };
  it("the required mode needs at least one secret, and secrets must be long and different", () => {
    assert.throws(() => loadConfig({ ...env, PORTAL_BINDING_REQUIRED: "true" }), ConfigError);
    assert.throws(() => loadConfig({ ...env, PORTAL_PROXY_SECRET_DOMESTIC_NONE: "short" }), ConfigError);
    assert.throws(() => loadConfig({ ...env, PORTAL_PROXY_SECRET_DOMESTIC_NONE: SECRET_DOMESTIC, PORTAL_PROXY_SECRET_INTERNATIONAL_NONE: SECRET_DOMESTIC }), /same value/);
    assert.throws(() => loadConfig({ ...env, PORTAL_PROXY_SECRET_DOMESTIC_NONE: `${SECRET_DOMESTIC} \n` }), ConfigError);
    const ok = loadConfig({ ...env, PORTAL_BINDING_REQUIRED: "true", PORTAL_PROXY_SECRET_DOMESTIC_NONE: SECRET_DOMESTIC });
    assert.equal(ok.portalSecrets.domestic_none, SECRET_DOMESTIC);
    assert.equal(ok.portalSecrets.international_none, null);
    assert.equal(loadConfig(env).portalSecrets.domestic_none, null, "no secrets, not required: allowed (local use)");
  });
  it("an error message names the variable and never prints a secret value", () => {
    try {
      loadConfig({ ...env, PORTAL_PROXY_SECRET_DOMESTIC_NONE: "tooshort" });
      assert.fail("should refuse");
    } catch (err) {
      assert.match(err.message, /PORTAL_PROXY_SECRET_DOMESTIC_NONE/);
      assert.doesNotMatch(err.message, /tooshort/);
    }
  });
});
