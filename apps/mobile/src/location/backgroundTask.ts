import type { Api } from "../api/client";
import { ApiError } from "../api/client";
import { classify, pickLatest, sendDue, toFix, type Reading } from "./policy";
import type { StateStore } from "./sharingState";

export const LOCATION_TASK = "ye-team-leader-location";

/**
 * What happens each time the operating system hands the app new locations (in the foreground, in the background, or
 * on Android with the app closed and the foreground service running). Kept free of native modules so it can be
 * tested: `stopUpdates` stops the OS location updates.
 *
 *   not sharing                 -> stop OS updates (nothing should be running)
 *   not due yet (< 4.5 min)     -> remember the reading's accuracy for the screen, send nothing
 *   due                         -> send the newest reading with its real capture time
 *   server: sharing is over     -> stop OS updates, remember why (signed out, reassigned, trip ended, stopped elsewhere)
 *   offline / server busy       -> remember the problem; the next reading tries again
 */
export async function handleLocations(
  { api, state, stopUpdates, now = () => Date.now() }: { api: Pick<Api, "sendLocation">; state: StateStore; stopUpdates: () => Promise<void>; now?: () => number },
  { readings, error }: { readings: readonly Reading[]; error?: { message?: string } | null },
): Promise<"stopped" | "skipped" | "sent" | "failed" | "idle"> {
  const s = await state.load();
  if (!s.enrolmentId) {
    await stopUpdates();
    return "idle";
  }
  if (error) {
    await state.save({ ...s, lastError: "LOCATION_UNAVAILABLE" });
    return "failed";
  }
  const reading = pickLatest(readings);
  if (!reading) return "skipped";
  const t = now();
  const withReading = { ...s, lastReadingAt: reading.timestamp, lastAccuracyM: reading.coords.accuracy };
  if (!sendDue(s.lastSentAt, t)) {
    await state.save(withReading);
    return "skipped";
  }
  const fix = toFix(reading, t);
  if (!fix) {
    await state.save(withReading);
    return "skipped";
  }
  try {
    await api.sendLocation(s.enrolmentId, fix);
    await state.save({ ...withReading, lastSentAt: t, lastError: null });
    return "sent";
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "NETWORK_ERROR";
    const what = classify(code);
    if (what === "stop") {
      await stopUpdates();
      await state.save({ ...withReading, enrolmentId: null, stopReason: code, lastError: null });
      return "stopped";
    }
    if (what === "drop") {
      await state.save({ ...withReading, lastError: null });
      return "skipped";
    }
    // TOO_FREQUENT: the server saw an update moments ago (e.g. from the Send-now button): not an error worth showing
    await state.save({ ...withReading, lastError: code === "TOO_FREQUENT" ? null : code });
    return "failed";
  }
}
