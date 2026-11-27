// TEST FIXTURE. This is the old admin HTTP router, kept ONLY so the test suite can set up schools, trips and live-location
// data over HTTP through the same validation and services as before. It is mounted by test/support/fixture-admin.js on a
// private test server. The product has no admin route: nothing under src/ imports this file.
import express from "express";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";
import { AppError } from "../../src/modules/email-otp/errors.js";
import { parseBody } from "../../src/modules/email-otp/validation.js";
import { requireRole } from "../../src/modules/staff/middleware.js";
import { DEFAULT_LIMITS, limiting } from "../../src/modules/live-location/routes.js";
import { assignSchema } from "../../src/modules/live-location/validation.js";

/** Staff (mounted inside /api/admin, after requireStaff): see a trip's sharing and choose its team lead. */
export function createLiveLocationStaffRouter({ service, limits = DEFAULT_LIMITS }) {
  const router = express.Router();
  // Team leads and live location are the admin's; Sales have no access (also enforced where app.js mounts this router).
  router.use(requireRole("admin"));
  const read = limiting(createRateLimiter(limits.read), (req) => req.staff.id);
  router.get("/trips/:id/live-location", read, async (req, res) => {
    res.json(await service.staffView(req.staff, uuidParam(req.params.id)));
  });
  router.put("/trips/:id/live-location/team-lead", read, async (req, res) => {
    const { enrolmentId } = parseBody(assignSchema, req.body);
    res.json(await service.assignTeamLead(req.staff, uuidParam(req.params.id), enrolmentId));
  });
  return router;
}

// A malformed id is simply "not found" (never a database error).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(value) {
  if (!UUID.test(value)) throw new AppError(404, "NOT_FOUND", "Not found.");
  return value;
}
