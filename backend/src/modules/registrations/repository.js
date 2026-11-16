// SQL only. Takes a pg client so the service controls the transaction.

// The parent never supplies a school. With a trip link the school name comes from the school the
// sales team linked to the trip; without one, the existing NOT NULL column gets this fixed value.
export const UNASSIGNED_SCHOOL = "Unassigned";

export async function insertRegistration(q, r) {
  const { rows } = await q.query(
    `INSERT INTO parent_registrations
       (first_name, last_name, school, role, phone, email_normalized,
        email_verified_at, verification_token_id, request_ip, trip_id, trip_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, created_at`,
    [
      r.firstName, r.lastName, r.schoolName ?? UNASSIGNED_SCHOOL, r.role, r.phone, r.email,
      r.verifiedAt, r.tokenId, r.ip, r.tripId ?? null, null, // trip_link_id: retired links only
    ],
  );
  return rows[0];
}

/** Stores only the hash. */
export const insertPasswordCredential = (q, registrationId, passwordHash) =>
  q.query("INSERT INTO password_credentials (registration_id, password_hash) VALUES ($1, $2)", [registrationId, passwordHash]);
