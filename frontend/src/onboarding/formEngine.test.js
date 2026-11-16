import { describe, expect, it } from "vitest";
import { PARTICIPANT_ROLES, TOUR_TYPES, getDefinition } from "../../../backend/src/modules/onboarding/definitions.js";
import * as server from "../../../backend/src/modules/onboarding/engine.js";
import { ageFromDob, computeProgress, deriveValue, displayValue, fieldError, isIsoDate, normalizeValue, validateForm } from "./formEngine.js";

const TODAY = "2026-10-21";
const def = (tour, role) => JSON.parse(JSON.stringify(getDefinition(tour, role)));
const field = (d, key) => d.sections.flatMap((s) => s.fields).find((f) => f.key === key);

// Inputs that exercise every rule: good values, bad formats, blanks, padding, odd casing, boundary dates.
const SAMPLES = {
  text: ["", "Asha Rao", "  Asha   Rao  ", "x".repeat(101), "A"],
  textarea: ["", "dust\npollen", "x".repeat(2000)],
  phone: ["", "9876543210", "98765", "12ab", "+919876543210", "98765432101"],
  date: ["", "2016-05-04", "2999-01-01", "1800-01-01", "2016-02-30", "not a date", TODAY, "2026-10-22", "2026-10-23", "2020-01-10", "2019-01-01", "2030-01-09"],
  select: ["", "Male", "Female", "Veg", "Non-veg", "Other"],
};
const PATTERNED = { passportNumber: ["aw246971", "AW 246971", "12", "ABCDEFGHIJ"], panNumber: ["acgpa3164k", "ABCDE12345", "ABCDE1234F", ""] };

function* variants(d) {
  const fields = d.sections.flatMap((s) => s.fields).filter((f) => f.type !== "derived");
  yield {};
  for (const f of fields) {
    const values = PATTERNED[f.key] ?? SAMPLES[f.type] ?? SAMPLES.text;
    for (const v of values) yield { [f.key]: v };
  }
  // A mostly complete set with one field changed at a time.
  const base = {};
  for (const f of fields) base[f.key] = (SAMPLES[f.type] ?? SAMPLES.text)[1] ?? "x";
  base.passportNumber = "AW246971";
  base.panNumber = "ACGPA3164K";
  base.dateOfBirth = "2016-05-04";
  base.passportIssueDate = "2020-01-10";
  base.passportExpiryDate = "2030-01-09";
  base.panHolderDob = "1985-03-02";
  base.phone = "9876543210";
  yield base;
  for (const f of fields) for (const v of PATTERNED[f.key] ?? SAMPLES[f.type] ?? SAMPLES.text) yield { ...base, [f.key]: v };
}

describe("parity with the server's rules", () => {
  for (const tour of TOUR_TYPES) {
    for (const role of PARTICIPANT_ROLES) {
      it(`${tour} / ${role}: same errors and same progress for every sample answer set`, () => {
        const d = def(tour, role);
        let n = 0;
        for (const raw of variants(d)) {
          // The server stores normalised answers (empty ones dropped); the client works on what was typed.
          const stored = {};
          for (const f of d.sections.flatMap((s) => s.fields)) {
            const v = server.normalizeValue(f, raw[f.key]);
            if (v !== "" && f.type !== "derived") stored[f.key] = v;
          }
          expect(validateForm(d, raw, TODAY), JSON.stringify(raw)).toEqual(server.validateForm(d, stored, TODAY));
          expect(computeProgress(d, raw, TODAY), JSON.stringify(raw)).toEqual(server.computeProgress(d, stored, TODAY));
          n += 1;
        }
        expect(n).toBeGreaterThan(40);
      });
    }
  }

  it("normalises exactly like the server", () => {
    const d = def("international", "student");
    for (const [key, raw] of [["firstName", "  Asha   Rao "], ["passportNumber", " aw 246971"], ["address", "a \r\n\r\n  b  "], ["firstName", 5], ["panNumber", " acgpa3164k "]]) {
      expect(normalizeValue(field(d, key), raw)).toBe(server.normalizeValue(field(d, key), raw));
    }
  });
});

describe("fieldError", () => {
  const d = def("international", "student");
  it("optional fields are fine empty; required ones say what is missing", () => {
    expect(fieldError(field(d, "allergies"), "", {}, TODAY)).toBeNull();
    expect(fieldError(field(d, "branch"), "", {}, TODAY)).toBeNull();
    expect(fieldError(field(d, "firstName"), "  ", {}, TODAY)).toBe("First name is required.");
  });
  it("applies the field's own rules", () => {
    expect(fieldError(field(d, "panNumber"), "ABCDE1234", {}, TODAY)).toBe("Enter a valid PAN, for example ABCDE1234F.");
    expect(fieldError(field(d, "passportExpiryDate"), "2019-01-01", { passportIssueDate: "2020-01-10" }, TODAY)).toBe("Expiry date must be after the issue date.");
    expect(fieldError(field(d, "dateOfBirth"), "2999-01-01", {}, TODAY)).toBe("Date can't be in the future.");
  });
});

describe("derived values (passport validity)", () => {
  const d = def("international", "student");
  const validity = field(d, "passportValidity");
  it("passport validity is shown in years, months and days like the sheet, or 'Expired'", () => {
    expect(deriveValue(validity, { passportExpiryDate: "2036-07-22" }, TODAY)).toBe("9 years 9 months 1 day");
    expect(deriveValue(validity, { passportExpiryDate: "2026-10-22" }, TODAY)).toBe("0 years 0 months 1 day");
    expect(deriveValue(validity, { passportExpiryDate: "2026-10-21" }, TODAY)).toBe("Expired");
    expect(deriveValue(validity, { passportExpiryDate: "2020-01-01" }, TODAY)).toBe("Expired");
    expect(deriveValue(validity, {}, TODAY)).toBe("");
  });
  it("displayValue shows an em dash for empty answers; AGE is a hidden derived value worked out from the date of birth", () => {
    expect(displayValue(field(d, "firstName"), {}, TODAY)).toBe("—");
    expect(displayValue(field(d, "firstName"), { firstName: " Asha " }, TODAY)).toBe("Asha");
    expect(field(d, "age").hidden).toBe(true);
    expect(displayValue(field(d, "age"), { dateOfBirth: "2016-05-04" }, "2026-05-04")).toBe("10");
    expect(displayValue(field(d, "age"), {}, TODAY)).toBe("—");
  });
});

describe("ageFromDob", () => {
  it("counts completed years: the day before, on, and after the birthday", () => {
    expect(ageFromDob("2016-10-22", TODAY)).toBe(9);
    expect(ageFromDob("2016-10-21", TODAY)).toBe(10);
    expect(ageFromDob("2016-10-20", TODAY)).toBe(10);
    expect(ageFromDob("2016-12-31", TODAY)).toBe(9);
    expect(ageFromDob("2026-10-21", TODAY)).toBe(0);
    expect(ageFromDob("2026-01-01", TODAY)).toBe(0);
  });
  it("handles leap days", () => {
    expect(ageFromDob("2024-02-29", "2025-02-28")).toBe(0);
    expect(ageFromDob("2024-02-29", "2025-03-01")).toBe(1);
    expect(ageFromDob("2024-02-29", "2028-02-29")).toBe(4);
    expect(ageFromDob("2000-02-29", "2027-02-28")).toBe(26);
  });
  it("returns null (no misleading age) for incomplete, impossible, future or implausible dates", () => {
    for (const bad of ["", null, undefined, "2016-1", "2016-02-30", "garbage", "2999-01-01", "2026-10-22", "1800-01-01"]) {
      expect(ageFromDob(bad, TODAY), String(bad)).toBeNull();
    }
  });
});

describe("isIsoDate", () => {
  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const bad of ["2023-02-29", "2024-13-01", "", null, "01/02/2024"]) expect(isIsoDate(bad)).toBe(false);
  });
});
