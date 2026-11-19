import { getVariant } from "@pp/contracts/variants";
import { usePortal } from "../portal/PortalContext.jsx";
import { sameTrip } from "../portal/deployment.js";

/**
 * Whether this website may show the registration page for these address words.
 *   "free"   the combined app (no deployment): any trip the server publishes, as before
 *   "bound"  a public portal customised for exactly this trip: `deployment` holds what to show
 *   "closed" a public portal customised for another school or trip: nothing of either is shown, and the server is not asked
 *   "unset"  a public portal nobody has customised yet: no registration at all
 * The server refuses new registrations for any other trip as well (portal_deployments); this decides what the page shows.
 */
export function useDeploymentGuard(address) {
  const { target, deployment } = usePortal();
  if (!getVariant(target)) return { state: "free", deployment: null };
  if (!deployment) return { state: "unset", deployment: null };
  return sameTrip(deployment, address) ? { state: "bound", deployment } : { state: "closed", deployment: null };
}

/** What the server said about the trip, with the developer's school name, logo, trip title and destination shown instead. */
export function brandedInfo(info, deployment) {
  if (!info || !deployment) return info;
  return {
    ...info,
    school: { name: deployment.schoolName, ...(deployment.logo ? { logo: deployment.logo } : {}) },
    trip: { ...info.trip, title: deployment.tripTitle, destination: deployment.destination },
  };
}
