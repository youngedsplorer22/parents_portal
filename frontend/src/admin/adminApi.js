// Client for the staff API under /api/admin. Identity is the staff member's own HttpOnly cookie, which this
// code can't read. Nothing here logs or stores request or response bodies.
import { ApiError, apiFetch, deleteJson, getJson, patchJson, postJson, serverBusyMessage } from "../api/http.js";

const A = "/api/admin";

function requireStaff(data) {
  const s = data?.staff;
  if (data?.authenticated !== true || typeof s?.email !== "string" || !["admin", "sales"].includes(s?.role)) throw new ApiError("SERVER_ERROR");
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

export const listSchools = ({ includeArchived = false, signal } = {}) =>
  list(`${A}/schools${includeArchived ? "?includeArchived=true" : ""}`, "schools", signal);
/** `branch` is optional; an empty one is not sent. */
export const createSchool = async (name, branch = "", { signal } = {}) =>
  one(await postJson(`${A}/schools`, { name, ...(branch.trim() ? { branch } : {}) }, signal), "school");
export const updateSchool = async (id, patch, { signal } = {}) => one(await patchJson(`${A}/schools/${id}`, patch, signal), "school");

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 512 * 1024;
/** Uploads a school logo as the raw image (the server checks the real type from its bytes). -> the updated school */
export async function uploadSchoolLogo(id, file, { signal } = {}) {
  let response;
  try {
    response = await apiFetch(`${A}/schools/${id}/logo`, {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": file.type },
      body: file,
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError("NETWORK_ERROR");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* not JSON */
  }
  if (!response.ok) throw new ApiError(data?.error?.code ?? "SERVER_ERROR", { status: response.status, details: data?.error ?? {} });
  return one(data, "school");
}
export const removeSchoolLogo = async (id, { signal } = {}) => one(await deleteJson(`${A}/schools/${id}/logo`, signal), "school");

export const listTrips = ({ schoolId, signal } = {}) => list(`${A}/trips${schoolId ? `?schoolId=${encodeURIComponent(schoolId)}` : ""}`, "trips", signal);
export const getTrip = async (id, { signal } = {}) => one(await getJson(`${A}/trips/${id}`, signal), "trip");
export const createTrip = async (schoolId, input, { signal } = {}) => one(await postJson(`${A}/schools/${schoolId}/trips`, input, signal), "trip");
export const updateTrip = async (id, patch, { signal } = {}) => one(await patchJson(`${A}/trips/${id}`, patch, signal), "trip");
export const setTripStatus = async (id, status, { signal } = {}) => one(await postJson(`${A}/trips/${id}/status`, { status }, signal), "trip");

/** Turns the trip's public registration page on or off. -> the updated trip */
export const setPublicRegistration = async (id, enabled, { signal } = {}) =>
  one(await postJson(`${A}/trips/${id}/public-registration`, { enabled }, signal), "trip");
/** The full address of a trip's public page: the server's PUBLIC_BASE_URL form if set, else this site's origin. */
export const publicAddress = (trip) => trip.publicUrl ?? `${window.location.origin}${trip.publicPath}`;

export const listStaff = ({ signal } = {}) => list(`${A}/staff`, "staff", signal);
/** Adds a SALES account with no password: its owner sets one by emailed code. -> { ..., status: "pending" } */
export const createStaff = async ({ name, email }, { signal } = {}) => one(await postJson(`${A}/staff`, { name, email, role: "sales" }, signal), "staff");
export const setStaffActive = async (id, active, { signal } = {}) => one(await patchJson(`${A}/staff/${id}`, { active }, signal), "staff");

export const listAudit = ({ limit = 100, signal } = {}) => list(`${A}/audit?limit=${limit}`, "entries", signal);


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
