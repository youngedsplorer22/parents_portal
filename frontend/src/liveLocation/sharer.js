/**
 * The team lead's location loop, with no screen code in it (so its timing can be tested with fake timers).
 *
 *   start()  -> reads the position now and sends it
 *   then     -> one timer for the next reading, about every 5 minutes (never setInterval, never two timers at once)
 *   stop()   -> clears the timer; nothing further is read or sent
 *
 * A reading is only taken while sharing is on. Failures don't stop the loop unless they can't fix themselves:
 *   permission denied, or the server saying sharing is over (trip ended, team lead changed, signed out)  -> stops
 *   no GPS fix, timeout, offline, a failed upload                                                         -> tries again in 1 minute
 * Browsers slow or pause timers in background tabs, so wake() (called when the page becomes visible again or the
 * connection comes back) takes a reading straight away if one is overdue.
 */
export const LOW_ACCURACY_M = 500; // a reading less precise than this is still sent, but flagged as approximate

// Server answers after which sharing can't continue without the person doing something.
const FINAL_ERRORS = new Set(["NOT_SHARING", "TRIP_NOT_ACTIVE", "NOT_TEAM_LEAD", "UNAUTHENTICATED", "NOT_FOUND"]);

export function createLocationSharer({
  geolocation,
  send, // async (fix) => anything; throws an error with .code on failure
  onChange = () => {},
  intervalMs = 5 * 60_000,
  retryMs = 60_000,
  positionTimeoutMs = 30_000,
  timers = globalThis,
  now = () => Date.now(),
  isOnline = () => globalThis.navigator?.onLine !== false,
}) {
  let state = { phase: "idle", lastSentAt: null, lastFix: null, warning: null, stopReason: null, nextAt: null, error: null };
  let timer = null;
  let busy = false;
  let lastAttemptAt = 0;
  let generation = 0; // a reading that finishes after stop() (or a restart) is ignored

  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms) => {
    clear();
    if (state.phase === "idle" || state.phase === "stopped") return;
    timer = timers.setTimeout(() => {
      timer = null;
      tick();
    }, ms);
    set({ nextAt: now() + ms });
  };

  const readPosition = () =>
    new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: positionTimeoutMs, maximumAge: 60_000 });
    });

  function finish(stopReason, error = null) {
    clear();
    generation += 1;
    busy = false;
    set({ phase: "stopped", stopReason, nextAt: null, error });
  }

  async function tick() {
    if (busy || state.phase === "idle" || state.phase === "stopped") return;
    busy = true;
    lastAttemptAt = now();
    const mine = generation;
    clear();
    if (!isOnline()) {
      busy = false;
      set({ phase: "waiting", warning: "offline" });
      schedule(retryMs);
      return;
    }
    set({ phase: "locating" });
    let position;
    try {
      position = await readPosition();
    } catch (err) {
      if (mine !== generation) return;
      busy = false;
      if (err?.code === 1) return finish("permission_denied"); // PERMISSION_DENIED: only the person can change this
      set({ phase: "waiting", warning: err?.code === 3 ? "timeout" : "unavailable" });
      schedule(retryMs);
      return;
    }
    if (mine !== generation) return;
    const { latitude, longitude, accuracy } = position.coords;
    // the phone's own time of the reading, unless it is clearly wrong (then the time it arrived here)
    const stamp = Number.isFinite(position.timestamp) && Math.abs(now() - position.timestamp) < 10 * 60_000 ? position.timestamp : now();
    const fix = { latitude, longitude, accuracy: Number.isFinite(accuracy) ? Math.min(accuracy, 10000) : null, capturedAt: new Date(stamp).toISOString() };
    set({ phase: "sending" });
    try {
      await send(fix);
    } catch (err) {
      if (mine !== generation) return;
      busy = false;
      if (FINAL_ERRORS.has(err?.code)) return finish(err.code === "UNAUTHENTICATED" ? "signed_out" : "server_stopped", err);
      if (err?.code === "TOO_FREQUENT") {
        set({ phase: "waiting", warning: null, error: null });
        schedule(Math.max(5, Number(err?.details?.retryAfterSeconds) || 60) * 1000);
        return;
      }
      set({ phase: "waiting", warning: err?.code === "NETWORK_ERROR" ? "offline" : "send_failed", error: err ?? null });
      schedule(retryMs);
      return;
    }
    if (mine !== generation) return;
    busy = false;
    set({ phase: "waiting", lastSentAt: now(), lastFix: fix, warning: Number.isFinite(accuracy) && accuracy > LOW_ACCURACY_M ? "low_accuracy" : null, error: null });
    schedule(intervalMs);
  }

  return {
    start() {
      if (state.phase !== "idle" && state.phase !== "stopped") return; // already running: never a second loop
      generation += 1;
      set({ phase: "waiting", stopReason: null, warning: null, error: null });
      tick();
    },
    stop(reason = "stopped") {
      if (state.phase === "idle" || state.phase === "stopped") return;
      finish(reason);
    },
    /** The page is visible again or back online: read now if a reading is due (browsers delay background timers). */
    wake() {
      if (state.phase === "idle" || state.phase === "stopped" || busy) return;
      const due = state.warning ? retryMs : intervalMs;
      if (now() - lastAttemptAt >= due - 1000) tick();
    },
    get state() {
      return state;
    },
    get active() {
      return state.phase !== "idle" && state.phase !== "stopped";
    },
  };
}
