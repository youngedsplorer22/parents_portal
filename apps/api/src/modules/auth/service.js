import { withTransaction } from "../../db/transaction.js";
import { createTokenSessions } from "../sessions/token-sessions.js";
import { accountNotFoundError, invalidCredentialsError, refreshRaceError, unauthenticatedError, verificationRequiredError } from "./errors.js";
import { createLoginThrottle } from "./login-throttle.js";
import { createPasswordHasher } from "./password.js";

const PURPOSE = "login";

/**
 * Parent sign-ins. A sign-in is created only after email ownership has been proven (a single-use verification token,
 * a password, or the registration that just consumed a verification), and the browser holds nothing but two opaque
 * random tokens in HttpOnly cookies: a 15-minute ACCESS token for every request and a one-time-use REFRESH token that
 * renews it (see ../sessions/token-sessions.js). Only keyed hashes are stored.
 */
export function createAuthService({ db, emailOtp, config, gate, logger = console, passwords = createPasswordHasher({ cost: config.scryptCost, gate }) }) {
  const throttle = createLoginThrottle({ db, config: config.passwordLogin });
  const engine = (domain) =>
    createTokenSessions({
      db,
      secret: config.hmacSecret, // domain-separated inside, so the same secret never produces a valid OTP hash
      domain,
      sessions: "auth_sessions",
      refreshTokens: "auth_refresh_tokens",
      owner: "registration_id",
      policy: {
        accessTtlSeconds: config.accessTtlSeconds,
        idleTimeoutSeconds: config.idleTimeoutSeconds,
        absoluteTtlSeconds: config.sessionTtlSeconds,
        reuseGraceSeconds: config.reuseGraceSeconds,
      },
    });
  const sessions = engine("session-token-v1");
  // The Team Leader mobile app: the same sign-ins table, rules and lifetimes, but its tokens are hashed in their own
  // domain, so an app token is never accepted as a browser cookie and a browser cookie never works on the app API.
  // Logout everywhere, password reset (which revoke by registration) end app sign-ins too.
  const mobileSessions = engine("mobile-session-token-v1");

  /** A new sign-in, inside the caller's transaction so it commits or rolls back with it. -> { sessionId, access, refresh } */
  const createSessionIn = (q, registrationId) => sessions.createIn(q, registrationId);

  const userOf = async (registrationId) => {
    const { rows } = await db.query("SELECT id, email_normalized AS email, first_name, last_name, role FROM parent_registrations WHERE id = $1", [registrationId]);
    const u = rows[0];
    return u ? { registrationId: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, role: u.role } : null;
  };

  /** The signed-in user for a CURRENT access token, or null (unknown, expired, revoked, past the sign-in's end). */
  async function authenticate(accessToken, { mobile = false } = {}) {
    const found = await (mobile ? mobileSessions : sessions).sessionForAccess(db, accessToken);
    if (!found) return null;
    const user = await userOf(found.ownerId);
    return user ? { ...user, sessionId: found.sessionId } : null;
  }

  /**
   * Renews a sign-in: the refresh token (or, once, a cookie from before refresh tokens) for a new pair.
   * -> { session, user }. Throws 409 REFRESH_RACE when another request refreshed a moment ago (nothing issued; the
   * caller just retries with the cookies it now has), and 401 when the sign-in is over, unknown, or was replayed.
   */
  async function refreshSession({ refresh, legacy, mobile = false }) {
    const r = refresh
      ? await (mobile ? mobileSessions : sessions).refresh(refresh)
      : legacy && !mobile ? await sessions.upgradeLegacy(sessions.legacyHashOf(legacy)) : { status: "invalid" };
    if (r.status === "race") throw refreshRaceError();
    if (r.status === "reused") {
      // Someone presented a refresh token that had already been used: the whole sign-in has just been revoked.
      logger.error(`[auth] a refresh token was reused; that ${mobile ? "mobile app" : "parent"} sign-in was ended (possible token theft).`);
      throw unauthenticatedError();
    }
    if (r.status !== "ok") throw unauthenticatedError();
    const user = await userOf(r.ownerId);
    if (!user) throw unauthenticatedError();
    return { session: { sessionId: r.sessionId, access: r.access, refresh: r.refresh }, user };
  }

  /**
   * Log in with a single-use "login" verification token. The token is spent and
   * the session created in one transaction; if there is no account the token is
   * not consumed.
   */
  async function login({ email, verificationToken }) {
    return withTransaction(db, async (client) => {
      const token = await emailOtp.consumeVerificationTokenIn(client, { email, purpose: PURPOSE, token: verificationToken });
      if (!token) throw verificationRequiredError();

      const { rows } = await client.query(
        "SELECT id, first_name, last_name, role FROM parent_registrations WHERE email_normalized = $1",
        [email],
      );
      if (!rows[0]) throw accountNotFoundError();
      const session = await createSessionIn(client, rows[0].id);
      return {
        session,
        user: { email, firstName: rows[0].first_name, lastName: rows[0].last_name, role: rows[0].role },
      };
    });
  }

  /**
   * Sign in with email + password. Every failure (no such email, an account that
   * has no password yet, a wrong password) gives the same error, and the same
   * amount of hashing work is done in each case.
   * A place for the hashing is taken first: a busy server (SERVER_BUSY) answers before the attempt is counted.
   */
  async function passwordLogin({ email, password, ip, mobile = false }) {
    const ticket = passwords.reserve(); // may throw SERVER_BUSY
    let account;
    try {
      await throttle.begin({ email, ip }); // may throw RATE_LIMITED; counts this attempt first
      const { rows } = await db.query(
        `SELECT r.id, r.first_name, r.last_name, r.role, c.password_hash
           FROM parent_registrations r
           LEFT JOIN password_credentials c ON c.registration_id = r.id
          WHERE r.email_normalized = $1`,
        [email],
      );
      account = rows[0];
      const ok = account?.password_hash
        ? await passwords.verify(password, account.password_hash, { ticket })
        : await passwords.verifyDecoy(password, { ticket });
      if (!ok) throw invalidCredentialsError();
    } finally {
      ticket.release();
    }

    return withTransaction(db, async (client) => {
      await throttle.clearIn(client, email);
      const session = await (mobile ? mobileSessions : sessions).createIn(client, account.id);
      return { session, user: { email, firstName: account.first_name, lastName: account.last_name, role: account.role } };
    });
  }

  /** Ends the sign-in identified by any of its cookies (works with an expired access token too). */
  async function logout({ access, refresh, legacy, mobile = false } = {}) {
    if (mobile) return void (await mobileSessions.revoke({ accessToken: access, refreshToken: refresh }, "logout"));
    await sessions.revoke({ accessToken: access, refreshToken: refresh, legacyHash: sessions.legacyHashOf(legacy) }, "logout");
  }

  /** Housekeeping: sign-ins (and their refresh tokens) a day past their absolute end. */
  const purgeExpired = async () => {
    await sessions.purgeExpired();
    await throttle.purgeOld();
  };

  return { createSessionIn, authenticate, refreshSession, login, passwordLogin, logout, purgeExpired, passwords, policy: sessions.policy };
}
