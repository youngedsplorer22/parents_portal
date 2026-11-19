import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
});
afterEach(() => h.close());
after(() => pool.end());

const EVIL = { origin: "https://evil.example" };
const writes = [
  ["post", "/api/email-otp/send", { email: "a@example.com", purpose: "registration" }],
  ["post", "/api/email-otp/verify", { email: "a@example.com", purpose: "registration", code: "123456" }],
  ["post", "/api/registrations", {}],
  ["post", "/api/auth/login/password", { email: "a@example.com", password: "x" }],
  ["post", "/api/auth/password-reset/request", { email: "a@example.com" }],
  ["post", "/api/auth/logout", {}],
  ["put", "/api/onboarding", {}],
  ["post", "/api/onboarding/submit", {}],
  ["del", "/api/onboarding"],
  ["post", "/api/enrolments", {}],
  ["post", "/api/live-location/start", {}],
  ["post", "/api/live-location/location", {}],
  ["post", "/api/live-location/stop", {}],
  ["post", "/api/mobile/auth/login", { email: "a@example.com", password: "x" }],
  ["post", "/api/mobile/auth/refresh", { refreshToken: "x" }],
  ["post", "/api/mobile/auth/logout", {}],
  ["post", "/api/admin/auth/login", { email: "a@example.com", password: "x" }],
  ["post", "/api/admin/auth/password/request", { email: "a@example.com" }],
];
const call = (method, path, body, headers) => (method === "del" ? h.api.del(path, { headers }) : h.api[method](path, body, { headers }));

describe("cross-site writes are refused on every API write, not only the staff ones", () => {
  it("a state-changing request from another site is 403 CROSS_SITE_REQUEST before anything else happens", async () => {
    for (const [method, path, body] of writes) {
      const res = await call(method, path, body, EVIL);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error.code, "CROSS_SITE_REQUEST", `${method} ${path}`);
    }
    assert.equal(h.sender.sent.length, 0, "no code was sent for a cross-site request");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM email_otps")).rows[0].n, 0, "and none was created");
  });

  it("a malformed Origin is refused too", async () => {
    for (const origin of ["null", "not a url", "http://"]) {
      const res = await h.api.post("/api/email-otp/send", { email: "a@example.com", purpose: "registration" }, { headers: { origin } });
      assert.equal(res.status, 403, origin);
    }
  });

  it("the same site (the Origin matches the Host) and non-browser clients (no Origin) work normally", async () => {
    const same = await h.api.post("/api/email-otp/send", { email: "same@example.com", purpose: "registration" }, { headers: { origin: h.base } });
    assert.equal(same.status, 200);
    const none = await h.api.post("/api/email-otp/send", { email: "none@example.com", purpose: "registration" });
    assert.equal(none.status, 200);
  });

  it("reads are never blocked (a cross-site GET is harmless), and the public page lookup still works from anywhere", async () => {
    assert.equal((await h.api.get("/api/health", { headers: EVIL })).status, 200);
    const join = await h.api.get("/api/join/some-school/main/some-trip", { headers: EVIL });
    assert.equal(join.status, 404);
    assert.equal(join.body.error.code, "TRIP_NOT_FOUND");
  });
});
