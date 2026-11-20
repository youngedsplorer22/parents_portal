import { z } from "zod";
import { withTransaction } from "../../db/transaction.js";
import { AppError } from "../email-otp/errors.js";
import { emailSchema } from "../email-otp/validation.js";
import { recordAudit } from "./audit.js";

const UNIQUE_VIOLATION = "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new AppError(404, "NOT_FOUND", "Not found.");
const staffExists = () => new AppError(409, "STAFF_EXISTS", "A staff account with that email already exists.");
const staffProtected = () =>
  new AppError(409, "STAFF_PROTECTED", "Admin accounts can't be changed here. They are managed with the command-line tool.");

/**
 * Sales accounts only, by design. Anything about the role other than "sales" is refused: an admin is
 * created and changed only with the command-line tool (backend/scripts/staff.js) or by IT in SQL.
 *
 * There is NO password here. The row is created "pending": its owner chooses the password
 * themselves by emailed code (password-service.js), so nobody else ever knows it. Any password
 * field in the request is refused (the schema is strict).
 */
export const staffCreateSchema = z
  .strictObject({
    email: emailSchema,
    name: z
      .string({ error: "Name is required." })
      .trim()
      .min(1, "Name is required.")
      .max(100, "Name must be 100 characters or fewer.")
      .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Name contains invalid characters.")
      .transform((s) => s.replace(/\s+/g, " ")),
    role: z.literal("sales", { error: "Only sales accounts can be created here." }).optional(),
  })
  .transform(({ role, ...rest }) => rest);

export const staffActiveSchema = z.strictObject({ active: z.boolean({ error: "Choose active or inactive." }) });

// status: "inactive" (deactivated), "pending" (no password chosen yet) or "active". The hash itself is
// never selected, only whether one exists.
const COLUMNS = "id, email_normalized, display_name, role, disabled_at, created_at, (password_hash IS NULL) AS pending";
const view = (r) => ({
  id: r.id,
  email: r.email_normalized,
  name: r.display_name,
  role: r.role,
  status: r.disabled_at !== null ? "inactive" : r.pending ? "pending" : "active",
  createdAt: r.created_at,
});

/** Staff management for the admin panel. `actor` is always req.staff, never request input. */
export function createStaffManagement({ db }) {
  async function list() {
    const { rows } = await db.query(
      `SELECT ${COLUMNS}
         FROM staff_users ORDER BY (role = 'admin') DESC, lower(display_name), email_normalized LIMIT 500`,
    );
    return rows.map(view);
  }

  async function createSales(actor, { email, name }) {
    return withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
      try {
        const { rows } = await client.query(
          `INSERT INTO staff_users (email_normalized, display_name, role)
           VALUES ($1, $2, 'sales')
           RETURNING ${COLUMNS}`,
          [email, name],
        );
        await recordAudit(client, actor, "staff.create", "staff", rows[0].id, { email, role: "sales" });
        return view(rows[0]);
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) throw staffExists();
        throw err;
      }
    });
  }

  /** Deactivating also ends that person's sessions at once. Only sales accounts can be changed. */
  async function setActive(actor, id, active) {
    if (!UUID.test(id)) throw notFound();
    return withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staff-provisioning', 0))");
      const { rows: found } = await client.query("SELECT id, role FROM staff_users WHERE id = $1 FOR UPDATE", [id]);
      if (!found[0]) throw notFound();
      if (found[0].role !== "sales" || found[0].id === actor.id) throw staffProtected();
      const { rows } = await client.query(
        `UPDATE staff_users
            SET disabled_at = CASE WHEN $2 THEN NULL ELSE COALESCE(disabled_at, clock_timestamp()) END,
                changed_at = clock_timestamp()
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [id, active],
      );
      if (!active) await client.query("UPDATE staff_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'deactivated' WHERE staff_id = $1 AND revoked_at IS NULL", [id]);
      await recordAudit(client, actor, active ? "staff.activate" : "staff.deactivate", "staff", id, { email: rows[0].email_normalized });
      return view(rows[0]);
    });
  }

  return { list, createSales, setActive };
}
