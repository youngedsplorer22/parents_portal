import * as Location from "expo-location";
import { Linking, Platform } from "react-native";
import { ApiError, type Api, type TripView } from "../api/client";
import { LOCATION_TASK, handleLocations } from "./backgroundTask";
import { classify, SEND_INTERVAL_MS } from "./policy";
import { stopLocationUpdates } from "./registerTask";
import { EMPTY_STATE, secureStateStore, type SharingState } from "./sharingState";

/**
 * Start / Stop and recovery for the sharing screen. The OS does the location work (see registerTask.ts); this decides
 * when it runs. Server first: the app only starts the OS updates after the server has agreed this person may share
 * this trip right now, and stops them whenever the server says sharing is over.
 */
export type PermissionStatus = { servicesOn: boolean; foreground: Location.PermissionStatus; background: Location.PermissionStatus };

export async function permissionStatus(): Promise<PermissionStatus> {
  const [servicesOn, fg, bg] = await Promise.all([
    Location.hasServicesEnabledAsync().catch(() => false),
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return { servicesOn, foreground: fg.status, background: bg.status };
}

export class SharingError extends Error {
  constructor(public code: "SERVICES_OFF" | "FOREGROUND_DENIED" | "BACKGROUND_DENIED" | string, message: string) {
    super(message);
  }
}

/** Ask for permission in the order the OS requires: "while using" first, then "always" (background). */
async function ensurePermissions() {
  if (!(await Location.hasServicesEnabledAsync())) throw new SharingError("SERVICES_OFF", "Turn on Location (GPS) in your phone's settings, then try again.");
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") throw new SharingError("FOREGROUND_DENIED", "Location permission is needed to share your location. Allow it in Settings.");
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") {
    throw new SharingError(
      "BACKGROUND_DENIED",
      Platform.OS === "ios"
        ? "To keep sharing while the phone is locked, set Location to \"Always\" for this app in Settings."
        : "To keep sharing while the phone is locked, choose \"Allow all the time\" for Location in this app's settings.",
    );
  }
}

export const openSettings = () => Linking.openSettings();

async function startOsUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    // Balanced (~100 m, Wi-Fi/cell assisted) instead of best GPS: far less battery, good enough to find a group.
    accuracy: Location.Accuracy.Balanced,
    timeInterval: SEND_INTERVAL_MS, // Android: ask for a reading about every 5 minutes
    distanceInterval: 0,
    deferredUpdatesInterval: SEND_INTERVAL_MS, // iOS: batch deliveries to save battery
    pausesUpdatesAutomatically: false, // iOS: don't silently stop when the phone is still for a while
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: true, // iOS: the blue pill, so the team lead always knows sharing is on
    foregroundService: {
      // Android: required for background location; the notification stays while sharing
      notificationTitle: "Sharing your location with parents",
      notificationBody: "Young Edsplorer trip: open the app to stop sharing.",
      notificationColor: "#2364e8",
      killServiceOnDestroy: false,
    },
  });
}

/** Sends one reading now (Start, Send now, coming back online), through the same rules as the background task. */
export async function sendNow(api: Api) {
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null);
  if (!position) return "failed";
  // force: clear the last-sent time so the 4.5-minute spacing doesn't hold back an explicit send
  const s = await secureStateStore.load();
  await secureStateStore.save({ ...s, lastSentAt: null });
  const result = await handleLocations(
    { api, state: secureStateStore, stopUpdates: stopLocationUpdates },
    { readings: [{ coords: { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy ?? null }, timestamp: position.timestamp }] },
  );
  if (result !== "sent") await secureStateStore.save({ ...(await secureStateStore.load()), lastSentAt: s.lastSentAt ?? null });
  return result;
}

export async function startSharing(api: Api, trip: TripView): Promise<SharingState> {
  await ensurePermissions();
  await api.start(trip.enrolmentId); // the server decides: assigned team lead, active trip
  const state: SharingState = { ...EMPTY_STATE, enrolmentId: trip.enrolmentId, tripTitle: trip.trip.title, startedAt: Date.now() };
  await secureStateStore.save(state);
  try {
    await startOsUpdates();
  } catch (err) {
    await api.stop(trip.enrolmentId).catch(() => {});
    await secureStateStore.save({ ...EMPTY_STATE });
    throw new SharingError("OS_REFUSED", `The phone refused to start location updates. ${err instanceof Error ? err.message : ""}`.trim());
  }
  await sendNow(api); // parents see the team lead straight away
  return secureStateStore.load();
}

export async function stopSharing(api: Api): Promise<void> {
  const s = await secureStateStore.load();
  await stopLocationUpdates();
  await secureStateStore.save({ ...EMPTY_STATE, stopReason: "STOPPED" });
  if (s.enrolmentId) await api.stop(s.enrolmentId).catch(() => {}); // the server also wipes the position
}

/**
 * Makes the phone agree with the server, on app start and whenever the app comes back to the screen: after a restart
 * or reboot (OS updates may have stopped), reassignment, trip closure, sign-out, or permission being removed.
 */
export async function reconcile(api: Api): Promise<SharingState> {
  const s = await secureStateStore.load();
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (!s.enrolmentId) {
    if (running) await stopLocationUpdates();
    return s;
  }
  const perms = await permissionStatus();
  if (perms.background !== "granted") {
    await stopLocationUpdates();
    await api.stop(s.enrolmentId).catch(() => {});
    const next = { ...s, enrolmentId: null, stopReason: "PERMISSION" };
    await secureStateStore.save(next);
    return next;
  }
  try {
    const view = await api.trip(s.enrolmentId);
    if (!view.teamLead?.sharingHere) {
      const reason = view.state === "ended" ? "TRIP_NOT_ACTIVE" : !view.teamLead ? "NOT_TEAM_LEAD" : "NOT_SHARING";
      await stopLocationUpdates();
      const next = { ...s, enrolmentId: null, stopReason: reason };
      await secureStateStore.save(next);
      return next;
    }
    if (!running) await startOsUpdates(); // e.g. after a reboot
    return s;
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "NETWORK_ERROR";
    if (classify(code) === "stop") {
      await stopLocationUpdates();
      const next = { ...s, enrolmentId: null, stopReason: code };
      await secureStateStore.save(next);
      return next;
    }
    if (!running) await startOsUpdates().catch(() => {}); // offline: keep collecting; it sends when back online
    return { ...s, lastError: code };
  }
}

export const loadSharingState = () => secureStateStore.load();
