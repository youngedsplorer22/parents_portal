// Client for /api/live-location (parents and the chosen team lead) and the staff live-location routes. The server
// decides who the caller is from the session cookie; the page only names one of its OWN enrolments (or, for staff, a
// trip they manage). Coordinates are never logged or written to browser storage.
import { getJson, postJson, putJson } from "./http.js";

const BASE = "/api/live-location";
const STATES = ["not_started", "waiting", "live", "stale", "stopped", "ended"];

const num = (v) => typeof v === "number" && Number.isFinite(v);
/** Only a well-formed answer is used; anything else is treated as "no position" rather than guessed at. */
export function toLiveView(body) {
  if (!body || !STATES.includes(body.state)) return null;
  const l = body.location;
  const location = l && num(l.latitude) && num(l.longitude) && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180 && !Number.isNaN(Date.parse(l.capturedAt))
    ? { latitude: l.latitude, longitude: l.longitude, accuracyM: num(l.accuracyM) ? l.accuracyM : null, capturedAt: l.capturedAt, receivedAt: l.receivedAt ?? null }
    : null;
  const interval = num(body.policy?.updateIntervalSeconds) ? body.policy.updateIntervalSeconds : 300;
  const stale = num(body.policy?.staleAfterSeconds) ? body.policy.staleAfterSeconds : 720;
  return {
    trip: body.trip ?? null,
    state: body.state,
    location: ["live", "stale"].includes(body.state) ? location : null, // a position is only ever shown while sharing is on
    sharingSince: body.sharingSince ?? null,
    teamLead: body.teamLead ? { canShare: body.teamLead.canShare === true, sharingHere: body.teamLead.sharingHere === true } : null,
    policy: { updateIntervalSeconds: interval, staleAfterSeconds: stale },
    serverTime: body.serverTime ?? null,
  };
}

export const getLiveLocation = async (enrolmentId, { signal } = {}) =>
  toLiveView(await getJson(`${BASE}?enrolment=${encodeURIComponent(enrolmentId)}`, signal));
export const startSharing = async (enrolmentId) => toLiveView(await postJson(`${BASE}/start`, { enrolmentId }));
export const stopSharing = async (enrolmentId) => toLiveView(await postJson(`${BASE}/stop`, { enrolmentId }));
/** One position: { latitude, longitude, accuracy, capturedAt (ISO) }. */
export const sendLocation = async (enrolmentId, fix) => toLiveView(await postJson(`${BASE}/location`, { enrolmentId, ...fix }));

// ---- staff ----
export async function getTripLiveLocation(tripId, { signal } = {}) {
  const body = await getJson(`/api/admin/trips/${encodeURIComponent(tripId)}/live-location`, signal);
  return { ...toLiveView({ ...body, trip: null }), teamLeadEnrolmentId: body.teamLeadEnrolmentId ?? null, candidates: Array.isArray(body.candidates) ? body.candidates : [] };
}
export async function assignTeamLead(tripId, enrolmentId) {
  const body = await putJson(`/api/admin/trips/${encodeURIComponent(tripId)}/live-location/team-lead`, { enrolmentId });
  return { ...toLiveView({ ...body, trip: null }), teamLeadEnrolmentId: body.teamLeadEnrolmentId ?? null, candidates: Array.isArray(body.candidates) ? body.candidates : [] };
}

/** Words for the error codes the live-location routes return. */
export function liveLocationErrorMessage(err) {
  switch (err?.code) {
    case "NETWORK_ERROR": return "No internet connection. We'll try again automatically.";
    case "NOT_TEAM_LEAD": return "Only the team lead chosen for this trip can share its location.";
    case "TRIP_NOT_ACTIVE": return "This trip isn't active, so its location can't be shared.";
    case "NOT_SHARING": return "Sharing was stopped (here or on another device). Start it again to continue.";
    case "TOO_FREQUENT": return "Location was sent very recently. The next update will follow automatically.";
    case "INVALID_LOCATION": return err.details?.message || "That location couldn't be used. Check the phone's date, time and location settings.";
    case "UNAUTHENTICATED": return "Your session has ended. Please log in again.";
    case "RATE_LIMITED": return "Too many requests. Please wait a moment.";
    default: return "Something went wrong. Please try again.";
  }
}
