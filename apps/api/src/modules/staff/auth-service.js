import { withTransaction } from "../../db/transaction.js";
import { refreshRaceError } from "../auth/errors.js";
import { createTokenSessions } from "../sessions/token-sessions.js";
import { createLoginThrottle } from "../auth/login-throttle.js";
import { createPasswordHasher } from "../auth/password.js";
import { recordAudit } from "./audit.js";
import { staffInvalidCredentialsError, staffUnauthenticatedError } from "./errors.js";

/**
 * Staff sign-in and sessions. Separate from parent auth in every way that matters: own tables,
 * own cookies, own token hash domain ("staff-session-token-v1", never equal to the parents'), own policy (shorter
 * inactivity and absolute limits) and own rate-limit table. A 15-minute access token plus a one-time-use refresh token,
 * exactly as for parents (../sessions/token-sessions.js). There is no sign-up here; accounts
 * are added by an authorised admin (admin panel, provisioning script or SQL by IT) and their owner
 * sets the password by emailed code (password-service.js).
 *
 * LIMITATION (needs a decision from the lead): staff sign in with email + password only. A
 * second factor (for example an emailed code) is not implemented because it is not confirmed.
 */
export function createStaffAuthService({ db, config, gate, logger = console, passwords = createPasswordHasher({ cost: config.scryptCost, gate }) }) {
  const sessions = createTokenSessions({
    db,
    secret: config.hmacSecret,
    domain: "staff-session-token-v1",
    sessions: "staff_sessions",
    refreshTokens: "staff_refresh_tokens",
    owner: "staff_id",
    policy: {
      accessTtlSeconds: config.accessTtlSeconds,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      absoluteTtlSeconds: config.sessionTtlSeconds,
      reuseGraceSeconds: config.reuseGraceSeconds,
    },
  });
  const throttle = createLoginThrottle({
    db,
    config: config.login,
    table: "staff_login_attempts",
    name: "stafflogin",
    lockedMessage: "Too many sign-in attempts. Please wait a while and try again.",
  });

  async function login({ email, password, ip }) {
    // A place for the hashing is taken first: a busy server (SERVER_BUSY) answers before the attempt is counted.
    const ticket = passwords.reserve();
    let staff;
    try {
      await throttle.begin({ email, ip }); // counts this attempt first; may throw RATE_LIMITED
      const { rows } = await db.query(
        "SELECT id, email_normalized, display_name, role, password_hash, disabled_at FROM staff_users WHERE email_normalized = $1",
        [email],
      );
      staff = rows[0];
      // Unknown, disabled and wrong password all take the same path and the same amount of hashing.
      // A pending account (no password yet) takes the same path as an unknown one.
      const ok =
        staff && !staff.disabled_at && staff.role === "sales" && staff.password_hash
          ? await passwords.verify(password, staff.password_hash, { ticket })
          : await passwords.verifyDecoy(password, { ticket });
      if (!ok) throw staffInvalidCredentialsError();
    } finally {
      ticket.release();
    }

    return withTransaction(db, async (client) => {
      await throttle.clearIn(client, email);
      const session = await sessions.createIn(client, staff.id);
      await recordAudit(client, { id: staff.id, email: staff.email_normalized }, "staff.login", "staff", staff.id, {});
      return { session, staff: publicStaff(staff) };
    });
  }

  const activeStaff = async (id) =>
    (await db.query("SELECT id, email_normalized, display_name, role FROM staff_users WHERE id = $1 AND disabled_at IS NULL AND role = 'sales'", [id])).rows[0] ?? null;

  /** The signed-in staff member for a CURRENT access token, or null (unknown, expired, revoked, or account disabled). */
  async function authenticate(accessToken) {
    const found = await sessions.sessionForAccess(db, accessToken);
    if (!found) return null;
    const row = await activeStaff(found.ownerId);
    return row ? { ...publicStaff(row), sessionId: found.sessionId } : null;
  }

  /**
   * Renews a staff sign-in (refresh token, or once an old single cookie) -> { session, staff }. 409 REFRESH_RACE when
   * another request renewed it a moment ago; 401 when it is over, replayed, or the account is disabled.
   */
  async function refreshSession({ refresh, legacy }) {
    const r = refresh ? await sessions.refresh(refresh) : legacy ? await sessions.upgradeLegacy(sessions.legacyHashOf(legacy)) : { status: "invalid" };
    if (r.status === "race") throw refreshRaceError();
    if (r.status === "reused") {
      logger.error("[staff] a staff refresh token was reused; that sign-in was ended (possible token theft).");
      const row = (await db.query("SELECT id, email_normalized FROM staff_users WHERE id = $1", [r.ownerId])).rows[0];
      if (row) await recordAudit(db, { id: row.id, email: row.email_normalized }, "staff.session_reuse", "staff", row.id, { reason: "refresh_reuse" });
      throw staffUnauthenticatedError();
    }
    if (r.status !== "ok") throw staffUnauthenticatedError();
    const row = await activeStaff(r.ownerId);
    if (!row) {
      await sessions.revoke({ accessToken: r.access.token }, "deactivated"); // a disabled account never keeps a sign-in
      throw staffUnauthenticatedError();
    }
    return { session: { sessionId: r.sessionId, access: r.access, refresh: r.refresh }, staff: publicStaff(row) };
  }

  /** Ends the sign-in identified by any of its cookies (even an expired access token); audited when it was live. */
  async function logout({ access, refresh, legacy } = {}, staff) {
    const id = await sessions.revoke({ accessToken: access, refreshToken: refresh, legacyHash: sessions.legacyHashOf(legacy) }, "logout");
    if (id && staff) await recordAudit(db, staff, "staff.logout", "staff", staff.id, {});
  }

  const purgeExpired = async () => {
    await sessions.purgeExpired();
    await throttle.purgeOld();
  };

  return { login, authenticate, refreshSession, logout, purgeExpired, passwords, policy: sessions.policy };
}

function publicStaff(row) {
  return { id: row.id, email: row.email_normalized, name: row.display_name, role: row.role };
}
