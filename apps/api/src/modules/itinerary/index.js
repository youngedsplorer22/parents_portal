import { createItineraryOperations } from "./operations.js";
import { createItineraryRouter } from "./routes.js";
import { createItineraryService } from "./service.js";

/**
 * Itinerary. `router` is for Sales and must be mounted behind staff authentication. `operations` (assignments, portal
 * bindings) is for the developer command-line tool only and has no route.
 */
export function createItineraryModule({ db, deploymentTemplateKey = null }) {
  const service = createItineraryService({ db, deploymentTemplateKey });
  return { service, operations: createItineraryOperations({ db }), router: createItineraryRouter({ service }) };
}
