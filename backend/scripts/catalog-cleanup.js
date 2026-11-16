// Review, and only if explicitly confirmed remove, schools and trips created for testing.
// There is deliberately NO HTTP endpoint for this. It works on the local development database only.
//
//   npm run catalog:cleanup                       review (read only): every school and trip, and what depends on it
//   npm run catalog:cleanup -- review --json      the same, as JSON
//   npm run catalog:cleanup -- remove-trip <id> --by <admin email>             dry run: what would be removed
//   npm run catalog:cleanup -- remove-trip <id> --by <admin email> --confirm   remove it (only if nothing depends on it)
//   npm run catalog:cleanup -- remove-school <id> --by <admin email> [--confirm]  a school and its trips, all or nothing
//
// Anything with registrations, forms, signatures or retired-link history is refused, never cascaded. Take and verify a
// backup first. Uses DATABASE_URL from backend/.env and refuses any database other than local parents_portal_dev.
import pg from "pg";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { CleanupRefusedError, removeSchool, removeTrip, reviewCatalog } from "../src/modules/catalog/cleanup.js";

export const TARGET_DB = "parents_portal_dev";

export function assertCleanupTarget(connectionString) {
  assertLocalDatabaseUrl(connectionString);
  const name = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (name !== TARGET_DB) throw new Error(`Refusing: this cleanup only runs against ${TARGET_DB} (got "${name}").`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function formatReview(schools) {
  const lines = [];
  for (const s of schools) {
    lines.push(`SCHOOL ${s.name}${s.branch ? ` (${s.branch})` : ""}  id=${s.id}  status=${s.status}  created=${day(s.createdAt)} by ${s.createdBy ?? "unknown"}  logo=${s.hasLogo ? "yes" : "no"}  audit entries=${s.auditEntries}`);
    lines.push(`  -> ${s.removable ? "could be removed (with its trips)" : "NOT removable: " + s.blockers.join(" | ")}`);
    for (const t of s.trips) {
      const d = t.dependencies;
      lines.push(`  TRIP ${t.title}  id=${t.id}  ${t.tourType}/${t.status}${t.publicRegistration ? "/public" : ""}  created=${day(t.createdAt)}`);
      lines.push(`       registrations=${d.enrolments} accounts=${d.registrations} forms=${d.forms} submitted=${d.submitted} signed=${d.signed} links=${d.links} audit entries=${d.auditEntries}`);
      lines.push(`       -> ${t.removable ? "could be removed" : "NOT removable: " + t.blockers.join("; ")}`);
    }
  }
  return lines.join("\n");
}

async function adminActor(db, email) {
  if (!email) throw new Error("Pass --by <admin email>: the admin running the cleanup is recorded in the audit log.");
  const { rows } = await db.query("SELECT id, email_normalized AS email, role, disabled_at FROM staff_users WHERE email_normalized = lower($1)", [email]);
  if (!rows[0] || rows[0].role !== "admin" || rows[0].disabled_at) throw new Error("--by must be an active admin account.");
  return { id: rows[0].id, email: rows[0].email, role: "admin" };
}

export async function main(argv, { env = process.env, out = console.log, makePool = (cs) => new pg.Pool({ connectionString: cs, max: 2 }) } = {}) {
  assertCleanupTarget(env.DATABASE_URL);
  const [command = "review", id] = argv;
  const flag = (name) => argv.includes(name);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const db = makePool(env.DATABASE_URL);
  try {
    const schools = await reviewCatalog(db);
    if (command === "review") {
      out(flag("--json") ? JSON.stringify(schools, null, 2) : formatReview(schools));
      return 0;
    }
    if (!["remove-trip", "remove-school"].includes(command)) throw new Error(`Unknown command "${command}".`);
    if (!UUID.test(id ?? "")) throw new Error("Give the id of the school or trip (from the review).");
    const actor = await adminActor(db, value("--by"));
    const school = command === "remove-school" ? schools.find((s) => s.id === id) : null;
    const trip = command === "remove-trip" ? schools.flatMap((s) => s.trips).find((t) => t.id === id) : null;
    if (!school && !trip) throw new Error("No such record.");
    const target = school ?? trip;
    out(command === "remove-school"
      ? `Would remove school "${school.name}" and ${school.trips.length} trip(s): ${school.trips.map((t) => t.title).join(", ") || "none"}.`
      : `Would remove trip "${trip.title}".`);
    if (!target.removable) {
      out(`Refused: ${target.blockers.join(" | ")}`);
      return 2;
    }
    if (!flag("--confirm")) {
      out("Dry run only. Nothing was changed. Add --confirm to remove it.");
      return 0;
    }
    if (command === "remove-trip") await removeTrip(db, actor, id);
    else await removeSchool(db, actor, id);
    out("Removed. The audit log keeps its history and records this removal.");
    return 0;
  } catch (err) {
    if (err instanceof CleanupRefusedError) {
      out(`Refused: ${err.message} ${err.blockers.join(" | ")}`);
      return 2;
    }
    throw err;
  } finally {
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
