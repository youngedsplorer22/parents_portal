import { createCatalogAdminRouter } from "./admin-routes.js";
import { createJoinRouter, createLogoRouter } from "./join-routes.js";
import { createCatalogService } from "./service.js";

/**
 * Schools, trips and their public registration pages.
 *   config - { publicBaseUrl, joinLookups: { windowSeconds, max } }
 * `adminRouter` must be mounted behind staff authentication; `joinRouter` is public.
 */
export function createCatalogModule({ db, config, listAudit }) {
  const service = createCatalogService({ db, config });
  return {
    service,
    adminRouter: createCatalogAdminRouter({ catalog: service, listAudit }),
    joinRouter: createJoinRouter({ catalog: service }),
    logoRouter: createLogoRouter({ catalog: service }),
  };
}
