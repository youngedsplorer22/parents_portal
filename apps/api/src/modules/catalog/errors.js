import { AppError } from "../email-otp/errors.js";

export const notFoundError = () => new AppError(404, "NOT_FOUND", "Not found.");
export const schoolExistsError = () => new AppError(409, "SCHOOL_EXISTS", "A school with that name and branch already exists.");
export const invalidTransitionError = (from, to) =>
  new AppError(409, "INVALID_STATUS_CHANGE", `A trip can't change from ${from} to ${to}.`);
export const tripLockedError = () =>
  new AppError(409, "TRIP_LOCKED", "The tour type and payment mode can only be changed while the trip is a draft.");
export const logoInvalidError = (message) => new AppError(400, "LOGO_INVALID", message);
export const schoolArchivedError = () => new AppError(409, "SCHOOL_ARCHIVED", "That school is archived.");
// The ONE public answer for an address that names no trip, or a trip that isn't public: unknown, misspelt, draft,
// archived, school archived, or public registration switched off. Says nothing about which.
export const publicTripNotFoundError = () =>
  new AppError(404, "TRIP_NOT_FOUND", "This registration page isn't available. Please check the address with your school.");
export const lookupRateLimitedError = (retryAfterSeconds) =>
  new AppError(429, "RATE_LIMITED", "Too many requests. Please try again shortly.", { retryAfterSeconds });
// A public trip that is not accepting registrations (closed or outside its dates).
export const tripNotOpenError = () => new AppError(409, "TRIP_NOT_OPEN", "Registration isn't open for this trip right now. Please check with your school.");
