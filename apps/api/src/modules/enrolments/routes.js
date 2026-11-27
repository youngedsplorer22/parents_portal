import express from "express";
import { z } from "zod";
import { parseBody } from "../email-otp/validation.js";
import { publicTripSchema } from "../catalog/validation.js";

const enrolSchema = z.strictObject({ trip: publicTripSchema });

export function createEnrolmentRouter({ service, requireSession }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Authenticate before reading any body. `req.auth` is the only identity.
  router.use(requireSession);
  router.use(express.json({ limit: "2kb", inflate: false }));

  router.get("/", async (req, res) => res.json({ enrolments: await service.list(req.auth), legacy: await service.legacy(req.auth) }));
  // After login with no trip in the address: which of the caller's own registrations to open (see service.resume).
  router.get("/resume", async (req, res) => res.json(await service.resume(req.auth)));

  // Read-only. The enrolment id is checked against the session's own registration; anyone else's id is a plain 404.
  router.get("/:enrolmentId/itinerary", async (req, res) => res.json(await service.itinerary(req.auth, req.params.enrolmentId)));

  // Parent-facing trip document access. The tripId is never accepted from the client: it is always resolved from the
  // enrolment, so a parent can only ever see documents for their own trip.
  router.get("/:enrolmentId/documents", async (req, res) => {
    const docs = await service.listDocuments(req.auth, req.params.enrolmentId, req.query.type);
    res.json({ documents: docs });
  });

  router.get("/:enrolmentId/documents/:documentId", async (req, res) => {
    const { bytes, mimeType, displayName } = await service.downloadDocument(req.auth, req.params.enrolmentId, req.params.documentId);
    const INLINE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    const disposition = INLINE_TYPES.has(mimeType) ? "inline" : "attachment";
    const safeName = displayName.replace(/[^\w. ()-]/g, "_").slice(0, 200);
    // PDF/image served inline must not carry `sandbox` in CSP: Firefox's PDF.js viewer runs as
    // JavaScript inside the iframe and sandbox (without allow-scripts) silently blocks it.
    // For non-inline types (forced download) the sandbox adds an extra layer of defence.
    const csp = INLINE_TYPES.has(mimeType) ? "default-src 'none'" : "default-src 'none'; sandbox";
    res.set({
      "Content-Type": mimeType,
      "Content-Disposition": `${disposition}; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
    });
    res.send(bytes);
  });

  router.post("/", async (req, res) => {
    const { trip } = parseBody(enrolSchema, req.body);
    const result = await service.enrol(req.auth, trip, req.portal?.templateKey ?? null);
    res.status(result.created ? 201 : 200).json(result);
  });

  return router;
}
