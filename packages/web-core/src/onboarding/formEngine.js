// Client-side checks for the onboarding forms, driven by the definitions the
// server sends (backend/src/modules/onboarding/definitions.js). They give instant
// feedback and a live progress figure; the server repeats every check and is the
// authority. backend/src/modules/onboarding/engine.js holds the same rules, and
// formEngine.parity.test.js keeps the two in step.

import { personNameError, phoneError } from "../validation/rules.js";

export const ROLE_LABELS = { student: "Student", teacher: "Teacher", team_leader: "Team Leader" };

const pad = (n) => String(n).padStart(2, "0");
/** Today's date in the browser's time zone as YYYY-MM-DD. */
export const todayIso = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

export const allFields = (def) => def.sections.flatMap((s) => s.fields);
export const answerFields = (def) => allFields(def).filter((f) => f.type !== "derived");

/** Same normalisation the server applies before storing. */
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

const addDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function formatError(field, value, answers, today) {
  if (field.type === "select") return field.options.includes(value) ? null : `Select a ${field.label.toLowerCase()}.`;
  if (field.rule === "personName") return personNameError(field.label, value);
  if (field.rule === "phone") return phoneError(value);
  if (field.pattern && !new RegExp(field.pattern).test(value)) return field.patternMessage ?? `Enter a valid ${field.label.toLowerCase()}.`;
  if (field.type === "date") {
    if (!isIsoDate(value)) return "Enter a valid date.";
    if (field.minYear && Number(value.slice(0, 4)) < field.minYear) return "Enter a valid date.";
    if (field.notFuture && value > addDay(today)) return "Date can't be in the future.";
    if (field.after) {
      const other = normalizeValue({ type: "date" }, answers[field.after]);
      if (isIsoDate(other) && value <= other) return field.afterMessage ?? "Date is too early.";
    }
  }
  return null;
}

/** Message for one field's current value, or null when it is fine (or optional and empty). */
export function fieldError(field, raw, answers, today = todayIso()) {
  const value = normalizeValue(field, raw);
  if (value === "") return field.required ? `${field.label} is required.` : null;
  if (field.type !== "select" && field.type !== "date" && value.length > field.max) return `Must be at most ${field.max} characters.`;
  return formatError(field, value, answers, today);
}

/** { key: message } for every required field that is empty and every filled field that is invalid. */
export function validateForm(def, answers, today = todayIso()) {
  const errors = {};
  for (const field of answerFields(def)) {
    const message = fieldError(field, answers[field.key], answers, today);
    if (message) errors[field.key] = message;
  }
  return errors;
}

/**
 * Progress from the real required fields: a required field counts once it holds a
 * valid value. Sections are "complete", "attention" (something filled in wrongly)
 * or "incomplete". Never 100% until every required field is valid.
 */
export function computeProgress(def, answers, today = todayIso()) {
  const errors = validateForm(def, answers, today);
  const filled = (f) => normalizeValue(f, answers[f.key]) !== "";
  let done = 0;
  let total = 0;
  const sections = def.sections.map((section) => {
    const fields = section.fields.filter((f) => f.type !== "derived");
    const required = fields.filter((f) => f.required);
    const requiredDone = required.filter((f) => filled(f) && !errors[f.key]).length;
    const invalid = fields.some((f) => filled(f) && errors[f.key]);
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
  return { percent: done < total ? Math.min(rounded, 99) : rounded, requiredTotal: total, requiredDone: done, sections };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ymdBetween(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let years = ty - fy;
  let months = tm - fm;
  let days = td - fd;
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(ty, tm - 1, 0)).getUTCDate(); // days in the month before `to`
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}

/**
 * Completed years between a date of birth and today, or null when the date of birth is not a real,
 * plausible, non-future date (so no misleading age is ever produced from half-typed or bad input).
 */
export function ageFromDob(dob, today = todayIso()) {
  const from = normalizeValue({ type: "date" }, dob);
  if (!isIsoDate(from) || Number(from.slice(0, 4)) < 1900 || from > today) return null;
  return ymdBetween(from, today).years;
}

/** Read-only values the spreadsheets show (AGE, PASSPORT VALIDITY). "" until the source date is valid. */
export function deriveValue(field, answers, today = todayIso()) {
  const from = normalizeValue({ type: "date" }, answers[field.derive.from]);
  if (!isIsoDate(from)) return "";
  if (field.derive.kind === "age") {
    if (from > today) return "";
    return String(ymdBetween(from, today).years);
  }
  if (from <= today) return "Expired";
  const { years, months, days } = ymdBetween(today, from);
  return `${plural(years, "year")} ${plural(months, "month")} ${plural(days, "day")}`;
}

/** Answers as shown to the user (selects and dates as stored; empty becomes an em dash). */
export const displayValue = (field, answers, today) =>
  field.type === "derived" ? deriveValue(field, answers, today) || "—" : normalizeValue(field, answers[field.key]) || "—";
