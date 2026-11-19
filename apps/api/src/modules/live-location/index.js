import { createLiveLocationRouter } from "./routes.js";
import { createLiveLocationService } from "./service.js";

/**
 * Live location of a trip's team lead for that trip's parents (018_trip_live_location.sql).
 *   db             - a pg Pool
 *   catalog        - the catalog service (getTrip: who may manage a trip)
 *   requireSession - Express middleware from the auth module; sets req.auth
 *   policy         - optional overrides of DEFAULT_LIVE_LOCATION_POLICY (tests)
 */
export function createLiveLocationModule({ db, catalog, requireSession, policy, limits }) {
  const service = createLiveLocationService({ db, catalog, policy });
  return {
    service,
    router: createLiveLocationRouter({ service, requireSession, limits }),
    mountPath: "/api/live-location",
  };
}
