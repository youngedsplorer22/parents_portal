// TEST FIXTURE: a private HTTP server that exposes the old admin-shaped routes (schools, trips, staff, live location,
// assignments, bindings) acting as the developer. The product has none of these routes; the tests use this only to set up data
// through the same services and validation the developer commands use. It is never part of the app (src/app.js).
import express from "express";
import { createErrorHandler } from "../../src/middleware/error-handler.js";
import { createCatalogAdminRouter } from "./fixture-catalog-routes.js";
import { createFixtureOperationsRouter } from "./fixture-itinerary-routes.js";
import { createLiveLocationStaffRouter } from "./fixture-live-location-routes.js";
import { createStaffAdminRouter } from "./fixture-staff-routes.js";
import { listAudit } from "../../src/modules/staff/audit.js";

export const FIXTURE_ACTOR = { id: null, email: "admin@example.com", name: "Alex Admin", role: "admin" };

/** Starts the fixture server on a random local port. -> { base, close } */
export async function startAdminFixture({ services, db, actor = FIXTURE_ACTOR }) {
  const app = express();
  app.use((req, res, next) => {
    req.staff = actor;
    next();
  });
  const admin = express.Router();
  admin.use(express.json({ limit: "8kb", inflate: false }));
  admin.use("/staff", createStaffAdminRouter({ management: services.staffManagement }));
  admin.use(createCatalogAdminRouter({ catalog: services.catalogService, listAudit: (o) => listAudit(db, o) }));
  admin.use(createLiveLocationStaffRouter({ service: services.liveLocation }));
  admin.use(createFixtureOperationsRouter({ operations: services.itineraryOperations, actor }));
  app.use("/api/admin", admin);
  app.use(createErrorHandler({ logger: { error() {}, warn() {} } }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
