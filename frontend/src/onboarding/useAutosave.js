import { useCallback, useEffect, useRef, useState } from "react";
import { saveDraft } from "../api/onboardingApi.js";

/**
 * Debounced autosave of the draft to the server.
 *
 *  - `queue(snapshot)` records the newest { tourType, data, currentSection } and schedules a save.
 *  - Only one request is ever in flight; the next one starts after it, with the version the
 *    server just returned, so saves cannot overtake each other or overwrite newer data.
 *  - `flush()` saves right now and resolves true only if everything queued has been stored.
 *  - status: "idle" | "saving" | "saved" | "error" | "conflict".
 *
 * Nothing is written to localStorage/sessionStorage: the database is the only copy.
 */
export function useAutosave({ initialVersion, delayMs = 800, onSaved, onConflict, onFormSubmitted, onUnauthenticated }) {
  const [status, setStatus] = useState("idle");
  const versionRef = useRef(initialVersion ?? null);
  const latest = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const running = useRef(null);
  const blocked = useRef(false); // set after a conflict: stop saving until the form is reloaded
  const handlers = useRef({});
  useEffect(() => {
    handlers.current = { onSaved, onConflict, onFormSubmitted, onUnauthenticated };
  });

  const run = useCallback(() => {
    if (running.current) return running.current;
    running.current = (async () => {
      try {
        while (dirty.current) {
          const snapshot = latest.current;
          dirty.current = false;
          setStatus("saving");
          try {
            const form = await saveDraft({ ...snapshot, version: versionRef.current });
            versionRef.current = form.version;
            handlers.current.onSaved?.(form);
          } catch (err) {
            dirty.current = true; // still unsaved
            if (err?.code === "VERSION_CONFLICT") {
              blocked.current = true;
              setStatus("conflict");
              handlers.current.onConflict?.();
            } else if (err?.code === "FORM_SUBMITTED") {
              blocked.current = true;
              setStatus("conflict");
              handlers.current.onFormSubmitted?.();
            } else if (err?.code === "UNAUTHENTICATED") {
              setStatus("error");
              handlers.current.onUnauthenticated?.();
            } else {
              setStatus("error");
            }
            return false;
          }
        }
        setStatus("saved");
        return true;
      } finally {
        running.current = null;
      }
    })();
    return running.current;
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (running.current) await running.current;
    if (blocked.current) return false;
    if (!dirty.current) return true;
    return run();
  }, [run]);

  const queue = useCallback(
    (snapshot) => {
      latest.current = snapshot;
      dirty.current = true;
      clearTimeout(timer.current);
      if (blocked.current) return;
      timer.current = setTimeout(run, delayMs);
    },
    [run, delayMs],
  );

  // Save when the tab is hidden, and warn before leaving with unsaved changes.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && dirty.current && !blocked.current) {
        clearTimeout(timer.current);
        run();
      }
    };
    const onBeforeUnload = (event) => {
      if (dirty.current || running.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearTimeout(timer.current);
    };
  }, [run]);

  return {
    status,
    queue,
    flush,
    retry: () => (blocked.current ? Promise.resolve(false) : run()),
    version: () => versionRef.current,
    hasPending: () => dirty.current || Boolean(running.current),
    /** Adopt a version from outside (after a reload from the server). */
    reset: (version) => {
      versionRef.current = version ?? null;
      blocked.current = false;
      dirty.current = false;
      clearTimeout(timer.current);
      setStatus("idle");
    },
  };
}
