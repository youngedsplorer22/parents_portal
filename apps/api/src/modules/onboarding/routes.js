import express from "express";
import { z } from "zod";
import { parseBody } from "../email-otp/validation.js";
import { CURRENT_DECLARATION, SIGNATURE_MAX, SIGNATURE_MIN } from "./declaration.js";
import { TOUR_TYPES } from "./definitions.js";
import { LEGACY } from "./constants.js";
import { AppError } from "../email-otp/errors.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

const int32 = z.number().int().min(1).max(2_147_483_647);
// Which registration: one of the caller's own trip enrolments (checked in the service), or "legacy" for the form
// that belongs to no trip. Left out, the newest enrolment is used (older clients).
const enrolmentId = z.union([z.uuid({ error: "Unknown registration." }), z.literal(LEGACY)]).optional();
const saveSchema = z.strictObject({
  tourType: z.enum(TOUR_TYPES, { error: "Choose Domestic Tours or International Tours." }),
  data: z.record(z.string(), z.unknown()),
  currentSection: z.string().max(40).nullable().optional(),
  version: int32.nullable(),
  enrolmentId,
});
// Final submission needs the declaration accepted (the current wording) and a typed signature. The time is the
// server's own; nothing here takes a date from the client.
const signatureName = z
  .string({ error: "Type your full name as your signature." })
  .transform((v) => v.normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(SIGNATURE_MIN, "Type your full name as your signature.")
      .max(SIGNATURE_MAX, `Your signature can be at most ${SIGNATURE_MAX} characters.`)
      .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u, "Your signature contains characters that aren't allowed."),
  );
export const submitSchema = z.strictObject({
  version: int32,
  enrolmentId,
  declarationAccepted: z.literal(true, { error: "Please confirm the declaration before submitting." }),
  declarationVersion: z.literal(CURRENT_DECLARATION.version, { error: "The declaration has changed. Please reload the page." }),
  signatureName,
});
// Other query parameters are ignored (they never choose anything); only `enrolment` is read, and checked.
const querySchema = z.object({ enrolment: enrolmentId });
// "Try storing my PDF again": only which registration. Nothing about files, forms or accounts is ever taken from the client.
const retrySchema = z.strictObject({ enrolmentId });

// Per signed-in parent, in memory: how often each PDF endpoint may be used. (The 15-second pause between storing
// attempts is enforced in the database by the storage service, so it also holds across servers.)
const DEFAULT_LIMITS = { download: { windowMs: 60_000, max: 20 }, status: { windowMs: 60_000, max: 120 }, retry: { windowMs: 10 * 60_000, max: 6 } };
const limiting = (limiter) => (req, res, next) => {
  const result = limiter.hit(req.auth.registrationId);
  if (!result.ok) throw new AppError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { retryAfterSeconds: result.retryAfterSeconds });
  next();
};

export function createOnboardingRouter({ service, requireSession, limits = DEFAULT_LIMITS }) {
  const router = express.Router();
  const limit = Object.fromEntries(Object.entries(limits).map(([name, cfg]) => [name, limiting(createRateLimiter(cfg))]));

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Authenticate before reading any body. From here on `req.auth` is the only identity.
  router.use(requireSession);
  router.use(express.json({ limit: "64kb", inflate: false }));

  router.get("/", async (req, res) => {
    const { enrolment } = parseBody(querySchema, { ...req.query });
    res.json(await service.getState(req.auth, { enrolmentId: enrolment }));
  });

  router.put("/", async (req, res) => {
    const body = parseBody(saveSchema, req.body);
    res.json({ form: await service.saveDraft(req.auth, body) });
  });

  // Success is sent only after the transaction that marked the form submitted has committed.
  router.post("/submit", async (req, res) => {
    const { version, enrolmentId: id, declarationVersion, signatureName: name } = parseBody(submitSchema, req.body);
    // `pdf` says where the PDF copy stands (it is stored in the background after this reply).
    res.json(await service.submit(req.auth, { version, enrolmentId: id, declarationVersion, signatureName: name }));
  });

  // Where the owner's PDF stands. Only a status word: never a Drive id, account or error text.
  router.get("/pdf/status", limit.status, async (req, res) => {
    const { enrolment } = parseBody(querySchema, { ...req.query });
    res.json({ pdf: await service.pdfStatus(req.auth, { enrolmentId: enrolment }) });
  });

  // "Try again" when the PDF couldn't be stored: starts a new attempt in the background; no new submission.
  router.post("/pdf/retry", limit.retry, async (req, res) => {
    const { enrolmentId: id } = parseBody(retrySchema, req.body);
    const pdf = await service.retryPdf(req.auth, { enrolmentId: id });
    res.status(pdf.status === "pending" ? 202 : 200).json({ pdf });
  });

  // The submitted registration as a PDF download (owner only; 409 for a draft). Cache-Control: no-store (above).
  router.get("/pdf", limit.download, async (req, res) => {
    const { enrolment } = parseBody(querySchema, { ...req.query });
    const { filename, pdf } = await service.submittedPdf(req.auth, { enrolmentId: enrolment });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdf);
  });

  router.delete("/", async (req, res) => {
    const { enrolment } = parseBody(querySchema, { ...req.query });
    await service.discardDraft(req.auth, { enrolmentId: enrolment });
    res.json({ form: null });
  });

  return router;
}
