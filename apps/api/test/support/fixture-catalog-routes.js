// TEST FIXTURE. This is the old admin HTTP router, kept ONLY so the test suite can set up schools, trips and live-location
// data over HTTP through the same validation and services as before. It is mounted by test/support/fixture-admin.js on a
// private test server. The product has no admin route: nothing under src/ imports this file.
import express from "express";
import { parseBody } from "../../src/modules/email-otp/validation.js";
import { requireRole } from "../../src/modules/staff/middleware.js";
import { logoInvalidError, notFoundError } from "../../src/modules/catalog/errors.js";
import { LOGO_MAX_BYTES, LOGO_TYPES } from "../../src/modules/catalog/logo.js";
import {
  UUID,
  publicRegistrationSchema,
  schoolCreateSchema,
  schoolUpdateSchema,
  tripCreateSchema,
  tripStatusSchema,
  tripUpdateSchema,
} from "../../src/modules/catalog/validation.js";

// A path id that isn't a UUID can't exist, so it is a plain 404 (never a database error).
const idParam = (req, name = "id") => {
  const value = req.params[name];
  if (!UUID.test(value)) throw notFoundError();
  return value;
};

/**
 * The staff API for schools and trips. The caller has already been through requireStaff, so req.staff is set, and
 * app.js has already refused anyone who is not an admin: every route in this file is admin-only. A Sales user reaches only
 * the itinerary routes (modules/itinerary). Permissions are enforced there and again in the service; hiding buttons in the
 * panel is only a convenience.
 *
 *   admin: list/create schools, rename/archive, logos; list/create/edit trips, open, close, reopen or archive them,
 *          turn a trip's public registration page on or off; the audit log
 */
export function createCatalogAdminRouter({ catalog, listAudit }) {
  const router = express.Router();
  // Defence in depth: app.js already mounts this behind the admin check, and this keeps it admin-only wherever it is mounted.
  router.use(requireRole("admin"));

  router.get("/schools", async (req, res) => {
    res.json({ schools: await catalog.listSchools(req.staff, { includeArchived: req.query.includeArchived === "true" }) });
  });
  router.post("/schools", async (req, res) => {
    res.status(201).json({ school: await catalog.createSchool(req.staff, parseBody(schoolCreateSchema, req.body)) });
  });
  router.patch("/schools/:id", requireRole("admin"), async (req, res) => {
    res.json({ school: await catalog.updateSchool(req.staff, idParam(req), parseBody(schoolUpdateSchema, req.body)) });
  });
  // The logo is sent as the raw image (Content-Type image/png, image/jpeg or image/webp). The service decides the real
  // type from the bytes. Admin only, like renaming a school.
  router.put(
    "/schools/:id/logo",
    requireRole("admin"),
    express.raw({ type: LOGO_TYPES, limit: LOGO_MAX_BYTES, inflate: false }),
    async (req, res) => {
      const id = idParam(req);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw logoInvalidError("Upload a PNG, JPEG or WebP image.");
      res.json({ school: await catalog.setSchoolLogo(req.staff, id, req.body) });
    },
  );
  router.delete("/schools/:id/logo", requireRole("admin"), async (req, res) => {
    res.json({ school: await catalog.removeSchoolLogo(req.staff, idParam(req)) });
  });

  router.get("/trips", async (req, res) => {
    const schoolId = req.query.schoolId === undefined ? undefined : idParam({ params: { id: String(req.query.schoolId) } });
    res.json({ trips: await catalog.listTrips(req.staff, { schoolId }) });
  });
  router.post("/schools/:id/trips", async (req, res) => {
    res.status(201).json({ trip: await catalog.createTrip(req.staff, idParam(req), parseBody(tripCreateSchema, req.body)) });
  });
  router.get("/trips/:id", async (req, res) => {
    res.json({ trip: await catalog.getTrip(idParam(req), req.staff) });
  });
  router.patch("/trips/:id", async (req, res) => {
    res.json({ trip: await catalog.updateTrip(req.staff, idParam(req), parseBody(tripUpdateSchema, req.body)) });
  });
  router.post("/trips/:id/status", async (req, res) => {
    const { status } = parseBody(tripStatusSchema, req.body);
    res.json({ trip: await catalog.changeTripStatus(req.staff, idParam(req), status) });
  });

  router.post("/trips/:id/public-registration", async (req, res) => {
    const { enabled } = parseBody(publicRegistrationSchema, req.body);
    res.json({ trip: await catalog.setPublicRegistration(req.staff, idParam(req), enabled) });
  });

  router.get("/audit", requireRole("admin"), async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    res.json({ entries: await listAudit({ limit: Number.isFinite(limit) ? limit : 100 }) });
  });

  return router;
}
