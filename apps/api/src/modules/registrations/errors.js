import { AppError } from "../email-otp/errors.js";

// One answer for every token problem (missing from the DB, wrong, expired, already
// used, or issued for another email) so the response reveals nothing about which.
export const verificationRequiredError = () =>
  new AppError(
    403,
    "VERIFICATION_REQUIRED",
    "Your email verification is missing, expired, or already used. Please verify your email again.",
  );

export const emailAlreadyRegisteredError = () =>
  new AppError(409, "EMAIL_ALREADY_REGISTERED", "This email address is already registered.");
