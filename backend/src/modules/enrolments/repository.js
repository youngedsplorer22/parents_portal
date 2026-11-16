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
