// Client for the backend email OTP endpoints (purpose "registration" or "login").
// Requests go to /api/email-otp, which the Vite dev server proxies to the backend.
// Nothing here logs, stores or persists codes or verification tokens.
import { ApiError, postJson } from "./http.js";

const BASE = "/api/email-otp";
const DEFAULT_PURPOSE = "registration";

// The OTP client's error type is the shared ApiError.
export { ApiError as OtpApiError };

export const normalizeEmail = (email) => String(email).trim().toLowerCase();

const post = (path, body, signal) => postJson(BASE + path, body, signal);

const challengeRequest = (email, purpose = DEFAULT_PURPOSE) => ({ email: normalizeEmail(email), purpose });

function requireChallenge(data) {
  if (!Number.isFinite(data.expiresInSeconds) || !Number.isFinite(data.resendAvailableInSeconds)) {
    throw new ApiError("SERVER_ERROR");
  }
  return data;
}

/** -> { expiresInSeconds, resendAvailableInSeconds, delivery, alreadySent } */
export const sendEmailOtp = async (email, { signal, purpose } = {}) =>
  requireChallenge(await post("/send", challengeRequest(email, purpose), signal));

/** Explicit resend: the backend invalidates the previous code. Same response shape as send. */
export const resendEmailOtp = async (email, { signal, purpose } = {}) =>
  requireChallenge(await post("/resend", challengeRequest(email, purpose), signal));

/** -> { verificationToken, verificationTokenExpiresInSeconds } (kept in memory by the caller only) */
export async function verifyEmailOtp(email, code, { signal, purpose } = {}) {
  const data = await post("/verify", { ...challengeRequest(email, purpose), code }, signal);
  if (data.verified !== true || typeof data.verificationToken !== "string" || data.verificationToken === "") {
    throw new ApiError("SERVER_ERROR");
  }
  return {
    verificationToken: data.verificationToken,
    verificationTokenExpiresInSeconds: Number(data.verificationTokenExpiresInSeconds) || 0,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** User-facing text for an error from the functions above. */
export function otpErrorMessage(err) {
  const d = err?.details ?? {};
  switch (err?.code) {
    case "INVALID_CODE":
      return Number.isFinite(d.attemptsRemaining)
        ? `That code is incorrect. ${plural(d.attemptsRemaining, "attempt")} left.`
        : "That code is incorrect.";
    case "OTP_EXPIRED":
      return "This code has expired. Request a new code.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many incorrect attempts. Request a new code.";
    case "OTP_NOT_FOUND":
      return "There is no active code for this email. Request a new code.";
    case "RESEND_COOLDOWN":
      return Number.isFinite(d.retryAfterSeconds)
        ? `Please wait ${d.retryAfterSeconds}s before requesting a new code.`
        : "Please wait a moment before requesting a new code.";
    case "RATE_LIMITED":
      return "Too many verification requests. Please try again later.";
    case "DELIVERY_FAILED":
      return "We couldn't send the email. Please try again in a moment.";
    case "VALIDATION_ERROR":
      return "Please check the email address and code, then try again.";
    case "NETWORK_ERROR":
      return "Can't reach the server. Check your connection and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
