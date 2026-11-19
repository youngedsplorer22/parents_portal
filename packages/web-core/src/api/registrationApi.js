// Client for POST /api/registrations. Sends the form details, the password and the email
// verification token from the OTP step. The token and password are passed in by the caller,
// used for this one request body, and never logged or stored here. There is no school field:
// the school comes from the trip's public page (publicTrip: its address words), checked on the server.
import { normalizeEmail } from "./emailOtpApi.js";
import { ApiError, postJson, serverBusyMessage } from "./http.js";

const FIELDS = ["firstName", "lastName", "role", "phone", "email", "password"];

/**
 * Resolves only if the backend confirms the insert (201 with registered: true).
 * Anything else throws, so the UI can never show success on an unconfirmed result.
 */
export async function registerParent(details, { signal } = {}) {
  const data = await postJson(
    "/api/registrations",
    {
      firstName: details.firstName.trim(),
      lastName: details.lastName.trim(),
      role: details.role,
      phone: details.phone.trim(),
      email: normalizeEmail(details.email),
      // Passwords are sent exactly as typed (never trimmed) and only in this request body.
      password: details.password,
      verificationToken: details.verificationToken,
      ...(details.publicTrip ? { publicTrip: { school: details.publicTrip.school, branch: details.publicTrip.branch, trip: details.publicTrip.trip } } : {}),
    },
    signal,
  );
  if (data.registered !== true || typeof data.registrationId !== "string" || data.registrationId === "") {
    throw new ApiError("SERVER_ERROR");
  }
  return { registrationId: data.registrationId, email: typeof data.email === "string" ? data.email : normalizeEmail(details.email) };
}

/** { phone: "Enter a valid phone number." } from a VALIDATION_ERROR, limited to known form fields. */
export function fieldErrorsFrom(err) {
  const out = {};
  for (const { path, message } of Array.isArray(err?.details?.fields) ? err.details.fields : []) {
    if (FIELDS.includes(path) && typeof message === "string" && !out[path]) out[path] = message;
  }
  return out;
}

/** User-facing text. Raw server text is never shown. */
export function registrationErrorMessage(err) {
  switch (err?.code) {
    case "VERIFICATION_REQUIRED":
      return "Your email verification has expired or was already used. Please verify your email again.";
    case "EMAIL_ALREADY_REGISTERED":
      return "This email address is already registered. Log in instead, or use a different email address.";
    case "TRIP_NOT_FOUND":
      return "This trip's registration page isn't available any more. Please check with your school.";
    case "TRIP_NOT_OPEN":
      return "Registration isn't open for this trip right now. Please check with your school.";
    case "VALIDATION_ERROR":
      return "Please check the highlighted details and try again.";
    case "SERVER_BUSY":
      return serverBusyMessage(err);
    case "NETWORK_ERROR":
      return "Can't reach the server, so we couldn't confirm your registration. Check your connection and try again.";
    default:
      return "We couldn't complete your registration. Please try again.";
  }
}
