import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createWebServer } from "../../web-server/src/server.js";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// The REAL API behind the REAL portal web servers (one public, one Sales), the way they run on Railway: the API trusts one hop
// and the web server sends it one validated address. What goes through, what is stopped, and what address the API ends up using.
const pool = createTestPool();
after(() => pool.end());

const KEY = "k".repeat(40); // the domestic (without payment) portal
const KEY_INTL = "i".repeat(40); // the international (without payment) portal
const UUID = "123e4567-e89b-42d3-a456-426614174000";

let h;
let publicSite;
let intlSite;
let staffSite;
let tripD; // domestic_none, bound and open
let tripI; // international_none, bound and open
const sites = [];

async function openSite(role, key = KEY) {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-it-"));
  writeFileSync(path.join(dir, "index.html"), "<html>shell</html>");
  const server = createWebServer({
    staticDir: dir, apiUrl: h.base, role, clientIpSource: { mode: "xff", hops: 1 },
    portalSecret: role === "public" ? key : null,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  sites.push(server);
  const call = async (method, p, { body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
  return { base, call, get: (p, o) => call("GET", p, o), post: (p, b, o) => call("POST", p, { ...o, body: b }) };
}

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, trustProxyHops: 1, staff: { requireBinding: true }, portalSecrets: { domestic_none: KEY, international_none: KEY_INTL, domestic_payment: null, international_payment: null } });
  const admin = await h.staffUser({ email: "dev@example.com", role: "admin" });
  const school = (await admin.as.post("/api/admin/schools", { name: "ABC School" })).body.school;
  const make = async (title, tourType) => (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title, tourType, paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripD = await make("Jaipur 2027", "domestic");
  tripI = await make("Tokyo 2027", "international");
  for (const t of [tripD, tripI]) {
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    await admin.as.put(`/api/admin/portal-deployments/${t.templateKey}`, { tripId: t.id });
  }
  publicSite = await openSite("public", KEY);
  intlSite = await openSite("public", KEY_INTL);
  staffSite = await openSite("staff");
});
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => new Promise((r) => s.close(r))));
  await h.close();
});

const register = async (site, email, trip, headers = {}) => {
  const verificationToken = await h.verifiedToken(email, "registration");
  return site.post("/api/registrations", { ...registrationFields(email), verificationToken, publicTrip: slugsOf(trip) }, { headers });
};
const accounts = async () => (await pool.query("SELECT count(*)::int n FROM parent_registrations")).rows[0].n;
const lastLookupIp = async () => (await pool.query("SELECT host(request_ip) AS ip FROM trip_link_lookups ORDER BY created_at DESC, id DESC LIMIT 1")).rows[0]?.ip ?? null;

describe("a parent's workflows still work through a public portal", () => {
  it("emailed code, registration, sign-in, session, the form, the PDF status and logout", async () => {
    const email = "parent@example.com";
    const send = await publicSite.post("/api/email-otp/send", { email, purpose: "registration" });
    assert.equal(send.status, 200);
    h.clock.advance(31_000);
    const verify = await publicSite.post("/api/email-otp/verify", { email, purpose: "registration", code: h.sender.last().code });
    assert.equal(verify.status, 200);
    const reg = await publicSite.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken: verify.body.verificationToken, publicTrip: slugsOf(tripD) });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cookie = reg.setCookie.find((c) => c.startsWith("pp_access=")).split(";")[0];
    assert.match(reg.setCookie.join("\n"), /HttpOnly/i, "the sign-in cookies pass through untouched");

    // Each of these must give through the portal exactly what the API gives when asked directly: the portal adds nothing and
    // blocks nothing here. (A draft has no PDF yet, so the API itself answers 409 for the PDF calls.)
    for (const target of ["/api/auth/session", "/api/onboarding", "/api/enrolments/resume", "/api/onboarding/pdf/status", "/api/onboarding/pdf", `/api/live-location?enrolment=${UUID}`]) {
      const direct = await h.api.get(target, { cookie });
      const viaPortal = await publicSite.get(target, { cookie });
      assert.equal(viaPortal.status, direct.status, target);
      assert.deepEqual(viaPortal.body, direct.body, target);
    }
    assert.equal((await publicSite.get("/api/auth/session", { cookie })).status, 200);
    assert.equal((await publicSite.get("/api/onboarding", { cookie })).status, 200);
    assert.equal((await publicSite.get("/api/enrolments/resume", { cookie })).status, 200);
    assert.equal((await publicSite.get(`/api/live-location?enrolment=${UUID}`)).status, 401, "without a session the API says 401");
    assert.equal((await publicSite.post("/api/auth/logout", undefined, { cookie })).status, 200);
  });

  it("password sign-in and password reset reach the API", async () => {
    const wrong = await publicSite.post("/api/auth/login/password", { email: "nobody@example.com", password: "wrong-wrong-1" });
    assert.equal(wrong.status, 401, "the API's own answer");
    const reset = await publicSite.post("/api/auth/password-reset/request", { email: "nobody@example.com" });
    assert.ok([200, 202, 429].includes(reset.status), String(reset.status));
  });

  it("the public trip page is reached, and a school logo address is too (an unknown one is the API's own 404)", async () => {
    assert.equal((await publicSite.get("/api/join/some-school/main/some-trip")).status, 404);
    assert.equal((await publicSite.get("/api/school-logos/some-school/main?v=1")).status, 404);
  });
});

describe("portal identity end to end: the web server's own key, never the browser's", () => {
  it("a portal registers people only for its own bound trip", async () => {
    assert.equal((await register(publicSite, "a@example.com", tripD)).status, 201);
    assert.equal((await register(intlSite, "b@example.com", tripI)).status, 201);
  });

  it("a portal cannot register anyone for another portal's trip, whatever key the browser claims", async () => {
    const before = await accounts();
    const res = await register(publicSite, "c@example.com", tripI, { "x-portal-key": KEY_INTL, "x-portal-template": "international_none" });
    assert.equal(res.status, 409, "the domestic portal's own key is what the API sees, so the international trip is refused");
    assert.equal(res.body.error.code, "TRIP_NOT_OPEN");
    assert.equal(await accounts(), before);
  });

  it("a sign-up with no trip is refused, as before", async () => {
    const verificationToken = await h.verifiedToken("d@example.com", "registration");
    const res = await publicSite.post("/api/registrations", { ...registrationFields("d@example.com"), verificationToken });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "TRIP_REQUIRED");
  });

  it("the API itself, called directly with no key or a guessed one, still refuses", async () => {
    const verificationToken = await h.verifiedToken("e@example.com", "registration");
    const none = await h.api.post("/api/registrations", { ...registrationFields("e@example.com"), verificationToken, publicTrip: slugsOf(tripD) });
    assert.equal(none.status, 409);
    const guessed = await h.api.post("/api/registrations", { ...registrationFields("e@example.com"), verificationToken, publicTrip: slugsOf(tripD) }, { headers: { "x-portal-key": "g".repeat(40) } });
    assert.equal(guessed.status, 409);
  });
});

describe("Sales through the Sales portal", () => {
  it("signs in, reads the session and lists trips, with the Sales cookies passed through", async () => {
    const { email, password } = await h.makeStaff({ email: "sales@example.com" });
    const login = await staffSite.post("/api/admin/auth/login", { email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = login.setCookie.find((c) => c.startsWith("pp_staff_access=")).split(";")[0];
    assert.equal((await staffSite.get("/api/admin/auth/session", { cookie })).status, 200);
    const trips = await staffSite.get("/api/admin/itinerary/trips", { cookie });
    assert.equal(trips.status, 200);
    assert.deepEqual(trips.body, { trips: [] });
  });
});

describe("what a portal will not forward", () => {
  it("Sales routes through a public portal, and parent routes through the Sales portal, never reach the API", async () => {
    const { email, password } = await h.makeStaff({ email: "sales@example.com" });
    const viaPublic = await publicSite.post("/api/admin/auth/login", { email, password });
    assert.equal(viaPublic.status, 404);
    assert.deepEqual(viaPublic.body, { error: { code: "NOT_FOUND", message: "Not found." } });
    assert.equal(viaPublic.setCookie.length, 0, "no Sales sign-in happened");
    assert.equal((await publicSite.get("/api/admin/itinerary/trips")).status, 404);

    assert.equal((await staffSite.post("/api/auth/login", { email: "a@b.test", verificationToken: "x" })).status, 404);
    assert.equal((await staffSite.post("/api/email-otp/send", { email: "a@b.test", purpose: "login" })).status, 404);
    assert.equal((await staffSite.get("/api/join/a/b/c")).status, 404);
    assert.equal((await publicSite.get("/api/health/ready")).status, 404);
    assert.equal((await staffSite.get("/api/health/ready")).status, 404);
  });

  it("the mobile routes stay on the API for later, and no portal forwards them", async () => {
    const direct = await h.api.post("/api/mobile/auth/login", { email: "x@example.com", password: "whatever-1234" });
    assert.notEqual(direct.status, 404, "the API still serves the mobile routes");
    for (const site of [publicSite, staffSite]) {
      assert.equal((await site.post("/api/mobile/auth/login", { email: "x@example.com", password: "whatever-1234" })).status, 404);
      assert.equal((await site.get("/api/mobile/me")).status, 404);
    }
    const health = await h.api.get("/api/health");
    assert.equal(health.status, 200, "the API's health check is for Railway, not for a portal");
  });

  it("the approved blocks: the enrolment list, discarding a draft and any change-password address", async () => {
    const reg = await register(publicSite, "parent2@example.com", tripD);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const signed = { cookie: reg.setCookie.find((c) => c.startsWith("pp_access=")).split(";")[0] };
    for (const [method, target] of [["GET", "/api/enrolments"], ["DELETE", "/api/onboarding"], ["POST", "/api/auth/password"]]) {
      const res = await fetch(publicSite.base + target, { method, headers: { cookie: signed.cookie } });
      assert.equal(res.status, 404, `${method} ${target}`);
    }
    assert.equal((await h.api.get("/api/enrolments", { cookie: signed.cookie })).status, 200, "the API itself still has the list");
  });
});

describe("the address the API ends up using", () => {
  it("is the one the edge reported (xff:1), however the browser dresses the request", async () => {
    await publicSite.get("/api/join/some-school/main/some-trip", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-real-ip": "7.7.7.7", forwarded: "for=8.8.8.8", "x-forwarded-host": "evil.example" } });
    assert.equal(await lastLookupIp(), "203.0.113.9");
  });

  it("falls back to the connecting address when the edge reported nothing usable", async () => {
    await publicSite.get("/api/join/some-school/main/some-trip", { headers: { "x-forwarded-for": "unknown" } });
    assert.equal(await lastLookupIp(), "127.0.0.1");
    await publicSite.get("/api/join/some-school/main/some-trip");
    assert.equal(await lastLookupIp(), "127.0.0.1");
  });

  it("a forged x-portal-key from a browser changes nothing: the web server's own key is the one the API sees", async () => {
    // The API answers 'no trip' either way; what matters is that the request is not treated as coming from another portal.
    const res = await publicSite.get("/api/join/some-school/main/some-trip", { headers: { "x-portal-key": "f".repeat(40), "x-portal-template": "international_payment" } });
    assert.equal(res.status, 404);
  });
});

describe("the proxy's body limits are the API's own, byte for byte", () => {
  // The web server stops a body that is bigger than the API would accept anyway. If these two ever drift apart a real call
  // could be refused by the proxy (limit too low) or streamed through to be refused by the API (limit too high). So each limit is
  // measured on the real API: a body of exactly the limit is not refused for size by either; one byte more is refused by both.
  const KB = 1024;
  const filler = (n) => `{"x":"${"a".repeat(n - 8)}"}`; // valid JSON of exactly n bytes
  const sizeRefused = (res) => res.status === 413 && res.body?.error?.code === "PAYLOAD_TOO_LARGE";

  const unauthenticated = [
    ["POST", "/api/email-otp/send", 2 * KB, "public"],
    ["POST", "/api/registrations", 4 * KB, "public"],
    ["POST", "/api/auth/login", 4 * KB, "public"],
    ["POST", "/api/auth/password-reset/confirm", 4 * KB, "public"],
    ["POST", "/api/admin/auth/login", 8 * KB, "staff"],
    ["POST", "/api/admin/auth/password/request", 8 * KB, "staff"],
  ];
  for (const [method, target, limit, role] of unauthenticated) {
    it(`${method} ${target}: ${limit} bytes`, async () => {
      const site = role === "public" ? publicSite : staffSite;
      const atLimit = filler(limit);
      const over = filler(limit + 1);
      const send = async (base, body) => {
        const res = await fetch(base + target, { method, headers: { "content-type": "application/json" }, body });
        let json = null;
        try { json = await res.json(); } catch { /* none */ }
        return { status: res.status, body: json };
      };
      const apiAt = await send(h.base, atLimit);
      const apiOver = await send(h.base, over);
      const portalAt = await send(site.base, atLimit);
      const portalOver = await send(site.base, over);
      assert.equal(sizeRefused(apiAt), false, "the API accepts a body of exactly its limit");
      assert.equal(sizeRefused(apiOver), true, "the API refuses one byte more");
      assert.equal(sizeRefused(portalAt), false, "so does the portal's check: it lets exactly that size through");
      assert.equal(sizeRefused(portalOver), true, "and refuses one byte more");
      assert.equal(portalAt.status, apiAt.status, "the portal adds nothing: same answer as the API at the limit");
    });
  }

  it("the routes that need a session: draft save (64 KB), enrolment (2 KB) and live location (1 KB)", async () => {
    const reg = await register(publicSite, "limits@example.com", tripD);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cookie = reg.setCookie.find((c) => c.startsWith("pp_access=")).split(";")[0];
    const send = async (base, method, target, body) => {
      const res = await fetch(base + target, { method, headers: { "content-type": "application/json", cookie }, body });
      let json = null;
      try { json = await res.json(); } catch { /* none */ }
      return { status: res.status, body: json };
    };
    for (const [method, target, limit] of [["PUT", "/api/onboarding", 64 * KB], ["POST", "/api/enrolments", 2 * KB], ["POST", "/api/live-location/start", 1 * KB]]) {
      const apiAt = await send(h.base, method, target, filler(limit));
      const apiOver = await send(h.base, method, target, filler(limit + 1));
      const portalAt = await send(publicSite.base, method, target, filler(limit));
      const portalOver = await send(publicSite.base, method, target, filler(limit + 1));
      assert.equal(sizeRefused(apiAt), false, `${target}: the API accepts exactly ${limit}`);
      assert.equal(sizeRefused(apiOver), true, `${target}: the API refuses ${limit + 1}`);
      assert.equal(sizeRefused(portalAt), false, `${target}: the portal lets ${limit} through`);
      assert.equal(sizeRefused(portalOver), true, `${target}: the portal refuses ${limit + 1}`);
      assert.equal(portalAt.status, apiAt.status, `${target}: same answer at the limit`);
    }
  });
});
