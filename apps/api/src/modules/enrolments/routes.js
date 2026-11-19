import express from "express";
import { z } from "zod";
import { parseBody } from "../email-otp/validation.js";
import { publicTripSchema } from "../catalog/validation.js";

const enrolSchema = z.strictObject({ trip: publicTripSchema });

export function createEnrolmentRouter({ service, requireSession }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Authenticate before reading any body. `req.auth` is the only identity.
  router.use(requireSession);
  router.use(express.json({ limit: "2kb", inflate: false }));

  router.get("/", async (req, res) => res.json({ enrolments: await service.list(req.auth), legacy: await service.legacy(req.auth) }));
  // After login with no trip in the address: which of the caller's own registrations to open (see service.resume).
  router.get("/resume", async (req, res) => res.json(await service.resume(req.auth)));

  // Read-only. The enrolment id is checked against the session's own registration; anyone else's id is a plain 404.
  router.get("/:enrolmentId/itinerary", async (req, res) => res.json(await service.itinerary(req.auth, req.params.enrolmentId)));

  router.post("/", async (req, res) => {
    const { trip } = parseBody(enrolSchema, req.body);
    const result = await service.enrol(req.auth, trip, req.portal?.templateKey ?? null);
    res.status(result.created ? 201 : 200).json(result);
  });

  return router;
}
