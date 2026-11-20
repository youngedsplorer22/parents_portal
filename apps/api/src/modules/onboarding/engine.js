// Validation and progress for the onboarding forms, driven by definitions.js.
//
// Two levels:
//  - draft shape (checkDraft): what may be SAVED while the form is half done.
//    Only known fields, string values, length limits, select options. Formats
//    and required-ness are not enforced, so autosave works mid-typing.
//  - completeness (validateForm): format rules and required fields, enforced on
//    final submission and used to compute progress.
//
// frontend/src/onboarding/formEngine.js implements the same rules for live
// feedback; a parity test keeps the two in step. The server is the authority.
import { AppError } from "../email-otp/errors.js";
import { allFields, answerFields } from "./definitions.js";
import { ageFromDob, personNameError, phoneError } from "../validation/rules.js";

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

/** Trims, collapses whitespace, applies the field's transform. Non-strings become "". */
export function normalizeValue(field, raw) {
  if (typeof raw !== "string") return "";
  let s =
    field.type === "textarea"
      ? raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").trim()
      : raw.replace(/\s+/g, " ").trim();
  if (field.transform === "upper") s = s.toUpperCase();
  return s;
}

export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The latest accepted date is tomorrow (UTC), so a user whose local date is already
// "tomorrow" relative to UTC is not told their date of birth is in the future.
const latestAllowed = (today) => new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Message for a normalised, non-empty value that breaks a format rule; null if fine. */
export function formatError(field, value, data, today) {
  if (field.type === "select") return field.options.includes(value) ? null : `Select a ${field.label.toLowerCase()}.`;
  if (field.rule === "personName") return personNameError(field.label, value);
  if (field.rule === "phone") return phoneError(value);
  if (field.pattern && !new RegExp(field.pattern).test(value)) return field.patternMessage ?? `Enter a valid ${field.label.toLowerCase()}.`;
  if (field.type === "date") {
    if (!isIsoDate(value)) return "Enter a valid date.";
    if (field.minYear && Number(value.slice(0, 4)) < field.minYear) return "Enter a valid date.";
    if (field.notFuture && value > latestAllowed(today)) return "Date can't be in the future.";
    if (field.after) {
      const other = data[field.after];
      if (isIsoDate(other) && value <= other) return field.afterMessage ?? "Date is too early.";
    }
  }
  return null;
}

/**
 * Validates what may be saved as a draft. Returns the cleaned data (normalised,
 * empty answers dropped) or throws a 400 VALIDATION_ERROR listing every problem.
 */
export function checkDraft(def, data) {
  const issues = [];
  const add = (path, message) => issues.push({ path: `data.${path}`, message });
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request.", { fields: [{ path: "data", message: "Answers must be an object." }] });
  }
  const known = new Map(answerFields(def).map((x) => [x.key, x]));
  const clean = {};
  for (const [key, raw] of Object.entries(data)) {
    const field = known.get(key);
    if (!field) {
      add(key, "This field is not part of the form.");
      continue;
    }
    if (typeof raw !== "string") {
      add(key, "Answer must be text.");
      continue;
    }
    if (field.type === "textarea" ? CONTROL_EXCEPT_NEWLINE.test(raw) : CONTROL.test(raw)) {
      add(key, "Contains characters that are not allowed.");
      continue;
    }
    const value = normalizeValue(field, raw);
    if (value === "") continue;
    if (field.type === "select" && !field.options.includes(value)) add(key, `Select a valid ${field.label.toLowerCase()}.`);
    else if (value.length > field.max && field.type !== "select" && field.type !== "date") add(key, `Must be at most ${field.max} characters.`);
    else clean[key] = value;
  }
  if (issues.length) throw new AppError(400, "VALIDATION_ERROR", "Invalid request.", { fields: issues });
  return clean;
}

/**
 * Values the SERVER fills in itself (derived fields marked `stored`, today only AGE): calculated from the answers with
 * the server's date and written into the stored answers, replacing anything that was there. Returns new data.
 */
export function applyComputed(def, data, today = todayIso()) {
  const out = { ...data };
  for (const field of allFields(def)) {
    if (field.type !== "derived" || !field.stored || field.derive?.kind !== "age") continue;
    const years = ageFromDob(out[field.derive.from], today);
    if (years === null) delete out[field.key];
    else out[field.key] = String(years);
  }
  return out;
}

/** { errors: {key: message} } for every required field that is empty or any filled field that is invalid. */
export function validateForm(def, data, today = todayIso()) {
  const errors = {};
  for (const field of answerFields(def)) {
    const value = normalizeValue(field, data[field.key]);
    if (value === "") {
      if (field.required) errors[field.key] = `${field.label} is required.`;
      continue;
    }
    const tooLong = field.type !== "select" && field.type !== "date" && value.length > field.max;
    const message = tooLong ? `Must be at most ${field.max} characters.` : formatError(field, value, data, today);
    if (message) errors[field.key] = message;
  }
  return errors;
}

/**
 * Progress from the real required fields. A required field counts once it holds
 * a valid value. A section is "complete" when all of its required fields do,
 * "attention" when anything in it is filled in wrongly, otherwise "incomplete".
 */
export function computeProgress(def, data, today = todayIso()) {
  const errors = validateForm(def, data, today);
  let done = 0;
  let total = 0;
  const sections = def.sections.map((section) => {
    const fields = section.fields.filter((x) => x.type !== "derived");
    const required = fields.filter((x) => x.required);
    const requiredDone = required.filter((x) => data[x.key] && !errors[x.key]).length;
    const invalid = fields.some((x) => data[x.key] && errors[x.key]);
    done += requiredDone;
    total += required.length;
    return {
      id: section.id,
      requiredTotal: required.length,
      requiredDone,
      status: invalid ? "attention" : requiredDone === required.length ? "complete" : "incomplete",
    };
  });
  const rounded = total === 0 ? 100 : Math.round((done / total) * 100);
  // Never show 100% until every required field is really done.
  const percent = done < total ? Math.min(rounded, 99) : rounded;
  return { percent, requiredTotal: total, requiredDone: done, sections };
}

export const sectionIds = (def) => def.sections.map((s) => s.id);
export { allFields };
