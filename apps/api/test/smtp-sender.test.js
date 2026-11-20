import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { createSender } from "../src/create-sender.js";
import { createDevConsoleSender } from "../src/modules/email-otp/senders/dev-console-sender.js";
import { buildMessage, createSmtpSender } from "../src/modules/email-otp/senders/smtp-sender.js";
import { createOtpService } from "../src/modules/email-otp/service.js";
import { counterCodes, createTestPool, errorCode, fakeClock, resetTables, testOtpConfig } from "./helpers.js";

const PASSWORD = "mailer-password-value";
const smtp = { host: "smtp.example.com", port: 587, secure: false, user: "mailer-user", pass: PASSWORD, from: "Young Edsplorer <no-reply@example.com>" };

/** A stand-in for Nodemailer: records options and mail, never opens a network connection. */
function stubTransport({ failSend, failVerify } = {}) {
  const stub = { options: null, mail: [], verifyCalls: 0 };
  stub.createTransport = (options) => {
    stub.options = options;
    return {
      async sendMail(message) {
        if (failSend) throw failSend;
        stub.mail.push(message);
        return { accepted: [message.to] };
      },
      async verify() {
        stub.verifyCalls += 1;
        if (failVerify) throw failVerify;
        return true;
      },
    };
  };
  return stub;
}
const logs = () => {
  const lines = [];
  return { lines, error: (m) => lines.push(String(m)), log: (m) => lines.push(String(m)) };
};
const authError = Object.assign(new Error(`535 Invalid login for ${PASSWORD} to parent@example.com`), { code: "EAUTH", responseCode: 535 });

describe("smtp sender: transport configuration", () => {
  it("passes host, port, secure and credentials from config, with timeouts and hardening", () => {
    const stub = stubTransport();
    createSmtpSender({ smtp, createTransport: stub.createTransport });
    const o = stub.options;
    assert.equal(o.host, "smtp.example.com");
    assert.equal(o.port, 587);
    assert.equal(o.secure, false);
    assert.deepEqual(o.auth, { user: "mailer-user", pass: PASSWORD });
    assert.equal(o.tls.minVersion, "TLSv1.2");
    assert.equal(o.disableFileAccess, true);
    assert.equal(o.disableUrlAccess, true);
    assert.ok(o.connectionTimeout > 0 && o.socketTimeout > 0);
  });

  it("requires STARTTLS on a remote server when secure=false (no plaintext downgrade)", () => {
    const stub = stubTransport();
    createSmtpSender({ smtp, createTransport: stub.createTransport });
    assert.equal(stub.options.requireTLS, true);
  });

  it("does not need requireTLS when using implicit TLS or a localhost test server", () => {
    let stub = stubTransport();
    createSmtpSender({ smtp: { ...smtp, secure: true, port: 465 }, createTransport: stub.createTransport });
    assert.equal(stub.options.requireTLS, false);
    assert.equal(stub.options.secure, true);

    stub = stubTransport();
    createSmtpSender({ smtp: { ...smtp, host: "localhost", port: 1025 }, createTransport: stub.createTransport });
    assert.equal(stub.options.requireTLS, false);
  });
});

describe("smtp sender: sending", () => {
  it("emails the code to the recipient from the configured sender", async () => {
    const stub = stubTransport();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: logs() });
    assert.equal(sender.mode, "smtp");
    await sender.send({ email: "parent@example.com", code: "482913", expiresInSeconds: 300 });

    assert.equal(stub.mail.length, 1);
    const m = stub.mail[0];
    assert.equal(m.to, "parent@example.com");
    assert.equal(m.from, smtp.from);
    assert.ok(m.text.includes("482913") && m.html.includes("482913"));
    assert.match(m.text, /expires in 5 minutes/);
    assert.ok(!m.subject.includes("482913"), "code stays out of the subject line");
  });

  it("never logs the code or the password on success", async () => {
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stubTransport().createTransport, logger: log });
    await sender.send({ email: "parent@example.com", code: "482913", expiresInSeconds: 300 });
    assert.deepEqual(log.lines, []);
  });

  it("describes lifetimes in plain words", () => {
    const text = (s) => buildMessage({ from: "a@b.co", to: "c@d.co", code: "123456", expiresInSeconds: s, appName: "App" }).text;
    assert.match(text(300), /5 minutes/);
    assert.match(text(60), /1 minute\./);
    assert.match(text(90), /90 seconds/);
  });

  it("escapes HTML in the app name so the message cannot be altered", () => {
    const m = buildMessage({ from: "a@b.co", to: "c@d.co", code: "123456", expiresInSeconds: 300, appName: "<script>x</script>" });
    assert.ok(!m.html.includes("<script>"));
    assert.ok(m.html.includes("&lt;script&gt;"));
  });
});

describe("smtp sender: password reset emails", () => {
  it("the reset code email says it is for a password reset and that nothing has changed yet", async () => {
    const stub = stubTransport();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: logs() });
    await sender.send({ email: "parent@example.com", code: "482913", expiresInSeconds: 300, purpose: "password_reset" });
    const m = stub.mail[0];
    assert.match(m.text, /reset your password/);
    assert.match(m.text, /your password has not been changed/);
    assert.ok(m.text.includes("482913"));
    assert.ok(!m.subject.includes("482913"));
  });

  it("the password-changed notice goes to the account's email and contains no code, token or password", async () => {
    const stub = stubTransport();
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: log });
    await sender.sendPasswordChanged({ email: "parent@example.com" });
    const m = stub.mail[0];
    assert.equal(m.to, "parent@example.com");
    assert.equal(m.from, smtp.from);
    assert.match(m.subject, /password was changed/);
    assert.match(m.text, /was just changed/);
    assert.deepEqual(log.lines, []);
  });

  it("a failed notice throws a generic error that doesn't echo the address or SMTP details", async () => {
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stubTransport({ failSend: authError }).createTransport, logger: log });
    await assert.rejects(sender.sendPasswordChanged({ email: "parent@example.com" }), (err) => {
      assert.equal(err.message, "SMTP delivery failed");
      return true;
    });
    assert.ok(!log.lines.join("\n").includes(PASSWORD) && !log.lines.join("\n").includes("parent@example.com"));
  });

  it("the dev-console sender has the notice too, and prints no code", async () => {
    const out = [];
    const sender = createDevConsoleSender({ log: (m) => out.push(m), env: { NODE_ENV: "development" } });
    await sender.sendPasswordChanged({ email: "parent@example.com" });
    assert.equal(out.length, 1);
    assert.match(out[0], /No notification email is sent/);
  });
});

describe("smtp sender: staff password emails", () => {
  const send = async (context) => {
    const stub = stubTransport();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: logs() });
    await sender.send({ email: "staff@example.com", code: "482913", expiresInSeconds: 300, purpose: "staff_password", context });
    return stub.mail[0];
  };

  it("a first-time setup code says it is for SETTING a password, and names the admin panel", async () => {
    const m = await send({ kind: "setup" });
    assert.match(m.subject, /Set up your Young Edsplorer Admin Panel password/);
    assert.match(m.text, /set up your password/);
    assert.match(m.text, /nothing has been changed/);
    assert.ok(m.text.includes("482913") && !m.subject.includes("482913"));
    assert.ok(!/Parent Portal/.test(m.text + m.subject));
  });

  it("a forgot-password code says it is for RESETTING one and that nothing has changed yet", async () => {
    const m = await send({ kind: "reset" });
    assert.match(m.subject, /Reset your Young Edsplorer Admin Panel password/);
    assert.match(m.text, /reset your password/);
    assert.match(m.text, /your password has not been changed/);
  });

  it("a staff code email tells the person it lasts 15 minutes; a parent's still says 5", async () => {
    const stub = stubTransport();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: logs() });
    await sender.send({ email: "staff@example.com", code: "482913", expiresInSeconds: 900, purpose: "staff_password", context: { kind: "setup" } });
    await sender.send({ email: "parent@example.com", code: "482913", expiresInSeconds: 300, purpose: "registration" });
    assert.match(stub.mail[0].text, /expires in 15 minutes/);
    assert.match(stub.mail[1].text, /expires in 5 minutes/);
  });

  it("without a context it defaults to the safer, reset wording; parents' wording is unchanged", async () => {
    assert.match((await send(undefined)).text, /reset your password/);
    const parent = buildMessage({ from: "a@b.c", to: "p@x.y", code: "123456", expiresInSeconds: 300, appName: "Young Edsplorer Parent Portal", purpose: "registration" });
    assert.match(parent.subject, /Young Edsplorer Parent Portal verification code/);
  });

  it("the set/changed notice reaches the account, says which, and contains no code, token or password", async () => {
    const stub = stubTransport();
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: log });
    await sender.sendStaffPasswordChanged({ email: "staff@example.com", firstTime: true });
    await sender.sendStaffPasswordChanged({ email: "staff@example.com", firstTime: false });
    assert.equal(stub.mail[0].to, "staff@example.com");
    assert.match(stub.mail[0].text, /was just set/);
    assert.match(stub.mail[1].text, /was just changed/);
    assert.deepEqual(log.lines, []);
  });

  it("a failed notice throws a generic error that doesn't echo the address or SMTP details", async () => {
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stubTransport({ failSend: authError }).createTransport, logger: log });
    await assert.rejects(sender.sendStaffPasswordChanged({ email: "staff@example.com" }), (err) => err.message === "SMTP delivery failed");
    assert.ok(!log.lines.join("\n").includes(PASSWORD) && !log.lines.join("\n").includes("staff@example.com"));
  });

  it("the dev-console sender labels staff codes and prints the notice without any password", async () => {
    const out = [];
    const sender = createDevConsoleSender({ log: (m) => out.push(m), env: { NODE_ENV: "development" } });
    await sender.send({ email: "staff@example.com", code: "482913", expiresInSeconds: 300, purpose: "staff_password", context: { kind: "setup" } });
    await sender.sendStaffPasswordChanged({ email: "staff@example.com", firstTime: true });
    assert.match(out[0], /\[staff setup\]/);
    assert.match(out[1], /No notification email is sent/);
  });
});

describe("smtp sender: delivery errors", () => {
  it("throws a generic error and logs only the error code, never the message, password or recipient", async () => {
    const log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stubTransport({ failSend: authError }).createTransport, logger: log });
    await assert.rejects(
      sender.send({ email: "parent@example.com", code: "482913", expiresInSeconds: 300 }),
      (err) => err.message === "SMTP delivery failed" && !JSON.stringify(err).includes(PASSWORD),
    );
    assert.deepEqual(log.lines, ["[smtp] delivery failed: EAUTH 535"]);
    const all = log.lines.join(" ");
    for (const secret of [PASSWORD, "parent@example.com", "482913"]) assert.ok(!all.includes(secret), `log leaked ${secret}`);
  });

  it("verify() succeeds on a good connection and sends nothing", async () => {
    const stub = stubTransport();
    await createSmtpSender({ smtp, createTransport: stub.createTransport }).verify();
    assert.equal(stub.verifyCalls, 1);
    assert.equal(stub.mail.length, 0);
  });

  it("verify() fails loudly with the error code and without the password", async () => {
    const bad = Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
    const sender = createSmtpSender({ smtp, createTransport: stubTransport({ failVerify: bad }).createTransport });
    await assert.rejects(sender.verify(), (err) => /SMTP check failed \(EAUTH 535\)/.test(err.message) && !err.message.includes(PASSWORD));
  });
});

describe("sender selection", () => {
  it("builds exactly the sender config names, with no fallback", () => {
    assert.equal(createSender({ delivery: "smtp", smtp }, { logger: logs() }).mode, "smtp");
    assert.equal(createSender({ delivery: "dev-console" }).mode, "dev-console");
    assert.throws(() => createSender({ delivery: "console" }), /Unknown OTP delivery method/);
    assert.throws(() => createSender({}), /Unknown OTP delivery method/);
  });

  it("the dev-console sender refuses to run in production", () => {
    assert.throws(() => createDevConsoleSender({ env: { NODE_ENV: "production" } }), /never run in production/);
    createDevConsoleSender({ env: { NODE_ENV: "development" } });
  });

  it("the dev-console sender prints the code (development only)", async () => {
    const log = logs();
    await createDevConsoleSender({ log: log.log, env: {} }).send({ email: "a@b.co", code: "111222", expiresInSeconds: 300 });
    assert.match(log.lines[0], /\[DEV OTP\] a@b\.co -> 111222 \(expires in 300s\)\. No email is sent\./);
  });
});

describe("registration OTP through the SMTP sender (stubbed transport, real PostgreSQL)", () => {
  const pool = createTestPool();
  const EMAIL = "parent@example.com";
  const SEC = 1000;
  let clock;
  let stub;
  let log;
  let service;

  beforeEach(async () => {
    await resetTables(pool);
    clock = fakeClock();
    stub = stubTransport();
    log = logs();
    const sender = createSmtpSender({ smtp, createTransport: stub.createTransport, logger: log });
    service = createOtpService({ db: pool, sender, config: testOtpConfig(), clock, generateCode: counterCodes() });
  });
  after(() => pool.end());

  const emailedCode = () => stub.mail.at(-1).text.match(/code is (\d{6})/)[1];

  it("send emails a fresh 6-digit code and reports the 5-minute lifetime", async () => {
    const res = await service.send({ email: EMAIL });
    assert.deepEqual(res, { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "smtp", alreadySent: false });
    assert.equal(stub.mail.length, 1);
    assert.match(emailedCode(), /^\d{6}$/);
    assert.match(stub.mail[0].text, /expires in 5 minutes/);
  });

  it("the emailed code verifies successfully and yields a single-use token", async () => {
    await service.send({ email: EMAIL });
    const res = await service.verify({ email: EMAIL, code: emailedCode() });
    assert.equal(res.verified, true);
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token: res.verificationToken }), true);
    assert.equal(await service.consumeVerificationToken({ email: EMAIL, token: res.verificationToken }), false);
  });

  it("the code is valid for the full five minutes and not a moment longer", async () => {
    await service.send({ email: EMAIL });
    const code = emailedCode();
    clock.advance(299 * SEC + 999);
    assert.equal((await service.verify({ email: EMAIL, code })).verified, true);

    await resetTables(pool);
    await service.send({ email: EMAIL });
    clock.advance(300 * SEC);
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: emailedCode() })), "OTP_EXPIRED");
  });

  it("resend is blocked for 30s even though the code lives for 300s, then emails a new code", async () => {
    await service.send({ email: EMAIL });
    const first = emailedCode();
    clock.advance(29 * SEC);
    assert.equal(await errorCode(service.resend({ email: EMAIL })), "RESEND_COOLDOWN");
    assert.equal(stub.mail.length, 1);

    clock.advance(1 * SEC);
    await service.resend({ email: EMAIL });
    assert.equal(stub.mail.length, 2);
    assert.notEqual(emailedCode(), first);
    assert.equal(await errorCode(service.verify({ email: EMAIL, code: first })), "INVALID_CODE");
    assert.equal((await service.verify({ email: EMAIL, code: emailedCode() })).verified, true);
  });

  it("an SMTP failure surfaces as DELIVERY_FAILED, voids the code, and leaks nothing", async () => {
    const failing = createSmtpSender({
      smtp,
      createTransport: stubTransport({ failSend: authError }).createTransport,
      logger: log,
    });
    const svc = createOtpService({ db: pool, sender: failing, config: testOtpConfig(), clock, generateCode: counterCodes() });

    const err = await svc.send({ email: EMAIL }).catch((e) => e);
    assert.equal(err.code, "DELIVERY_FAILED");
    assert.equal(err.status, 502);
    assert.ok(!JSON.stringify([err.message, err.details]).includes(PASSWORD));

    const { rows } = await pool.query("SELECT invalidated_at FROM email_otps");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].invalidated_at, "undelivered code must be invalidated");
    assert.ok(!log.lines.join(" ").match(/\d{6}/), "no OTP in logs");

    // Nothing is stuck: after the cooldown a retry through a working sender succeeds.
    clock.advance(30 * SEC);
    await service.send({ email: EMAIL });
    assert.equal(stub.mail.length, 1);
  });
});
