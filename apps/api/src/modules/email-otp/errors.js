/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const cooldownError = (retryAfterSeconds) =>
  new AppError(429, "RESEND_COOLDOWN", `Please wait ${retryAfterSeconds}s before requesting a new code.`, {
    retryAfterSeconds,
  });

export const rateLimitedError = (retryAfterSeconds) =>
  new AppError(429, "RATE_LIMITED", "Too many verification requests. Please try again later.", {
    retryAfterSeconds,
  });

export const notFoundError = () =>
  new AppError(404, "OTP_NOT_FOUND", "No verification is in progress for this email. Please request a new code.");

export const expiredError = () =>
  new AppError(410, "OTP_EXPIRED", "This code has expired. Request a new code.");

export const tooManyAttemptsError = () =>
  new AppError(429, "TOO_MANY_ATTEMPTS", "Too many incorrect attempts. Request a new code.");

export const invalidCodeError = (attemptsRemaining) =>
  new AppError(400, "INVALID_CODE", "That code is incorrect.", { attemptsRemaining });
