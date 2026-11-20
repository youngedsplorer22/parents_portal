import { withTransaction } from "../../db/transaction.js";
import { forbiddenError } from "../staff/errors.js";
import { recordAudit } from "../staff/audit.js";
import { notFoundError } from "./errors.js";
import { UUID } from "./validation.js";

const itemView = (r) => ({
  id: r.id,
  tripId: r.trip_id,
  dayNumber: r.day_number,
  position: r.position,
  title: r.title,
  details: r.details,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const ITEM_COLUMNS = "id, trip_id, day_number, position, title, details, created_at, updated_at";

/**
 * The itinerary, for Sales. Who may do what is decided HERE, from req.staff (set by requireStaff, never from the request):
 * a Sales user may read and write the itinerary of a trip a developer assigned to them (staff_trip_assignments), and
 * nothing else. A Sales user asking for a trip they are not assigned to (or one that does not exist) gets the same 403,
 * so the answer does not reveal which trips exist. (Assignments and portal bindings are developer commands: operations.js.)
 */
export function createItineraryService({ db }) {
  /** Throws unless `actor` is a Sales user assigned to this trip. Unknown, malformed and unassigned all give the same 403. */
  async function authorizeTrip(q, actor, tripId) {
    if (actor?.role !== "sales" || typeof tripId !== "string" || !UUID.test(tripId)) throw forbiddenError();
    const { rows } = await q.query("SELECT 1 FROM staff_trip_assignments WHERE staff_id = $1 AND trip_id = $2", [actor.id, tripId]);
    if (rows.length === 0) throw forbiddenError();
  }

  async function listTrips(actor) {
    if (actor?.role !== "sales") throw forbiddenError();
    const { rows } = await db.query(
      `SELECT t.id, t.title, t.destination, t.academic_year, t.tour_type, t.status, s.name AS school_name, s.branch AS school_branch,
              (SELECT count(*)::int FROM trip_itinerary_items i WHERE i.trip_id = t.id) AS itinerary_count
         FROM trips t JOIN schools s ON s.id = t.school_id
         JOIN staff_trip_assignments a ON a.trip_id = t.id AND a.staff_id = $1
        ORDER BY s.name, t.created_at DESC, t.id LIMIT 500`,
      [actor.id],
    );
    return rows.map((r) => ({
      id: r.id, title: r.title, destination: r.destination, academicYear: r.academic_year, tourType: r.tour_type, status: r.status,
      schoolName: r.school_name, schoolBranch: r.school_branch ?? null, itineraryCount: r.itinerary_count,
    }));
  }

  async function listItems(actor, tripId) {
    await authorizeTrip(db, actor, tripId);
    const { rows } = await db.query(`SELECT ${ITEM_COLUMNS} FROM trip_itinerary_items WHERE trip_id = $1 ORDER BY day_number, position, created_at, id`, [tripId]);
    return rows.map(itemView);
  }

  async function addItem(actor, tripId, input) {
    return withTransaction(db, async (client) => {
      await authorizeTrip(client, actor, tripId);
      const { rows } = await client.query(
        `INSERT INTO trip_itinerary_items (trip_id, day_number, position, title, details, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${ITEM_COLUMNS}`,
        [tripId, input.dayNumber, input.position ?? 0, input.title, input.details ?? null, actor.id],
      );
      await recordAudit(client, actor, "itinerary.create", "trip", tripId, { itemId: rows[0].id, day: input.dayNumber });
      return itemView(rows[0]);
    });
  }

  async function updateItem(actor, tripId, itemId, patch) {
    return withTransaction(db, async (client) => {
      await authorizeTrip(client, actor, tripId);
      if (typeof itemId !== "string" || !UUID.test(itemId)) throw notFoundError();
      // The item must belong to THIS trip: the trip in the URL is what was authorised.
      const { rows: found } = await client.query("SELECT * FROM trip_itinerary_items WHERE id = $1 AND trip_id = $2 FOR UPDATE", [itemId, tripId]);
      if (found.length === 0) throw notFoundError();
      const cur = found[0];
      const next = {
        day: patch.dayNumber ?? cur.day_number,
        pos: patch.position ?? cur.position,
        title: patch.title ?? cur.title,
        details: patch.details !== undefined ? patch.details : cur.details,
      };
      const { rows } = await client.query(
        `UPDATE trip_itinerary_items SET day_number = $2, position = $3, title = $4, details = $5, updated_by = $6, updated_at = clock_timestamp()
          WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
        [itemId, next.day, next.pos, next.title, next.details, actor.id],
      );
      await recordAudit(client, actor, "itinerary.update", "trip", tripId, { itemId });
      return itemView(rows[0]);
    });
  }

  return { listTrips, listItems, addItem, updateItem };
}
