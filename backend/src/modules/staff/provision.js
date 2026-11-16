import { withTransaction } from "../../db/transaction.js";
import { emailSchema } from "../email-otp/validation.js";
import { passwordSchema } from "../auth/password.js";

export const ROLES = ["admin", "sales"];
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
 * Creates a staff account. Used only by the local provisioning script (backend/scripts/staff.js);
 * there is no HTTP route for it. Guards against uncontrolled admins:
 *  - everything runs under one advisory lock, so two runs can't race;
 *  - an existing email is refused (never silently overwritten);
 *  - the FIRST account must be an admin, and the first admin needs no flag;
 *  - any further admin needs allowAdditionalAdmin: true (the script asks for a typed confirmation).
 *  - `pending: true` adds the account with no password; the owner then sets it by emailed code.
 */
export async function createStaff(db, passwords, { email, name, role, password, allowAdditionalAdmin = false, pending = false }) {
  const v = validate({ email, name, role, password: pending ? undefined : password });
  // `pending` creates the account WITHOUT a password: its owner sets it by emailed code. A password
  // supplied together with `pending` is a mistake, never silently ignored.
  if (pending && password !== undefined) throw new ProvisionError("A pending account has no password: its owner sets it by email.");
  if (!pending && password === undefined) throw new ProvisionError("A password is required.");
  const hash = pending ? null : await passwords.hash(password);

  return withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
    const { rows: counts } = await client.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE role = 'admin')::int AS admins FROM staff_users",
    );
    if (counts[0].total === 0 && role !== "admin") {
      throw new ProvisionError("The first staff account must be an admin.");
    }
    if (role === "admin" && counts[0].admins > 0 && !allowAdditionalAdmin) {
      throw new ProvisionError("An admin already exists. Creating another admin needs the explicit additional-admin confirmation.");
    }
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
      if (rows[0].role === "admin") {
        const { rows: left } = await client.query(
          "SELECT count(*)::int AS n FROM staff_users WHERE role = 'admin' AND disabled_at IS NULL",
        );
        if (left[0].n === 0) throw new ProvisionError("That would leave no active admin.");
      }
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
