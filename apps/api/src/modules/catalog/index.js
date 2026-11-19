import { createJoinRouter, createLogoRouter } from "./join-routes.js";
import { createCatalogService } from "./service.js";

/**
 * Schools, trips and their public registration pages.
 *   config - { publicBaseUrl, publicBaseUrls (template key -> portal origin, optional), joinLookups: { windowSeconds, max } }
 * `joinRouter` and `logoRouter` are public and read-only. Schools and trips are created and changed only by the developer
 * commands (scripts/ops.js), which call `service`; no HTTP route changes them.
 */
export function createCatalogModule({ db, config }) {
  const service = createCatalogService({ db, config });
  return {
    service,
    joinRouter: createJoinRouter({ catalog: service }),
    logoRouter: createLogoRouter({ catalog: service }),
  };
}
