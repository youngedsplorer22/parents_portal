import { createPasswordResetService } from "./password-reset.js";
import { createAuthRouter } from "./routes.js";
import { createAuthService } from "./service.js";

export { requireSession } from "./middleware.js";
export { parentCookies } from "./session-cookie.js";

/**
 * Login and sessions. The host supplies:
 *   db       - a pg Pool with 003_auth_sessions.sql applied
 *   emailOtp - the email-otp module's service
 *   sender   - the OTP sender (optional sendPasswordChanged for the post-reset notice)
 *   logger   - { error } (optional)
 *   config   - { hmacSecret, sessionTtlSeconds, cookieSecure, passwordLogin: { windowSeconds, maxPerEmail, maxPerIp }, scryptCost? }
 *   gate     - the work gate shared by everything that hashes passwords (optional; see work-gate.js)
 * Other modules call `service.createSessionIn(client, registrationId)` inside
 * their own transaction and use `requireSession(service)` to protect routes.
 */
export function createAuthModule({ db, emailOtp, config, sender, logger, gate }) {
  const service = createAuthService({ db, emailOtp, config, gate, logger });
  const passwordReset = createPasswordResetService({
    db, emailOtp, passwords: service.passwords, sender, logger, loginConfig: config.passwordLogin,
  });
  const router = createAuthRouter({ service, passwordReset, config });
  return { router, service, passwordReset, mountPath: "/api/auth" };
}
