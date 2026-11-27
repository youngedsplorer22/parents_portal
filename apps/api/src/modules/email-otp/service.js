import { randomUUID } from "node:crypto";
import {
  AppError,
  cooldownError,
  expiredError,
  invalidCodeError,
  notFoundError,
  rateLimitedError,
  tooManyAttemptsError,
} from "./errors.js";
import * as crypto from "./otp-crypto.js";
import * as repo from "./repository.js";
import { PURPOSE, normalizeEmail } from "./validation.js";

const HOUR_MS = 3_600_000;
const RETENTION_MS = 24 * HOUR_MS;
const MS = 1000;

const secondsUntil = (target, now) => Math.max(0, Math.ceil((target - now) / MS));

/**
 * Rules enforced here (never in the browser):
 *  - a new code is created only by send (when none is pending) or an explicit resend;
 *  - resend invalidates the previous code in the same transaction;
 *  - expiry (ttlSeconds), resend cooldown, attempt limit and hourly send caps;
 *  - all work for one email is serialised with an advisory lock, so concurrent
 *    requests cannot create two usable codes or verify one code twice.
 *
 * Time comes from PostgreSQL (clock_timestamp()) unless a `clock` is injected,
 * which only tests do. Stored timestamps are compared with it inside SQL.
 */
export function createOtpService({
  db,
  sender,
  config,
  clock,
  generateCode = crypto.generateCode,
  generateToken = crypto.generateToken,
  logger = console,
}) {
  const currentTime = async (q) => (clock ? clock() : repo.dbNow(q));

  async function withTransaction(fn) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const state = (row, now) => ({
    expiresInSeconds: secondsUntil(row.expires_at, now),
    resendAvailableInSeconds: secondsUntil(row.resend_available_at, now),
    delivery: sender.mode,
  });

  const retryAfter = (oldest, now) => Math.max(1, Math.ceil((oldest.getTime() + HOUR_MS - now) / MS));

  /**
   * How long a code lives. Staff codes (purpose "staff_password") have their own, longer lifetime; every
   * other purpose (the parents') uses ttlSeconds, unchanged. The value is written into expires_at when the
   * code is created and verify() compares against that stored time, so this is the one place expiry is set.
   */
  const ttlFor = (purpose) => (purpose === "staff_password" && config.staffTtlSeconds ? config.staffTtlSeconds : config.ttlSeconds);

  /** Caps, invalidate the previous code, insert a new one. Runs inside the caller's transaction. */
  async function issueNew(client, { email, purpose, ip, now, previous }) {
    const since = new Date(now.getTime() - HOUR_MS);
    const byEmail = await repo.sendWindowByEmail(client, email, purpose, since);
    if (byEmail.count >= config.maxSendsPerEmailPerHour) throw rateLimitedError(retryAfter(byEmail.oldest, now));
    if (ip) {
      const byIp = await repo.sendWindowByIp(client, ip, since);
      if (byIp.count >= config.maxSendsPerIpPerHour) throw rateLimitedError(retryAfter(byIp.oldest, now));
    }

    if (previous) await repo.invalidate(client, previous.id, now);
    await repo.purgeCreatedBefore(client, new Date(now.getTime() - RETENTION_MS));

    const id = randomUUID();
    const code = generateCode();
    const row = {
      id,
      email,
      purpose,
      codeHash: crypto.hashCode(config.hmacSecret, { otpId: id, email, purpose, code }),
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlFor(purpose) * MS),
      resendAvailableAt: new Date(now.getTime() + config.resendCooldownSeconds * MS),
      maxAttempts: config.maxAttempts,
      ip: ip ?? null,
    };
    await repo.insertOtp(client, row);
    return { id, code, expires_at: row.expiresAt, resend_available_at: row.resendAvailableAt };
  }

  /** Hands the code to the sender after the commit. If delivery fails the code is voided. */
  async function deliver(email, purpose, issued, context) {
    try {
      await sender.send({ email, code: issued.code, expiresInSeconds: ttlFor(purpose), purpose, context });
    } catch (err) {
      // Warn immediately (before the async invalidation) so Railway logs capture this even if the DB call is slow.
      logger.warn?.("[email-otp] background delivery failed; code voided. Check SMTP settings and Railway logs for the error code.");
      await repo.invalidate(db, issued.id, await currentTime(db)).catch(() => {});
      throw new AppError(502, "DELIVERY_FAILED", "We could not deliver the code. Please try again.");
    }
  }

  /**
   * delivery: "await" (default) reports a failed delivery to the caller;
   *           "background" sends without waiting and never reports failure;
   *           "none" issues the code but sends nothing.
   * The last two exist for flows that must behave identically whether or not
   * the email has an account (see auth/password-reset.js).
   */
  async function dispatch(delivery, email, purpose, issued, context) {
    if (delivery === "none") return;
    if (delivery === "background") {
      deliver(email, purpose, issued, context).catch(() => {});
      return;
    }
    await deliver(email, purpose, issued, context);
  }

  /**
   * Starts verification. If a code is already pending for this email (even an
   * expired one) nothing new is generated: only an explicit resend does that.
   */
  async function send({ email, purpose = PURPOSE, ip, delivery = "await", context }) {
    email = normalizeEmail(email);
    const result = await withTransaction(async (client) => {
      await repo.lockChallenge(client, email, purpose);
      const now = await currentTime(client);

      const active = await repo.findActive(client, email, purpose, now);
      if (active) return { now, row: active, issued: null };

      const latest = await repo.findLatest(client, email, purpose, now);
      if (latest?.cooldown_active) throw cooldownError(secondsUntil(latest.resend_available_at, now));
      const issued = await issueNew(client, { email, purpose, ip, now, previous: null });
      return { now, row: issued, issued };
    });

    if (result.issued) await dispatch(delivery, email, purpose, result.issued, context);
    return { ...state(result.row, result.now), alreadySent: !result.issued };
  }

  /** Explicit "Resend OTP": invalidates the pending code and issues a new one. */
  async function resend({ email, purpose = PURPOSE, ip, delivery = "await", context }) {
    email = normalizeEmail(email);
    const { now, issued } = await withTransaction(async (client) => {
      await repo.lockChallenge(client, email, purpose);
      const now = await currentTime(client);

      const active = await repo.findActive(client, email, purpose, now);
      if (!active) throw notFoundError();
      if (active.cooldown_active) throw cooldownError(secondsUntil(active.resend_available_at, now));

      return { now, issued: await issueNew(client, { email, purpose, ip, now, previous: active }) };
    });

    await dispatch(delivery, email, purpose, issued, context);
    return { ...state(issued, now), alreadySent: false };
  }

  /** Checks a code. A correct code is consumed and exchanged for a single-use verification token. */
  async function verify({ email, purpose = PURPOSE, code }) {
    email = normalizeEmail(email);
    const outcome = await withTransaction(async (client) => {
      await repo.lockChallenge(client, email, purpose);
      const now = await currentTime(client);

      const row = await repo.findActive(client, email, purpose, now);
      if (!row) return { fail: notFoundError() };
      // Neither of these consumes an attempt.
      if (row.is_expired) return { fail: expiredError() };
      if (row.attempts >= row.max_attempts) return { fail: tooManyAttemptsError() };

      const params = { otpId: row.id, email, purpose, code };
      if (!crypto.verifyCode(config.hmacSecret, row.code_hash, params)) {
        // Committed (not rolled back) so the failed attempt always counts.
        const attempts = await repo.incrementAttempts(client, row.id);
        const remaining = row.max_attempts - attempts;
        return { fail: remaining > 0 ? invalidCodeError(remaining) : tooManyAttemptsError() };
      }

      await repo.markVerified(client, row.id, now);
      const token = generateToken();
      await repo.insertToken(client, {
        otpId: row.id,
        email,
        purpose,
        tokenHash: crypto.hashToken(config.hmacSecret, { token, email, purpose }),
        createdAt: now,
        expiresAt: new Date(now.getTime() + config.verificationTokenTtlSeconds * MS),
      });
      return { token };
    });

    if (outcome.fail) throw outcome.fail;
    return {
      verified: true,
      verificationToken: outcome.token,
      verificationTokenExpiresInSeconds: config.verificationTokenTtlSeconds,
    };
  }

  /**
   * Spends a verification token using `q` (a pool, or a client inside the caller's
   * transaction). Returns { id, verifiedAt } exactly once, and only for the email
   * and purpose the token was issued to; otherwise null and nothing is changed.
   * If the caller's transaction rolls back, the token is NOT spent.
   */
  async function consumeVerificationTokenIn(q, { email, purpose = PURPOSE, token }) {
    if (typeof token !== "string" || token.length === 0 || token.length > 200) return null;
    email = normalizeEmail(email);
    return repo.consumeToken(q, {
      tokenHash: crypto.hashToken(config.hmacSecret, { token, email, purpose }),
      email,
      purpose,
      now: await currentTime(q),
    });
  }

  /** Standalone variant: true exactly once. */
  async function consumeVerificationToken(args) {
    return (await consumeVerificationTokenIn(db, args)) !== null;
  }

  return { send, resend, verify, consumeVerificationToken, consumeVerificationTokenIn };
}
