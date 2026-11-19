import { AppError } from "../email-otp/errors.js";

export const notFoundError = () => new AppError(404, "NOT_FOUND", "Not found.");
export const invalidAssigneeError = (message) => new AppError(400, "INVALID_ASSIGNEE", message);
export const templateMismatchError = () => new AppError(400, "TEMPLATE_MISMATCH", "That trip is not of that registration template.");
export const unknownTemplateError = () => new AppError(400, "VALIDATION_ERROR", "Invalid request.", { fields: [{ path: "templateKey", message: "Unknown registration template." }] });
export const tripArchivedError = () => new AppError(409, "TRIP_ARCHIVED", "An archived trip can't be deployed.");
