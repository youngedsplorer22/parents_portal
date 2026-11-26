import { createTripDocumentsRouter } from "./routes.js";
import { createTripDocumentsService } from "./service.js";

/** Trip document uploads (itinerary, insurance, transport) and school logo, for Sales. `router` requires staff authentication. */
export function createTripDocumentsModule({ db, drive, deploymentTemplateKey = null, rootName = "Young Edsplorer" }) {
  const service = createTripDocumentsService({ db, drive, deploymentTemplateKey, rootName });
  return { service, router: createTripDocumentsRouter({ service }) };
}
