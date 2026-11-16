import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

// An independent attacker's view of the running app (isolated test database, fake mail sender): who can reach what,
// whether one person can reach another's data, and whether the one-time email code can be abused.

const pool = createTestPool();
let h;
let admin;
let school;
let trip;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Trip 2026", tourType: "domestic", academicYear: "2026-27", destination: "Manali", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
});
afterEach(() => h.close());
after(() => pool.end());

async function parentOnTrip(email) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = h.cookieOf(res);
  const enrolments = await h.api.get("/api/enrolments", { cookie });
  assert.equal(enrolments.status, 200);
  return { cookie, registrationId: res.body.registrationId, enrolments: enrolments.body };
}

/** One call shape for every method (api.delete takes its options third, the others second or third). */
const call = (method, path, body, cookie) => {
  const opts = cookie ? { cookie } : undefined;
  if (method === "get") return h.api.get(path, opts);
  if (method === "delete") return h.api.delete(path, undefined, opts);
  return h.api[method](path, body ?? {}, opts);
};

const PARENT_ROUTES = [
  ["get", "/api/auth/session"],
  ["get", "/api/enrolments"],
  ["get", "/api/onboarding"],
  ["put", "/api/onboarding", {}],
  ["post", "/api/onboarding/submit", {}],
  ["get", "/api/onboarding/pdf"],
  ["delete", "/api/onboarding"],
  ["get", "/api/live-location"],
];
const STAFF_ROUTES = [
  ["get", "/api/admin/schools"],
  ["post", "/api/admin/schools", { name: "X" }],
  ["get", "/api/admin/trips"],
  ["get", "/api/admin/audit"],
  ["get", "/api/admin/staff"],
  ["post", "/api/admin/staff", {}],
  ["get", "/api/admin/auth/session"],
];
const MOBILE_ROUTES = [
  ["get", "/api/mobile/me"],
  ["get", "/api/mobile/trips"],
];

describe("nobody signed in", () => {
  for (const [method, path, body] of [...PARENT_ROUTES, ...STAFF_ROUTES, ...MOBILE_ROUTES]) {
    it(`${method.toUpperCase()} ${path} is refused with 401`, async () => {
      const res = await call(method, path, body);
      assert.equal(res.status, 401, JSON.stringify(res.body));
    });
  }
});

describe("one kind of account cannot use another kind's routes", () => {
  it("a parent's cookie opens no staff or mobile route", async () => {
    const { cookie } = await parentOnTrip("parent@example.com");
    for (const [method, path, body] of [...STAFF_ROUTES, ...MOBILE_ROUTES]) {
      const res = await call(method, path, body, cookie);
      assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
    }
  });

  it("a staff cookie opens no parent route", async () => {
    for (const [method, path, body] of PARENT_ROUTES) {
      const res = await call(method, path, body, admin.cookie);
      assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
    }
  });

  it("a refresh cookie is not an access cookie", async () => {
    const { refreshCookie } = await h.signUp("refresh@example.com");
    const res = await h.api.get("/api/enrolments", { cookie: refreshCookie.replace("pp_refresh=", "pp_access=") });
    assert.equal(res.status, 401);
  });

  it("a signed-out session stops working at once", async () => {
    const { cookie } = await parentOnTrip("out@example.com");
    assert.equal((await h.api.get("/api/enrolments", { cookie })).status, 200);
    await h.api.post("/api/auth/logout", {}, { cookie });
    assert.equal((await h.api.get("/api/enrolments", { cookie })).status, 401);
  });
});

describe("staff roles", () => {
  const ADMIN_ONLY = (schoolId) => [
    ["get", "/api/admin/staff"],
    ["post", "/api/admin/staff", { email: "x@example.com", name: "X", role: "admin" }],
    ["get", "/api/admin/audit"],
    ["patch", `/api/admin/schools/${schoolId}`, { name: "Hijacked" }],
  ];

  it("a salesperson gets 403 on every admin-only route, and nothing changes", async () => {
    const sales = await h.staffUser({ email: "sales@example.com", role: "sales", name: "Sam Sales" });
    for (const [method, path, body] of ADMIN_ONLY(school.id)) {
      const res = await sales.as[method](path, ...(body === undefined ? [] : [body]));
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
    }
    const unchanged = await pool.query("SELECT name FROM schools WHERE id = $1", [school.id]);
    assert.equal(unchanged.rows[0].name, "Greenfield Public School");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM staff_users WHERE email_normalized = 'x@example.com'")).rows[0].n, 0, "no staff account was created");
  });

  it("one salesperson cannot see or change another salesperson's school or trip", async () => {
    const one = await h.staffUser({ email: "sales1@example.com", role: "sales", name: "Sam Sales" });
    const two = await h.staffUser({ email: "sales2@example.com", role: "sales", name: "Sia Sales" });
    const ownSchool = (await one.as.post("/api/admin/schools", { name: "Sales One School" })).body.school;
    const ownTrip = (await one.as.post(`/api/admin/schools/${ownSchool.id}/trips`, { title: "One Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
    // positive control: the owner can see their own
    assert.equal((await one.as.get(`/api/admin/trips/${ownTrip.id}`)).status, 200);
    assert.deepEqual((await one.as.get("/api/admin/schools")).body.schools.map((x) => x.id), [ownSchool.id]);
    // the other salesperson gets nothing, and cannot change it
    assert.deepEqual((await two.as.get("/api/admin/schools")).body.schools, []);
    assert.equal((await two.as.get(`/api/admin/trips/${ownTrip.id}`)).status, 404);
    assert.equal((await two.as.post(`/api/admin/trips/${ownTrip.id}/status`, { status: "active" })).status, 404);
    assert.equal((await two.as.patch(`/api/admin/trips/${ownTrip.id}`, { title: "Hijacked" })).status, 404);
    const after = await pool.query("SELECT title, status FROM trips WHERE id = $1", [ownTrip.id]);
    assert.equal(after.rows[0].title, "One Trip");
    assert.notEqual(after.rows[0].status, "active");
  });
});

describe("one parent cannot reach another parent's registration", () => {
  it("a second parent gets nothing of the first parent's form, PDF or enrolment by guessing the id", async () => {
    const a = await parentOnTrip("a@example.com");
    const b = await parentOnTrip("b@example.com");
    const aId = a.enrolments.enrolments[0]?.id;
    assert.ok(aId, "parent A has an enrolment id");
    const own = await h.api.get(`/api/onboarding?enrolment=${aId}`, { cookie: a.cookie });
    assert.equal(own.status, 200, "positive control: A can read their own");
    for (const [method, path, body] of [
      ["get", `/api/onboarding?enrolment=${aId}`],
      ["get", `/api/onboarding/pdf?enrolment=${aId}`],
      ["get", `/api/onboarding/pdf/status?enrolment=${aId}`],
      ["put", "/api/onboarding", { tourType: "domestic", data: { fullName: "Hijacked" }, currentSection: null, version: null, enrolmentId: aId }],
      ["delete", `/api/onboarding?enrolment=${aId}`],
    ]) {
      const res = await call(method, path, body, b.cookie);
      assert.ok([400, 403, 404].includes(res.status), `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    const left = await pool.query("SELECT count(*)::int AS n FROM onboarding_forms WHERE data::text LIKE '%Hijacked%'");
    assert.equal(left.rows[0].n, 0, "nothing was written by the second parent");
    // The query string never picks the form for a write: it lands on the caller's own, never on A's.
    const mine = await h.api.put(`/api/onboarding?enrolment=${aId}`, { tourType: "domestic", data: { fullName: "Mine" }, currentSection: null, version: null }, { cookie: b.cookie });
    assert.equal(mine.status, 200);
    const aForm = await h.api.get(`/api/onboarding?enrolment=${aId}`, { cookie: a.cookie });
    assert.notEqual(aForm.body.form?.data?.fullName, "Mine", "A's form is untouched");
  });
});

describe("cross-site and malformed requests", () => {
  it("a write from another site's Origin is refused on parent, OTP, registration and staff routes", async () => {
    const evil = { headers: { origin: "https://evil.example" } };
    for (const [path, body] of [
      ["/api/email-otp/send", { email: "x@example.com", purpose: "registration" }],
      ["/api/registrations", {}],
      ["/api/auth/login", {}],
      ["/api/admin/auth/login", { email: "admin@example.com", password: "x" }],
    ]) {
      const res = await h.api.post(path, body, evil);
      assert.equal(res.status, 403, `${path} -> ${res.status}`);
    }
    assert.equal(h.sender.sent.length, 0, "no code was sent for the cross-site request");
  });

  it("answers are JSON with hardening headers and no server fingerprint", async () => {
    const res = await h.api.get("/api/health");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-powered-by"), null);
    const nf = await h.api.get("/api/no-such-route");
    assert.equal(nf.status, 404);
    assert.ok(!/at .*\.js:\d+/.test(nf.raw.toString()), "no stack trace");
  });

  it("a school name with markup is only ever returned as JSON data, never as HTML", async () => {
    const evil = (await admin.as.post("/api/admin/schools", { name: "<img src=x onerror=alert(1)> School" })).body.school;
    const res = await h.api.get("/api/admin/schools", { cookie: admin.cookie });
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.ok(evil?.id, "stored as inert text");
  });
});

describe("the one-time email code", () => {
  const send = (email) => h.api.post("/api/email-otp/send", { email, purpose: "registration" });
  const verify = (email, code) => h.api.post("/api/email-otp/verify", { email, purpose: "registration", code });

  it("locks after repeated wrong guesses, even for the right code", async () => {
    const email = "guess@example.com";
    h.clock.advance(31_000);
    assert.equal((await send(email)).status, 200);
    const right = h.sender.last().code;
    const wrong = right === "000000" ? "111111" : "000000";
    let last;
    for (let i = 0; i < 6; i += 1) last = await verify(email, wrong);
    assert.ok([400, 401, 403, 429].includes(last.status));
    const res = await verify(email, right);
    assert.notEqual(res.status, 200, "the right code no longer works once guesses ran out");
  });

  it("a code works once only", async () => {
    const email = "once@example.com";
    h.clock.advance(31_000);
    await send(email);
    const code = h.sender.last().code;
    assert.equal((await verify(email, code)).status, 200);
    assert.notEqual((await verify(email, code)).status, 200);
  });

  it("a code expires", async () => {
    const email = "late@example.com";
    h.clock.advance(31_000);
    await send(email);
    const code = h.sender.last().code;
    h.clock.advance(60 * 60 * 1000);
    assert.notEqual((await verify(email, code)).status, 200);
  });

  it("a code for one email cannot verify another email", async () => {
    h.clock.advance(31_000);
    await send("victim@example.com");
    const code = h.sender.last().code;
    assert.notEqual((await verify("attacker@example.com", code)).status, 200);
  });

  it("sending codes to one address is limited", async () => {
    const email = "flood@example.com";
    let limited = false;
    h.clock.advance(31_000);
    await send(email);
    for (let i = 0; i < 15 && !limited; i += 1) {
      h.clock.advance(31_000);
      const res = await h.api.post("/api/email-otp/resend", { email, purpose: "registration" });
      if (res.status === 429) limited = true;
    }
    assert.ok(limited, "a flood of codes to one address is eventually refused");
  });

  it("a registration token for registration cannot be used to sign in", async () => {
    const email = "swap@example.com";
    const { registrationId } = await h.signUp(email);
    assert.ok(registrationId);
    const token = await h.verifiedToken(email, "registration");
    const res = await h.api.post("/api/auth/login", { email, verificationToken: token });
    assert.notEqual(res.status, 200);
  });
});

describe("what an attacker learns from answers", () => {
  it("asking to reset the password answers the same for a known and an unknown email", async () => {
    await h.signUp("known@example.com");
    h.clock.advance(31_000);
    const known = await h.api.post("/api/auth/password-reset/request", { email: "known@example.com" });
    h.clock.advance(31_000);
    const unknown = await h.api.post("/api/auth/password-reset/request", { email: "nobody-here@example.com" });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(Object.keys(known.body ?? {}).sort(), Object.keys(unknown.body ?? {}).sort());
  });

  it("staff sign-in answers the same for a wrong password and an unknown account", async () => {
    const wrong = await h.api.post("/api/admin/auth/login", { email: "admin@example.com", password: "not-the-password-1" });
    const unknown = await h.api.post("/api/admin/auth/login", { email: "ghost@example.com", password: "not-the-password-1" });
    assert.equal(wrong.status, unknown.status);
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.setCookie, []);
  });

  it("repeated wrong staff passwords lock the account, even for the right password", async () => {
    let last;
    for (let i = 0; i < 12; i += 1) last = await h.api.post("/api/admin/auth/login", { email: "admin@example.com", password: `wrong-password-${i}` });
    assert.ok([423, 429].includes(last.status), `status ${last.status}`);
    const right = await h.api.post("/api/admin/auth/login", { email: "admin@example.com", password: "staff-passphrase-123" });
    assert.notEqual(right.status, 200, "the right password does not get through during the lock");
  });

  it("broken or hostile request bodies answer 4xx, never 500, and leak no internals", async () => {
    const bad = async (path, raw, type = "application/json") => {
      const res = await fetch(h.base + path, { method: "POST", headers: { "content-type": type }, body: raw });
      const text = await res.text();
      assert.ok(res.status >= 400 && res.status < 500, `${path} ${raw.slice(0, 20)} -> ${res.status}`);
      assert.ok(!/node_modules|\bat \S+ \(|SELECT |INSERT /.test(text), `no internals in: ${text.slice(0, 120)}`);
    };
    for (const path of ["/api/registrations", "/api/email-otp/send", "/api/auth/login", "/api/admin/auth/login"]) {
      await bad(path, "{not json");
      await bad(path, "[]");
      await bad(path, "null");
      await bad(path, "\"just a string\"");
      await bad(path, `${"[".repeat(5000)}${"]".repeat(5000)}`);
      await bad(path, "{}", "text/xml");
    }
  });

  it("school logo and join lookups refuse path tricks", async () => {
    for (const path of ["/api/school-logos/..%2f..%2fetc/passwd", "/api/join/..%2f..%2f..%2fetc/passwd/x", "/api/school-logos/%00/main", "/api/join/a'%20OR%20'1'='1/main/x"]) {
      const res = await h.api.get(path);
      assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
    }
  });
});
