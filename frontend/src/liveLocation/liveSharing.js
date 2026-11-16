import { sendLocation, startSharing, stopSharing } from "../api/liveLocationApi.js";
import { createLocationSharer } from "./sharer.js";

/**
 * The team lead's sharing for this page, kept outside any one screen so that moving between dashboard sections doesn't
 * stop it. One controller per page: there can never be two loops. It stops when the team lead presses Stop, signs out
 * (OnboardingFlow calls stopLiveSharing first), the page is closed, or the server says sharing is over.
 *
 * While sharing, the screen is asked to stay on (Screen Wake Lock, where the browser supports it): a phone browser
 * only keeps reading the location reliably while this page is open in front. That is a browser limit; see
 * LIVE_LOCATION.md.
 */
let current = null; // { enrolmentId, sharer, wakeLock }
const listeners = new Set();
let snapshot = { enrolmentId: null, phase: "idle", lastSentAt: null, lastFix: null, warning: null, stopReason: null, nextAt: null, error: null, wakeLock: false };

function publish(patch) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l(snapshot));
}

export function subscribeLiveSharing(listener) {
  listeners.add(listener);
  listener(snapshot);
  return () => listeners.delete(listener);
}
export const liveSharingSnapshot = () => snapshot;

/** Browser support for sharing: a secure page (HTTPS, or localhost) and a geolocation API. */
export function sharingSupport() {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!navigator.geolocation) return "unsupported";
  return "ok";
}

async function holdScreenOn() {
  try {
    if (!current || !navigator.wakeLock?.request) return publish({ wakeLock: false });
    const lock = await navigator.wakeLock.request("screen");
    if (!current) return lock.release().catch(() => {});
    current.wakeLock = lock;
    publish({ wakeLock: true });
    lock.addEventListener?.("release", () => publish({ wakeLock: false }));
  } catch {
    publish({ wakeLock: false }); // refused (battery saver, not visible): sharing still works while the page is open
  }
}

function onVisible() {
  if (!current || document.visibilityState !== "visible") return;
  current.sharer.wake(); // timers are delayed or paused in the background: send now if an update is overdue
  if (!current.wakeLock || current.wakeLock.released) holdScreenOn(); // the lock is dropped whenever the page is hidden
}
function onOnline() {
  current?.sharer.wake();
}
function detach() {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("online", onOnline);
  current?.wakeLock?.release?.().catch(() => {});
}

/** Start Live Location for one of the caller's own enrolments. Resolves to the server's view; throws on refusal. */
export async function startLiveSharing(enrolmentId, { geolocation = navigator.geolocation, intervalMs, retryMs } = {}) {
  if (current && current.enrolmentId === enrolmentId && current.sharer.active) return null;
  if (current) await stopLiveSharing({ notifyServer: false });
  const view = await startSharing(enrolmentId); // the server checks this person may share for this trip
  const sharer = createLocationSharer({
    geolocation,
    intervalMs,
    retryMs,
    send: (fix) => sendLocation(enrolmentId, fix),
    onChange: (s) => {
      publish({ ...s });
      if (s.phase === "stopped" && current?.sharer === sharer) {
        // stopped from inside (permission denied, or the server said it is over): tidy up; tell the server if it may not know
        const reason = s.stopReason;
        detach();
        current = null;
        if (reason === "permission_denied") stopSharing(enrolmentId).catch(() => {});
      }
    },
  });
  current = { enrolmentId, sharer, wakeLock: null };
  publish({ enrolmentId, stopReason: null });
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  holdScreenOn();
  sharer.start();
  return view;
}

/** Stop Live Location. With notifyServer the position is wiped on the server too (Stop button, signing out). */
export async function stopLiveSharing({ notifyServer = true } = {}) {
  const c = current;
  if (!c) return null;
  current = null;
  detach();
  c.sharer.stop("stopped");
  publish({ phase: "stopped", stopReason: "stopped", nextAt: null, wakeLock: false });
  if (!notifyServer) return null;
  return stopSharing(c.enrolmentId);
}

/** For tests: forget everything (a page reload does the same). */
export function resetLiveSharing() {
  if (current) {
    detach();
    current.sharer.stop("reset");
  }
  current = null;
  snapshot = { enrolmentId: null, phase: "idle", lastSentAt: null, lastFix: null, warning: null, stopReason: null, nextAt: null, error: null, wakeLock: false };
}
