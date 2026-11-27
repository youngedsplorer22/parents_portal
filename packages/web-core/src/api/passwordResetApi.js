// Client for the Forgot Password endpoints under /api/auth/password-reset.
// request/resend/verify answer the same way for every email, so nothing here (or in the
// UI built on it) can tell whether an account exists. The verification token and the new
// password are passed in for one request body and never logged or stored.
import { normalizeEmail } from "./emailOtpApi.js";
import { ApiError, postJson, serverBusyMessage } from "./http.js";

const BASE = "/api/auth/password-reset";

function requireChallenge(data) {
  if (!Number.isFinite(data.expiresInSeconds) || !Number.isFinite(data.resendAvailableInSeconds)) {
    throw new ApiError("SERVER_ERROR");
  }
  return data;
}

/** -> { expiresInSeconds, resendAvailableInSeconds, delivery, alreadySent } */
export const requestPasswordReset = async (email, { signal } = {}) =>
  requireChallenge(await postJson(`${BASE}/request`, { email: normalizeEmail(email) }, signal));

/** Explicit resend; the server voids the previous code. Same response shape as request. */
export const resendPasswordReset = async (email, { signal } = {}) =>
  requireChallenge(await postJson(`${BASE}/resend`, { email: normalizeEmail(email) }, signal));

/** -> { verificationToken, verificationTokenExpiresInSeconds } (kept in memory by the caller only) */
export async function verifyPasswordResetCode(email, code, { signal } = {}) {
  const data = await postJson(`${BASE}/verify`, { email: normalizeEmail(email), code }, signal);
  if (data.verified !== true || typeof data.verificationToken !== "string" || data.verificationToken === "") {
    throw new ApiError("SERVER_ERROR");
  }
  return {
    verificationToken: data.verificationToken,
    verificationTokenExpiresInSeconds: Number(data.verificationTokenExpiresInSeconds) || 0,
  };
}

/** Resolves only when the server confirms the change. It does not sign the user in. */
export async function confirmPasswordReset({ email, verificationToken, password, confirmPassword }, { signal } = {}) {
  const data = await postJson(
    `${BASE}/confirm`,
    // Passwords are sent exactly as typed (never trimmed).
    { email: normalizeEmail(email), verificationToken, password, confirmPassword },
    signal,
  );
  if (data.passwordChanged !== true) throw new ApiError("SERVER_ERROR");
}

/** User-facing text for a failed confirm. Raw server text is never shown. */
export function resetErrorMessage(err) {
  switch (err?.code) {
    case "VERIFICATION_REQUIRED":
      return "Your verification has expired or was already used. Please start again to get a new code.";
    case "VALIDATION_ERROR":
      return "Please check the highlighted details and try again.";
    case "SERVER_BUSY":
      return serverBusyMessage(err);
    case "NETWORK_ERROR":
      return "Can't reach the server, so we couldn't confirm the change. Check your connection and try again.";
    default:
      return "We couldn't change your password. Please try again.";
  }
}
