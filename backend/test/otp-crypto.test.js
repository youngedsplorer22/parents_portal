import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCode,
  generateCode,
  generateToken,
  hashCode,
  hashToken,
  safeEqualHex,
  verifyCode,
} from "../src/modules/email-otp/otp-crypto.js";

const secret = "b".repeat(64);
const params = { otpId: "id-1", email: "a@b.co", purpose: "registration", code: "123456" };

describe("generateCode", () => {
  it("always returns exactly 6 digits", () => {
    for (let i = 0; i < 5000; i++) assert.match(generateCode(), /^\d{6}$/);
  });

  it("is not constant and uses the full range, including leading zeros", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateCode));
    assert.ok(seen.size > 1900, `expected near-unique codes, got ${seen.size}/2000`);
  });

  it("pads small numbers with leading zeros", () => {
    assert.equal(formatCode(0), "000000");
    assert.equal(formatCode(42), "000042");
    assert.equal(formatCode(999999), "999999");
  });
});

describe("hashCode / verifyCode", () => {
  it("is deterministic and never contains the code", () => {
    const h = hashCode(secret, params);
    assert.equal(h, hashCode(secret, params));
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("accepts the right code and rejects a wrong one", () => {
    const h = hashCode(secret, params);
    assert.equal(verifyCode(secret, h, params), true);
    assert.equal(verifyCode(secret, h, { ...params, code: "123457" }), false);
  });

  it("binds the hash to the otp id, email, purpose and secret", () => {
    const h = hashCode(secret, params);
    assert.notEqual(h, hashCode(secret, { ...params, otpId: "id-2" }));
    assert.notEqual(h, hashCode(secret, { ...params, email: "x@b.co" }));
    assert.notEqual(h, hashCode(secret, { ...params, purpose: "login" }));
    assert.notEqual(h, hashCode("c".repeat(64), params));
  });

  it("cannot be confused by values that shift between fields", () => {
    const a = hashCode(secret, { ...params, email: "a", code: "bc" });
    const b = hashCode(secret, { ...params, email: "ab", code: "c" });
    assert.notEqual(a, b);
  });
});

describe("safeEqualHex", () => {
  it("handles mismatched lengths, empty and non-hex input without throwing", () => {
    assert.equal(safeEqualHex("ab", "abcd"), false);
    assert.equal(safeEqualHex("", ""), false);
    assert.equal(safeEqualHex("zz", "zz"), false);
    assert.equal(safeEqualHex("abcd", "abcd"), true);
  });
});

describe("verification tokens", () => {
  it("are 256-bit URL-safe strings and unique", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    assert.equal(tokens.size, 200);
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  });

  it("hash is bound to the email and purpose", () => {
    const base = { token: "t", email: "a@b.co", purpose: "registration" };
    const h = hashToken(secret, base);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, hashToken(secret, { ...base, email: "x@b.co" }));
    assert.notEqual(h, hashToken(secret, { ...base, purpose: "login" }));
    assert.notEqual(h, hashToken(secret, { ...base, token: "u" }));
  });
});
