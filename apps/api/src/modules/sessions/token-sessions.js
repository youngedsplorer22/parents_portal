import { createHmac, randomBytes } from "node:crypto";
import { withTransaction } from "../../db/transaction.js";

/**
 * Sign-ins with a short-lived ACCESS token and a one-time-use REFRESH token. Used by both parent and staff sign-in, each
 * with its own tables, hash domain and policy.
 *
 * Both tokens are 32 random bytes (base64url), opaque, and only their keyed hashes (HMAC-SHA256, in separate "access"
 * and "refresh" domains) are stored. The access token is checked against PostgreSQL on every request rather than being
 * a signed JWT, on purpose: logout, password reset, deactivation and replay detection then take effect immediately, and
 * there is no signing key to leak. A sign-in (a "session family") is one row in the sessions table:
 *
 *   access token   ~15 min; replaced on every refresh, so only the newest one works.
 *   refresh token  one use only. A refresh spends it and issues a new pair. It expires after the INACTIVITY limit.
 *   sign-in        ends at its ABSOLUTE limit (expires_at), which no refresh ever moves; or earlier when revoked.
 *
 * Replay: presenting a spent refresh token again revokes the whole sign-in (whoever holds the newest tokens is signed
 * out too), except within a few seconds of it being spent, which is what two tabs refreshing at the same moment look
 * like. That case is answered "race" and issues NOTHING, so it gives an attacker no new token either.
 */

const TABLES = {
  auth_sessions: { refresh: "auth_refresh_tokens", owner: "registration_id" },
  staff_sessions: { refresh: "staff_refresh_tokens", owner: "staff_id" },
};
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const newToken = () => randomBytes(32).toString("base64url");
const okToken = (t) => typeof t === "string" && TOKEN_SHAPE.test(t);

function checkPolicy(p) {
  const n = (v) => Number.isInteger(v) && v > 0;
  if (!n(p.accessTtlSeconds) || !n(p.idleTimeoutSeconds) || !n(p.absoluteTtlSeconds) || !Number.isInteger(p.reuseGraceSeconds) || p.reuseGraceSeconds < 0) {
    throw new Error("session policy: every lifetime must be a positive whole number of seconds");
  }
  if (p.accessTtlSeconds > p.idleTimeoutSeconds || p.idleTimeoutSeconds > p.absoluteTtlSeconds) {
    throw new Error("session policy: access token <= inactivity limit <= absolute limit");
  }
}

export function createTokenSessions({ db, secret, domain, sessions, refreshTokens, owner, policy }) {
  const t = TABLES[sessions];
  if (!t || t.refresh !== refreshTokens || t.owner !== owner) throw new Error("unknown session tables"); // fixed internal names only
  checkPolicy(policy);
  const hash = (kind, token) => createHmac("sha256", secret).update(`${domain}:${kind}:${token}`).digest("hex");
  /** The hash of a long-lived token from before access/refresh tokens existed (their original format). */
  const legacyHashOf = (token) => (okToken(token) ? createHmac("sha256", secret).update(`${domain}:${token}`).digest("hex") : null);

  /** Issues a fresh access + refresh pair for a sign-in, inside the caller's transaction. */
  async function issue(q, sessionId) {
    const access = newToken();
    const refresh = newToken();
    const { rows } = await q.query(
      `UPDATE ${sessions}
          SET access_token_hash = $2,
              access_expires_at = LEAST(clock_timestamp() + make_interval(secs => $3), expires_at),
              idle_expires_at   = LEAST(clock_timestamp() + make_interval(secs => $4), expires_at)
        WHERE id = $1
        RETURNING extract(epoch FROM access_expires_at - clock_timestamp()) AS access_left,
                  extract(epoch FROM idle_expires_at - clock_timestamp()) AS idle_left`,
      [sessionId, hash("access", access), policy.accessTtlSeconds, policy.idleTimeoutSeconds],
    );
    await q.query(
      `INSERT INTO ${refreshTokens} (session_id, token_hash, expires_at)
       SELECT id, $2, idle_expires_at FROM ${sessions} WHERE id = $1`,
      [sessionId, hash("refresh", refresh)],
    );
    const left = (v, cap) => Math.max(1, Math.min(cap, Math.ceil(Number(v))));
    return {
      access: { token: access, maxAgeSeconds: left(rows[0].access_left, policy.accessTtlSeconds) },
      refresh: { token: refresh, maxAgeSeconds: left(rows[0].idle_left, policy.idleTimeoutSeconds) },
    };
  }

  /** A new sign-in for `ownerId`, inside the caller's transaction. -> { sessionId, access, refresh } */
  async function createIn(q, ownerId) {
    const { rows } = await q.query(
      `INSERT INTO ${sessions} (${owner}, expires_at) VALUES ($1, now() + make_interval(secs => $2)) RETURNING id`,
      [ownerId, policy.absoluteTtlSeconds],
    );
    return { sessionId: rows[0].id, ...(await issue(q, rows[0].id)) };
  }

  /** The sign-in an access token belongs to, if the token is current: { sessionId, ownerId } or null. */
  async function sessionForAccess(q, token) {
    if (!okToken(token)) return null;
    const { rows } = await q.query(
      `SELECT id, ${owner} AS owner_id FROM ${sessions}
        WHERE access_token_hash = $1 AND access_expires_at > clock_timestamp()
          AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [hash("access", token)],
    );
    return rows[0] ? { sessionId: rows[0].id, ownerId: rows[0].owner_id } : null;
  }

  /**
   * Exchanges a refresh token for a new pair. ->
   *   { status: "ok", sessionId, ownerId, access, refresh }
   *   { status: "race" }     spent a moment ago by a simultaneous request: nothing issued, nothing revoked
   *   { status: "reused", sessionId, ownerId }   spent earlier: replay, the whole sign-in is now revoked
   *   { status: "expired" }  inactivity or absolute limit reached, or the sign-in was revoked
   *   { status: "invalid" }  not a refresh token we issued
   */
  async function refresh(token) {
    if (!okToken(token)) return { status: "invalid" };
    return withTransaction(db, async (q) => {
      // Locks the token row (and its sign-in), so simultaneous refreshes with one token are handled one at a time.
      const { rows } = await q.query(
        `SELECT rt.id, rt.used_at, s.id AS session_id, s.${owner} AS owner_id,
                (rt.used_at IS NOT NULL AND rt.used_at > clock_timestamp() - make_interval(secs => $2)) AS in_grace,
                (rt.expires_at <= clock_timestamp()) AS token_expired,
                (s.revoked_at IS NOT NULL OR s.expires_at <= clock_timestamp()) AS session_over
           FROM ${refreshTokens} rt JOIN ${sessions} s ON s.id = rt.session_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt, s`,
        [hash("refresh", token), policy.reuseGraceSeconds],
      );
      const r = rows[0];
      if (!r) return { status: "invalid" };
      if (r.session_over) return { status: "expired" };
      if (r.used_at) {
        if (r.in_grace) return { status: "race" };
        await q.query(
          `UPDATE ${sessions} SET revoked_at = clock_timestamp(), revoke_reason = 'refresh_reuse' WHERE id = $1 AND revoked_at IS NULL`,
          [r.session_id],
        );
        return { status: "reused", sessionId: r.session_id, ownerId: r.owner_id };
      }
      if (r.token_expired) return { status: "expired" };
      await q.query(`UPDATE ${refreshTokens} SET used_at = clock_timestamp() WHERE id = $1`, [r.id]);
      return { status: "ok", sessionId: r.session_id, ownerId: r.owner_id, ...(await issue(q, r.session_id)) };
    });
  }

  /** A sign-in from before this change (one long-lived token): exchanged ONCE for a pair; the old token is retired. */
  async function upgradeLegacy(legacyHash) {
    if (typeof legacyHash !== "string" || !/^[0-9a-f]{64}$/.test(legacyHash)) return { status: "invalid" };
    return withTransaction(db, async (q) => {
      const { rows } = await q.query(
        `SELECT id, ${owner} AS owner_id FROM ${sessions}
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
        [legacyHash],
      );
      if (!rows[0]) return { status: "invalid" };
      await q.query(`UPDATE ${sessions} SET token_hash = NULL WHERE id = $1`, [rows[0].id]);
      return { status: "ok", sessionId: rows[0].id, ownerId: rows[0].owner_id, ...(await issue(q, rows[0].id)) };
    });
  }

  /** Ends the sign-in identified by any of its tokens (even an expired access token). -> its id, or null. */
  async function revoke({ accessToken, refreshToken, legacyHash } = {}, reason) {
    let id = null;
    if (okToken(accessToken)) id = (await db.query(`SELECT id FROM ${sessions} WHERE access_token_hash = $1`, [hash("access", accessToken)])).rows[0]?.id ?? null;
    if (!id && okToken(refreshToken)) id = (await db.query(`SELECT session_id AS id FROM ${refreshTokens} WHERE token_hash = $1`, [hash("refresh", refreshToken)])).rows[0]?.id ?? null;
    if (!id && typeof legacyHash === "string") id = (await db.query(`SELECT id FROM ${sessions} WHERE token_hash = $1`, [legacyHash])).rows[0]?.id ?? null;
    if (!id) return null;
    await db.query(`UPDATE ${sessions} SET revoked_at = clock_timestamp(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, reason]);
    return id;
  }

  /** Housekeeping: sign-ins (and their refresh tokens) a day past their absolute end. */
  const purgeExpired = () => db.query(`DELETE FROM ${sessions} WHERE expires_at < clock_timestamp() - interval '1 day'`);

  return { policy, createIn, sessionForAccess, refresh, upgradeLegacy, revoke, purgeExpired, legacyHashOf };
}
