// Rules shared by the onboarding forms and the account registration, applied on the server (the authority).
// frontend/src/validation/rules.js is an exact copy of these three functions for instant feedback; a parity test
// (frontend/src/validation/rules.parity.test.js) runs both on the same cases so they can't drift apart.

/**
 * A person's name: letters in any script (with their accents and marks), spaces, hyphens, apostrophes (' or ’) and
 * full stops (for initials, e.g. "R. K. Sharma"). At least one letter. The value is checked as entered (after the
 * normal trimming); it is never rewritten into a different name. Returns a message naming the field, or null.
 */
export function personNameError(label, value) {
  const v = String(value ?? "").normalize("NFC");
  if (/\p{Nd}/u.test(v)) return `${label} can't contain numbers.`;
  if (!/^[\p{L}\p{M} '’.-]+$/u.test(v)) return `${label} can only contain letters, spaces, hyphens, apostrophes and full stops.`;
  if (!/\p{L}/u.test(v)) return `${label} must contain letters.`;
  return null;
}

/**
 * A mobile number: exactly 10 digits (0-9), nothing else. No country code, spaces, hyphens or brackets; the value is
 * stored as entered and never shortened or rewritten. Surrounding spaces are ignored. Returns a message or null.
 */
export const PHONE_DIGITS = 10;
// Drafts may hold a mistyped number up to this length (so autosave never fails mid-form); submission needs 10 digits.
export const PHONE_MAX_LENGTH = 25;
export function phoneError(value) {
  const v = String(value ?? "").trim();
  if (v === "") return "Enter your 10-digit mobile number.";
  if (v.startsWith("+")) return "Enter your 10-digit mobile number without the country code (no + or 91 in front).";
  if (!/^[0-9]+$/.test(v)) return "Use digits only, with no spaces, letters or symbols.";
  if (v.length < PHONE_DIGITS) return `Enter all 10 digits of your mobile number (you entered ${v.length}).`;
  if (v.length > PHONE_DIGITS) return `That's ${v.length} digits. Enter your 10-digit mobile number without the country code.`;
  return null;
}

const isIso = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * Completed years from a date of birth to `today` (both YYYY-MM-DD), or null for an invalid, pre-1900 or future
 * date. A 29 February birthday is reached on 1 March in non-leap years.
 */
export function ageFromDob(dob, today) {
  if (!isIso(dob) || !isIso(today) || Number(dob.slice(0, 4)) < 1900 || dob > today) return null;
  const [by, bm, bd] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
