import express from "express";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../email-otp/errors.js";
import { parseBody } from "../email-otp/validation.js";
import { DEFAULT_LIMITS, limiting } from "./routes.js";
import { assignSchema } from "./validation.js";

/** Staff (mounted inside /api/admin, after requireStaff): see a trip's sharing and choose its team lead. */
export function createLiveLocationStaffRouter({ service, limits = DEFAULT_LIMITS }) {
  const router = express.Router();
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
