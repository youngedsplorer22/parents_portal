import { createEnrolmentRouter } from "./routes.js";
import { createEnrolmentService } from "./service.js";

/**
 * Trip enrolments: a person (parent_registrations row) taking part in one school trip.
 *   db       - a pg Pool with 011_trip_enrolments.sql applied
 *   catalog  - the catalog service (resolvePublicTripForRegistration)
 *   requireSession - Express middleware from the auth module; sets req.auth
 */
export function createEnrolmentsModule({ db, catalog, requireSession }) {
  const service = createEnrolmentService({ db, catalog });
  return { service, router: createEnrolmentRouter({ service, requireSession }), mountPath: "/api/enrolments" };
}
