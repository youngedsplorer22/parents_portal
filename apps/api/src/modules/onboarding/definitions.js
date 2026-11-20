import { PHONE_MAX_LENGTH } from "../validation/rules.js";
// The onboarding forms, taken field by field from the two core sheet workbooks
// ("CORESHEET FORMAT- DOMESTIC TOURS.xlsx" and "... INTERNATIONAL TOURS.xlsx").
// This file is the single source of truth: the server validates against it and
// sends it to the frontend, which renders and checks the forms from it.
//
// Each workbook has three blocks of rows with their own header row, so there are
// three variants per tour: student, teacher and team leader (the sheets' "TL").
// `source` is the column header exactly as it appears in the workbook.
//
// Not collected, because they are derived or are just row numbers:
//   S No. / S.NO              - the row number in the school's roster.
//   PASSPORT VALIDITY         - shown read-only, computed from the expiry date.
// AGE is collected (optional): editable, and pre-filled from the date of birth in the browser.
//
// Required-ness: a column is required unless its own header says otherwise
// ("(IF ANY)", "(IF DIFFERENT BRANCHES ...)"). Domestic ALLERGY and REMARK have
// no such wording; they are treated as optional (open question, see README).

export const TOUR_TYPES = ["domestic", "international"];
export const PARTICIPANT_ROLES = ["student", "teacher", "team_leader"];

/** Registration role (App.jsx / registrations/validation.js) -> variant. */
const ROLE_KEYS = { Student: "student", Teacher: "teacher", "Team Leader": "team_leader" };
export const roleKey = (registrationRole) => ROLE_KEYS[registrationRole] ?? null;

const NO_FUTURE = "Date can't be in the future.";

const f = (key, label, source, type, extra = {}) => ({ key, label, source, type, required: true, ...extra });
const text = (key, label, source, extra) => f(key, label, source, "text", { max: 100, ...extra });
const area = (key, label, source, extra) => f(key, label, source, "textarea", { max: 500, ...extra });
const date = (key, label, source, extra) => f(key, label, source, "date", { ...extra });
const select = (key, label, source, options, extra) => f(key, label, source, "select", { options, ...extra });
const optional = (field) => ({ ...field, required: false });

const GENDER = ["Male", "Female"];
const MEALS = ["Veg", "Non-veg"];

const dob = () => date("dateOfBirth", "Date of birth", "DATE OF BIRTH", { notFuture: true, minYear: 1900 });
// AGE (the sheet's column) is not asked for: the SERVER calculates it from the date of birth on every save and on
// submission and stores it in the answers (engine.applyComputed), so a client can neither send nor change it. It is
// hidden on the form, the review and the submitted view, because the date of birth already says it.
const age = () => ({
  key: "age", label: "Age", source: "AGE", type: "derived", required: false,
  hidden: true, stored: true, derive: { kind: "age", from: "dateOfBirth" },
});
// A person's name: letters in any script, spaces, hyphens, apostrophes and full stops (validation/rules.js).
const personName = (key, label, source) => text(key, label, source, { rule: "personName", autocomplete: "off" });
const gender = () => select("gender", "Gender", "GENDER", GENDER);

// ---------------------------------------------------------------- Domestic

function domestic(role) {
  const withClass = role !== "team_leader"; // the TL block has no CLASS & SECTION column
  return {
    sections: [
      {
        id: "personal",
        title: "Personal details",
        fields: [
          personName("fullName", "Full name", "FULL NAME"),
          gender(),
          ...(withClass ? [text("classSection", "Class & section", "CLASS & SECTION", { max: 20, placeholder: "e.g. 4 - B" })] : []),
          dob(),
          age(),
        ],
      },
      {
        id: "nominee",
        title: "Nominee",
        fields: [
          personName("nomineeName", "Nominee name", "NOMINEE NAME"),
          text("nomineeRelation", "Nominee relation", "NOMINEE RELATION", { max: 50 }),
        ],
      },
      {
        id: "meals",
        title: "Meals & health",
        fields: [
          select("mealPreference", "Meals preference", "MEALS PREFERENCE", MEALS),
          optional(area("allergy", "Allergy", "ALLERGY")),
        ],
      },
      {
        id: "contact",
        title: "Contact & remarks",
        fields: [
          // A mobile number: exactly 10 digits, no country code (validation/rules.js). `max` only bounds what a draft
          // may hold, so autosave never fails on a mistyped number; submission needs exactly 10 digits.
          f("phone", "Phone number", "CONTACT DETAILS (PHONE NO.)", "phone", {
            max: PHONE_MAX_LENGTH,
            rule: "phone",
            placeholder: "9876543210",
            autocomplete: "tel-national",
          }),
          optional(area("remark", "Remark", "REMARK", { max: 1000 })),
        ],
      },
    ],
  };
}

// ----------------------------------------------------------- International

function international(role) {
  const student = role === "student";
  const withBranch = role !== "team_leader"; // the TL block has no BRANCH column
  const relationWith = student ? "student" : "teacher"; // the sheet words the TL block as "WITH TEACHER"
  return {
    sections: [
      {
        id: "personal",
        title: "Personal details",
        fields: [personName("firstName", "First name", "FIRST NAME"), personName("lastName", "Last name", "LAST NAME"), gender(), dob(), age()],
      },
      {
        id: "passport",
        title: "Passport details",
        fields: [
          text("passportNumber", "Passport number", "PASSPORT NUMBER", {
            max: 9,
            transform: "upper",
            pattern: "^[A-Z0-9]{6,9}$",
            patternMessage: "Enter the passport number as printed (6 to 9 letters or digits).",
          }),
          text("placeOfBirth", "Place of birth", "PLACE OF BIRTH"),
          date("passportIssueDate", "Issue date", "ISSUE DATE", { notFuture: true, minYear: 1900 }),
          date("passportExpiryDate", "Expiry date", "EXPIRY DATE", {
            minYear: 1900,
            after: "passportIssueDate",
            afterMessage: "Expiry date must be after the issue date.",
          }),
          { key: "passportValidity", label: "Passport validity", source: "PASSPORT VALIDITY", type: "derived", derive: { kind: "validity", from: "passportExpiryDate" }, required: false },
          text("placeOfIssue", "Place of issue", "PLACE OF ISSUE"),
          text("nationality", "Nationality", "NATIONALITY", { max: 60 }),
        ],
      },
      {
        id: "address",
        title: withBranch ? "Address & branch" : "Address",
        fields: [
          area("address", "Address", "ADDRESS", { max: 300 }),
          ...(withBranch
            ? [optional(text("branch", "Branch (if different branches are travelling of same school)", "BRANCH (IF DIFFERENT BRANCHES ARE TRAVELLING OF SAME SCHOOL)"))]
            : []),
        ],
      },
      {
        id: "meals",
        title: "Meals & health",
        fields: [
          select("mealInFlight", "Meal preference (in flight)", "MEAL PREFERENCE (IN FLIGHT)", MEALS),
          select("mealOnTrip", "Meal preference (on trip)", "MEAL PREFERENCE (ON TRIP)", MEALS),
          optional(area("allergies", "Allergies (if any)", "ALLERGIES (IF ANY)")),
        ],
      },
      {
        id: "nominee",
        title: "Nominee",
        fields: [
          personName("nomineeName", "Nominee name", "NOMINEE NAME"),
          text("nomineeRelation", `Nominee relation with ${relationWith}`, `NOMINEE RELATION WITH ${relationWith.toUpperCase()}`, { max: 50 }),
        ],
      },
      {
        id: "pan",
        title: "PAN card details & remarks",
        fields: [
          personName("panHolderName", "PAN card holder name", "PAN CARD HOLDER NAME"),
          text("panNumber", "PAN card no", "PAN CARD NO", {
            max: 10,
            transform: "upper",
            pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$",
            patternMessage: "Enter a valid PAN, for example ABCDE1234F.",
          }),
          date("panHolderDob", "PAN card holder's DOB", "PAN CARD HOLDER'S  DOB", { notFuture: true, minYear: 1900 }),
          ...(student ? [text("panHolderRelation", "Relation with student", "RELATION WITH STUDENT", { max: 50 })] : []),
          optional(area("remarks", "Remarks (if any)", "REMARKS (IF ANY)", { max: 1000 })),
        ],
      },
    ],
  };
}

const TITLES = { domestic: "Domestic Tours", international: "International Tours" };
const BUILDERS = { domestic, international };

/** The form for a tour type and participant role, or null if either is unknown. */
export function getDefinition(tourType, role) {
  if (!TOUR_TYPES.includes(tourType) || !PARTICIPANT_ROLES.includes(role)) return null;
  return { tourType, role, title: TITLES[tourType], ...BUILDERS[tourType](role) };
}

/** Both tours for one role: what the frontend renders. Plain data, safe to serialise. */
export const definitionsFor = (role) => Object.fromEntries(TOUR_TYPES.map((t) => [t, getDefinition(t, role)]));

export const allFields = (def) => def.sections.flatMap((s) => s.fields);
/** Fields the user answers (everything except read-only derived ones). */
export const answerFields = (def) => allFields(def).filter((x) => x.type !== "derived");
