// Client for POST /api/enrolments: a signed-in parent joining a trip from its public page (for example a
// returning student starting a new year). The server works out the person from the session cookie and the
// trip from the page's address words, and checks the trip is public and open; nothing here sends an id.
import { ApiError, getJson, postJson } from "./http.js";

/** Resolves only if the server confirms the enrolment (new or already existing). */
export async function enrolInTrip(address, { signal } = {}) {
  const data = await postJson("/api/enrolments", { trip: { school: address.school, branch: address.branch, trip: address.trip } }, signal);
  if (data.enrolled !== true) throw new ApiError("SERVER_ERROR");
  return { created: data.created === true, enrolmentId: typeof data.enrolmentId === "string" ? data.enrolmentId : null };
}

/**
 * After login with no trip in the address, which of the parent's own registrations to open, decided by the server:
 * -> { status: "none" } | { status: "one", enrolmentId } | { status: "several" }
 */
export async function resumeTarget({ signal } = {}) {
  const data = await getJson("/api/enrolments/resume", signal);
  if (data.status === "none") return { status: "none" };
  if (data.status === "one" && typeof data.enrolmentId === "string") return { status: "one", enrolmentId: data.enrolmentId };
  if (data.status === "several") return { status: "several" };
  throw new ApiError("SERVER_ERROR");
}


/** User-facing text. Raw server text is never shown. */
export function enrolmentErrorMessage(err) {
  switch (err?.code) {
    case "TRIP_NOT_FOUND":
      return "This trip's registration page isn't available any more, so we couldn't add this trip. Please check with your school.";
    case "TRIP_NOT_OPEN":
      return "Registration isn't open for that trip right now. Please check with your school.";
    case "NETWORK_ERROR":
      return "Can't reach the server, so we couldn't add this trip. Check your connection and try again.";
    default:
      return "We couldn't add this trip. Please try again.";
  }
}
