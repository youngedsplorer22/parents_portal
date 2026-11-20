import { PHONE_DIGITS } from "./rules.js";

/**
 * The value a phone field takes after a change. Typing one more character beyond 10 is ignored, so the field stops at
 * 10 as you type. Anything else (a paste, autofill, deleting) is kept exactly as entered: an over-long or malformed
 * value is shown with its error, never shortened into a different number that merely looks valid. (That's why the
 * input has no maxLength: the browser would silently cut a pasted "919876543210" down to "9198765432".)
 */
export function nextPhoneValue(previous, next) {
  const typedOneMore = next.length === previous.length + 1;
  if (typedOneMore && next.length > PHONE_DIGITS) return previous;
  return next;
}
