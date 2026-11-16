import express from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { emailSchema, parseBody } from "../email-otp/validation.js";
import { PASSWORD_MAX, checkPasswordPair, passwordSchema } from "./password.js";
import { requireSession } from "./middleware.js";
import { parentCookies } from "./session-cookie.js";
import { AppError } from "../email-otp/errors.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

const loginSchema = z.strictObject({
  email: emailSchema,
  verificationToken: z.string().min(1, "Email verification is required.").max(200, "Email verification is invalid."),
});

// No password *policy* here: accounts and rules may predate it. Only a sane size limit.
const passwordLoginSchema = z.strictObject({
  email: emailSchema,
  password: z.string({ error: "Password is required." }).min(1, "Password is required.").max(PASSWORD_MAX, "Password is too long."),
});

const emailOnlySchema = z.strictObject({ email: emailSchema });
const resetVerifySchema = z.strictObject({ email: emailSchema, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") });
export const resetConfirmSchema = z
  .strictObject({
    email: emailSchema,
    verificationToken: z.string().min(1, "Email verification is required.").max(200, "Email verification is invalid."),
    password: passwordSchema,
    confirmPassword: z.string({ error: "Confirm your password." }).min(1, "Confirm your password."),
  })
  .superRefine(checkPasswordPair)
  .transform(({ confirmPassword, ...rest }) => rest); // the confirmation exists only to be compared

const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);

export const userBody = (u) => ({ email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role });

// The refresh endpoint is open to anyone holding a cookie, so it is limited per address (generous: a school's whole
// network may share one address, and each tab only renews about every 15 minutes).
export const DEFAULT_REFRESH_LIMIT = { windowMs: 10 * 60_000, max: 300 };
export const jsonOnly = (req, res, next) =>
  req.is("application/json") ? next() : next(new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON."));

export function createAuthRouter({ service, passwordReset, config }) {
  const router = express.Router();
  const secure = config.cookieSecure;
  const refreshLimiter = createRateLimiter(config.refreshLimit ?? DEFAULT_REFRESH_LIMIT);
  const limitRefresh = (req, res, next) => {
    const r = refreshLimiter.hit(clientIp(req) ?? "unknown");
    return r.ok ? next() : next(new AppError(429, "RATE_LIMITED", "Too many requests. Please wait a moment.", { retryAfterSeconds: r.retryAfterSeconds }));
  };

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "4kb", inflate: false }));

  router.post("/login", async (req, res) => {
    const { email, verificationToken } = parseBody(loginSchema, req.body);
    const { session, user } = await service.login({ email, verificationToken });
    // After COMMIT only. The tokens go into HttpOnly cookies, never the body.
    res.set("Set-Cookie", parentCookies.issue(session, { secure }));
    res.json({ authenticated: true, user: userBody(user) });
  });

  router.post("/login/password", async (req, res) => {
    const { email, password } = parseBody(passwordLoginSchema, req.body);
    const { session, user } = await service.passwordLogin({ email, password, ip: clientIp(req) });
    res.set("Set-Cookie", parentCookies.issue(session, { secure }));
    res.json({ authenticated: true, user: userBody(user) });
  });

  // Forgot Password. None of these starts a session or sets a cookie.
  router.post("/password-reset/request", async (req, res) => {
    const { email } = parseBody(emailOnlySchema, req.body);
    res.json(await passwordReset.request({ email, ip: clientIp(req) }));
  });

  router.post("/password-reset/resend", async (req, res) => {
    const { email } = parseBody(emailOnlySchema, req.body);
    res.json(await passwordReset.resend({ email, ip: clientIp(req) }));
  });

  router.post("/password-reset/verify", async (req, res) => {
    const { email, code } = parseBody(resetVerifySchema, req.body);
    res.json(await passwordReset.verify({ email, code }));
  });

  router.post("/password-reset/confirm", async (req, res) => {
    const { email, verificationToken, password } = parseBody(resetConfirmSchema, req.body);
    await passwordReset.confirm({ email, verificationToken, password });
    res.json({ passwordChanged: true });
  });

  router.get("/session", requireSession(service, { sessionCheck: true }), (req, res) => {
    res.json({ authenticated: true, user: userBody(req.auth) });
  });

  /**
   * Renews the sign-in: the refresh cookie (sent only to /api/auth) for a new access + refresh pair. A JSON POST only, so
   * a cross-site HTML form can't trigger it (and SameSite=Strict plus the same-origin check stop other sites anyway).
   * 200: new cookies. 409 REFRESH_RACE: another request just renewed it; retry the original request. 401: sign in again.
   */
  router.post("/refresh", limitRefresh, jsonOnly, async (req, res) => {
    try {
      const { session, user } = await service.refreshSession(parentCookies.read(req.headers.cookie));
      res.set("Set-Cookie", parentCookies.issue(session, { secure }));
      res.json({ authenticated: true, user: userBody(user) });
    } catch (err) {
      if (err?.status === 401) res.set("Set-Cookie", parentCookies.clear({ secure }));
      throw err;
    }
  });

  // Works with an expired access token too: the refresh cookie (path /api/auth) identifies the sign-in.
  router.post("/logout", async (req, res) => {
    await service.logout(parentCookies.read(req.headers.cookie));
    res.set("Set-Cookie", parentCookies.clear({ secure }));
    res.json({ authenticated: false });
  });

  return router;
}
