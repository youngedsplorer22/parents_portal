// Client for /api/auth. Identity comes from the server's HttpOnly session cookie,
// which this code cannot read, so there is nothing to store, log or leak here.
// Login uses the same single-use email verification token as registration: it is
// passed in for one request body and never kept.
import { normalizeEmail } from "./emailOtpApi.js";
import { ApiError, getJson, postJson, serverBusyMessage } from "./http.js";

function requireUser(data) {
  const u = data?.user;
  if (data?.authenticated !== true || typeof u?.email !== "string" || typeof u?.firstName !== "string") {
    throw new ApiError("SERVER_ERROR");
  }
  return { email: u.email, firstName: u.firstName, lastName: u.lastName ?? "", role: u.role ?? "" };
}

/** The signed-in user, or null when there is no valid session. Other failures throw. */
export async function getSession({ signal } = {}) {
  try {
    return requireUser(await getJson("/api/auth/session", signal));
  } catch (err) {
    if (err?.code === "UNAUTHENTICATED") return null;
    throw err;
  }
}

/** Resolves to the user only after the server has created the session. */
export async function loginWithToken(email, verificationToken, { signal } = {}) {
  return requireUser(await postJson("/api/auth/login", { email: normalizeEmail(email), verificationToken }, signal));
}

/** Email + password sign-in. Resolves to the user only after the server has created the session. */
export async function loginWithPassword(email, password, { signal } = {}) {
  return requireUser(await postJson("/api/auth/login/password", { email: normalizeEmail(email), password }, signal));
}

export const logout = async ({ signal } = {}) => {
  await postJson("/api/auth/logout", undefined, signal);
};

/** User-facing text for a failed login. Raw server text is never shown. */
export function loginErrorMessage(err) {
  switch (err?.code) {
    case "ACCOUNT_NOT_FOUND":
      return "We couldn't find an account for this email address. Please register first.";
    case "VERIFICATION_REQUIRED":
      return "Your email verification has expired or was already used. Please verify your email again.";
    case "INVALID_CREDENTIALS":
      return "The email or password is incorrect. You can also sign in with an email code.";
    case "RATE_LIMITED": {
      const minutes = Math.ceil(Number(err?.details?.retryAfterSeconds) / 60);
      return `Too many sign-in attempts. ${minutes > 0 ? `Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}, or ` : "Please wait a while, or "}sign in with an email code instead.`;
    }
    case "SERVER_BUSY":
      return serverBusyMessage(err);
    case "NETWORK_ERROR":
      return "Can't reach the server, so we couldn't log you in. Check your connection and try again.";
    default:
      return "We couldn't log you in. Please try again.";
  }
}
