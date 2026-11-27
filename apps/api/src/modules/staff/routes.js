import express from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { PASSWORD_MAX, checkPasswordPair, passwordSchema } from "../auth/password.js";
import { emailSchema, parseBody } from "../email-otp/validation.js";
import { staffCookies } from "./cookie.js";
import { AppError } from "../email-otp/errors.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { jsonOnly } from "../auth/routes.js";
import { requireStaff } from "./middleware.js";

const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string({ error: "Password is required." }).min(1, "Password is required.").max(PASSWORD_MAX, "Password is too long."),
});
const emailOnlySchema = z.strictObject({ email: emailSchema });
const verifySchema = z.strictObject({ email: emailSchema, code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") });
const confirmSchema = z
  .strictObject({
    email: emailSchema,
    verificationToken: z.string().min(1, "Email verification is required.").max(200, "Email verification is invalid."),
    password: passwordSchema,
    confirmPassword: z.string({ error: "Confirm your password." }).min(1, "Confirm your password."),
  })
  .superRefine(checkPasswordPair)
  .transform(({ confirmPassword, ...rest }) => rest);
// Changing while signed in: the current password is required; the new one must differ from it.
const changeSchema = (email) =>
  z
    .strictObject({
      currentPassword: z.string({ error: "Enter your current password." }).min(1, "Enter your current password.").max(PASSWORD_MAX, "Password is too long."),
      password: passwordSchema,
      confirmPassword: z.string({ error: "Confirm your new password." }).min(1, "Confirm your new password."),
    })
    .superRefine((v, ctx) => {
      checkPasswordPair({ ...v, email }, ctx);
      if (v.password === v.currentPassword) ctx.addIssue({ code: "custom", path: ["password"], message: "Choose a password different from your current one." });
    })
    .transform(({ confirmPassword, ...rest }) => rest);
const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);
export const staffBody = (s) => ({ email: s.email, name: s.name, role: s.role });

/** Mounted at /api/admin/auth. Login is open; session and logout need a STAFF session. */
export function createStaffAuthRouter({ service, config, passwordService }) {
  const router = express.Router();
  const secure = config.cookieSecure;
  const refreshLimiter = createRateLimiter(config.refreshLimit ?? { windowMs: 10 * 60_000, max: 300 });
  const limitRefresh = (req, res, next) => {
    const r = refreshLimiter.hit(clientIp(req) ?? "unknown");
    return r.ok ? next() : next(new AppError(429, "RATE_LIMITED", "Too many requests. Please wait a moment.", { retryAfterSeconds: r.retryAfterSeconds }));
  };

  router.post("/login", async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const { session, staff } = await service.login({ email, password, ip: clientIp(req) });
    // After COMMIT only; the tokens go into HttpOnly cookies, never the body.
    res.set("Set-Cookie", staffCookies.issue(session, { secure }));
    res.json({ authenticated: true, staff: staffBody(staff) });
  });

  router.get("/session", requireStaff(service, { sessionCheck: true }), (req, res) => {
    res.json({ authenticated: true, staff: staffBody(req.staff) });
  });

  // Renews the staff sign-in with the refresh cookie (sent only to /api/admin/auth). JSON POST only; see auth/routes.js.
  router.post("/refresh", limitRefresh, jsonOnly, async (req, res) => {
    try {
      const { session, staff } = await service.refreshSession(staffCookies.read(req.headers.cookie));
      res.set("Set-Cookie", staffCookies.issue(session, { secure }));
      res.json({ authenticated: true, staff: staffBody(staff) });
    } catch (err) {
      if (err?.status === 401) res.set("Set-Cookie", staffCookies.clear({ secure }));
      throw err;
    }
  });

  // First-time setup and forgot-password: public, same answer for every email (see password-service.js).
  router.post("/password/request", async (req, res) => {
    const { email } = parseBody(emailOnlySchema, req.body);
    res.json(await passwordService.request({ email, ip: clientIp(req) }));
  });
  router.post("/password/resend", async (req, res) => {
    const { email } = parseBody(emailOnlySchema, req.body);
    res.json(await passwordService.resend({ email, ip: clientIp(req) }));
  });
  router.post("/password/verify", async (req, res) => {
    const { email, code } = parseBody(verifySchema, req.body);
    res.json(await passwordService.verify({ email, code }));
  });
  router.post("/password/confirm", async (req, res) => {
    const { firstTime } = await passwordService.confirm(parseBody(confirmSchema, req.body));
    res.json({ passwordSet: true, firstTime });
  });

  // Change while signed in (staff session + current password).
  router.post("/password", requireStaff(service), async (req, res) => {
    const { currentPassword, password } = parseBody(changeSchema(req.staff.email), req.body);
    await passwordService.changePassword({
      staff: req.staff,
      sessionId: req.staff.sessionId, // this sign-in stays; every other one ends
      currentPassword,
      newPassword: password,
      ip: clientIp(req),
    });
    res.json({ passwordChanged: true });
  });

  // Works with an expired access token too: the refresh cookie (path /api/admin/auth) identifies the sign-in.
  router.post("/logout", async (req, res) => {
    const cookies = staffCookies.read(req.headers.cookie);
    await service.logout(cookies, cookies.access ? await service.authenticate(cookies.access) : null);
    res.set("Set-Cookie", staffCookies.clear({ secure }));
    res.json({ authenticated: false });
  });

  return router;
}
