import { AppError } from "../email-otp/errors.js";

export const versionConflictError = (currentVersion) =>
  new AppError(409, "VERSION_CONFLICT", "This form was changed somewhere else. Reload to see the latest version.", { currentVersion });

export const formSubmittedError = () =>
  new AppError(409, "FORM_SUBMITTED", "This form has already been submitted and can no longer be changed.");

export const alreadySubmittedError = (submittedAt) =>
  new AppError(409, "ALREADY_SUBMITTED", "This form has already been submitted.", { submittedAt });

export const tourLockedError = () =>
  new AppError(409, "TOUR_TYPE_LOCKED", "The tour type of a saved draft can't be changed. Start over to pick a different tour.");

export const tourFixedByTripError = (tourType) =>
  new AppError(409, "TOUR_FIXED_BY_TRIP", `Your school's trip is a ${tourType} tour, so that is the form you fill in.`, { tourType });

export const noDraftError = () => new AppError(404, "NO_DRAFT", "There is no saved form to submit.");

export const formIncompleteError = (errors) =>
  new AppError(422, "FORM_INCOMPLETE", "Some required answers are missing or invalid.", {
    fields: Object.entries(errors).map(([path, message]) => ({ path: `data.${path}`, message })),
  });

// The PDF exists only for a registration the database records as submitted.
export const formNotSubmittedError = () =>
  new AppError(409, "FORM_NOT_SUBMITTED", "This registration hasn't been submitted yet, so there is no PDF to download.");

// The submission is safe in the database; only the document couldn't be made this time.
export const pdfFailedError = () =>
  new AppError(500, "PDF_FAILED", "We couldn't prepare the PDF just now. Your registration is saved; please try the download again.");

// With Drive storage configured the parent's PDF is the stored copy; until it is stored there is nothing to download.
export const pdfNotReadyError = (status) =>
  new AppError(409, "PDF_NOT_READY", "Your PDF isn't ready to download yet.", { status });
