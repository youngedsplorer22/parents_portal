import { useCallback, useEffect, useState } from "react";
import { adminErrorMessage } from "./adminApi.js";
import { useStaff } from "./staffContext.js";

/** Loads data once and again whenever `reload()` is called. A 401 ends the staff session. */
export function useAdminData(load, deps) {
  const { expire } = useStaff();
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal })
      .then((data) => setState({ status: "ready", data, error: "" }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") expire();
        else setState({ status: "error", data: null, error: adminErrorMessage(err) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, expire]);

  return { ...state, reload };
}

/** Runs a save. Resolves to the result, or null after putting a message in `setError`. */
export async function attempt(fn, { expire, setError }) {
  try {
    setError("");
    return await fn();
  } catch (err) {
    if (err?.code === "UNAUTHENTICATED") expire();
    else setError(adminErrorMessage(err));
    return null;
  }
}
