import express from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { DEFAULT_REFRESH_LIMIT, jsonOnly } from "../auth/routes.js";
import { unauthenticatedError } from "../auth/errors.js";
import { AppError } from "../email-otp/errors.js";
import { emailSchema, parseBody } from "../email-otp/validation.js";

/**
 * /api/mobile: the Team Leader mobile app. The app holds an access + refresh token pair in the phone's secure storage
 * (Keychain / Android Keystore) and sends the access token as `Authorization: Bearer ...`. These tokens are accepted
 * ONLY under /api/mobile (never as browser cookies, and browser cookies are never accepted here), and everything the
 * app can do is narrow: see its own assigned trips, and start / send / stop the live location of a trip staff chose it
 * for. Every rule is the Live Location service's own (one implementation for the browser and the app).
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);

const loginSchema = z.strictObject({ email: emailSchema, password: z.string().min(1).max(256) });
const refreshSchema = z.strictObject({ refreshToken: z.string().regex(TOKEN, "Invalid token.") });
const logoutSchema = z.strictObject({ refreshToken: z.string().regex(TOKEN).optional() });
const fixSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(10000).nullable().optional(),
  capturedAt: z.iso.datetime({ offset: true }),
});

const bearerOf = (req) => {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
  return m ? m[1] : null;
};
const tokensBody = (session) => ({
  tokenType: "Bearer",
  accessToken: session.access.token,
  accessExpiresIn: session.access.maxAgeSeconds,
  refreshToken: session.refresh.token,
  refreshExpiresIn: session.refresh.maxAgeSeconds,
});
const userBody = (u) => ({ email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role });

export function createMobileRouter({ auth, liveLocation, refreshLimit = DEFAULT_REFRESH_LIMIT, writeLimit = { windowMs: 10 * 60_000, max: 60 }, readLimit = { windowMs: 10 * 60_000, max: 240 } }) {
  const router = express.Router();
  const limiter = (cfg, key) => {
    const l = createRateLimiter(cfg);
    return (req, res, next) => {
      const r = l.hit(key(req) ?? "unknown");
      return r.ok ? next() : next(new AppError(429, "RATE_LIMITED", "Too many requests. Please wait a moment.", { retryAfterSeconds: r.retryAfterSeconds }));
    };
  };
  const limitRefresh = limiter(refreshLimit, clientIp);
  const limitRead = limiter(readLimit, (req) => req.auth.registrationId);
  const limitWrite = limiter(writeLimit, (req) => req.auth.registrationId);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "2kb", inflate: false }));

  /** Bearer access token -> req.auth. Nothing else (no cookie, no body field) is ever an identity here. */
  const requireBearer = async (req, res, next) => {
    try {
      const user = await auth.authenticate(bearerOf(req), { mobile: true });
      if (!user) {
        res.set("WWW-Authenticate", 'Bearer realm="young-edsplorer"');
        throw unauthenticatedError();
      }
      req.auth = user;
      next();
    } catch (err) {
      next(err);
    }
  };
  const enrolmentParam = (req) => {
    if (!UUID.test(req.params.enrolmentId)) throw new AppError(404, "NOT_FOUND", "Not found.");
    return req.params.enrolmentId;
  };

  // ---- sign-in (the same password check, lock-out and busy-server rules as the website) ----
  router.post("/auth/login", jsonOnly, async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const { session, user } = await auth.passwordLogin({ email, password, ip: clientIp(req), mobile: true });
    res.json({ ...tokensBody(session), user: userBody(user) });
  });
  router.post("/auth/refresh", limitRefresh, jsonOnly, async (req, res) => {
    const { refreshToken } = parseBody(refreshSchema, req.body);
    const { session, user } = await auth.refreshSession({ refresh: refreshToken, mobile: true });
    res.json({ ...tokensBody(session), user: userBody(user) });
  });
  // Works with an expired access token or none: the refresh token alone identifies the sign-in to end.
  router.post("/auth/logout", jsonOnly, async (req, res) => {
    const { refreshToken } = parseBody(logoutSchema, req.body ?? {});
    await auth.logout({ access: bearerOf(req), refresh: refreshToken, mobile: true });
    res.json({ signedOut: true });
  });

  // ---- everything below needs a current access token ----
  router.use(requireBearer);
  router.get("/me", limitRead, (req, res) => res.json({ user: userBody(req.auth) }));
  router.get("/trips", limitRead, async (req, res) => res.json({ trips: await liveLocation.assignedTrips(req.auth) }));
  router.get("/trips/:enrolmentId", limitRead, async (req, res) => res.json(await liveLocation.view(req.auth, enrolmentParam(req))));
  router.post("/trips/:enrolmentId/start", limitWrite, jsonOnly, async (req, res) => res.json(await liveLocation.start(req.auth, enrolmentParam(req))));
  router.post("/trips/:enrolmentId/location", limitWrite, jsonOnly, async (req, res) => {
    const fix = parseBody(fixSchema, req.body);
    res.json(await liveLocation.update(req.auth, { enrolmentId: enrolmentParam(req), ...fix }));
  });
  router.post("/trips/:enrolmentId/stop", limitWrite, jsonOnly, async (req, res) => res.json(await liveLocation.stop(req.auth, enrolmentParam(req))));
  return router;
}
