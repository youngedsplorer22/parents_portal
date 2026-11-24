import { createOtpController } from "./controller.js";
import { createOtpRouter } from "./routes.js";
import { createOtpService } from "./service.js";

export { AppError } from "./errors.js";
export { createDevConsoleSender } from "./senders/dev-console-sender.js";
export { createSmtpSender } from "./senders/smtp-sender.js";

/**
 * Self-contained email OTP module. The host app supplies everything it owns:
 *   db     - a pg Pool (the host's own database, with 001_email_otp.sql applied)
 *   sender - { mode, send({ email, code, expiresInSeconds }) }
 *   config - { hmacSecret, ttlSeconds, staffTtlSeconds (staff_password codes only), resendCooldownSeconds, maxAttempts,
 *              maxSendsPerEmailPerHour, maxSendsPerIpPerHour, verificationTokenTtlSeconds }
 *   clock, generateCode - optional, for tests
 *
 * Mount `router` at `mountPath`. Use `service.consumeVerificationToken` from
 * the host's registration code.
 */
export function createEmailOtpModule({ db, sender, config, clock, generateCode, logger }) {
  const service = createOtpService({ db, sender, config, clock, generateCode, logger });
  const router = createOtpRouter({ controller: createOtpController({ service }) });
  return { router, service, mountPath: "/api/email-otp" };
}
