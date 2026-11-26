// Reviewing and removing schools and trips created for testing. Used by scripts/catalog-cleanup.js only; there is no
// HTTP endpoint for it.
//
// The review is READ ONLY: it lists every school and trip with what depends on it. A trip can be removed only when
// nothing a parent created points at it: no registration (trip_enrolments or parent_registrations.trip_id), no form,
// and no retired link row (trip_links is audit history). A school can be removed only when every one of its trips can
// be (they are removed with it, in the same transaction). Anything else is refused, never cascaded.
//
// Removal re-checks everything inside the transaction with the rows locked, so a registration made between the review
// and the removal blocks it. audit_log has no foreign key to schools or trips, so the history of a removed record is
// kept; the removal itself is recorded there too.
import { withTransaction } from "../../db/transaction.js";
import { recordAudit } from "../staff/audit.js";

export class CleanupRefusedError extends Error {
  constructor(message, blockers = []) {
    super(message);
    this.name = "CleanupRefusedError";
    this.blockers = blockers;
  }
}

const TRIP_DEPENDENCIES = `
  (SELECT count(*)::int FROM trip_enrolments e WHERE e.trip_id = t.id) AS enrolments,
  (SELECT count(*)::int FROM parent_registrations r WHERE r.trip_id = t.id) AS registrations,
  (SELECT count(*)::int FROM onboarding_forms f JOIN trip_enrolments e ON e.id = f.enrolment_id WHERE e.trip_id = t.id) AS forms,
  (SELECT count(*)::int FROM onboarding_forms f JOIN trip_enrolments e ON e.id = f.enrolment_id
     WHERE e.trip_id = t.id AND f.status = 'submitted') AS submitted,
  (SELECT count(*)::int FROM onboarding_forms f JOIN trip_enrolments e ON e.id = f.enrolment_id
     WHERE e.trip_id = t.id AND f.signature_name IS NOT NULL) AS signed,
  (SELECT count(*)::int FROM trip_links l WHERE l.trip_id = t.id) AS links,
  (SELECT count(*)::int FROM trip_itinerary_items i WHERE i.trip_id = t.id) AS itinerary_items,
  (SELECT count(*)::int FROM portal_deployments d WHERE d.trip_id = t.id) AS bound,
  (SELECT count(*)::int FROM audit_log a WHERE a.entity_type = 'trip' AND a.entity_id = t.id::text) AS audit_entries`;

/** Why a trip can't be removed (empty when it can). */
export function tripBlockers(d) {
  const out = [];
  if (d.enrolments) out.push(`${d.enrolments} trip registration(s)`);
  if (d.registrations) out.push(`${d.registrations} parent account(s) registered through it`);
  if (d.forms) out.push(`${d.forms} form(s), ${d.submitted} submitted, ${d.signed} signed`);
  if (d.links) out.push(`${d.links} retired link record(s) (history)`);
  if (d.itineraryItems) out.push(`${d.itineraryItems} itinerary item(s)`);
  if (d.bound) out.push("it is the trip bound to a portal");
  return out;
}

const tripView = (r) => {
  const dependencies = {
    enrolments: r.enrolments, registrations: r.registrations, forms: r.forms, submitted: r.submitted,
    signed: r.signed, links: r.links, itineraryItems: r.itinerary_items, bound: r.bound, auditEntries: r.audit_entries,
  };
  const blockers = tripBlockers(dependencies);
  return {
    id: r.id, schoolId: r.school_id, title: r.title, destination: r.destination, tourType: r.tour_type, status: r.status,
    publicRegistration: r.public_registration, createdAt: r.created_at, dependencies, removable: blockers.length === 0, blockers,
  };
};

/** Every school with its trips and what depends on them. Read only. */
export async function reviewCatalog(db) {
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows: schools } = await client.query(
      `SELECT s.id, s.name, s.branch, s.status, s.created_at, st.email_normalized AS created_by,
              (SELECT count(*)::int FROM school_logos l WHERE l.school_id = s.id) AS logo,
              (SELECT count(*)::int FROM audit_log a WHERE a.entity_type = 'school' AND a.entity_id = s.id::text) AS audit_entries
         FROM schools s LEFT JOIN staff_users st ON st.id = s.created_by
        ORDER BY s.created_at, s.id`,
    );
    const { rows: trips } = await client.query(`SELECT t.*, ${TRIP_DEPENDENCIES} FROM trips t ORDER BY t.created_at, t.id`);
    await client.query("COMMIT");
    const byId = new Map(schools.map((s) => [s.id, { ...s, trips: [] }]));
    for (const t of trips) byId.get(t.school_id)?.trips.push(tripView(t));
    return [...byId.values()].map((s) => {
      const blocked = s.trips.filter((t) => !t.removable);
      return {
        id: s.id, name: s.name, branch: s.branch, status: s.status, createdAt: s.created_at, createdBy: s.created_by,
        hasLogo: s.logo > 0, auditEntries: s.audit_entries, trips: s.trips,
        removable: blocked.length === 0,
        blockers: blocked.map((t) => `trip "${t.title}": ${t.blockers.join("; ")}`),
      };
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Locks the trip and checks it again inside `client`'s transaction; throws CleanupRefusedError if anything depends on it. */
async function assertTripRemovable(client, tripId) {
  const { rows } = await client.query(`SELECT t.*, ${TRIP_DEPENDENCIES} FROM trips t WHERE t.id = $1 FOR UPDATE`, [tripId]);
  if (!rows[0]) throw new CleanupRefusedError("That trip doesn't exist.");
  // Lock out new registrations for this trip until we commit (they need the trip row FOR SHARE).
  const trip = tripView(rows[0]);
  if (!trip.removable) throw new CleanupRefusedError(`Trip "${trip.title}" has linked data and was not removed.`, trip.blockers);
  return trip;
}

/** Removes one trip that nothing depends on. `actor` is the admin running the cleanup (recorded in the audit log). */
export async function removeTrip(db, actor, tripId) {
  return withTransaction(db, async (client) => {
    const trip = await assertTripRemovable(client, tripId);
    await client.query("DELETE FROM trips WHERE id = $1", [tripId]);
    await recordAudit(client, actor, "trip.delete", "trip", tripId, { title: trip.title, schoolId: trip.schoolId, reason: "test data cleanup" });
    return trip;
  });
}

/** Removes a school and its trips, only if every one of those trips can be removed. All or nothing. */
export async function removeSchool(db, actor, schoolId) {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT id, name, branch FROM schools WHERE id = $1 FOR UPDATE", [schoolId]);
    if (!rows[0]) throw new CleanupRefusedError("That school doesn't exist.");
    const school = rows[0];
    const { rows: tripIds } = await client.query("SELECT id FROM trips WHERE school_id = $1 ORDER BY created_at, id", [schoolId]);
    const blockers = [];
    const removed = [];
    for (const { id } of tripIds) {
      try {
        removed.push(await assertTripRemovable(client, id));
      } catch (err) {
        if (!(err instanceof CleanupRefusedError)) throw err;
        blockers.push(`${err.message} ${err.blockers.join("; ")}`.trim());
      }
    }
    if (blockers.length) throw new CleanupRefusedError(`School "${school.name}" has trips with linked data and was not removed.`, blockers);
    for (const t of removed) {
      await client.query("DELETE FROM trips WHERE id = $1", [t.id]);
      await recordAudit(client, actor, "trip.delete", "trip", t.id, { title: t.title, schoolId, reason: "test data cleanup" });
    }
    await client.query("DELETE FROM school_logos WHERE school_id = $1", [schoolId]);
    await client.query("DELETE FROM schools WHERE id = $1", [schoolId]);
    await recordAudit(client, actor, "school.delete", "school", schoolId, { name: school.name, branch: school.branch, trips: removed.length, reason: "test data cleanup" });
    return { school, trips: removed };
  });
}
