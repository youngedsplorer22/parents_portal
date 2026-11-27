import express from "express";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../email-otp/errors.js";
import { parseBody } from "../email-otp/validation.js";
import { jsonOnly } from "../auth/routes.js";
import { enrolmentBodySchema, enrolmentQuerySchema, fixSchema } from "./validation.js";

// Per signed-in person (or staff member), in memory. Pages refresh every 5 minutes and phones send every 5 minutes, so
// these leave plenty of room for several open tabs and retries while stopping a runaway client. The real per-trip
// spacing of location updates is enforced in the database (minUpdateGapSeconds), so it also holds across servers.
export const DEFAULT_LIMITS = { read: { windowMs: 10 * 60_000, max: 120 }, write: { windowMs: 10 * 60_000, max: 60 } };
export const limiting = (limiter, who) => (req, res, next) => {
  const r = limiter.hit(who(req));
  return r.ok ? next() : next(new AppError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { retryAfterSeconds: r.retryAfterSeconds }));
};

/** /api/live-location: a parent (any enrolment of theirs) reads; the chosen team lead starts, sends and stops. */
export function createLiveLocationRouter({ service, requireSession, limits = DEFAULT_LIMITS }) {
  const router = express.Router();
  const read = limiting(createRateLimiter(limits.read), (req) => req.auth.registrationId);
  const write = limiting(createRateLimiter(limits.write), (req) => req.auth.registrationId);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Authenticate before reading any body. `req.auth` is the only identity.
  router.use(requireSession);
  router.use(express.json({ limit: "1kb", inflate: false }));

  router.get("/", read, async (req, res) => {
    const { enrolment } = parseBody(enrolmentQuerySchema, { ...req.query });
    res.json(await service.view(req.auth, enrolment));
  });
  router.post("/start", write, jsonOnly, async (req, res) => {
    const { enrolmentId } = parseBody(enrolmentBodySchema, req.body);
    res.json(await service.start(req.auth, enrolmentId));
  });
  router.post("/location", write, jsonOnly, async (req, res) => {
    res.json(await service.update(req.auth, parseBody(fixSchema, req.body)));
  });
  router.post("/stop", write, jsonOnly, async (req, res) => {
    const { enrolmentId } = parseBody(enrolmentBodySchema, req.body);
    res.json(await service.stop(req.auth, enrolmentId));
  });
  return router;
}
