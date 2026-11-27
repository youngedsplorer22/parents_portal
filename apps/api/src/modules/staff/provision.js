import { withTransaction } from "../../db/transaction.js";
import { emailSchema } from "../email-otp/validation.js";
import { passwordSchema } from "../auth/password.js";

// Sales is the only staff role that can be created or can sign in. There is no admin account, no admin login and no admin
// portal: school, trip, assignment and portal operations are developer commands (scripts/ops.js).
export const ROLES = ["sales"];
const UNIQUE_VIOLATION = "23505";

export class ProvisionError extends Error {}

const cleanName = (name) => String(name ?? "").trim().replace(/\s+/g, " ");

function validate({ email, name, role, password }) {
  const e = emailSchema.safeParse(email);
  if (!e.success) throw new ProvisionError("Enter a valid email address.");
  const n = cleanName(name);
  if (!n || n.length > 100 || /[\u0000-\u001f\u007f]/.test(n)) throw new ProvisionError("Enter a name of 1 to 100 characters.");
  if (!ROLES.includes(role)) throw new ProvisionError(`Role must be one of: ${ROLES.join(", ")}.`);
  if (password !== undefined) {
    const p = passwordSchema.safeParse(password);
    if (!p.success) throw new ProvisionError(p.error.issues[0].message);
  }
  return { email: e.data, name: n };
}

/**
 * Creates a SALES staff account. Used by the developer commands (scripts/ops.js, scripts/staff.js); there is no HTTP route
 * for it. This is the allowlist: only an account created here can ever sign in or set a password.
 *  - everything runs under one advisory lock, so two runs can't race;
 *  - an existing email is refused (never silently overwritten);
 *  - `pending: true` adds the account with no password; the owner then sets it by emailed code (the usual way).
 */
export async function createStaff(db, passwords, { email, name, role = "sales", password, pending = false }) {
  const v = validate({ email, name, role, password: pending ? undefined : password });
  // `pending` creates the account WITHOUT a password: its owner sets it by emailed code. A password
  // supplied together with `pending` is a mistake, never silently ignored.
  if (pending && password !== undefined) throw new ProvisionError("A pending account has no password: its owner sets it by email.");
  if (!pending && password === undefined) throw new ProvisionError("A password is required.");
  const hash = pending ? null : await passwords.hash(password);

  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
    try {
      const { rows } = await client.query(
        `INSERT INTO staff_users (email_normalized, display_name, role, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [v.email, v.name, role, hash],
      );
      return { id: rows[0].id, email: v.email, role, pending };
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) throw new ProvisionError("A staff account with that email already exists.");
      throw err;
    }
  });
}

/** Disables or re-enables an account, and ends its sessions when disabling. */
export async function setStaffDisabled(db, { email, disabled }) {
  const e = emailSchema.safeParse(email);
  if (!e.success) throw new ProvisionError("Enter a valid email address.");
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
    const { rows } = await client.query(
      `UPDATE staff_users SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, clock_timestamp()) ELSE NULL END
        WHERE email_normalized = $1 RETURNING id, role`,
      [e.data, disabled],
    );
    if (!rows[0]) throw new ProvisionError("No staff account with that email.");
    if (disabled) {
      await client.query("UPDATE staff_sessions SET revoked_at = clock_timestamp() WHERE staff_id = $1 AND revoked_at IS NULL", [rows[0].id]);
    }
    return { email: e.data, disabled };
  });
}

/** Sets a new password and ends the account's sessions. */
export async function setStaffPassword(db, passwords, { email, password }) {
  const e = emailSchema.safeParse(email);
  if (!e.success) throw new ProvisionError("Enter a valid email address.");
  const p = passwordSchema.safeParse(password);
  if (!p.success) throw new ProvisionError(p.error.issues[0].message);
  const hash = await passwords.hash(password);
  return withTransaction(db, async (client) => {
    const { rows } = await client.query(
      "UPDATE staff_users SET password_hash = $2, changed_at = clock_timestamp() WHERE email_normalized = $1 RETURNING id",
      [e.data, hash],
    );
    if (!rows[0]) throw new ProvisionError("No staff account with that email.");
    await client.query("UPDATE staff_sessions SET revoked_at = clock_timestamp() WHERE staff_id = $1 AND revoked_at IS NULL", [rows[0].id]);
    return { email: e.data };
  });
}

/**
 * The old admin accounts (role 'admin'), which the product no longer has. Returns what deleting them would touch; with
 * `apply: true` it deletes them, and everything that existed only for them. ONLY rows with role 'admin' are ever selected, so a
 * Sales account, a school, a trip, a registration, a payment record, an itinerary, a PDF or a Google Drive record is never deleted.
 *
 * Deleted (apply):
 *  - the admin accounts (staff_users, role 'admin');
 *  - their sign-in sessions (staff_sessions: ON DELETE CASCADE);
 *  - their unused "set password" email codes and verification tokens (email_otps / email_verification_tokens, purpose
 *    'staff_password', for those addresses), and their sign-in attempt counters (staff_login_attempts);
 *  - the audit_log rows THEY wrote (staff_id or staff_email is theirs). audit_log is append-only (a trigger refuses UPDATE and
 *    DELETE), so the trigger is switched off for this one DELETE, inside this transaction, and switched back on straight after:
 *    if anything fails the whole transaction rolls back and the trigger is untouched. Audit rows written by Sales people or by
 *    the developer commands are kept.
 * Nullified, never deleted (declared ON DELETE SET NULL in the migrations; the row stays, only the pointer goes):
 *  schools.created_by, trips.created_by, trip_links.created_by / revoked_by, school_logos.updated_by,
 *  trip_live_locations.assigned_by, trip_itinerary_items.created_by / updated_by,
 *  portal_deployments.bound_by.
 * One audit row is then written with only a count: no admin address is kept anywhere.
 */
export async function removeAdminAccounts(db, { apply = false, actor }) {
  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
    const { rows: admins } = await client.query("SELECT id, email_normalized AS email FROM staff_users WHERE role = 'admin' ORDER BY created_at, id FOR UPDATE");
    const ids = admins.map((a) => a.id);
    const emails = admins.map((a) => a.email);
    const count = async (sql, params) => (await client.query(sql, params)).rows[0].n;
    const none = ids.length === 0;
    const report = {
      admins: emails,
      sessions: none ? 0 : await count("SELECT count(*)::int n FROM staff_sessions WHERE staff_id = ANY($1)", [ids]),
      loginAttempts: none ? 0 : await count("SELECT count(*)::int n FROM staff_login_attempts WHERE email_normalized = ANY($1)", [emails]),
      setupCodes: none ? 0 : await count("SELECT count(*)::int n FROM email_otps WHERE email_normalized = ANY($1) AND purpose = 'staff_password'", [emails]),
      auditRows: none ? 0 : await count("SELECT count(*)::int n FROM audit_log WHERE staff_id = ANY($1) OR staff_email = ANY($2)", [ids, emails]),
      schoolsNamingThem: none ? 0 : await count("SELECT count(*)::int n FROM schools WHERE created_by = ANY($1)", [ids]),
      tripsNamingThem: none ? 0 : await count("SELECT count(*)::int n FROM trips WHERE created_by = ANY($1)", [ids]),
      applied: false,
    };
    if (!apply || none) return report;
    await client.query("DELETE FROM email_otps WHERE email_normalized = ANY($1) AND purpose = 'staff_password'", [emails]);
    await client.query("DELETE FROM email_verification_tokens WHERE email_normalized = ANY($1) AND purpose = 'staff_password'", [emails]);
    await client.query("DELETE FROM staff_login_attempts WHERE email_normalized = ANY($1)", [emails]);
    try {
      await client.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update");
    } catch (err) {
      if (err?.code === "42501") throw new ProvisionError("This database user does not own audit_log, so the old admin audit rows cannot be removed. Nothing was changed. Run this with the database owner's connection.");
      throw err;
    }
    await client.query("DELETE FROM audit_log WHERE staff_id = ANY($1) OR staff_email = ANY($2)", [ids, emails]);
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update");
    await client.query("DELETE FROM staff_users WHERE id = ANY($1) AND role = 'admin'", [ids]);
    await client.query(
      `INSERT INTO audit_log (staff_id, staff_email, action, entity_type, entity_id, details)
       VALUES (NULL, $1, 'staff.remove_admins', 'staff', NULL, $2::jsonb)`,
      [actor.email, JSON.stringify({ count: ids.length })],
    );
    return { ...report, applied: true };
  });
}
