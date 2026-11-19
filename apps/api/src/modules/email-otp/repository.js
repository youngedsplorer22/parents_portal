// SQL only. Every function takes a pg client or pool as `q` so the service
// decides what runs inside a transaction. Time is always passed in by the
// caller (never now()) so the service clock is the single source of truth.

/** Serialises all work for one email+purpose until the transaction ends. */
export const lockChallenge = (q, email, purpose) =>
  q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`email-otp:${purpose}:${email}`]);

/**
 * PostgreSQL's own clock, not the Node process's. Read after the advisory lock
 * so time spent waiting for it is counted. Tests inject a fake clock instead.
 */
export async function dbNow(q) {
  const { rows } = await q.query("SELECT clock_timestamp() AS now");
  return rows[0].now;
}

// Expiry and cooldown are decided inside PostgreSQL (is_expired, cooldown_active)
// by comparing the stored timestamps with `now`, not by comparing dates in JS.
export async function findActive(q, email, purpose, now) {
  const { rows } = await q.query(
    `SELECT *, (expires_at <= $3) AS is_expired, (resend_available_at > $3) AS cooldown_active
       FROM email_otps
      WHERE email_normalized = $1 AND purpose = $2
        AND verified_at IS NULL AND invalidated_at IS NULL
        FOR UPDATE`,
    [email, purpose, now],
  );
  return rows[0] ?? null;
}

export async function findLatest(q, email, purpose, now) {
  const { rows } = await q.query(
    `SELECT *, (expires_at <= $3) AS is_expired, (resend_available_at > $3) AS cooldown_active
       FROM email_otps
      WHERE email_normalized = $1 AND purpose = $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, purpose, now],
  );
  return rows[0] ?? null;
}

export async function insertOtp(q, o) {
  await q.query(
    `INSERT INTO email_otps
       (id, email_normalized, purpose, code_hash, created_at, expires_at,
        resend_available_at, max_attempts, request_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [o.id, o.email, o.purpose, o.codeHash, o.createdAt, o.expiresAt, o.resendAvailableAt, o.maxAttempts, o.ip],
  );
}

export const invalidate = (q, id, at) =>
  q.query("UPDATE email_otps SET invalidated_at = $2 WHERE id = $1 AND invalidated_at IS NULL", [id, at]);

export async function incrementAttempts(q, id) {
  const { rows } = await q.query("UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [id]);
  return rows[0].attempts;
}

export const markVerified = (q, id, at) =>
  q.query("UPDATE email_otps SET verified_at = $2 WHERE id = $1", [id, at]);

export async function sendWindowByEmail(q, email, purpose, since) {
  const { rows } = await q.query(
    `SELECT count(*)::int AS count, min(created_at) AS oldest FROM email_otps
      WHERE email_normalized = $1 AND purpose = $2 AND created_at > $3`,
    [email, purpose, since],
  );
  return rows[0];
}

export async function sendWindowByIp(q, ip, since) {
  const { rows } = await q.query(
    `SELECT count(*)::int AS count, min(created_at) AS oldest FROM email_otps
      WHERE request_ip = $1::inet AND created_at > $2`,
    [ip, since],
  );
  return rows[0];
}

/** Retention: drops old OTPs (their tokens go with them via ON DELETE CASCADE). */
export const purgeCreatedBefore = (q, before) => q.query("DELETE FROM email_otps WHERE created_at < $1", [before]);

export const insertToken = (q, t) =>
  q.query(
    `INSERT INTO email_verification_tokens
       (otp_id, email_normalized, purpose, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [t.otpId, t.email, t.purpose, t.tokenHash, t.createdAt, t.expiresAt],
  );

/**
 * Atomic single-use: only one caller can flip consumed_at from NULL. Returns the
 * spent token row's id and verification time, or null if nothing matched
 * (unknown, expired, already used, or issued for a different email/purpose).
 * Takes any client, so it can run inside the caller's transaction.
 */
export async function consumeToken(q, { tokenHash, email, purpose, now }) {
  const { rows } = await q.query(
    `UPDATE email_verification_tokens SET consumed_at = $4
      WHERE token_hash = $1 AND email_normalized = $2 AND purpose = $3
        AND consumed_at IS NULL AND expires_at > $4
      RETURNING id, created_at`,
    [tokenHash, email, purpose, now],
  );
  return rows[0] ? { id: rows[0].id, verifiedAt: rows[0].created_at } : null;
}
