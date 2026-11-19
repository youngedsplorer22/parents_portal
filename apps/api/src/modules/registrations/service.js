import { withTransaction } from "../../db/transaction.js";
import { AppError } from "../email-otp/errors.js";
import { emailAlreadyRegisteredError, verificationRequiredError } from "./errors.js";
import { insertEnrolment } from "../enrolments/repository.js";
import * as repo from "./repository.js";

const PURPOSE = "registration";
const UNIQUE_VIOLATION = "23505";

/**
 * Creates a registration, authorised by a single-use email verification token.
 *
 * Everything happens in ONE transaction:
 *   1. spend the token (bound to this email + purpose; atomic, so only one
 *      concurrent request can win it);
 *   2. insert the registration.
 * If either step fails, both roll back: a failed insert never burns the token.
 *
 * From a trip's public page (publicTrip: its school, branch and trip words) the account is tied to that trip and the
 * school name comes from the trip's school, checked in the same transaction (public, active, open). Without one it behaves exactly as before.
 *
 * The password is hashed (scrypt) and stored in the same transaction; the plain
 * password is never stored or logged.
 *
 * The new account's login session is created in the same transaction, so the
 * person who just proved control of the email continues straight into the
 * onboarding form, and a failed registration never leaves a session behind.
 *
 * The token is spent first on purpose. Checking for a duplicate email before
 * the token would let anyone probe which emails are registered; this way only
 * someone who just proved control of the email can learn it is already taken.
 */
export function createRegistrationService({ db, emailOtp, sessions, passwords, catalog }) {
  async function register({ fields: { password, ...fields }, verificationToken, publicTrip, ip, portal = null }) {
    // A place for the hashing is taken before the transaction: a busy server (SERVER_BUSY) never uses up the token.
    const ticket = passwords.reserve();
    try {
      return await registerWith(ticket, { password, fields, verificationToken, publicTrip, ip, portal });
    } finally {
      ticket.release();
    }
  }

  function registerWith(ticket, { password, fields, verificationToken, publicTrip, ip, portal }) {
    return withTransaction(db, async (client) => {
      const token = await emailOtp.consumeVerificationTokenIn(client, {
        email: fields.email,
        purpose: PURPOSE,
        token: verificationToken,
      });
      if (!token) throw verificationRequiredError();

      // A trip address that was sent but is wrong is an error, never silently ignored (that would register the parent
      // with no school). Checked inside the same transaction: an unknown, private or closed trip rolls everything back,
      // so it never burns the email verification either.
      // With PORTAL_BINDING_REQUIRED on (production), a new account is created only from a trip's page: a sign-up with no
      // trip would belong to no school. (A returning parent signs in; that is a different route.)
      if (publicTrip === undefined && (catalog?.requiresPortalBinding || portal)) {
        throw new AppError(400, "TRIP_REQUIRED", "Please register from your school's registration link.");
      }
      const trip = publicTrip !== undefined ? await catalog.resolvePublicTripForRegistration(client, publicTrip, { portal }) : null;

      // After the token check on purpose: a request without a valid token costs no hashing.
      const passwordHash = await passwords.hash(password, { ticket });

      try {
        const row = await repo.insertRegistration(client, {
          ...fields,
          verifiedAt: token.verifiedAt,
          tokenId: token.id,
          ip: ip ?? null,
          schoolName: trip?.schoolName,
          tripId: trip?.tripId,
        });
        await repo.insertPasswordCredential(client, row.id, passwordHash);
        if (trip) await insertEnrolment(client, { registrationId: row.id, tripId: trip.tripId });
        const session = await sessions.createSessionIn(client, row.id);
        return { id: row.id, email: fields.email, createdAt: row.created_at, session };
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) {
          if (err.constraint === "parent_registrations_email_key") throw emailAlreadyRegisteredError();
          if (err.constraint === "parent_registrations_token_key") throw verificationRequiredError();
        }
        throw err; // anything else becomes a generic 500; the transaction rolls back
      }
    });
  }

  return { register };
}
