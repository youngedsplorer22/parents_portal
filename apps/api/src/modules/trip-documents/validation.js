export const DOCUMENT_TYPES = ["itinerary", "insurance", "transport"];
// Single-document types: only one active file per trip; a new upload replaces the old one.
export const SINGLE_DOC_TYPES = new Set(["itinerary", "insurance"]);

export const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_MIME_TYPES = {
  itinerary: new Set(["application/pdf"]),
  insurance: new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
  transport: new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
};
