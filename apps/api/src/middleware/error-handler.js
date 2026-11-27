import { AppError } from "../modules/email-otp/errors.js";

const body = (code, message, details) => ({ error: { code, message, ...details } });

export function notFoundHandler(req, res) {
  res.status(404).json(body("NOT_FOUND", "Not found."));
}

/**
 * Only AppError text and known body-parser failures reach the client.
 * Anything else is a generic 500; the log keeps the error message and code but
 * not the stack or query parameters, which can contain emails.
 */
export function createErrorHandler({ logger = console } = {}) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) {
      if (err.details.retryAfterSeconds) res.set("Retry-After", String(err.details.retryAfterSeconds));
      return res.status(err.status).json(body(err.code, err.message, err.details));
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json(body("INVALID_JSON", "Request body is not valid JSON."));
    }
    // Compressed request bodies are refused (inflate: false on every parser): no client of this API sends them.
    if (err?.type === "encoding.unsupported") {
      return res.status(415).json(body("UNSUPPORTED_ENCODING", "Compressed request bodies are not accepted."));
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json(body("PAYLOAD_TOO_LARGE", "Request body is too large."));
    }

    logger.error(`[error] ${err?.code ?? ""} ${err?.message ?? err}`);
    return res.status(500).json(body("INTERNAL_ERROR", "Something went wrong. Please try again."));
  };
}
