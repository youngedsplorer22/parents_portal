import { AppError } from "../email-otp/errors.js";

// One answer for "not yours" and "doesn't exist", so ids of other people's trips reveal nothing.
export const notFoundError = () => new AppError(404, "NOT_FOUND", "Not found.");
export const notTeamLeadError = () =>
  new AppError(403, "NOT_TEAM_LEAD", "Only the team lead chosen for this trip can share its live location.");
export const tripNotActiveError = () =>
  new AppError(409, "TRIP_NOT_ACTIVE", "Live location can only be shared while the trip is active.");
// Sharing was stopped (by the team lead, staff, the trip ending, or signing out), or was started on another device.
export const notSharingError = () =>
  new AppError(409, "NOT_SHARING", "Live location sharing isn't on for this device. Start it again to continue.");
export const tooFrequentError = (retryAfterSeconds) =>
  new AppError(429, "TOO_FREQUENT", "Location updates are sent every few minutes. Please wait a little.", { retryAfterSeconds });
export const invalidFixError = (message) => new AppError(400, "INVALID_LOCATION", message);
export const notTeamLeaderEnrolmentError = () =>
  new AppError(400, "NOT_A_TEAM_LEADER", "Choose someone registered for this trip as a Team Leader.");
