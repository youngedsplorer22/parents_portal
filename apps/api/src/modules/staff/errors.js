import { AppError } from "../email-otp/errors.js";

export const staffUnauthenticatedError = (details) => new AppError(401, "UNAUTHENTICATED", "Please log in to continue.", details);
export const forbiddenError = () => new AppError(403, "FORBIDDEN", "You don't have permission to do that.");
// One answer for an unknown email, a disabled account and a wrong password.
export const staffInvalidCredentialsError = () => new AppError(401, "INVALID_CREDENTIALS", "The email or password is incorrect.");
export const crossSiteError = () => new AppError(403, "CROSS_SITE_REQUEST", "This request was blocked.");
