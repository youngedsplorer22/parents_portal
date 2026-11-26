import { withTransaction } from "../../db/transaction.js";
import { recordAudit } from "../staff/audit.js";
import { templateMismatchError, tripArchivedError, unknownTemplateError } from "./errors.js";
import { TEMPLATE_KEYS, UUID } from "./validation.js";

/**
 * Portal bindings: DEVELOPER operations, run only by the command-line tool (scripts/ops.js).
 * There is no HTTP route for any of it. `actor` is the command's own identity ({ id: null, email: "cli:<user>" }) and is
 * only used to write the audit row. All active Sales accounts reach a trip's itinerary through the portal deployment that
 * names it; no per-user assignment is needed or recorded.
 */
export function createItineraryOperations({ db }) {
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

  return { listDeployments, bindDeployment };
}
