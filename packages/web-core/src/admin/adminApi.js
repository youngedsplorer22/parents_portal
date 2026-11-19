// Client for the Sales staff API under /api/admin (sign-in, password and itinerary only). Identity is the staff member's own HttpOnly cookie, which this
// code can't read. Nothing here logs or stores request or response bodies.
import { ApiError, getJson, patchJson, postJson, serverBusyMessage } from "../api/http.js";

const A = "/api/admin";

function requireStaff(data) {
  const s = data?.staff;
  if (data?.authenticated !== true || typeof s?.email !== "string" || s?.role !== "sales") throw new ApiError("SERVER_ERROR");
  return { email: s.email, name: s.name ?? "", role: s.role };
}

export const staffLogin = async (email, password, { signal } = {}) =>
  requireStaff(await postJson(`${A}/auth/login`, { email: String(email).trim().toLowerCase(), password }, signal));
export const staffLogout = async ({ signal } = {}) => {
  await postJson(`${A}/auth/logout`, undefined, signal);
};
/** The signed-in staff member, or null when there is no staff session. */
export async function getStaffSession({ signal } = {}) {
  try {
    return requireStaff(await getJson(`${A}/auth/session`, signal));
  } catch (err) {
    if (err?.code === "UNAUTHENTICATED") return null;
    throw err;
  }
}

const list = async (url, key, signal) => {
  const data = await getJson(url, signal);
  if (!Array.isArray(data[key])) throw new ApiError("SERVER_ERROR");
  return data[key];
};
const one = (data, key) => {
  if (!data[key] || typeof data[key] !== "object") throw new ApiError("SERVER_ERROR");
  return data[key];
};

/** Itinerary: a Sales person, only for trips a developer assigned to them. The server decides which trips they may see. */
export const listItineraryTrips = ({ signal } = {}) => list(`${A}/itinerary/trips`, "trips", signal);
export const listItinerary = (tripId, { signal } = {}) => list(`${A}/trips/${tripId}/itinerary`, "items", signal);
export const addItineraryItem = async (tripId, input, { signal } = {}) => one(await postJson(`${A}/trips/${tripId}/itinerary`, input, signal), "item");
export const updateItineraryItem = async (tripId, itemId, patch, { signal } = {}) => one(await patchJson(`${A}/trips/${tripId}/itinerary/${itemId}`, patch, signal), "item");

/** User-facing text for a failed admin call. The server's own field messages are shown for validation errors. */
export function adminErrorMessage(err) {
  switch (err?.code) {
    case "INVALID_CREDENTIALS":
      return "The email or password is incorrect.";
    case "RATE_LIMITED":
      return "Too many attempts. Please wait a while and try again.";
    case "UNAUTHENTICATED":
      return "Your session has ended. Please log in again.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "CROSS_SITE_REQUEST":
      return "This request was blocked. Reload the page and try again.";
    case "NOT_FOUND":
      return "That item no longer exists.";
    case "CURRENT_PASSWORD_INCORRECT":
      return "The current password is incorrect.";
    case "VERIFICATION_REQUIRED":
      return "Your verification has expired or was already used. Please start again to get a new code.";
    case "STAFF_EXISTS":
      return "A staff account with that email already exists.";
    case "STAFF_PROTECTED":
      return "Admin accounts can't be changed here. They are managed with the command-line tool.";
    case "SCHOOL_EXISTS":
      return "A school with that name and branch already exists.";
    case "LOGO_INVALID":
      return typeof err.details?.message === "string" ? err.details.message : "Upload a PNG, JPEG or WebP image of at most 512 KB.";
    case "PAYLOAD_TOO_LARGE":
      return "The logo can be at most 512 KB.";
    case "SCHOOL_ARCHIVED":
      return "That school is archived.";
    case "INVALID_STATUS_CHANGE":
      return "That change isn't allowed for the trip's current status.";
    case "NOT_A_TEAM_LEADER":
      return "Choose someone registered for this trip as a Team Leader.";
    case "INVALID_ASSIGNEE":
      return "Only active Sales accounts can be assigned to a trip.";
    case "TEMPLATE_MISMATCH":
      return "That trip uses a different registration template.";
    case "TRIP_ARCHIVED":
      return "An archived trip can't be deployed.";
    case "TRIP_LOCKED":
      return "The tour type and payment mode can only be changed while the trip is a draft.";
    case "VALIDATION_ERROR": {
      const first = Array.isArray(err.details?.fields) ? err.details.fields.find((f) => typeof f?.message === "string") : null;
      return first ? first.message : "Please check the details and try again.";
    }
    case "SERVER_BUSY":
      return serverBusyMessage(err);
    case "NETWORK_ERROR":
      return "Can't reach the server. Check your connection and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// ---- Staff passwords: first-time setup / forgot password (public) and change (signed in) ----
// The verification token and passwords are passed in for ONE request body each and never logged or stored here.
const P = `${A}/auth/password`;
const normalize = (email) => String(email).trim().toLowerCase();

function requireChallenge(data) {
  if (!Number.isFinite(data.expiresInSeconds) || !Number.isFinite(data.resendAvailableInSeconds)) throw new ApiError("SERVER_ERROR");
  return data;
}
/** Same answer for every email, so nothing here can tell whether an address is staff. */
export const requestStaffPasswordCode = async (email, { signal } = {}) =>
  requireChallenge(await postJson(`${P}/request`, { email: normalize(email) }, signal));
export const resendStaffPasswordCode = async (email, { signal } = {}) =>
  requireChallenge(await postJson(`${P}/resend`, { email: normalize(email) }, signal));
/** -> { verificationToken, verificationTokenExpiresInSeconds } (kept in memory by the caller only; same shape as the parents' client) */
export async function verifyStaffPasswordCode(email, code, { signal } = {}) {
  const data = await postJson(`${P}/verify`, { email: normalize(email), code }, signal);
  if (data.verified !== true || typeof data.verificationToken !== "string" || data.verificationToken === "") throw new ApiError("SERVER_ERROR");
  return { verificationToken: data.verificationToken, verificationTokenExpiresInSeconds: Number(data.verificationTokenExpiresInSeconds) || 0 };
}
/** Resolves to { firstTime } only when the server confirms. It does not sign anyone in. */
export async function confirmStaffPassword({ email, verificationToken, password, confirmPassword }, { signal } = {}) {
  const data = await postJson(`${P}/confirm`, { email: normalize(email), verificationToken, password, confirmPassword }, signal);
  if (data.passwordSet !== true) throw new ApiError("SERVER_ERROR");
  return { firstTime: data.firstTime === true };
}
/** Signed in: needs the current password. Other sessions are ended by the server; this one stays. */
export async function changeStaffPassword({ currentPassword, password, confirmPassword }, { signal } = {}) {
  const data = await postJson(P, { currentPassword, password, confirmPassword }, signal);
  if (data.passwordChanged !== true) throw new ApiError("SERVER_ERROR");
}
