import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { redact, run } from "../scripts/smtp-check.js";

const base = { NODE_ENV: "development", DATABASE_URL: "postgresql://u:pw@localhost:5432/parents_portal_dev", OTP_HMAC_SECRET: "a".repeat(64) };
const smtpEnv = { ...base, OTP_DELIVERY: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "mailer-user-name", SMTP_PASSWORD: "very-secret-app-password", SMTP_FROM: "Young Edsplorer <no-reply@example.com>" };
const lines = () => {
  const out = [];
  return { out, log: (m) => out.push(String(m)) };
};

describe("npm run mail:check (non-destructive SMTP diagnostic)", () => {
  it("verifies the login and says plainly that nothing was sent, without showing credentials", async () => {
    const o = lines();
    let verified = 0;
    const code = await run({ env: smtpEnv, log: o.log, makeSender: () => ({ verify: async () => { verified += 1; } }) });
    assert.equal(code, 0);
    assert.equal(verified, 1);
    const text = o.out.join("\n");
    assert.match(text, /Delivery mode: smtp/);
    assert.match(text, /smtp\.example\.com:587 \(STARTTLS required, no plaintext fallback\)/);
    assert.match(text, /OK: .*No email was sent/);
    assert.match(text, /does not prove a message reaches any particular mailbox/);
    for (const secret of ["mailer-user-name", "very-secret-app-password"]) assert.ok(!text.includes(secret), secret);
  });

  it("reports a refused login as FAILED with exit 1, redacting any credential the provider echoes back", async () => {
    const o = lines();
    const makeSender = () => ({ verify: async () => { throw new Error("SMTP check failed (EAUTH 535): login for mailer-user-name with very-secret-app-password rejected"); } });
    const code = await run({ env: smtpEnv, log: o.log, makeSender });
    assert.equal(code, 1);
    const text = o.out.join("\n");
    assert.match(text, /FAILED: .*EAUTH 535/);
    assert.match(text, /app password/);
    assert.ok(!text.includes("mailer-user-name") && !text.includes("very-secret-app-password"));
    assert.ok(!/OK:/.test(text));
  });

  it("in dev-console mode it says no email is sent and has nothing to verify (exit 3), never contacting a server", async () => {
    const o = lines();
    const code = await run({ env: { ...base, OTP_DELIVERY: "dev-console" }, log: o.log, makeSender: () => { throw new Error("must not be built"); } });
    assert.equal(code, 3);
    assert.match(o.out.join("\n"), /dev-console mode no email is sent/);
  });

  it("a bad configuration is explained (exit 2) and never falls back to console mode", async () => {
    const o = lines();
    const { SMTP_PASSWORD, ...incomplete } = smtpEnv;
    const code = await run({ env: incomplete, log: o.log, makeSender: () => { throw new Error("must not be built"); } });
    assert.equal(code, 2);
    assert.match(o.out.join("\n"), /not falling back to console mode/);
    assert.ok(!o.out.join("\n").includes("very-secret-app-password"));
  });

  it("redact() hides every secret and ignores empty or tiny ones", () => {
    assert.equal(redact("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"]), "a [hidden] b [hidden]");
    assert.equal(redact("abc", ["", undefined, "a"]), "abc");
  });
});

describe("starting a second backend on a busy port", () => {
  it("says the port is in use by another process and exits non-zero, instead of a raw crash", async () => {
    const blocker = createServer();
    await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
    const port = blocker.address().port;
    const script = fileURLToPath(new URL("../src/server.js", import.meta.url));
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, NODE_ENV: "development", OTP_DELIVERY: "dev-console", OTP_HMAC_SECRET: "a".repeat(64), DATABASE_URL: process.env.TEST_DATABASE_URL, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((r) => blocker.close(r));
    assert.equal(code, 1);
    assert.match(output, new RegExp(`Port ${port} is already in use by another process`));
    assert.match(output, /old or test backend with different settings/);
    assert.ok(!/at .*node_modules|EADDRINUSE\n\s+at/.test(output), "no raw stack trace");
  });
});
