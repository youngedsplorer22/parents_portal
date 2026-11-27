import { createRegistrationController } from "./controller.js";
import { createRegistrationRouter } from "./routes.js";
import { createRegistrationService } from "./service.js";

/**
 * Parent registration module. The host supplies:
 *   db       - a pg Pool with 001_email_otp.sql and 002_parent_registrations.sql applied
 *   emailOtp - the email-otp module's service (for consumeVerificationTokenIn)
 *   sessions - the auth module's service (for createSessionIn)
 *   passwords - the auth module's password hasher (hash)
 *   catalog  - the catalog service (resolvePublicTripForRegistration), for sign-ups from a trip's public page
 *   cookie   - { cookieSecure }
 * Mount `router` at `mountPath`.
 */
export function createRegistrationsModule({ db, emailOtp, sessions, passwords, catalog, cookie }) {
  const service = createRegistrationService({ db, emailOtp, sessions, passwords, catalog });
  const router = createRegistrationRouter({ controller: createRegistrationController({ service, cookie }) });
  return { router, service, mountPath: "/api/registrations" };
}
