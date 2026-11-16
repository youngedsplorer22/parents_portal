import { withTransaction } from "../../db/transaction.js";
import { emailSchema } from "../email-otp/validation.js";
import { recordAudit } from "./audit.js";

export class BootstrapError extends Error {}

const cleanName = (name) => String(name ?? "").trim().replace(/\s+/g, " ");

/**
 * Creates the very first admin of a new (production) database, ONCE. Used only by scripts/bootstrap-admin.js; there is no
 * HTTP route. The account has NO password: its owner sets one at /admin/login with a code emailed to that address, so no
 * secret is ever typed, stored in an environment variable or printed.
 * Refused when any staff account exists (sales, disabled, anything). Runs under the same advisory lock as the other
 * provisioning, so concurrent runs create exactly one admin. The result, and any refusal, is written to audit_log.
 */
export async function bootstrapFirstAdmin(db, { email, name }) {
  const e = emailSchema.safeParse(email);
  if (!e.success) throw new BootstrapError("Enter a valid email address.");
  const n = cleanName(name);
  if (!n || n.length > 100 || /[\u0000-\u001f\u007f]/.test(n)) throw new BootstrapError("Enter a name of 1 to 100 characters.");

  let refused = false;
  try {
    return await withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
      const { rows: counts } = await client.query("SELECT count(*)::int AS total FROM staff_users");
      if (counts[0].total > 0) { refused = true; throw new BootstrapError("Staff accounts already exist, so the first-admin bootstrap is finished and cannot run again. Nothing was changed."); }
      const { rows } = await client.query(
        `INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ($1, $2, 'admin', NULL) RETURNING id`,
        [e.data, n],
      );
      await recordAudit(client, { id: rows[0].id, email: e.data }, "staff.bootstrap_admin", "staff", rows[0].id, { method: "cli", pending: true });
      return { id: rows[0].id, email: e.data, role: "admin", pending: true };
    });
  } catch (err) {
    if (refused) {
      // The refusal is a security-relevant event: keep a record of it (best effort; the refusal itself is what matters).
      await recordAudit(db, { id: null, email: e.data }, "staff.bootstrap_refused", "staff", null, { method: "cli", reason: "staff_exists" }).catch(() => {});
    }
    throw err;
  }
}
