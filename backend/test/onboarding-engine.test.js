import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefinition } from "../src/modules/onboarding/definitions.js";
import { applyComputed, checkDraft, computeProgress, isIsoDate, normalizeValue, validateForm } from "../src/modules/onboarding/engine.js";
import { validAnswers } from "./harness.js";

const TODAY = "2026-10-21";
const dom = getDefinition("domestic", "student");
const intl = getDefinition("international", "student");
const field = (def, key) => def.sections.flatMap((s) => s.fields).find((x) => x.key === key);
const fieldsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.details.fields.map((x) => x.path);
  }
  return null;
};

describe("normalizeValue", () => {
  it("trims and collapses whitespace; upper-cases passport and PAN; keeps newlines in text areas", () => {
    assert.equal(normalizeValue(field(dom, "fullName"), "  Asha   Rao "), "Asha Rao");
    assert.equal(normalizeValue(field(intl, "passportNumber"), " aw 246971"), "AW 246971");
    assert.equal(normalizeValue(field(dom, "allergy"), "  dust \r\n\r\n  pollen  "), "dust\n\npollen");
    assert.equal(normalizeValue(field(dom, "fullName"), 42), "");
  });
});

describe("isIsoDate", () => {
  it("accepts only real calendar dates", () => {
    assert.ok(isIsoDate("2024-02-29"));
    for (const bad of ["2023-02-29", "2024-13-01", "2024-1-1", "01/02/2024", "", null, "2024-02-30"]) assert.equal(isIsoDate(bad), false, String(bad));
  });
});

describe("checkDraft (what may be saved while incomplete)", () => {
  it("accepts a partial draft, drops empty answers and normalises the rest", () => {
    assert.deepEqual(checkDraft(dom, { fullName: "  Asha  Rao ", gender: "", phone: "98" }), { fullName: "Asha Rao", phone: "98" });
  });
  it("does not enforce formats or required fields yet", () => {
    assert.doesNotThrow(() => checkDraft(intl, { panNumber: "abc", dateOfBirth: "not a date" }));
  });
  it("rejects unknown fields, derived fields, non-text answers and fields from the other tour", () => {
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { hacker: "x" })), ["data.hacker"]);
    assert.deepEqual(fieldsOf(() => checkDraft(intl, { passportValidity: "9 years" })), ["data.passportValidity"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { age: "9" })), ["data.age"]); // AGE is calculated by the server, never sent
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { fullName: 5 })), ["data.fullName"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { firstName: "Asha" })), ["data.firstName"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, [])), ["data"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, null)), ["data"]);
  });
  it("rejects over-long values, control characters and select values outside the options", () => {
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { fullName: "x".repeat(101) })), ["data.fullName"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { fullName: "As\u0000ha" })), ["data.fullName"]);
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { allergy: "a\u0007b" })), ["data.allergy"]);
    assert.doesNotThrow(() => checkDraft(dom, { allergy: "line one\nline two" }));
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { gender: "Robot" })), ["data.gender"]);
  });
  it("reports every problem at once", () => {
    assert.deepEqual(fieldsOf(() => checkDraft(dom, { gender: "Robot", hacker: "x" })).sort(), ["data.gender", "data.hacker"]);
  });
});

describe("validateForm (completeness and formats)", () => {
  it("a full set of valid answers has no errors, for every tour and role", () => {
    for (const tour of ["domestic", "international"]) {
      for (const role of ["student", "teacher", "team_leader"]) {
        assert.deepEqual(validateForm(getDefinition(tour, role), validAnswers(tour, role), TODAY), {}, `${tour}/${role}`);
      }
    }
  });
  it("lists every missing required field and none of the optional ones", () => {
    const errors = validateForm(dom, {}, TODAY);
    assert.deepEqual(Object.keys(errors).sort(), ["classSection", "dateOfBirth", "fullName", "gender", "mealPreference", "nomineeName", "nomineeRelation", "phone"]);
    assert.equal(errors.fullName, "Full name is required.");
  });
  it("checks formats: phone, passport, PAN, dates", () => {
    const base = validAnswers("international", "student");
    const err = (patch) => validateForm(intl, { ...base, ...patch }, TODAY);
    assert.ok(err({ panNumber: "ABCDE12345" }).panNumber);
    assert.ok(err({ passportNumber: "12" }).passportNumber);
    assert.ok(err({ dateOfBirth: "2012-02-30" }).dateOfBirth);
    assert.ok(err({ dateOfBirth: "2999-01-01" }).dateOfBirth);
    assert.ok(err({ dateOfBirth: "1800-01-01" }).dateOfBirth);
    assert.ok(err({ passportIssueDate: "2999-01-01" }).passportIssueDate);
    assert.deepEqual(err({ passportNumber: "aw246971" }), {}); // already normalised before storage; case is forgiven
    assert.ok(validateForm(dom, { ...validAnswers("domestic", "student"), phone: "12ab" }, TODAY).phone);
  });
  it("flags over-long stored values too (defence in depth: drafts are length-checked on save)", () => {
    const base = validAnswers("domestic", "student");
    assert.equal(validateForm(dom, { ...base, fullName: "x".repeat(101) }, TODAY).fullName, "Must be at most 100 characters.");
    assert.deepEqual(validateForm(dom, { ...base, fullName: "x".repeat(100) }, TODAY), {});
  });
  it("AGE is worked out by applyComputed from the date of birth (replacing any value), and removed when there is no valid date", () => {
    const base = validAnswers("domestic", "student");
    delete base.age;
    assert.deepEqual(validateForm(dom, base, TODAY), {});
    assert.equal(applyComputed(dom, { dateOfBirth: "2016-05-04", age: "99" }, "2026-05-03").age, "9");
    assert.equal(applyComputed(dom, { dateOfBirth: "2016-05-04" }, "2026-05-04").age, "10");
    assert.equal("age" in applyComputed(dom, { age: "12" }, TODAY), false);
    assert.equal("age" in applyComputed(dom, { dateOfBirth: "2099-01-01", age: "1" }, TODAY), false);
    assert.equal(computeProgress(dom, base, TODAY).requiredTotal, computeProgress(dom, { ...base, age: "10" }, TODAY).requiredTotal);
  });
  it("expiry must be after the issue date", () => {
    const base = validAnswers("international", "student");
    assert.equal(validateForm(intl, { ...base, passportExpiryDate: "2020-01-10" }, TODAY).passportExpiryDate, "Expiry date must be after the issue date.");
    assert.equal(validateForm(intl, { ...base, passportExpiryDate: "2019-01-01" }, TODAY).passportExpiryDate, "Expiry date must be after the issue date.");
    assert.deepEqual(validateForm(intl, { ...base, passportExpiryDate: "2020-01-11" }, TODAY), {});
  });
  it("tolerates a local date one day ahead of UTC, but not two", () => {
    const base = { ...validAnswers("domestic", "student") };
    assert.deepEqual(validateForm(dom, { ...base, dateOfBirth: "2026-10-22" }, TODAY), {});
    assert.ok(validateForm(dom, { ...base, dateOfBirth: "2026-10-23" }, TODAY).dateOfBirth);
  });
});

describe("computeProgress", () => {
  it("is 0% for an empty form and counts required fields only", () => {
    const p = computeProgress(dom, {}, TODAY);
    assert.equal(p.percent, 0);
    assert.equal(p.requiredTotal, 8);
    assert.equal(p.requiredDone, 0);
    assert.ok(p.sections.every((s) => s.status === "incomplete"));
  });
  it("rises with each valid required field", () => {
    const answers = validAnswers("domestic", "student");
    const steps = ["fullName", "gender", "classSection", "dateOfBirth", "nomineeName", "nomineeRelation", "mealPreference", "phone"];
    const seen = [];
    const partial = {};
    for (const key of steps) {
      partial[key] = answers[key];
      seen.push(computeProgress(dom, partial, TODAY).percent);
    }
    assert.deepEqual(seen, [13, 25, 38, 50, 63, 75, 88, 100]);
  });
  it("optional answers do not move the percentage", () => {
    assert.equal(computeProgress(dom, { allergy: "dust", remark: "x" }, TODAY).percent, 0);
  });
  it("an invalid value does not count, and its section needs attention", () => {
    const p = computeProgress(dom, { fullName: "Asha", dateOfBirth: "2999-01-01" }, TODAY);
    assert.equal(p.requiredDone, 1);
    assert.equal(p.sections.find((s) => s.id === "personal").status, "attention");
  });
  it("sections become complete independently", () => {
    const p = computeProgress(dom, { nomineeName: "A", nomineeRelation: "Mother" }, TODAY);
    assert.deepEqual(p.sections.map((s) => [s.id, s.status]), [["personal", "incomplete"], ["nominee", "complete"], ["meals", "incomplete"], ["contact", "incomplete"]]);
  });
  it("never reaches 100% before every required field is valid", () => {
    const answers = validAnswers("international", "student");
    delete answers.panNumber;
    const p = computeProgress(intl, answers, TODAY);
    assert.ok(p.percent < 100);
    assert.equal(computeProgress(intl, validAnswers("international", "student"), TODAY).percent, 100);
  });
});
