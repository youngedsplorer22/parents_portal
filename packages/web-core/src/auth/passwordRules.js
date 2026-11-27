// The browser-side half of the password rules. The server applies the same ones (plus a
// common-password check) and is the authority; these only save a round trip.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** An error message for a new password, or "". */
export function passwordProblem(password) {
  const length = [...password].length;
  if (!password) return "Create a password.";
  if (length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Password must be ${PASSWORD_MAX} characters or fewer.`;
  if (!password.trim()) return "Password can't be only spaces.";
  return "";
}

/** An error message for the confirmation field, or "". */
export function confirmProblem(password, confirmPassword) {
  if (!confirmPassword) return "Confirm your password.";
  if (confirmPassword !== password) return "Passwords do not match.";
  return "";
}
