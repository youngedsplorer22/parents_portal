import { AppError } from "../email-otp/errors.js";

const lockKey = (name, kind, value) => `${name}:${kind}:${value}`;

const retryAfter = (oldest, windowSeconds) =>
  Math.max(1, Math.ceil((new Date(oldest).getTime() + windowSeconds * 1000 - Date.now()) / 1000));

export const tooManyLoginsError = (retryAfterSeconds, message = "Too many sign-in attempts. Please wait a while, or sign in with an email code instead.") =>
  new AppError(429, "RATE_LIMITED", message, {
    retryAfterSeconds,
  });

/**
 * Limits password guessing per account (email) and per IP.
 *
 * `begin` records the attempt BEFORE the password is checked, inside a short
 * transaction holding a per-email advisory lock, so a burst of parallel guesses
 * is counted and cannot slip past the limit. A blocked request records nothing,
 * so the lock-out ends when the oldest counted attempt ages out of the window.
 * The limit applies whether or not the email has an account, so it reveals nothing about it.
 *
 * Known trade-off: someone can keep a victim's *password* sign-in locked by
 * guessing wrongly on purpose. Email-code sign-in is unaffected, and the message says so.
 */
// `table` is a fixed internal name (password_login_attempts or staff_login_attempts), never user input.
export function createLoginThrottle({ db, config, table = "password_login_attempts", name = "pwlogin", lockedMessage }) {
  const { windowSeconds, maxPerEmail, maxPerIp } = config;

  async function begin({ email, ip }) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Always email first, then IP: the same order everywhere, so two requests can't deadlock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(name, "email", email)]);
      if (ip) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(name, "ip", ip)]);

      const window = "created_at > clock_timestamp() - make_interval(secs => $2)";
      const byEmail = (
        await client.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM ${table} WHERE email_normalized = $1 AND ${window}`, [email, windowSeconds])
      ).rows[0];
      if (byEmail.n >= maxPerEmail) throw tooManyLoginsError(retryAfter(byEmail.oldest, windowSeconds), lockedMessage);
      if (ip) {
        const byIp = (
          await client.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM ${table} WHERE request_ip = $1::inet AND ${window}`, [ip, windowSeconds])
        ).rows[0];
        if (byIp.n >= maxPerIp) throw tooManyLoginsError(retryAfter(byIp.oldest, windowSeconds), lockedMessage);
      }
      await client.query(`INSERT INTO ${table} (email_normalized, request_ip) VALUES ($1, $2)`, [email, ip ?? null]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** After a successful sign-in, runs in the caller's transaction. */
  const clearIn = (q, email) => q.query(`DELETE FROM ${table} WHERE email_normalized = $1`, [email]);

  const purgeOld = () => db.query(`DELETE FROM ${table} WHERE created_at < clock_timestamp() - interval '1 day'`);

  return { begin, clearIn, purgeOld };
}
