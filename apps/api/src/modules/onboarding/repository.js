// SQL only. `q` is a pg client or pool; the service decides what is in a transaction.
// Every query is scoped by registration_id, which always comes from the session.
/** The school's logo address words and version (null when the school has no logo). */
export const SCHOOL_LOGO = `s.slug AS school_slug, s.branch_slug AS school_branch_slug,
  (SELECT floor(extract(epoch FROM l.updated_at) * 1000)::bigint FROM school_logos l WHERE l.school_id = s.id) AS logo_version`;
const COLUMNS = `id, registration_id, tour_type, participant_role, status, data, current_section,
                 progress_percent, version, created_at, updated_at, submitted_at,
                 declaration_version, declaration_accepted_at, signature_name`;

/**
 * The person's form for one enrolment, or (enrolmentId null) their legacy form: the one that was
 * never attached to a trip enrolment. A person has at most one form per enrolment.
 */
export async function findForContext(q, registrationId, enrolmentId, { lock = false } = {}) {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM onboarding_forms
      WHERE registration_id = $1 AND enrolment_id IS NOT DISTINCT FROM $2::uuid${lock ? " FOR UPDATE" : ""}`,
    [registrationId, enrolmentId],
  );
  return rows[0] ?? null;
}

/** null when this registration already has a form (a concurrent create won). */
export async function insertDraft(q, f) {
  const { rows } = await q.query(
    `INSERT INTO onboarding_forms (registration_id, enrolment_id, tour_type, participant_role, data, current_section, progress_percent)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [f.registrationId, f.enrolmentId ?? null, f.tourType, f.role, JSON.stringify(f.data), f.currentSection, f.percent],
  );
  return rows[0] ?? null;
}

export async function updateDraft(q, id, f) {
  const { rows } = await q.query(
    `UPDATE onboarding_forms
        SET data = $2::jsonb, current_section = $3, progress_percent = $4,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND status = 'draft'
      RETURNING ${COLUMNS}`,
    [id, JSON.stringify(f.data), f.currentSection, f.percent],
  );
  return rows[0] ?? null;
}

export async function markSubmitted(q, id, f) {
  const { rows } = await q.query(
    `UPDATE onboarding_forms
        SET status = 'submitted', data = $2::jsonb, progress_percent = 100,
            current_section = 'review', version = version + 1,
            updated_at = now(), submitted_at = now(),
            -- the acknowledgement is recorded with the submission itself, at the server's time
            declaration_version = $3, signature_name = $4, declaration_accepted_at = now()
      WHERE id = $1 AND status = 'draft'
      RETURNING ${COLUMNS}`,
    [id, JSON.stringify(f.data), f.declarationVersion, f.signatureName],
  );
  return rows[0] ?? null;
}

export const deleteDraft = (q, id) => q.query("DELETE FROM onboarding_forms WHERE id = $1 AND status = 'draft'", [id]);

/**
 * What the person is currently filling in for: their newest trip enrolment, else (accounts that
 * registered through a link before enrolments existed) the trip on the registration, else null.
 * `enrolment_id` is null in the legacy cases. The school name is read from the school row, so a
 * rename shows up immediately.
 */
export async function findContext(q, registrationId) {
  const current = await q.query(
    `SELECT e.id AS enrolment_id, t.title, t.destination, t.tour_type, t.academic_year, t.payment_mode, s.name AS school_name, s.branch AS school_branch, ${SCHOOL_LOGO}, s.id AS school_id, t.id AS trip_id, t.slug AS trip_slug
       FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id JOIN schools s ON s.id = t.school_id
      WHERE e.registration_id = $1
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1`,
    [registrationId],
  );
  if (current.rows[0]) return current.rows[0];
  const legacy = await q.query(
    `SELECT NULL::uuid AS enrolment_id, t.title, t.destination, t.tour_type, t.academic_year, t.payment_mode, s.name AS school_name, s.branch AS school_branch, ${SCHOOL_LOGO}, s.id AS school_id, t.id AS trip_id, t.slug AS trip_slug
       FROM parent_registrations r JOIN trips t ON t.id = r.trip_id JOIN schools s ON s.id = t.school_id
      WHERE r.id = $1`,
    [registrationId],
  );
  return legacy.rows[0] ?? null;
}

/**
 * One specific trip enrolment, ONLY if it belongs to this person. Anyone else's id (or a made-up one) gives null,
 * so a changed URL or request parameter can never reach another parent's registration.
 */
export async function findEnrolmentContext(q, registrationId, enrolmentId) {
  const { rows } = await q.query(
    `SELECT e.id AS enrolment_id, t.title, t.destination, t.tour_type, t.academic_year, t.payment_mode, s.name AS school_name, s.branch AS school_branch, ${SCHOOL_LOGO}, s.id AS school_id, t.id AS trip_id, t.slug AS trip_slug
       FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id JOIN schools s ON s.id = t.school_id
      WHERE e.id = $1 AND e.registration_id = $2`,
    [enrolmentId, registrationId],
  );
  return rows[0] ?? null;
}

/** The person's form that belongs to no enrolment (accounts from before trips), with the registration's trip if any. */
export async function findLegacyContext(q, registrationId) {
  const { rows } = await q.query(
    `SELECT NULL::uuid AS enrolment_id, t.title, t.destination, t.tour_type, t.academic_year, t.payment_mode, s.name AS school_name, s.branch AS school_branch, ${SCHOOL_LOGO}, s.id AS school_id, t.id AS trip_id, t.slug AS trip_slug
       FROM parent_registrations r LEFT JOIN trips t ON t.id = r.trip_id LEFT JOIN schools s ON s.id = t.school_id
      WHERE r.id = $1`,
    [registrationId],
  );
  const r = rows[0];
  return r && r.title ? r : { enrolment_id: null, legacyWithoutTrip: true };
}

/** For the PDF: the account holder's own details (never the password or anything about sessions). */
export async function findAccount(q, registrationId) {
  const { rows } = await q.query("SELECT first_name, last_name, role, email_normalized, phone FROM parent_registrations WHERE id = $1", [registrationId]);
  return rows[0] ?? null;
}

/** The exact declaration wording a submitted form accepted (declaration_texts rows are never changed). */
export async function findDeclarationText(q, version) {
  const { rows } = await q.query("SELECT body FROM declaration_texts WHERE version = $1", [version]);
  return rows[0]?.body ?? null;
}

/** A school's logo image by its address words, or null. */
export async function findSchoolLogo(q, schoolSlug, branchSlug) {
  const { rows } = await q.query(
    "SELECT l.content_type, l.data FROM school_logos l JOIN schools s ON s.id = l.school_id WHERE s.slug = $1 AND s.branch_slug = $2",
    [schoolSlug, branchSlug],
  );
  return rows[0] ?? null;
}

/** A form by id (for the background PDF storage, which has no session): its columns and its enrolment, if any. */
export async function findFormById(q, formId) {
  const { rows } = await q.query(`SELECT ${COLUMNS}, enrolment_id FROM onboarding_forms WHERE id = $1`, [formId]);
  return rows[0] ?? null;
}
