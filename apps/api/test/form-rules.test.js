import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ageFromDob, personNameError, phoneError } from "../src/modules/validation/rules.js";

import { NAME_BAD, NAME_OK, PHONE_BAD, PHONE_OK } from "./fixtures/form-rule-cases.js";

describe("person names", () => {
  it("accepts real names in any script, with spaces, hyphens, apostrophes and initials", () => {
    for (const n of NAME_OK) assert.equal(personNameError("Full name", n), null, n);
  });
  it("rejects digits, markup, symbols and punctuation-only values, with a field-specific message", () => {
    for (const n of NAME_BAD) assert.match(personNameError("Full name", n) ?? "", /^Full name /, n);
    assert.equal(personNameError("Nominee name", "Asha2"), "Nominee name can't contain numbers.");
    assert.equal(personNameError("Full name", "---"), "Full name must contain letters.");
    assert.equal(personNameError("Full name", "Asha_Rao"), "Full name can only contain letters, spaces, hyphens, apostrophes and full stops.");
  });
});

describe("mobile numbers: exactly 10 digits, no country code", () => {
  it("accepts exactly 10 digits (surrounding spaces are ignored)", () => {
    for (const p of PHONE_OK) assert.equal(phoneError(p), null, p);
    assert.equal(phoneError(" 9876543210 "), null);
  });
  it("rejects 9 or 11 digits, country codes, separators, letters and non-ASCII digits, each with a clear message", () => {
    for (const p of PHONE_BAD) assert.ok(phoneError(p), JSON.stringify(p));
    assert.equal(phoneError("987654321"), "Enter all 10 digits of your mobile number (you entered 9).");
    assert.equal(phoneError("98765432101"), "That's 11 digits. Enter your 10-digit mobile number without the country code.");
    assert.equal(phoneError("919876543210"), "That's 12 digits. Enter your 10-digit mobile number without the country code.");
    assert.equal(phoneError("+919876543210"), "Enter your 10-digit mobile number without the country code (no + or 91 in front).");
    assert.equal(phoneError("+91 98765 43210"), "Enter your 10-digit mobile number without the country code (no + or 91 in front).");
    assert.equal(phoneError("98765 43210"), "Use digits only, with no spaces, letters or symbols.");
    assert.equal(phoneError("98765abcde"), "Use digits only, with no spaces, letters or symbols.");
    assert.equal(phoneError("９".repeat(10)), "Use digits only, with no spaces, letters or symbols.", "full-width digits are not 0-9");
    assert.equal(phoneError(""), "Enter your 10-digit mobile number.");
    assert.equal(phoneError(null), "Enter your 10-digit mobile number.");
  });
});

describe("age from date of birth (server-side)", () => {
  it("counts completed years, changing exactly on the birthday", () => {
    assert.equal(ageFromDob("2016-05-04", "2026-05-03"), 9);
    assert.equal(ageFromDob("2016-05-04", "2026-05-04"), 10);
    assert.equal(ageFromDob("2016-05-04", "2026-12-31"), 10);
  });
  it("a 29 February birthday counts on 1 March in non-leap years, and on 29 February in leap years", () => {
    assert.equal(ageFromDob("2012-02-29", "2027-02-28"), 14);
    assert.equal(ageFromDob("2012-02-29", "2027-03-01"), 15);
    assert.equal(ageFromDob("2012-02-29", "2028-02-28"), 15);
    assert.equal(ageFromDob("2012-02-29", "2028-02-29"), 16);
  });
  it("gives no age for invalid, impossible or future dates", () => {
    for (const bad of ["", "2016-02-30", "2016-13-01", "not a date", "1899-12-31", "2026-10-27", null, undefined, 20160504]) {
      assert.equal(ageFromDob(bad, "2026-10-26"), null, String(bad));
    }
    assert.equal(ageFromDob("2026-10-26", "2026-10-26"), 0);
  });
});

describe("the phone check can't be slowed down by crafted input", () => {
  it("long near-miss values are answered quickly", () => {
    const evil = ["9".repeat(24) + "a", "+" + "9".repeat(24), " ".repeat(10) + "9".repeat(15)];
    const start = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) for (const v of evil) phoneError(v);
    const perCall = Number(process.hrtime.bigint() - start) / 1e6 / (2000 * evil.length);
    assert.ok(perCall < 0.05, `${perCall.toFixed(4)} ms per call`);
  });
});
