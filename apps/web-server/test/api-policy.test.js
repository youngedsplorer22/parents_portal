import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkApiTarget, looksLikeApi } from "../src/api-policy.js";

// The web server forwards ONLY the calls the portal's own frontend makes. This list is written out by hand from the endpoint
// inventory (every call in packages/web-core/src/api/*.js and admin/adminApi.js), not derived from the module under test.
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "9b2f6d1c-0a3e-4c52-8f1d-7a6e5d4c3b2a";
const PUBLIC = [
  ["GET", "/api/join/greenfield-public-school/main/winter-trip"],
  ["POST", "/api/registrations"],
  ["POST", "/api/email-otp/send"],
  ["POST", "/api/email-otp/resend"],
  ["POST", "/api/email-otp/verify"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/login/password"],
  ["POST", "/api/auth/password-reset/request"],
  ["POST", "/api/auth/password-reset/resend"],
  ["POST", "/api/auth/password-reset/verify"],
  ["POST", "/api/auth/password-reset/confirm"],
  ["GET", "/api/auth/session"],
  ["POST", "/api/auth/refresh"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/enrolments/resume"],
  ["POST", "/api/enrolments"],
  ["GET", `/api/enrolments/${UUID}/itinerary`],
  ["GET", "/api/onboarding"],
  ["GET", `/api/onboarding?enrolment=${UUID}`],
  ["PUT", "/api/onboarding"],
  ["POST", "/api/onboarding/submit"],
  ["GET", "/api/onboarding/pdf"],
  ["GET", `/api/onboarding/pdf?enrolment=${UUID}`],
  ["GET", "/api/onboarding/pdf/status"],
  ["GET", `/api/onboarding/pdf/status?enrolment=${UUID}`],
  ["POST", "/api/onboarding/pdf/retry"],
  ["GET", "/api/live-location"],
  ["GET", `/api/live-location?enrolment=${UUID}`],
  ["POST", "/api/live-location/start"],
  ["POST", "/api/live-location/location"],
  ["POST", "/api/live-location/stop"],
  ["GET", "/api/school-logos/greenfield-public-school/kolkata"],
  ["GET", "/api/school-logos/greenfield-public-school/kolkata?v=1767225600000"],
];
const STAFF = [
  ["POST", "/api/admin/auth/login"],
  ["GET", "/api/admin/auth/session"],
  ["POST", "/api/admin/auth/refresh"],
  ["POST", "/api/admin/auth/logout"],
  ["POST", "/api/admin/auth/password/request"],
  ["POST", "/api/admin/auth/password/resend"],
  ["POST", "/api/admin/auth/password/verify"],
  ["POST", "/api/admin/auth/password/confirm"],
  ["POST", "/api/admin/auth/password"],
  ["GET", "/api/admin/itinerary/trips"],
  ["GET", `/api/admin/trips/${UUID}/itinerary`],
  ["POST", `/api/admin/trips/${UUID}/itinerary`],
  ["PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID2}`],
];

const ok = (role, method, target) => checkApiTarget(role, method, target);

describe("every call the frontends make is allowed", () => {
  for (const [method, target] of PUBLIC) {
    it(`public: ${method} ${target}`, () => {
      const r = ok("public", method, target);
      assert.equal(r.ok, true);
      assert.equal(r.target, target, "forwarded exactly as validated");
      assert.equal(ok("staff", method, target).ok, false, "the Sales portal never forwards a parent route");
    });
  }
  for (const [method, target] of STAFF) {
    it(`staff: ${method} ${target}`, () => {
      const r = ok("staff", method, target);
      assert.equal(r.ok, true);
      assert.equal(r.target, target);
      assert.equal(ok("public", method, target).ok, true, "a public portal also forwards Sales routes (shared-URL deployment)");
    });
  }
});

describe("blocked on every portal", () => {
  const EVERYWHERE = [
    ["GET", "/api/health"],
    ["GET", "/api/health/live"],
    ["GET", "/api/health/ready"],
    ["POST", "/api/mobile/auth/login"],
    ["POST", "/api/mobile/auth/refresh"],
    ["POST", "/api/mobile/auth/logout"],
    ["GET", "/api/mobile/me"],
    ["GET", "/api/mobile/trips"],
    ["GET", `/api/mobile/trips/${UUID}`],
    ["POST", `/api/mobile/trips/${UUID}/start`],
    ["POST", `/api/mobile/trips/${UUID}/location`],
    ["POST", `/api/mobile/trips/${UUID}/stop`],
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/unknown"],
    ["GET", "/"],
    ["GET", ""],
  ];
  for (const role of ["public", "staff"]) {
    for (const [method, target] of EVERYWHERE) {
      it(`${role}: ${method} ${target || "(empty)"}`, () => assert.equal(ok(role, method, target).ok, false));
    }
  }

  it("the approved blocks: the enrolment list, discarding a draft, and any parent change-password address", () => {
    assert.equal(ok("public", "GET", "/api/enrolments").ok, false);
    assert.equal(ok("public", "DELETE", "/api/onboarding").ok, false);
    assert.equal(ok("public", "DELETE", `/api/onboarding?enrolment=${UUID}`).ok, false);
    for (const p of ["/api/auth/password", "/api/auth/change-password", "/api/auth/password/change"]) {
      for (const m of ["GET", "POST", "PUT", "PATCH"]) assert.equal(ok("public", m, p).ok, false, `${m} ${p}`);
    }
  });

  it("the Sales portal forwards no parent route, and public portals block wrong methods and admin-only paths, whatever the method", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      // Admin paths the public allowlist never includes.
      assert.equal(ok("public", m, `/api/admin/trips/${UUID}/live-location`).ok, false);
      assert.equal(ok("public", m, `/api/admin/trips/${UUID}/live-location/team-lead`).ok, false);
      // The Sales portal never forwards a parent route.
      assert.equal(ok("staff", m, "/api/auth/login").ok, false);
      assert.equal(ok("staff", m, "/api/registrations").ok, false);
      assert.equal(ok("staff", m, "/api/live-location/start").ok, false);
    }
    // Wrong methods on paths the public policy allows.
    assert.equal(ok("public", "GET",    "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "PUT",    "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "DELETE", "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "POST",   "/api/admin/auth/session").ok, false);
    assert.equal(ok("public", "POST",   "/api/admin/itinerary/trips").ok, false);
    assert.equal(ok("public", "PATCH",  "/api/admin/itinerary/trips").ok, false);
    assert.equal(ok("public", "PUT",    `/api/admin/trips/${UUID}/itinerary`).ok, false);
    assert.equal(ok("public", "DELETE", `/api/admin/trips/${UUID}/itinerary`).ok, false);
    assert.equal(ok("public", "GET",    `/api/admin/trips/${UUID}/itinerary/${UUID2}`).ok, false);
    assert.equal(ok("public", "DELETE", `/api/admin/trips/${UUID}/itinerary/${UUID2}`).ok, false);
  });

  it("routes that exist on the API for other callers (staff schools/trips/audit, which the product no longer has) stay blocked", () => {
    for (const p of ["/api/admin/schools", "/api/admin/trips", `/api/admin/trips/${UUID}`, "/api/admin/staff", "/api/admin/audit", "/api/admin/portal-deployments/domestic_none"]) {
      assert.equal(ok("staff", "GET", p).ok, false, p);
      assert.equal(ok("staff", "POST", p).ok, false, p);
      assert.equal(ok("public", "GET", p).ok, false, p);
      assert.equal(ok("public", "POST", p).ok, false, p);
    }
  });

  it("every other HTTP method on an allowed path is blocked", () => {
    const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "get", "Post", "PROPFIND"];
    for (const [role, table] of [["public", PUBLIC], ["staff", STAFF]]) {
      for (const [, target] of table) {
        const path = target.split("?")[0];
        for (const other of METHODS) {
          const allowedHere = table.some(([m2, t2]) => m2 === other && t2.split("?")[0] === path);
          if (!allowedHere) assert.equal(ok(role, other, path).ok, false, `${role} ${other} ${path}`);
        }
      }
    }
  });

  it("an unknown or missing role forwards nothing", () => {
    for (const role of [undefined, null, "", "admin", "mobile", "all", "PUBLIC"]) assert.equal(ok(role, "POST", "/api/auth/login").ok, false, String(role));
  });
});

describe("the raw request target is checked BEFORE any URL parsing", () => {
  const bad = [
    // traversal and dot segments, raw and encoded
    "/api/auth/../admin/auth/login",
    "/api/../api/auth/login",
    "/api/auth/./login",
    "/api/%2e%2e/admin/auth/login",
    "/api/%2E%2E/admin/auth/login",
    "/api/auth/%2e%2e/login",
    "/api/auth/..%2fadmin/auth/login",
    "/api/auth/..%2Fadmin",
    "/api/auth%2f..%2fadmin%2fauth%2flogin",
    "/api/.%2e/admin",
    "/api/auth/login/..",
    "/api/auth/login/.",
    "/api/auth/login.",
    "/api/auth/login/%2e",
    // double encoding, any percent sign in the path
    "/api/%252e%252e/admin/auth/login",
    "/api/auth/%6cogin",
    "/api/%61uth/login",
    "/%61pi/auth/login",
    "/api/auth/login%00",
    "/api/auth/login%0d%0a",
    "/api/auth/login%20",
    "/api/auth/%2Flogin",
    // duplicate separators, trailing slash
    "//api/auth/login",
    "/api//auth/login",
    "/api/auth//login",
    "/api/auth/login/",
    "///api/auth/login",
    // backslashes and semicolons (path parameters), encoded or not
    "/api\\auth\\login",
    "/api/auth\\login",
    "/api/auth/login;x=1",
    "/api/auth;/login",
    "/api/auth/login%5c",
    "/api/auth/login%3b",
    "/api/admin;/auth/login",
    // control characters, whitespace, non-ASCII
    "/api/auth/login\u0000",
    "/api/auth/login\r\nX: y",
    "/api/auth/login\n",
    "/api/auth/login\t",
    "/api/auth/login ",
    "/api/auth/loginé",
    "/api/auth/logın",
    "/api/auth/login‮",
    // case: Express routing is case-insensitive, so any other case must never reach it
    "/API/auth/login",
    "/api/AUTH/login",
    "/Api/auth/login",
    "/api/auth/Login",
    // absolute-form, authority-form, asterisk, fragments, missing leading slash
    "http://evil.example/api/auth/login",
    "https://x/api/auth/login",
    "*",
    "api/auth/login",
    "/api/auth/login#frag",
    "/api/auth/login?#",
    // overlong
    `/api/join/${"a".repeat(71)}/main/x`,
    `/api/join/x/${"a".repeat(71)}/y`,
    `/api/join/x/y/${"a".repeat(71)}`,
    `/api/auth/login?${"a=".repeat(500)}`,
    // slugs: shape
    "/api/join/Greenfield/main/winter",
    "/api/join/green_field/main/winter",
    "/api/join/-green/main/winter",
    "/api/join/green-/main/winter",
    "/api/join/gre--en/main/winter",
    "/api/join/green.field/main/winter",
    "/api/join/a/b",
    "/api/join/a/b/c/d",
    "/api/school-logos/a",
    "/api/school-logos/a/b/c",
    // ids: shape
    "/api/enrolments/not-a-uuid/itinerary",
    "/api/enrolments/123e4567e89b42d3a456426614174000/itinerary",
    `/api/enrolments/${UUID}x/itinerary`,
    `/api/enrolments/${UUID}/itinerary/`,
    `/api/enrolments/${UUID}`,
    `/api/enrolments/${UUID}/itinerary/extra`,
    "/api/enrolments/123e4567-e89b-42d3-a456-42661417400g/itinerary",
    "/api/enrolments/%31%32%33e4567-e89b-42d3-a456-426614174000/itinerary",
  ];
  for (const target of bad) {
    it(`public blocks ${JSON.stringify(target).slice(0, 90)}`, () => {
      assert.equal(ok("public", "GET", target).ok, false);
      assert.equal(ok("public", "POST", target).ok, false);
    });
  }

  it("the Sales portal blocks the same shapes on its own routes", () => {
    for (const target of [
      "/api/admin/../admin/auth/login",
      "/api/admin/%2e%2e/admin/itinerary/trips",
      "/api/admin//itinerary/trips",
      "/api/admin/itinerary/trips/",
      "/api/admin\\itinerary/trips",
      "/api/admin/itinerary/trips;x=1",
      "/API/admin/itinerary/trips",
      "/api/ADMIN/itinerary/trips",
      "/api/admin/trips/not-a-uuid/itinerary",
      `/api/admin/trips/${UUID}/itinerary/not-a-uuid`,
      `/api/admin/trips/${UUID}/itinerary/${UUID2}/x`,
      `/api/admin/trips/${UUID}%2fitinerary`,
    ]) {
      for (const m of ["GET", "POST", "PATCH"]) assert.equal(ok("staff", m, target).ok, false, `${m} ${target}`);
    }
  });
});

describe("query strings: only the named parameters, strictly", () => {
  const good = (t) => assert.equal(ok("public", "GET", t).ok, true, t);
  const bad = (t, method = "GET") => assert.equal(ok("public", method, t).ok, false, t);

  it("accepts the one parameter a route is documented to take, and nothing else", () => {
    good(`/api/onboarding?enrolment=${UUID}`);
    good(`/api/onboarding/pdf?enrolment=${UUID.toUpperCase()}`);
    good(`/api/onboarding/pdf/status?enrolment=${UUID}`);
    good(`/api/live-location?enrolment=${UUID}`);
    good("/api/school-logos/a/b?v=7");
  });

  it("rejects unknown, duplicate, empty, malformed or smuggled parameters", () => {
    bad(`/api/onboarding?enrolment=${UUID}&enrolment=${UUID2}`);
    bad(`/api/onboarding?enrolment=${UUID}&x=1`);
    bad(`/api/onboarding?x=1`);
    bad(`/api/onboarding?`);
    bad(`/api/onboarding?enrolment`);
    bad(`/api/onboarding?enrolment=`);
    bad(`/api/onboarding?enrolment=not-a-uuid`);
    bad(`/api/onboarding?enrolment=${UUID}%00`);
    bad(`/api/onboarding?enrolment=%31${UUID.slice(1)}`);
    bad(`/api/onboarding?enrolment=${UUID};x=1`);
    bad(`/api/onboarding?enrolment=${UUID}&`);
    bad(`/api/onboarding?&enrolment=${UUID}`);
    bad(`/api/onboarding?enrolment=${UUID}#x`);
    bad(`/api/onboarding?enrolment[]=${UUID}`);
    bad(`/api/onboarding?ENROLMENT=${UUID}`);
    bad(`/api/onboarding?enrolment=${UUID}+x`);
    bad(`/api/onboarding?enrolment=${UUID} `);
    bad(`/api/onboarding?enrolment=${UUID}\r\nX: y`);
    bad(`/api/onboarding?enrolment==${UUID}`);
    bad(`/api/onboarding?enrolment=${UUID}=1`);
    bad("/api/school-logos/a/b?v=abc");
    bad("/api/school-logos/a/b?v=");
    bad("/api/school-logos/a/b?v=1&v=2");
    bad("/api/school-logos/a/b?v=1234567890123456");
    bad("/api/school-logos/a/b?enrolment=" + UUID);
    bad(`/api/onboarding/pdf?v=1`);
  });

  it("routes that take no query reject any query at all, even an empty one", () => {
    for (const [method, target] of [
      ["GET", "/api/auth/session?x=1"],
      ["GET", "/api/auth/session?"],
      ["POST", "/api/auth/login?x=1"],
      ["POST", "/api/registrations?a=b"],
      ["GET", `/api/enrolments/${UUID}/itinerary?enrolment=${UUID}`],
      ["GET", "/api/join/a/b/c?x=1"],
      ["GET", "/api/enrolments/resume?x=1"],
      ["PUT", `/api/onboarding?enrolment=${UUID}`],
      ["POST", `/api/onboarding/submit?enrolment=${UUID}`],
      ["POST", `/api/onboarding/pdf/retry?enrolment=${UUID}`],
      ["POST", `/api/live-location/start?enrolment=${UUID}`],
    ]) {
      assert.equal(ok("public", method, target).ok, false, `${method} ${target}`);
    }
    assert.equal(ok("staff", "GET", "/api/admin/itinerary/trips?x=1").ok, false);
    assert.equal(ok("staff", "GET", "/api/admin/auth/session?x=1").ok, false);
  });

  it("forwards the validated query exactly as received", () => {
    assert.equal(ok("public", "GET", `/api/onboarding?enrolment=${UUID}`).target, `/api/onboarding?enrolment=${UUID}`);
  });
});

describe("looksLikeApi: what counts as an API request, in any spelling", () => {
  it("recognises /api in every form a client could use to reach it", () => {
    for (const t of ["/api", "/api/x", "/API/x", "/Api/x", "/api?x=1", "/api%2fadmin", "/api%2Fadmin", "/api\\x", "/api;x", "/%61pi/x", "/%41PI/x", "/api/", "/.%2e/api/x"]) {
      assert.equal(looksLikeApi(t), true, t);
    }
  });
  it("leaves the website's own paths alone", () => {
    for (const t of ["/", "/join/a/b/c", "/assets/a.js", "/apix", "/apiary/x", "/parent/login", "/sales/login", "/healthz", "/index.html"]) {
      assert.equal(looksLikeApi(t), false, t);
    }
  });
});

describe("Sales routes forwarded by public portals: access, body limits and method enforcement", () => {
  for (const [method, target] of STAFF) {
    it(`public allows ${method} ${target}`, () => {
      const pub = ok("public", method, target);
      const sta = ok("staff", method, target);
      assert.equal(pub.ok, true);
      assert.equal(pub.target, target);
      assert.equal(pub.maxBody, sta.maxBody, "body limit matches the staff policy");
    });
  }

  it("wrong methods on Sales paths are blocked for public portals", () => {
    assert.equal(ok("public", "GET",    "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "PUT",    "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "DELETE", "/api/admin/auth/login").ok, false);
    assert.equal(ok("public", "POST",   "/api/admin/auth/session").ok, false);
    assert.equal(ok("public", "POST",   "/api/admin/itinerary/trips").ok, false);
    assert.equal(ok("public", "PATCH",  "/api/admin/itinerary/trips").ok, false);
    assert.equal(ok("public", "PUT",    `/api/admin/trips/${UUID}/itinerary`).ok, false);
    assert.equal(ok("public", "DELETE", `/api/admin/trips/${UUID}/itinerary`).ok, false);
    assert.equal(ok("public", "GET",    `/api/admin/trips/${UUID}/itinerary/${UUID2}`).ok, false);
    assert.equal(ok("public", "DELETE", `/api/admin/trips/${UUID}/itinerary/${UUID2}`).ok, false);
  });

  it("invalid UUIDs in Sales paths are blocked for public portals", () => {
    assert.equal(ok("public", "GET",   "/api/admin/trips/not-a-uuid/itinerary").ok, false);
    assert.equal(ok("public", "POST",  "/api/admin/trips/not-a-uuid/itinerary").ok, false);
    assert.equal(ok("public", "PATCH", `/api/admin/trips/${UUID}/itinerary/not-a-uuid`).ok, false);
    assert.equal(ok("public", "PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID2}/extra`).ok, false);
    assert.equal(ok("public", "GET",   `/api/admin/trips/${UUID}/itinerary/`).ok, false);
  });

  it("admin-management paths not in the public allowlist are blocked on every method", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(ok("public", m, "/api/admin/schools").ok, false);
      assert.equal(ok("public", m, "/api/admin/staff").ok, false);
      assert.equal(ok("public", m, "/api/admin/audit").ok, false);
      assert.equal(ok("public", m, "/api/admin/trips").ok, false);
      assert.equal(ok("public", m, `/api/admin/trips/${UUID}`).ok, false);
      assert.equal(ok("public", m, `/api/admin/trips/${UUID}/live-location`).ok, false);
      assert.equal(ok("public", m, "/api/admin/portal-deployments/domestic_none").ok, false);
    }
  });
});
