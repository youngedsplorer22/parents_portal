import type { Fix } from "../api/client";

/**
 * Pure rules for the team lead's location, shared by the background task and the screens (and unit-tested).
 *
 * The phone's OS decides when the app receives locations (Android: about every 5 minutes, as asked; iOS: when the
 * phone has moved, more often). The app only SENDS about every 5 minutes, whichever reading is newest, and never
 * invents or re-dates a reading: a stationary phone on iOS may produce no new reading, and then parents see
 * "Out of date" rather than an old position presented as new.
 */
export const SEND_INTERVAL_MS = 5 * 60_000;
export const MIN_SEND_GAP_MS = 4.5 * 60_000; // a little under 5 minutes, so OS timing jitter doesn't skip a whole cycle
export const MAX_READING_AGE_MS = 14 * 60_000; // the server refuses readings older than 15 minutes
export const STALE_AFTER_MS = 12 * 60_000; // the same limit parents' pages use
export const LOW_ACCURACY_M = 500;

export type Reading = { coords: { latitude: number; longitude: number; accuracy: number | null }; timestamp: number };

const valid = (r: Reading) =>
  Number.isFinite(r.coords.latitude) && Number.isFinite(r.coords.longitude) &&
  Math.abs(r.coords.latitude) <= 90 && Math.abs(r.coords.longitude) <= 180 &&
  !(r.coords.latitude === 0 && r.coords.longitude === 0) &&
  (r.coords.accuracy === null || (Number.isFinite(r.coords.accuracy) && r.coords.accuracy >= 0 && r.coords.accuracy <= 10000)) &&
  Number.isFinite(r.timestamp);

/** The newest valid reading of a batch (iOS may deliver several at once). */
export function pickLatest(readings: readonly Reading[]): Reading | null {
  let best: Reading | null = null;
  for (const r of readings) if (valid(r) && (!best || r.timestamp > best.timestamp)) best = r;
  return best;
}

/** Is a send due? (Never more often than every 4.5 minutes.) */
export const sendDue = (lastSentAt: number | null, now: number) => lastSentAt === null || now - lastSentAt >= MIN_SEND_GAP_MS;

/** The reading as sent to the server, with its REAL capture time; null when it is too old or from the future. */
export function toFix(r: Reading, now: number): Fix | null {
  const age = now - r.timestamp;
  if (age > MAX_READING_AGE_MS || age < -60_000) return null;
  return { latitude: r.coords.latitude, longitude: r.coords.longitude, accuracy: r.coords.accuracy === null ? null : Math.round(r.coords.accuracy * 10) / 10, capturedAt: new Date(r.timestamp).toISOString() };
}

/**
 * What a failed send means:
 *   stop  - sharing can't continue without the person (signed out, reassigned, trip ended, stopped elsewhere)
 *   retry - temporary (offline, server busy, rate limit): try with the next reading
 *   drop  - this reading was refused (e.g. older than the last one): skip it, carry on
 */
export function classify(code: string): "stop" | "retry" | "drop" {
  if (["UNAUTHENTICATED", "NOT_TEAM_LEAD", "TRIP_NOT_ACTIVE", "NOT_SHARING", "NOT_FOUND"].includes(code)) return "stop";
  if (["INVALID_LOCATION", "VALIDATION_ERROR"].includes(code)) return "drop";
  return "retry";
}

export const STOP_REASON_TEXT: Record<string, string> = {
  UNAUTHENTICATED: "You were signed out (the sign-in ended or the password was changed). Sign in again to continue.",
  NOT_TEAM_LEAD: "You are no longer the team lead for this trip, so sharing stopped.",
  TRIP_NOT_ACTIVE: "This trip has ended, so sharing stopped.",
  NOT_SHARING: "Sharing was stopped elsewhere (on the website or another phone).",
  NOT_FOUND: "This trip is no longer available.",
  PERMISSION: "Location permission was removed, so sharing stopped.",
  STOPPED: "You stopped sharing.",
};

/** The status line for the sharing screen. */
export function statusOf({ sharing, lastSentAt, online, now }: { sharing: boolean; lastSentAt: number | null; online: boolean | null; now: number }) {
  if (!sharing) return { tone: "off", label: "Not sharing" } as const;
  if (online === false) return { tone: "warn", label: "No internet: updates will be sent when the connection is back" } as const;
  if (lastSentAt === null) return { tone: "info", label: "Starting: waiting for the first location" } as const;
  if (now - lastSentAt > STALE_AFTER_MS) return { tone: "warn", label: "Out of date: no update has reached parents for a while" } as const;
  return { tone: "ok", label: "Sharing: parents can see your location" } as const;
}
