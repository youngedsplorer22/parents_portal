import { AppError } from "../email-otp/errors.js";

// `details.renewable` (only on the session check, which can see the refresh cookie): false means there is nothing to
// renew with, so the page shouldn't try.
export const unauthenticatedError = (details) =>
  new AppError(401, "UNAUTHENTICATED", "Please log in to continue.", details);

// Same wording and code as registration: one answer for every token problem.
export const verificationRequiredError = () =>
  new AppError(
    403,
    "VERIFICATION_REQUIRED",
    "Your email verification is missing, expired, or already used. Please verify your email again.",
  );

// Only ever returned after the caller proved control of the email with a login code.
export const accountNotFoundError = () =>
  new AppError(404, "ACCOUNT_NOT_FOUND", "No account exists for this email address. Please register first.");

// One answer for an unknown email, an account with no password and a wrong password.
export const invalidCredentialsError = () =>
  new AppError(401, "INVALID_CREDENTIALS", "The email or password is incorrect. You can also sign in with an email code.");

// Every place for password-hashing work is taken (a burst of sign-ins). Nothing was checked or counted; retry shortly.
export const serverBusyError = (retryAfterSeconds) =>
  new AppError(503, "SERVER_BUSY", "The server is busy right now. Please try again in a few seconds.", { retryAfterSeconds });

// Another request (usually another tab) renewed this sign-in a moment ago. Nothing was issued or revoked: the browser
// already holds the new cookies, so the caller simply repeats its original request.
export const refreshRaceError = () =>
  new AppError(409, "REFRESH_RACE", "This sign-in was just renewed by another request. Repeat your request.");
