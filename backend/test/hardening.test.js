import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { emailSchema } from "../src/modules/email-otp/validation.js";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

describe("email addresses: only plain forms reach the mailer (defence in depth for the nodemailer addressparser advisories)", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of ["parent@example.com", "first.last+tag@school-mail.co.in", "a_b-c@sub.example.org", "  Mixed@Example.COM "]) {
      assert.equal(emailSchema.safeParse(ok).success, true, ok);
    }
  });

  it("refuses comments, quotes, groups and lists that an address parser could split into extra recipients", () => {
    for (const bad of ['"x;y"@example.com', "a(b;c)@example.com", "a(b(c)d)@example.com", "a,b@example.com", "a;b@example.com", "a:b@example.com",
      "<a@example.com>", "a@[127.0.0.1]", "a\\b@example.com", "a@example.com,b@evil.example", "a@b@example.com", "a @example.com"]) {
      assert.equal(emailSchema.safeParse(bad).success, false, bad);
    }
  });
});

describe("request bodies are never decompressed (mitigates the body-parser compressed-body DoS advisory)", () => {
  const pool = createTestPool();
  let h;
  beforeEach(async () => {
    await resetTables(pool);
    h = await startApp({ db: pool });
  });
  afterEach(() => h.close());
  after(() => pool.end());

  it("a gzip- or deflate-encoded JSON body is refused with 415 on public, parent and staff endpoints, and nothing is sent", async () => {
    const body = gzipSync(JSON.stringify({ email: "zip@example.com", purpose: "registration" }));
    for (const [path, encoding] of [["/api/email-otp/send", "gzip"], ["/api/email-otp/send", "deflate"], ["/api/registrations", "gzip"], ["/api/admin/auth/login", "gzip"], ["/api/auth/login/password", "gzip"]]) {
      const res = await h.api.post(path, body, { raw: true, headers: { "content-type": "application/json", "content-encoding": encoding } });
      assert.equal(res.status, 415, `${path} ${encoding}`);
    }
    assert.equal(h.sender.sent.length, 0);
  });

  it("ordinary uncompressed JSON still works", async () => {
    const res = await h.api.post("/api/email-otp/send", { email: "plain@example.com", purpose: "registration" });
    assert.equal(res.status, 200);
  });
});
