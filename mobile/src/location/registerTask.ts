import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { getApi } from "../api/instance";
import { handleLocations, LOCATION_TASK } from "./backgroundTask";
import { secureStateStore } from "./sharingState";

/**
 * Registers the background location task with the OS. Must run when the JavaScript bundle loads (index.ts imports
 * this first), so the task exists even when Android starts the app headless (no screen) to deliver locations.
 */
export async function stopLocationUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  }
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  let api;
  try {
    api = getApi();
  } catch {
    return; // no API address configured: nothing can be sent
  }
  await handleLocations(
    { api, state: secureStateStore, stopUpdates: stopLocationUpdates },
    {
      error: error ? { message: error.message } : null,
      readings: (data?.locations ?? []).map((l) => ({ coords: { latitude: l.coords.latitude, longitude: l.coords.longitude, accuracy: l.coords.accuracy ?? null }, timestamp: l.timestamp })),
    },
  );
});
