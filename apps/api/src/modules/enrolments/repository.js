import { SCHOOL_LOGO } from "../onboarding/repository.js";
// SQL only. Takes a pg client so the caller controls the transaction.

/**
 * Enrols a person in a trip. Idempotent: enrolling again in the same trip changes nothing and
 * returns the existing row (`created` tells which happened).
 */
// trip_link_id is left NULL: it only exists on enrolments made through the retired secret-token links.
export async function insertEnrolment(q, { registrationId, tripId }) {
  const { rows } = await q.query(
    `INSERT INTO trip_enrolments (registration_id, trip_id, trip_link_id)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT trip_enrolments_person_trip_key DO NOTHING
     RETURNING id`,
    [registrationId, tripId, null],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await q.query("SELECT id FROM trip_enrolments WHERE registration_id = $1 AND trip_id = $2", [registrationId, tripId]);
  return { id: existing.rows[0].id, created: false };
}

/** A person's trips, newest first, with the state of the form for each. Own rows only. */
export async function listForRegistration(q, registrationId) {
  const { rows } = await q.query(
    `SELECT e.id, e.created_at, t.title, t.destination, t.tour_type, t.academic_year, t.payment_mode, s.name AS school_name, s.branch AS school_branch, ${SCHOOL_LOGO},
            f.status AS form_status, f.progress_percent, f.submitted_at
       FROM trip_enrolments e
       JOIN trips t ON t.id = e.trip_id
       JOIN schools s ON s.id = t.school_id
       LEFT JOIN onboarding_forms f ON f.enrolment_id = e.id
      WHERE e.registration_id = $1
      ORDER BY e.created_at DESC, e.id DESC`,
    [registrationId],
  );
  return rows;
}

/** The caller's form that belongs to no enrolment (accounts from before trips), if there is one. */
export async function findLegacyForm(q, registrationId) {
  const { rows } = await q.query(
    `SELECT f.status, f.progress_percent, f.submitted_at, t.title, s.name AS school_name
       FROM onboarding_forms f
       JOIN parent_registrations r ON r.id = f.registration_id
       LEFT JOIN trips t ON t.id = r.trip_id LEFT JOIN schools s ON s.id = t.school_id
      WHERE f.registration_id = $1 AND f.enrolment_id IS NULL`,
    [registrationId],
  );
  return rows[0] ?? null;
}

/**
 * Trip documents of one type for one of the caller's own enrolments. Returns { tripId, documents: rows } or null when the
 * enrolment is not the caller's. The document type is validated by the caller; the tripId is resolved from the enrolment
 * so the client never names a trip directly (cross-trip access is impossible).
 */
export async function listDocumentsForEnrolment(q, registrationId, enrolmentId, type) {
  const { rows: owned } = await q.query(
    `SELECT t.id AS trip_id FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id
      WHERE e.id = $1 AND e.registration_id = $2`,
    [enrolmentId, registrationId],
  );
  if (!owned[0]) return null;
  const { rows } = await q.query(
    `SELECT id, display_name, mime_type, size_bytes FROM trip_documents
      WHERE trip_id = $1 AND document_type = $2 ORDER BY uploaded_at DESC, id`,
    [owned[0].trip_id, type],
  );
  return { tripId: owned[0].trip_id, documents: rows };
}

/**
 * Fetches the Drive download info for a specific document that belongs to one of the caller's own enrolments.
 * Both the enrolment ownership AND the document's trip membership are checked in a single join — the client
 * never supplies a tripId, so they cannot swap it for another trip's document.
 */
export async function getDocumentForDownload(q, registrationId, enrolmentId, documentId) {
  const { rows } = await q.query(
    `SELECT d.drive_file_id, d.mime_type, d.display_name
       FROM trip_enrolments e
       JOIN trip_documents d ON d.trip_id = e.trip_id
      WHERE e.id = $1 AND e.registration_id = $2 AND d.id = $3`,
    [enrolmentId, registrationId, documentId],
  );
  return rows[0] ?? null;
}

/**
 * The itinerary of the trip of ONE of the caller's own enrolments, or null when that enrolment is not the caller's (or does not
 * exist). The trip is found from the enrolment, never from anything the client names, so nobody can read another trip's or
 * another person's itinerary. It is read-only here.
 */
export async function itineraryForEnrolment(q, registrationId, enrolmentId) {
  const { rows: owned } = await q.query(
    `SELECT t.id AS trip_id, t.title, t.destination FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id
      WHERE e.id = $1 AND e.registration_id = $2`,
    [enrolmentId, registrationId],
  );
  if (!owned[0]) return null;
  const { rows } = await q.query(
    `SELECT id, day_number, position, title, details, updated_at FROM trip_itinerary_items
      WHERE trip_id = $1 ORDER BY day_number, position, created_at, id`,
    [owned[0].trip_id],
  );
  return { trip: { title: owned[0].title, destination: owned[0].destination }, items: rows };
}
