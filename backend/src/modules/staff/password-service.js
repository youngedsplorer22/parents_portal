import { AppError } from "../email-otp/errors.js";
import { withTransaction } from "../../db/transaction.js";
import { verificationRequiredError } from "../auth/errors.js";
import { createLoginThrottle } from "../auth/login-throttle.js";
import { recordAudit } from "./audit.js";

export const PURPOSE = "staff_password";

const currentPasswordIncorrectError = () =>
  new AppError(400, "CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.");

/**
 * Staff passwords: first-time setup, forgot-password, and change-while-signed-in.
 *
 * Setup and forgot-password are ONE flow built on the existing email code and single-use
 * verification token, under their own purpose ("staff_password") so a parent's code can never
 * work here. A pending account (no password yet) is "setting"; one that has a password is
 * "resetting". Ownership of the mailbox is the only proof accepted.
 *
 * Public behaviour must not reveal who is staff:
 *  - request/resend answer the same way for every email. For an email that is not an eligible
 *    (existing, not deactivated) staff account a real code row is still created, so cooldown,
 *    attempt limit, expiry and the hourly caps behave identically, but nothing is sent and the
 *    code is thrown away, so it can never be verified.
 *  - delivery never blocks the answer and its failure is never reported.
 *  - the generic /api/email-otp routes do NOT accept this purpose.
 *
 * `confirm` is the only step that changes anything. In ONE transaction it spends the token (bound
 * to this email and purpose), stores the new scrypt hash, ends every session of that account and
 * voids other unused authorisations. It does not sign anyone in.
 */
export function createStaffPasswordService({ db, emailOtp, passwords, sender, logger = console, loginConfig }) {
  const throttle = createLoginThrottle({
    db,
    config: loginConfig,
    table: "staff_login_attempts",
    name: "stafflogin",
    lockedMessage: "Too many sign-in attempts. Please wait a while and try again.",
  });

  /** { pending } for an existing, active (not deactivated) staff account; null for anything else. */
  async function eligibility(email) {
    const { rows } = await db.query(
      "SELECT (password_hash IS NULL) AS pending FROM staff_users WHERE email_normalized = $1 AND disabled_at IS NULL",
      [email],
    );
    return rows[0] ?? null;
  }
  const optionsFor = async (email) => {
    const found = await eligibility(email);
    return { delivery: found ? "background" : "none", context: { kind: found?.pending ? "setup" : "reset" } };
  };

  async function request({ email, ip }) {
    return emailOtp.send({ email, purpose: PURPOSE, ip, ...(await optionsFor(email)) });
  }
  async function resend({ email, ip }) {
    return emailOtp.resend({ email, purpose: PURPOSE, ip, ...(await optionsFor(email)) });
  }
  const verify = ({ email, code }) => emailOtp.verify({ email, purpose: PURPOSE, code });

  /** -> { firstTime }. Revealed only after the code was proven, so it tells the owner nothing new. */
  async function confirm({ email, verificationToken, password }) {
    // A place for the hashing is taken before the transaction: a busy server (SERVER_BUSY) never uses up the token.
    const ticket = passwords.reserve();
    let firstTime;
    try {
      firstTime = await confirmWith(ticket, { email, verificationToken, password });
    } finally {
      ticket.release();
    }
    notify(email, firstTime);
    return { firstTime };
  }

  function confirmWith(ticket, { email, verificationToken, password }) {
    return withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`staff-password:${email}`]);
      const token = await emailOtp.consumeVerificationTokenIn(client, { email, purpose: PURPOSE, token: verificationToken });
      if (!token) throw verificationRequiredError();
      const { rows } = await client.query(
        "SELECT id, (password_hash IS NULL) AS pending FROM staff_users WHERE email_normalized = $1 AND disabled_at IS NULL FOR UPDATE",
        [email],
      );
      if (!rows[0]) throw verificationRequiredError();
      const staff = rows[0];
      const hash = await passwords.hash(password, { ticket });
      await client.query("UPDATE staff_users SET password_hash = $2, changed_at = clock_timestamp() WHERE id = $1", [staff.id, hash]);
      // Every browser signed in as this account is signed out.
      await client.query("UPDATE staff_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'password_reset' WHERE staff_id = $1 AND revoked_at IS NULL", [staff.id]);
      // Any other verified-but-unused authorisation for this email dies with this one.
      await client.query(
        `UPDATE email_verification_tokens SET consumed_at = clock_timestamp()
          WHERE email_normalized = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [email, PURPOSE],
      );
      // Ownership of the mailbox was just proven, so a lock-out from earlier guesses ends.
      await throttle.clearIn(client, email);
      await recordAudit(client, { id: staff.id, email }, staff.pending ? "staff.password_set" : "staff.password_reset", "staff", staff.id, {});
      return staff.pending;
    });
  }

  /**
   * Change while signed in. The CURRENT password is required and every wrong guess counts toward the
   * same per-account limit as sign-in. The caller's own session stays; every other session ends.
   */
  async function changePassword({ staff, sessionId, currentPassword, newPassword, ip }) {
    // A place for both hashes is taken first: a busy server (SERVER_BUSY) answers before the attempt is counted.
    const ticket = passwords.reserve();
    let hash;
    try {
      await throttle.begin({ email: staff.email, ip });
      const { rows } = await db.query("SELECT password_hash FROM staff_users WHERE id = $1 AND disabled_at IS NULL", [staff.id]);
      const stored = rows[0]?.password_hash;
      const ok = stored
        ? await passwords.verify(currentPassword, stored, { ticket })
        : await passwords.verifyDecoy(currentPassword, { ticket });
      if (!ok) throw currentPasswordIncorrectError();
      hash = await passwords.hash(newPassword, { ticket });
    } finally {
      ticket.release();
    }
    await withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`staff-password:${staff.email}`]);
      await client.query("UPDATE staff_users SET password_hash = $2, changed_at = clock_timestamp() WHERE id = $1", [staff.id, hash]);
      await client.query(
        "UPDATE staff_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'password_change' WHERE staff_id = $1 AND revoked_at IS NULL AND id <> $2",
        [staff.id, sessionId],
      );
      await throttle.clearIn(client, staff.email);
      await recordAudit(client, staff, "staff.password_change", "staff", staff.id, {});
    });
    notify(staff.email, false);
  }

  /** After COMMIT, best effort. Whether it arrives is never claimed to the caller. */
  function notify(email, firstTime) {
    Promise.resolve()
      .then(() => sender?.sendStaffPasswordChanged?.({ email, firstTime }))
      .catch(() => logger.error("[staff-password] could not send the password notice"));
  }

  return { request, resend, verify, confirm, changePassword };
}
