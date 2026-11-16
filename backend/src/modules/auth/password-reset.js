import { withTransaction } from "../../db/transaction.js";
import { createLoginThrottle } from "./login-throttle.js";
import { verificationRequiredError } from "./errors.js";

export const PURPOSE = "password_reset";

/**
 * Forgot Password, built on the existing email OTP and single-use verification token.
 *
 * Public behaviour must not reveal whether an email has an account:
 *  - request/resend answer the same way for every email. For an email with no
 *    account a real code row is still created (so cooldown, attempt limit,
 *    expiry and the hourly caps behave identically), but nothing is sent and
 *    the code is thrown away, so it can never be verified.
 *  - delivery never blocks the answer and its failure is never reported, so
 *    neither response time nor an error tells the caller whether an email went out.
 *  - the generic /api/email-otp routes do NOT accept this purpose; only these
 *    routes can issue it.
 *
 * `confirm` is the only step that changes anything. In ONE transaction it spends
 * the single-use token (bound to this email and purpose), stores the new scrypt
 * hash, and revokes every existing session. It does not sign anyone in.
 */
export function createPasswordResetService({ db, emailOtp, passwords, sender, logger = console, loginConfig }) {
  const throttle = createLoginThrottle({ db, config: loginConfig });

  async function hasAccount(email) {
    const { rowCount } = await db.query("SELECT 1 FROM parent_registrations WHERE email_normalized = $1", [email]);
    return rowCount > 0;
  }
  const deliveryFor = async (email) => ((await hasAccount(email)) ? "background" : "none");

  async function request({ email, ip }) {
    return emailOtp.send({ email, purpose: PURPOSE, ip, delivery: await deliveryFor(email) });
  }

  async function resend({ email, ip }) {
    return emailOtp.resend({ email, purpose: PURPOSE, ip, delivery: await deliveryFor(email) });
  }

  const verify = ({ email, code }) => emailOtp.verify({ email, purpose: PURPOSE, code });

  async function confirm({ email, verificationToken, password }) {
    // A place for the hashing is taken before the transaction: a busy server (SERVER_BUSY) never uses up the token.
    const ticket = passwords.reserve();
    try {
      await confirmWith(ticket, { email, verificationToken, password });
    } finally {
      ticket.release();
    }

    // After COMMIT, best effort. Whether it arrives is never claimed to the caller.
    Promise.resolve()
      .then(() => sender?.sendPasswordChanged?.({ email }))
      .catch(() => logger.error("[password-reset] could not send the password-changed notice"));
  }

  function confirmWith(ticket, { email, verificationToken, password }) {
    return withTransaction(db, async (client) => {
      // One reset per email at a time, so two requests (even with two different tokens) can't interleave.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`password-reset:${email}`]);

      const token = await emailOtp.consumeVerificationTokenIn(client, { email, purpose: PURPOSE, token: verificationToken });
      if (!token) throw verificationRequiredError();
      const { rows } = await client.query("SELECT id FROM parent_registrations WHERE email_normalized = $1", [email]);
      if (!rows[0]) throw verificationRequiredError();
      const registrationId = rows[0].id;

      // After the token check on purpose: a request without a valid token costs no hashing.
      const passwordHash = await passwords.hash(password, { ticket });
      await client.query(
        `INSERT INTO password_credentials (registration_id, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (registration_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, changed_at = clock_timestamp()`,
        [registrationId, passwordHash],
      );
      // Every browser signed in as this account is signed out.
      await client.query(
        "UPDATE auth_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'password_reset' WHERE registration_id = $1 AND revoked_at IS NULL",
        [registrationId],
      );
      // Any other verified-but-unused reset authorisation for this email dies with this one.
      await client.query(
        `UPDATE email_verification_tokens SET consumed_at = clock_timestamp()
          WHERE email_normalized = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [email, PURPOSE],
      );
      // Ownership of the email was just proven, so a password lock-out from earlier guesses ends.
      await throttle.clearIn(client, email);
    });
  }

  return { request, resend, verify, confirm };
}
