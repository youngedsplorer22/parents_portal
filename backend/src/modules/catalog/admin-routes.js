import express from "express";
import { parseBody } from "../email-otp/validation.js";
import { requireRole } from "../staff/middleware.js";
import { logoInvalidError, notFoundError } from "./errors.js";
import { LOGO_MAX_BYTES, LOGO_TYPES } from "./logo.js";
import {
  UUID,
  publicRegistrationSchema,
  schoolCreateSchema,
  schoolUpdateSchema,
  tripCreateSchema,
  tripStatusSchema,
  tripUpdateSchema,
} from "./validation.js";

// A path id that isn't a UUID can't exist, so it is a plain 404 (never a database error).
const idParam = (req, name = "id") => {
  const value = req.params[name];
  if (!UUID.test(value)) throw notFoundError();
  return value;
};

/**
 * The staff API for schools and trips. The caller has already been through requireStaff,
 * so req.staff is set. Permissions are enforced here and again in the service; hiding buttons
 * in the panel is only a convenience.
 *
 *   any staff:  list/create schools, list/create/edit trips, open a draft, close an active trip,
 *               turn a trip's public registration page on or off
 *   admin only: rename/archive schools, reopen or archive trips, audit log
 */
export function createCatalogAdminRouter({ catalog, listAudit }) {
  const router = express.Router();

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
