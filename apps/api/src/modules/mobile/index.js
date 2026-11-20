import { createMobileRouter } from "./routes.js";

/**
 * The Team Leader mobile app's API (/api/mobile). No tables or rules of its own: sign-in is the auth service (mobile
 * token domain), trips and sharing are the live-location service. See MOBILE_APP.md.
 */
export function createMobileModule({ auth, liveLocation, limits = {} }) {
  return { router: createMobileRouter({ auth, liveLocation, ...limits }), mountPath: "/api/mobile" };
}
