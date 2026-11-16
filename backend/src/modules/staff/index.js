import { listAudit } from "./audit.js";
import { createStaffAdminRouter } from "./admin-routes.js";
import { createStaffAuthService } from "./auth-service.js";
import { createStaffManagement } from "./management.js";
import { createStaffPasswordService } from "./password-service.js";
import { requireRole, requireStaff, sameOriginForWrites } from "./middleware.js";
import { createStaffAuthRouter } from "./routes.js";

export { requireRole, requireStaff, sameOriginForWrites };

/**
 * Staff identity and sessions (separate from parent auth).
 *   emailOtp - the email-otp module's service; sender - the OTP sender (sendStaffPasswordChanged optional)
 *   config - { hmacSecret, sessionTtlSeconds, cookieSecure, login: { windowSeconds, maxPerEmail, maxPerIp }, scryptCost? }
 *   gate - the work gate shared by everything that hashes passwords (optional; see auth/work-gate.js)
 */
export function createStaffModule({ db, config, emailOtp, sender, logger, gate }) {
  const service = createStaffAuthService({ db, config, gate, logger });
  const passwordService = createStaffPasswordService({
    db, emailOtp, passwords: service.passwords, sender, logger, loginConfig: config.login,
  });
  const management = createStaffManagement({ db });
  return {
    service,
    // Admin-only staff management (sales accounts); the caller mounts it behind requireStaff + requireRole("admin").
    adminRouter: createStaffAdminRouter({ management }),
    authRouter: createStaffAuthRouter({ service, config, passwordService }),
    requireStaff: requireStaff(service),
    listAudit: (opts) => listAudit(db, opts),
  };
}
