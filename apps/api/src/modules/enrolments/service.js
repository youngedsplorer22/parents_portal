import { withTransaction } from "../../db/transaction.js";
import { logoUrl } from "../catalog/logo.js";
import { AppError } from "../email-otp/errors.js";
import { DriveError } from "../pdf-storage/drive-client.js";
import { paymentView } from "./payment.js";
import * as repo from "./repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tripView = (t) => ({ school: t.schoolName, title: t.title, destination: t.destination, tourType: t.tourType, academicYear: t.academicYear });

/**
 * A signed-in person taking part in a trip. `auth` is always the session's user (req.auth): a
 * person can only ever enrol or list themselves.
 *
 * The trip comes from its public page address (school, branch and trip words), resolved and checked on the server:
 * the trip must be public and open. The person never supplies an id. Enrolling twice in the same trip is a no-op.
 */
const DOCUMENT_TYPES = new Set(["itinerary", "insurance", "transport"]);

export function createEnrolmentService({ db, catalog, drive = null }) {
  async function enrol(auth, publicTrip, portal = null) {
    return withTransaction(db, async (client) => {
      const trip = await catalog.resolvePublicTripForRegistration(client, publicTrip, { portal });
      const { id, created } = await repo.insertEnrolment(client, { registrationId: auth.registrationId, tripId: trip.tripId });
      return { enrolled: true, created, enrolmentId: id, trip: tripView(trip) };
    });
  }

  async function list(auth) {
    const rows = await repo.listForRegistration(db, auth.registrationId);
    return rows.map((r) => ({
      id: r.id, // the caller's own enrolment; every use of it is checked against the session again
      school: r.school_name,
      branch: r.school_branch ?? null,
      schoolLogo: logoUrl(r.school_slug, r.school_branch_slug, r.logo_version),
      title: r.title,
      destination: r.destination,
      tourType: r.tour_type,
      academicYear: r.academic_year,
      enrolledAt: r.created_at,
      payment: paymentView(r.payment_mode),
      form: r.form_status ? { status: r.form_status, progress: r.progress_percent, submittedAt: r.submitted_at } : null,
    }));
  }

  async function legacy(auth) {
    const r = await repo.findLegacyForm(db, auth.registrationId);
    return r && { school: r.school_name ?? null, title: r.title ?? null, form: { status: r.status, progress: r.progress_percent, submittedAt: r.submitted_at } };
  }

  /**
   * Which registration to open after a parent logs in on the ordinary homepage (no trip in the address). Never "the
   * newest" by default, since that could be the wrong trip:
   *   none     - nothing to open: the parent should use their school's trip registration page;
   *   one      - exactly one registration (a trip one, or a form from before trips): open it;
   *   several  - more than one: the client must not guess. Only the fact is returned (no list): the parent is asked to
   *              open their school's trip link, which then decides.
   * Arriving from a trip's public page never comes here: that page's trip decides.
   */
  async function resume(auth) {
    const items = await list(auth);
    const old = await legacy(auth);
    const ids = [...items.map((r) => r.id), ...(old ? ["legacy"] : [])];
    if (ids.length === 0) return { status: "none" };
    if (ids.length === 1) return { status: "one", enrolmentId: ids[0] };
    return { status: "several" };
  }

  /** The itinerary of one of the caller's own registrations: read-only, whatever the trip's status (a closed trip keeps it). */
  async function itinerary(auth, enrolmentId) {
    if (typeof enrolmentId !== "string" || !UUID.test(enrolmentId)) throw new AppError(404, "NOT_FOUND", "Not found.");
    const found = await repo.itineraryForEnrolment(db, auth.registrationId, enrolmentId);
    if (!found) throw new AppError(404, "NOT_FOUND", "Not found.");
    return {
      trip: { title: found.trip.title, destination: found.trip.destination },
      items: found.items.map((r) => ({ id: r.id, dayNumber: r.day_number, position: r.position, title: r.title, details: r.details, updatedAt: r.updated_at })),
    };
  }

  /** Documents of one type for one of the caller's own enrolments. The tripId is resolved from the enrolment. */
  async function listDocuments(auth, enrolmentId, type) {
    if (typeof enrolmentId !== "string" || !UUID.test(enrolmentId)) throw new AppError(404, "NOT_FOUND", "Not found.");
    if (!DOCUMENT_TYPES.has(type)) throw new AppError(400, "INVALID_TYPE", `type must be one of: ${[...DOCUMENT_TYPES].join(", ")}`);
    const result = await repo.listDocumentsForEnrolment(db, auth.registrationId, enrolmentId, type);
    if (!result) throw new AppError(404, "NOT_FOUND", "Not found.");
    return result.documents.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
    }));
  }

  /** Streams a document that belongs to one of the caller's own enrolments from Drive. */
  async function downloadDocument(auth, enrolmentId, documentId) {
    if (typeof enrolmentId !== "string" || !UUID.test(enrolmentId)) throw new AppError(404, "NOT_FOUND", "Not found.");
    if (typeof documentId !== "string" || !UUID.test(documentId)) throw new AppError(404, "NOT_FOUND", "Not found.");
    if (!drive) throw new AppError(503, "DRIVE_NOT_CONFIGURED", "Document storage is not configured.");
    const found = await repo.getDocumentForDownload(db, auth.registrationId, enrolmentId, documentId);
    if (!found) throw new AppError(404, "NOT_FOUND", "Not found.");
    let bytes;
    try {
      bytes = await drive.downloadFile(found.drive_file_id);
    } catch (err) {
      const code = err instanceof DriveError ? err.code : "INTERNAL";
      throw new AppError(503, "DRIVE_DOWNLOAD_FAILED", `Could not retrieve the document (${code}).`);
    }
    return { bytes, mimeType: found.mime_type, displayName: found.display_name };
  }

  return { enrol, list, legacy, resume, itinerary, listDocuments, downloadDocument };
}
