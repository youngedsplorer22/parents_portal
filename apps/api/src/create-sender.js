import { createDevConsoleSender } from "./modules/email-otp/senders/dev-console-sender.js";
import { createSmtpSender } from "./modules/email-otp/senders/smtp-sender.js";

/**
 * Picks the sender named by config.delivery. There is deliberately no fallback:
 * an unknown value throws instead of degrading to console mode.
 */
export function createSender(config, { logger = console } = {}) {
  switch (config.delivery) {
    case "smtp":
      return createSmtpSender({ smtp: config.smtp, logger });
    case "dev-console":
      return createDevConsoleSender();
    default:
      throw new Error(`Unknown OTP delivery method "${config.delivery}"`);
  }
}
