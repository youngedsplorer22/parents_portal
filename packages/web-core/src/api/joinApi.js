// Client for the public trip page lookup. The three address words are not a secret; they only name the trip.
import { ApiError, getJson } from "./http.js";
import { safeLogo } from "./onboardingApi.js";

const text = (v) => (typeof v === "string" ? v : "");

/** -> { school, trip: { title, destination, tourType }, registrationOpen } or throws ApiError */
export async function resolvePublicTrip({ school, branch, trip }, { signal } = {}) {
  const path = [school, branch, trip].map(encodeURIComponent).join("/");
  const data = await getJson(`/api/join/${path}`, signal);
  if (typeof data.school?.name !== "string" || typeof data.trip?.title !== "string" || typeof data.registrationOpen !== "boolean") {
    throw new ApiError("SERVER_ERROR");
  }
  return {
    school: {
      name: data.school.name,
      ...(typeof data.school.branch === "string" && data.school.branch ? { branch: data.school.branch } : {}),
      ...(safeLogo(data.school.logo) ? { logo: safeLogo(data.school.logo) } : {}),
    },
    trip: { title: data.trip.title, destination: data.trip.destination ? text(data.trip.destination) : "", tourType: text(data.trip.tourType) },
    registrationOpen: data.registrationOpen,
  };
}

/** User-facing text. An unknown, private or archived trip all read the same, as on the server. */
export function joinErrorMessage(err) {
  switch (err?.code) {
    case "TRIP_NOT_FOUND":
      return "This registration page isn't available. Please check the address with your school.";
    case "RATE_LIMITED":
      return "Too many requests. Please wait a moment and try again.";
    case "NETWORK_ERROR":
      return "Can't reach the server. Check your connection and try again.";
    default:
      return "We couldn't open this page. Please try again.";
  }
}
