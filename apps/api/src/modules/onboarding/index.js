import { createOnboardingRouter } from "./routes.js";
import { createOnboardingService } from "./service.js";

export { getDefinition, definitionsFor } from "./definitions.js";

/**
 * Onboarding forms (Domestic / International tour core sheets).
 *   db           - a pg Pool with 004_onboarding_forms.sql applied
 *   requireSession - Express middleware from the auth module; sets req.auth
 *   renderPdf    - optional, replaces the PDF renderer (tests); logger - { error } (optional)
 */
export function createOnboardingModule({ db, requireSession, today, renderPdf, logger, pdfRendering, drive, driveRootName, pdfStorageNote, limits }) {
  const service = createOnboardingService({ db, today, renderPdf, logger, pdfRendering, drive, driveRootName, pdfStorageNote });
  const router = createOnboardingRouter({ service, requireSession, ...(limits ? { limits } : {}) });
  return { router, service, mountPath: "/api/onboarding" };
}
