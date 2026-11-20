import { useEffect, useState } from "react";
import { joinErrorMessage, resolvePublicTrip } from "../api/joinApi.js";
import { isAddress } from "./address.js";

/**
 * Looks up a trip's public page: { status: "loading" | "ready" | "error", info?, message? }. A malformed address is
 * answered here without asking the server, with the same words the server uses for an unknown page.
 */
export function usePublicTrip(address) {
  const key = isAddress(address) ? `${address.school}/${address.branch}/${address.trip}` : null;
  const [state, setState] = useState({ key: undefined, status: "loading" });

  useEffect(() => {
    if (key === null) return undefined;
    const controller = new AbortController();
    const [school, branch, trip] = key.split("/");
    resolvePublicTrip({ school, branch, trip }, { signal: controller.signal })
      .then((info) => setState({ key, status: "ready", info }))
      .catch((err) => {
        if (err?.name !== "AbortError") setState({ key, status: "error", message: joinErrorMessage(err) });
      });
    return () => controller.abort();
  }, [key]);

  if (key === null) return { status: "error", message: joinErrorMessage({ code: "TRIP_NOT_FOUND" }) };
  return state.key === key ? state : { status: "loading" }; // a result for a previous address is stale
}
