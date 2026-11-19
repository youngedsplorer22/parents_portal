import { withTransaction } from "../../db/transaction.js";
import { recordAudit } from "../staff/audit.js";
import { invalidAssigneeError, notFoundError, templateMismatchError, tripArchivedError, unknownTemplateError } from "./errors.js";
import { TEMPLATE_KEYS, UUID } from "./validation.js";

/**
 * Sales-to-trip assignments and portal bindings: DEVELOPER operations, run only by the command-line tool (scripts/ops.js).
 * There is no HTTP route for any of it. `actor` is the command's own identity ({ id: null, email: "cli:<user>" }) and is
 * only used to write the audit row. A Sales account reaches a trip's itinerary only while a row exists in
 * staff_trip_assignments; many Sales users may hold one trip and one Sales user may hold many trips.
 */
export function createItineraryOperations({ db }) {
  async function tripExists(q, tripId) {
    if (typeof tripId !== "string" || !UUID.test(tripId)) throw notFoundError();
    const { rows } = await q.query("SELECT id FROM trips WHERE id = $1", [tripId]);
    if (rows.length === 0) throw notFoundError();
  }

  async function listAssignments(actor, tripId) {
    await tripExists(db, tripId);
    const { rows } = await db.query(
      `SELECT a.staff_id, u.email_normalized AS email, u.display_name AS name, a.assigned_at
         FROM staff_trip_assignments a JOIN staff_users u ON u.id = a.staff_id WHERE a.trip_id = $1 ORDER BY u.display_name, u.email_normalized`,
      [tripId],
    );
    return rows.map((r) => ({ staffId: r.staff_id, email: r.email, name: r.name, tripId, assignedAt: r.assigned_at }));
  }

  async function assign(actor, tripId, staffId) {
    return withTransaction(db, async (client) => {
      await tripExists(client, tripId);
      if (typeof staffId !== "string" || !UUID.test(staffId)) throw notFoundError();
      const { rows: staff } = await client.query("SELECT id, role, disabled_at FROM staff_users WHERE id = $1", [staffId]);
      if (staff.length === 0) throw notFoundError();
      if (staff[0].role !== "sales") throw invalidAssigneeError("Only Sales accounts are assigned to trips. Admins can already reach every trip.");
      if (staff[0].disabled_at !== null) throw invalidAssigneeError("That account is deactivated.");
      const { rows } = await client.query(
        `INSERT INTO staff_trip_assignments (staff_id, trip_id, assigned_by) VALUES ($1, $2, $3)
         ON CONFLICT (staff_id, trip_id) DO NOTHING RETURNING assigned_at`,
        [staffId, tripId, actor.id],
      );
      if (rows.length > 0) await recordAudit(client, actor, "trip.assign_sales", "trip", tripId, { staffId });
      const { rows: now } = await client.query("SELECT assigned_at FROM staff_trip_assignments WHERE staff_id = $1 AND trip_id = $2", [staffId, tripId]);
      return { staffId, tripId, assignedAt: now[0].assigned_at };
    });
  }

  async function revoke(actor, tripId, staffId) {
    return withTransaction(db, async (client) => {
      await tripExists(client, tripId);
      if (typeof staffId !== "string" || !UUID.test(staffId)) throw notFoundError();
      const { rowCount } = await client.query("DELETE FROM staff_trip_assignments WHERE staff_id = $1 AND trip_id = $2", [staffId, tripId]);
      if (rowCount > 0) await recordAudit(client, actor, "trip.unassign_sales", "trip", tripId, { staffId });
      return { ok: true };
    });
  }

  // ---- portal bindings ----
  async function listDeployments(actor) {
    const { rows } = await db.query(
      `SELECT d.template_key, d.trip_id, d.bound_at, t.title, t.slug, t.status, s.name AS school_name, s.branch AS school_branch, s.slug AS school_slug, s.branch_slug
         FROM portal_deployments d JOIN trips t ON t.id = d.trip_id JOIN schools s ON s.id = t.school_id ORDER BY d.template_key`,
    );
    return rows.map((r) => ({
      templateKey: r.template_key, tripId: r.trip_id, tripTitle: r.title, tripStatus: r.status, schoolName: r.school_name, schoolBranch: r.school_branch ?? null,
      publicPath: `/join/${r.school_slug}/${r.branch_slug}/${r.slug}`, boundAt: r.bound_at,
    }));
  }

  /**
   * Makes `tripId` the one trip the template accepts new registrations for. The trip it replaces is closed and its public
   * page switched off, in the same transaction. Nothing is deleted: that trip, its registrations, enrolments, forms and PDFs stay.
   */
  async function bindDeployment(actor, templateKey, tripId) {
    if (!TEMPLATE_KEYS.includes(templateKey)) throw unknownTemplateError();
    return withTransaction(db, async (client) => {
      const { rows } = await client.query(
        "SELECT t.id, t.template_key, t.status, s.status AS school_status FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1 FOR UPDATE OF t",
        [tripId],
      );
      if (rows.length === 0) throw notFoundError();
      const trip = rows[0];
      if (trip.template_key !== templateKey) throw templateMismatchError();
      if (trip.status === "archived" || trip.school_status !== "active") throw tripArchivedError();
      const { rows: prev } = await client.query("SELECT trip_id FROM portal_deployments WHERE template_key = $1 FOR UPDATE", [templateKey]);
      const previousId = prev[0]?.trip_id ?? null;
      if (previousId && previousId !== tripId) {
        const { rows: old } = await client.query("SELECT status FROM trips WHERE id = $1 FOR UPDATE", [previousId]);
        if (old[0]?.status === "active") await client.query("UPDATE trips SET status = 'closed', updated_at = clock_timestamp() WHERE id = $1", [previousId]);
        await client.query("UPDATE trips SET public_registration = false, updated_at = clock_timestamp() WHERE id = $1", [previousId]);
        await recordAudit(client, actor, "trip.status_change", "trip", previousId, { from: old[0]?.status ?? null, to: old[0]?.status === "active" ? "closed" : (old[0]?.status ?? null), reason: "portal_rebound" });
      }
      await client.query(
        `INSERT INTO portal_deployments (template_key, trip_id, bound_by) VALUES ($1, $2, $3)
         ON CONFLICT (template_key) DO UPDATE SET trip_id = EXCLUDED.trip_id, bound_by = EXCLUDED.bound_by, bound_at = clock_timestamp()`,
        [templateKey, tripId, actor.id],
      );
      await recordAudit(client, actor, "portal.bind", "trip", tripId, { template: templateKey, previousTripId: previousId });
      return { templateKey, tripId, previousTripId: previousId };
    });
  }

  return { listAssignments, assign, revoke, listDeployments, bindDeployment };
}
