import express from "express";
import { AppError } from "../email-otp/errors.js";
import { requireRole } from "../staff/middleware.js";
import { LOGO_MAX_BYTES } from "../catalog/logo.js";
import { logoInvalidError } from "../catalog/errors.js";
import { ALLOWED_MIME_TYPES, DOCUMENT_TYPES, MAX_SIZE_BYTES } from "./validation.js";

/**
 * Trip documents API, for Sales. Mounted under /api/admin AFTER requireStaff.
 *
 *   GET    /trips/:tripId/documents                    list documents for the trip
 *   POST   /trips/:tripId/documents?type=&name=        upload a document (raw body = file bytes)
 *   GET    /trips/:tripId/documents/:documentId        download a document (proxied from Drive)
 *   DELETE /trips/:tripId/documents/:documentId        delete a document
 *   GET    /trips/:tripId/school-logo                  get the current school logo URL
 *   PUT    /trips/:tripId/school-logo                  upload/replace the school logo
 */
export function createTripDocumentsRouter({ service }) {
  const router = express.Router();
  const sales = requireRole("sales");

  router.get("/trips/:tripId/documents", sales, async (req, res) => {
    const docs = await service.listDocuments(req.staff, req.params.tripId, req.portal?.templateKey ?? null);
    res.json({ documents: docs });
  });

  router.post(
    "/trips/:tripId/documents",
    sales,
    express.raw({ type: () => true, limit: `${MAX_SIZE_BYTES}b`, inflate: false }),
    async (req, res) => {
      const type = req.query.type;
      if (!DOCUMENT_TYPES.includes(type)) {
        throw new AppError(400, "INVALID_DOCUMENT_TYPE", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}`);
      }

      const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED_MIME_TYPES[type]?.has(mimeType)) {
        throw new AppError(400, "INVALID_FILE_TYPE", `${type} documents accept: ${[...ALLOWED_MIME_TYPES[type]].join(", ")}`);
      }

      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new AppError(400, "MISSING_FILE", "Request body must be the file bytes.");
      }

      const rawName = typeof req.query.name === "string" ? req.query.name.trim() : "";
      const displayName = rawName.slice(0, 200) || "document";

      const doc = await service.uploadDocument(
        req.staff,
        req.params.tripId,
        { type, displayName, mimeType, bytes },
        req.portal?.templateKey ?? null,
      );
      res.status(201).json({ document: doc });
    },
  );

  router.get("/trips/:tripId/documents/:documentId", sales, async (req, res) => {
    const { bytes, mimeType, displayName } = await service.downloadDocument(
      req.staff, req.params.tripId, req.params.documentId, req.portal?.templateKey ?? null,
    );
    // Allow inline display (PDF, images); everything else becomes a download.
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

  router.delete("/trips/:tripId/documents/:documentId", sales, async (req, res) => {
    await service.deleteDocument(req.staff, req.params.tripId, req.params.documentId, req.portal?.templateKey ?? null);
    res.json({ deleted: true });
  });

  router.get("/trips/:tripId/school-logo", sales, async (req, res) => {
    const info = await service.getSchoolLogoInfo(req.staff, req.params.tripId, req.portal?.templateKey ?? null);
    res.json(info);
  });

  router.put(
    "/trips/:tripId/school-logo",
    sales,
    express.raw({ type: () => true, limit: `${LOGO_MAX_BYTES}b`, inflate: false }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw logoInvalidError("Upload a PNG, JPEG or WebP image.");
      const info = await service.uploadSchoolLogo(
        req.staff, req.params.tripId, req.body, req.portal?.templateKey ?? null,
      );
      res.json(info);
    },
  );

  return router;
}
