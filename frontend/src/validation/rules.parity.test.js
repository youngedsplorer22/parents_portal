import { describe, expect, it } from "vitest";
import * as server from "../../../backend/src/modules/validation/rules.js";
import { NAME_BAD, NAME_OK, PHONE_BAD, PHONE_OK } from "../../../backend/test/fixtures/form-rule-cases.js";
import * as browser from "./rules.js";

// The browser's copy must give exactly the server's answers (the server is the authority; this keeps feedback honest).
describe("browser and server validation rules agree", () => {
  it("person names", () => {
    for (const v of [...NAME_OK, ...NAME_BAD, "", " ", "A", "Ab", "Ünal", "Jean-Luc", "N'Golo"]) {
      for (const label of ["Full name", "Nominee name", "First name"]) expect(browser.personNameError(label, v), `${label}: ${v}`).toBe(server.personNameError(label, v));
    }
  });
  it("phone numbers", () => {
    for (const v of [...PHONE_OK, ...PHONE_BAD, " 9876543210 ", "9".repeat(25), "+91 98765 43210", null, undefined]) {
      expect(browser.phoneError(v), String(v)).toBe(server.phoneError(v));
    }
    expect(browser.PHONE_MAX_LENGTH).toBe(server.PHONE_MAX_LENGTH);
    expect(browser.PHONE_DIGITS).toBe(server.PHONE_DIGITS);
  });
  it("age from date of birth, around birthdays and leap days", () => {
    for (const [dob, today] of [["2016-05-04", "2026-05-03"], ["2016-05-04", "2026-05-04"], ["2012-02-29", "2027-02-28"], ["2012-02-29", "2027-03-01"], ["2012-02-29", "2028-02-29"], ["2026-10-27", "2026-10-26"], ["2016-02-30", "2026-10-26"], ["1899-12-31", "2026-10-26"]]) {
      expect(browser.ageFromDob(dob, today), `${dob} @ ${today}`).toBe(server.ageFromDob(dob, today));
    }
  });
});
