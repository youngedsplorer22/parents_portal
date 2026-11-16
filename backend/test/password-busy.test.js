import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { STAFF_PASSWORD, startApp } from "./harness.js";
import { TEST_PASSWORD, createTestPool, registrationFields, resetTables } from "./helpers.js";

// When the server already has as much password-hashing work as it can handle, every route that hashes answers at once
// with 503 SERVER_BUSY and a Retry-After header, instead of leaving the request hanging for minutes. A busy answer
// must never cost the user anything: no counted sign-in attempt, no used-up email verification, no partial change.

const pool = createTestPool();
const SEC = 1000;
const EMAIL = "parent@example.com";
const NEW_PASSWORD = "a-brand-new-passphrase-9";
let h;
let held = [];

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, passwordHashing: { concurrency: 1, maxQueue: 1 } });
});
afterEach(async () => {
  held.forEach((t) => t.release());
  held = [];
  await h.close();
});
after(() => pool.end());

/** Takes every place in the hashing gate, as a burst of other sign-ins would. */
const fill = () => {
  const gate = h.services.passwordGate;
  for (let t = gate.reserve(); t; t = gate.reserve()) held.push(t);
  assert.equal(gate.reserve(), null);
};
const drain = () => {
  held.forEach((t) => t.release());
  held = [];
};
const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

function assertBusy(res) {
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "SERVER_BUSY");
  assert.match(res.body.error.message, /busy/i);
  const retry = Number(res.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 30, `Retry-After was ${res.headers.get("retry-after")}`);
  assert.equal(res.body.error.retryAfterSeconds, retry);
  assert.deepEqual(res.setCookie, [], "no session is ever set on a busy answer");
}

describe("parent password sign-in under load", () => {
  it("answers 503 at once, counts no attempt, and works again when there is room", async () => {
    await h.signUp(EMAIL);
    fill();
    const started = Date.now();
    const res = await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD });
    assert.ok(Date.now() - started < 2000, "refused straight away, not after waiting");
    assertBusy(res);
    assert.equal(await count("password_login_attempts"), 0, "a busy answer is not a sign-in attempt");
    assert.equal(await count("auth_sessions"), 1, "only the sign-up session exists");
    drain();
    const ok = await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD });
    assert.equal(ok.status, 200);
  });

  it("an unknown email gets exactly the same busy answer as a real one (no account discovery)", async () => {
    await h.signUp(EMAIL);
    fill();
    const real = await h.api.post("/api/auth/login/password", { email: EMAIL, password: "wrong-password-123" });
    const unknown = await h.api.post("/api/auth/login/password", { email: "nobody@example.com", password: "wrong-password-123" });
    assertBusy(real);
    assertBusy(unknown);
    assert.deepEqual(unknown.body, real.body);
  });

  it("the sign-in rate limit still applies once there is room: being busy is never a way around it", async () => {
    await h.signUp(EMAIL);
    for (let i = 0; i < 5; i++) assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL, password: `wrong-guess-${i}-xyz` })).status, 401);
    const limited = await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD });
    assert.equal(limited.status, 429);
    assert.equal(h.services.passwordGate.stats().admitted, 0, "every place was handed back");
  });
});

describe("staff sign-in and password changes under load", () => {
  it("staff sign-in answers 503 and counts no attempt", async () => {
    await h.makeStaff({ email: "admin@example.com", role: "admin" });
    fill();
    assertBusy(await h.api.post("/api/admin/auth/login", { email: "admin@example.com", password: STAFF_PASSWORD }));
    assert.equal(await count("staff_login_attempts"), 0);
    assert.equal(await count("staff_sessions"), 0);
    drain();
    assert.equal((await h.api.post("/api/admin/auth/login", { email: "admin@example.com", password: STAFF_PASSWORD })).status, 200);
  });

  it("change-password answers 503 and leaves the old password in place", async () => {
    const admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
    fill();
    assertBusy(await admin.as.post("/api/admin/auth/password", { currentPassword: STAFF_PASSWORD, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }));
    drain();
    assert.equal(await count("staff_login_attempts"), 0);
    assert.equal((await h.staffSignIn("admin@example.com", STAFF_PASSWORD)).res.status, 200, "the old password still works");
  });

  it("first-time setup answers 503 without using up the emailed authorisation", async () => {
    const admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
    assert.equal((await admin.as.post("/api/admin/staff", { email: "sales@example.com", name: "Sam Sales" })).status, 201);
    h.clock.advance(31 * SEC);
    assert.equal((await h.api.post("/api/admin/auth/password/request", { email: "sales@example.com" })).status, 200);
    await new Promise((r) => setTimeout(r, 60));
    const verified = await h.api.post("/api/admin/auth/password/verify", { email: "sales@example.com", code: h.sender.last().code });
    const body = { email: "sales@example.com", verificationToken: verified.body.verificationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    fill();
    assertBusy(await h.api.post("/api/admin/auth/password/confirm", body));
    drain();
    assert.equal((await h.api.post("/api/admin/auth/password/confirm", body)).status, 200, "the same authorisation still works");
  });
});

describe("parent registration and password reset under load", () => {
  it("registration answers 503 and the email verification can still be used afterwards", async () => {
    const verificationToken = await h.verifiedToken(EMAIL, "registration");
    const body = { ...registrationFields(EMAIL), verificationToken };
    fill();
    assertBusy(await h.api.post("/api/registrations", body));
    assert.equal(await count("parent_registrations"), 0);
    drain();
    assert.equal((await h.api.post("/api/registrations", body)).status, 201);
  });

  it("password reset answers 503 and the reset authorisation still works afterwards", async () => {
    await h.signUp(EMAIL);
    h.clock.advance(31 * SEC);
    assert.equal((await h.api.post("/api/auth/password-reset/request", { email: EMAIL })).status, 200);
    const verified = await h.api.post("/api/auth/password-reset/verify", { email: EMAIL, code: h.sender.last().code });
    const body = { email: EMAIL, verificationToken: verified.body.verificationToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    fill();
    assertBusy(await h.api.post("/api/auth/password-reset/confirm", body));
    drain();
    assert.equal((await h.api.post("/api/auth/password-reset/confirm", body)).status, 200);
    assert.equal((await h.api.post("/api/auth/login/password", { email: EMAIL, password: NEW_PASSWORD })).status, 200);
  });
});

describe("work that never hashes is unaffected", () => {
  it("the public trip page, sessions and the health check answer normally while hashing is full", async () => {
    const { cookie } = await h.signUp(EMAIL);
    fill();
    assert.equal((await h.api.get("/api/health")).status, 200);
    assert.equal((await h.api.get("/api/auth/session", { cookie })).status, 200);
    assert.equal((await h.api.get("/api/join/no-school/main/no-trip")).status, 404);
  });
});

describe("every hashing route hands its place back", () => {
  it("after successes and failures alike, the gate is empty again", async () => {
    await h.signUp(EMAIL);
    await h.api.post("/api/auth/login/password", { email: EMAIL, password: TEST_PASSWORD });
    await h.api.post("/api/auth/login/password", { email: EMAIL, password: "wrong-password-123" });
    await h.api.post("/api/auth/login/password", { email: "nobody@example.com", password: "wrong-password-123" });
    await h.api.post("/api/registrations", { ...registrationFields("x@example.com"), verificationToken: "not-a-real-token" });
    await h.api.post("/api/auth/password-reset/confirm", { email: EMAIL, verificationToken: "not-a-real-token", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    const admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
    await admin.as.post("/api/admin/auth/password", { currentPassword: "wrong-password-123", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    assert.deepEqual(h.services.passwordGate.stats(), { running: 0, waiting: 0, admitted: 0 });
  });
});
