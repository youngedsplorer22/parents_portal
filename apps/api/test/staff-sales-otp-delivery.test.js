// Regression: the first-time-setup code of EVERY provisioned Sales account goes to that account's own address,
// from the one configured sender; an address that is not a provisioned account gets nothing, and the server
// log says so (without naming the address) so a missing production row is no longer invisible.
//
// PENDING: "frontend@youngedsplorer.com" (or the correct 5th address, once the typo in
// "frontend@youngedsplorer@gmail.com" is resolved) must be added to SALES below and provisioned in
// the production database with: npm run ops -- sales:allow --email <address> --name "Frontend"
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createOtpService } from "../src/modules/email-otp/service.js";
import { createSmtpSender } from "../src/modules/email-otp/senders/smtp-sender.js";
import { startApp } from "./harness.js";
import { counterCodes, createTestPool, fakeClock, resetTables, testOtpConfig } from "./helpers.js";

const pool = createTestPool();
let h;
const SALES = ["business@youngedsplorer.com", "business2@youngedsplorer.com", "partners@youngedsplorer.com", "corporate@youngedsplorer.com"];
const settle = () => new Promise((r) => setTimeout(r, 80));
const request = (email) => h.api.post("/api/admin/auth/password/request", { email });

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  for (const email of SALES) {
    await pool.query("INSERT INTO staff_users (email_normalized, display_name, role) VALUES ($1, $2, 'sales')", [email, email.split("@")[0]]);
  }
});
afterEach(() => h.close());
after(() => pool.end());

describe("Sales first-time setup code recipient", () => {
  for (const email of SALES) {
    it(`${email} receives its own code, and only it`, async () => {
      const res = await request(email);
      assert.equal(res.status, 200);
      await settle();
      assert.equal(h.sender.sent.length, 1);
      assert.equal(h.sender.last().email, email);
      assert.equal(h.sender.last().purpose, "staff_password");
      assert.deepEqual(h.sender.last().context, { kind: "setup" });
    });
  }

  it("normalises case and whitespace to the stored address", async () => {
    assert.equal((await request("  Partners@YoungEdsplorer.COM ")).status, 200);
    await settle();
    assert.equal(h.sender.last().email, "partners@youngedsplorer.com");
  });

  it("all four can ask in turn; each mail goes to a different, correct recipient", async () => {
    for (const email of SALES) await request(email);
    await settle();
    assert.deepEqual(h.sender.sent.map((m) => m.email).sort(), [...SALES].sort());
  });

  it("an address that is not a provisioned account gets no mail, the same answer, and a server warning without the address", async () => {
    const stranger = "stranger@example.com";
    const known = await request(SALES[0]);
    const unknown = await request(stranger);
    await settle();
    assert.equal(unknown.status, known.status);
    assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(known.body).sort());
    assert.deepEqual(h.sender.sent.map((m) => m.email), [SALES[0]]);
    assert.equal(h.warned.length, 1);
    assert.match(h.warned[0], /no active staff account/);
    assert.ok(!h.warned.join().includes("stranger") && !h.warned.join().includes("example.com"));
  });

  it("a deactivated account gets no mail", async () => {
    await pool.query("UPDATE staff_users SET disabled_at = now() WHERE email_normalized = $1", [SALES[1]]);
    await request(SALES[1]);
    await settle();
    assert.equal(h.sender.sent.length, 0);
  });
});

describe("background delivery failure", () => {
  it("when SMTP fails: send() resolves normally, logger.warn fires, code is voided and verify fails", async () => {
    // The staff password flow uses delivery:"background" so the caller cannot time the difference
    // between existing and non-existing accounts. When SMTP fails the OTP service must:
    //   1. NOT propagate the error to the caller
    //   2. log a warning (visible in Railway logs) without exposing the recipient address
    //   3. void the OTP so it can never be verified
    const warned = [];
    const failingSender = {
      mode: "smtp",
      async send() { throw Object.assign(new Error("Auth failed"), { code: "EAUTH", responseCode: 535 }); },
    };
    const clock = fakeClock();
    clock.advance(31 * 1000);
    const svc = createOtpService({
      db: pool,
      sender: failingSender,
      config: testOtpConfig(),
      clock,
      generateCode: counterCodes(),
      logger: { warn: (m) => warned.push(m), error() {} },
    });

    const res = await svc.send({ email: "smtpfail@youngedsplorer.com", purpose: "staff_password", delivery: "background" });
    assert.equal(typeof res.expiresInSeconds, "number", "resolves to the standard response shape");

    await settle();
    assert.ok(warned.some((m) => /background delivery failed/i.test(m)), `logger.warn must mention the failure; got: ${JSON.stringify(warned)}`);

    // The code is voided — verify throws (not found)
    const err = await svc.verify({ email: "smtpfail@youngedsplorer.com", purpose: "staff_password", code: "000001" }).catch((e) => e);
    assert.equal(err?.status, 404, "voided OTP must not be verifiable");
  });
});

describe("SMTP sender envelope", () => {
  it("sends FROM the configured Gmail sender TO the account's address, with the code only in the body", async () => {
    const mails = [];
    const sender = createSmtpSender({
      smtp: { host: "smtp.gmail.com", port: 587, secure: false, user: "rishikasadhukhan@gmail.com", pass: "x", from: "rishikasadhukhan@gmail.com" },
      createTransport: () => ({ sendMail: async (m) => mails.push(m) }),
      logger: { error() {} },
    });
    for (const email of SALES) await sender.send({ email, code: "123456", expiresInSeconds: 900, purpose: "staff_password", context: { kind: "setup" } });
    assert.deepEqual(mails.map((m) => m.to), SALES);
    assert.ok(mails.every((m) => m.from === "rishikasadhukhan@gmail.com"));
    assert.ok(mails.every((m) => !m.subject.includes("123456") && m.text.includes("123456")));
  });

  it("an SMTP failure is logged by error code only (no address, no code) and voids the code", async () => {
    const logs = [];
    const sender = createSmtpSender({
      smtp: { host: "smtp.gmail.com", port: 587, secure: false, user: "u", pass: "secret-pass", from: "u@gmail.com" },
      createTransport: () => ({ sendMail: async () => { throw Object.assign(new Error("550 rejected partners@youngedsplorer.com secret-pass"), { code: "EENVELOPE", responseCode: 550 }); } }),
      logger: { error: (m) => logs.push(m) },
    });
    await assert.rejects(sender.send({ email: SALES[2], code: "654321", expiresInSeconds: 900, purpose: "staff_password" }), /SMTP delivery failed/);
    const all = logs.join();
    assert.match(all, /EENVELOPE 550/);
    assert.ok(!all.includes("youngedsplorer") && !all.includes("654321") && !all.includes("secret-pass"));
  });
});
