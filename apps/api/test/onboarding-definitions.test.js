// The forms must match the two workbooks column for column. The expected header
// lists below were read from "CORESHEET FORMAT- DOMESTIC TOURS.xlsx" and
// "CORESHEET FORMAT- INTERNATIONAL TOURS.xlsx" (header rows of each block,
// excluding the "S No." row-number column).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARTICIPANT_ROLES, allFields, definitionsFor, getDefinition, roleKey } from "../src/modules/onboarding/definitions.js";

const DOMESTIC_STUDENT_AND_TEACHER = [
  "FULL NAME", "GENDER", "CLASS & SECTION", "DATE OF BIRTH", "AGE", "NOMINEE NAME", "NOMINEE RELATION",
  "MEALS PREFERENCE", "ALLERGY", "CONTACT DETAILS (PHONE NO.)", "REMARK",
];
const DOMESTIC_TL = DOMESTIC_STUDENT_AND_TEACHER.filter((h) => h !== "CLASS & SECTION");

const INTL_COMMON_START = [
  "FIRST NAME", "LAST NAME", "GENDER", "DATE OF BIRTH", "AGE", "PASSPORT NUMBER", "PLACE OF BIRTH", "ISSUE DATE",
  "EXPIRY DATE", "PASSPORT VALIDITY", "PLACE OF ISSUE", "NATIONALITY", "ADDRESS",
];
const BRANCH = "BRANCH (IF DIFFERENT BRANCHES ARE TRAVELLING OF SAME SCHOOL)";
const INTL_MEALS = ["MEAL PREFERENCE (IN FLIGHT)", "MEAL PREFERENCE (ON TRIP)", "ALLERGIES (IF ANY)", "NOMINEE NAME"];
const PAN = ["PAN CARD HOLDER NAME", "PAN CARD NO", "PAN CARD HOLDER'S  DOB"];
const INTL = {
  student: [...INTL_COMMON_START, BRANCH, ...INTL_MEALS, "NOMINEE RELATION WITH STUDENT", ...PAN, "RELATION WITH STUDENT", "REMARKS (IF ANY)"],
  teacher: [...INTL_COMMON_START, BRANCH, ...INTL_MEALS, "NOMINEE RELATION WITH TEACHER", ...PAN, "REMARKS (IF ANY)"],
  team_leader: [...INTL_COMMON_START, ...INTL_MEALS, "NOMINEE RELATION WITH TEACHER", ...PAN, "REMARKS (IF ANY)"],
};
const DOMESTIC = { student: DOMESTIC_STUDENT_AND_TEACHER, teacher: DOMESTIC_STUDENT_AND_TEACHER, team_leader: DOMESTIC_TL };

const headers = (tour, role) => allFields(getDefinition(tour, role)).map((x) => x.source);

describe("onboarding definitions match the workbooks", () => {
  for (const role of PARTICIPANT_ROLES) {
    it(`Domestic Tours / ${role}: same columns, same order`, () => assert.deepEqual(headers("domestic", role), DOMESTIC[role]));
    it(`International Tours / ${role}: same columns, same order`, () => assert.deepEqual(headers("international", role), INTL[role]));
  }

  it("keeps the student/teacher/TL distinctions the sheets make", () => {
    const has = (tour, role, key) => allFields(getDefinition(tour, role)).some((x) => x.key === key);
    assert.ok(has("domestic", "student", "classSection") && has("domestic", "teacher", "classSection"));
    assert.ok(!has("domestic", "team_leader", "classSection"));
    assert.ok(has("international", "student", "branch") && has("international", "teacher", "branch"));
    assert.ok(!has("international", "team_leader", "branch"));
    assert.ok(has("international", "student", "panHolderRelation"));
    assert.ok(!has("international", "teacher", "panHolderRelation") && !has("international", "team_leader", "panHolderRelation"));
    // Domestic has a single FULL NAME; International has FIRST NAME + LAST NAME.
    assert.ok(has("domestic", "student", "fullName") && !has("domestic", "student", "firstName"));
    assert.ok(has("international", "student", "firstName") && !has("international", "student", "fullName"));
  });

  it("only the columns whose header says so are optional (plus Domestic ALLERGY/REMARK, documented as an open question)", () => {
    const optional = (tour, role) => allFields(getDefinition(tour, role)).filter((x) => x.type !== "derived" && !x.required).map((x) => x.source);
    // AGE is no longer asked for (it is calculated by the server), so it isn't among the optional answers
    assert.deepEqual(optional("domestic", "student"), ["ALLERGY", "REMARK"]);
    assert.deepEqual(optional("international", "student"), [BRANCH, "ALLERGIES (IF ANY)", "REMARKS (IF ANY)"]);
    assert.deepEqual(optional("international", "team_leader"), ["ALLERGIES (IF ANY)", "REMARKS (IF ANY)"]);
  });

  it("PASSPORT VALIDITY is shown read-only; AGE is calculated and stored by the server from the date of birth, and hidden", () => {
    const fields = allFields(getDefinition("international", "student"));
    assert.deepEqual(fields.filter((x) => x.type === "derived").map((x) => x.source), ["AGE", "PASSPORT VALIDITY"]);
    const age = fields.find((x) => x.key === "age");
    assert.deepEqual([age.type, age.hidden, age.stored, age.derive], ["derived", true, true, { kind: "age", from: "dateOfBirth" }]);
    for (const tour of ["domestic", "international"]) {
      for (const role of ["student", "teacher", "team_leader"]) {
        assert.equal(allFields(getDefinition(tour, role)).find((x) => x.key === "age").source, "AGE", `${tour}/${role} still has the sheet's AGE column`);
      }
    }
  });

  it("person-name fields use the name rule and the phone field the phone rule; other text fields don't", () => {
    const dom = allFields(getDefinition("domestic", "student"));
    const intl = allFields(getDefinition("international", "student"));
    const ruled = (fields, rule) => fields.filter((x) => x.rule === rule).map((x) => x.key);
    assert.deepEqual(ruled(dom, "personName"), ["fullName", "nomineeName"]);
    assert.deepEqual(ruled(intl, "personName"), ["firstName", "lastName", "nomineeName", "panHolderName"]);
    assert.deepEqual(ruled(dom, "phone"), ["phone"]);
    const phone = dom.find((x) => x.key === "phone");
    assert.deepEqual([phone.label, phone.placeholder, phone.hint, phone.source], ["Phone number", "9876543210", undefined, "CONTACT DETAILS (PHONE NO.)"]); // no helper text; the rule is enforced
    for (const key of ["placeOfBirth", "nationality", "address", "classSection", "remarks"]) assert.equal(intl.concat(dom).find((x) => x.key === key)?.rule, undefined, key);
  });

  it("every field key is unique within a form and every section has fields", () => {
    for (const role of PARTICIPANT_ROLES) {
      for (const def of Object.values(definitionsFor(role))) {
        const keys = allFields(def).map((x) => x.key);
        assert.equal(new Set(keys).size, keys.length);
        assert.ok(def.sections.every((s) => s.fields.length > 0));
      }
    }
  });

  it("maps the registration role to the variant, and rejects unknown values", () => {
    assert.equal(roleKey("Student"), "student");
    assert.equal(roleKey("Teacher"), "teacher");
    assert.equal(roleKey("Team Leader"), "team_leader");
    assert.equal(roleKey("Parent"), null);
    assert.equal(getDefinition("domestic", "parent"), null);
    assert.equal(getDefinition("local", "student"), null);
  });

  it("definitions are plain JSON (they are sent to the browser)", () => {
    const def = getDefinition("international", "student");
    assert.deepEqual(JSON.parse(JSON.stringify(def)), def);
  });
});
