import { createCatalogService } from "../modules/catalog/service.js";
import { normalizeSchoolName, tripCreateSchema } from "../modules/catalog/validation.js";
import { listAudit } from "../modules/staff/audit.js";
import { createStaffManagement, staffCreateSchema } from "../modules/staff/management.js";
import { ProvisionError, removeAdminAccounts, setStaffDisabled } from "../modules/staff/provision.js";
import { createItineraryOperations } from "../modules/itinerary/operations.js";
import { TEMPLATE_KEYS } from "../modules/itinerary/validation.js";

// The developer's command-line tool for everything that is NOT a screen: schools, trips, the portal each trip is deployed on,
// which Sales accounts exist, and which trips each Sales account may keep an itinerary for. There is no website and no HTTP
// route for any of it. scripts/ops.js decides WHICH database this runs against (and refuses a live one by accident);
// this file only does the work, so it can be tested against a throwaway database.

export class OpsError extends Error {}

/** The folder of the public portal that serves each registration template, and its screen name. */
export const PORTALS = {
  domestic_payment: { folder: "apps/portal-domestic-paid", label: "Domestic — With Payment" },
  domestic_none: { folder: "apps/portal-domestic-free", label: "Domestic — Without Payment" },
  international_payment: { folder: "apps/portal-international-paid", label: "International — With Payment" },
  international_none: { folder: "apps/portal-international-free", label: "International — Without Payment" },
};

export const HELP = `Developer commands (npm run ops -- <command> ...)

  Schools and trips
    trip:create --school "ABC School" [--branch "Jaipur"] --title "Jaipur 2027" --type domestic|international
                --payment none|payment --year 2027-28 [--destination "Jaipur"] [--new-school]
                    Creates the trip as a draft (and the school, only with --new-school). Prints its address words.
    trip:list [--school "ABC School"]
    trip:open  <school>/<branch>/<trip>      Activates the trip and switches its public registration page on.
    trip:close <school>/<branch>/<trip>      Closes the trip and switches its public page off. Nothing is deleted.
    trip:config <school>/<branch>/<trip>     Prints the lines for the portal's src/deployment.config.js.

  Which trip each public portal serves
    portal:bind <school>/<branch>/<trip>     Makes this the one trip its portal accepts registrations for, and closes the
                                             trip it replaces. Run it before deploying the portal for a new school.
    portal:status

  Sales accounts (the allowlist) and their trips
    sales:allow --email name@company.com --name "Full Name"   Adds the exact address; its owner then sets a password.
    sales:list
    sales:disable <email>   |   sales:enable <email>
    sales:assign --email name@company.com <school>/<branch>/<trip>
    sales:revoke --email name@company.com <school>/<branch>/<trip>
    sales:assignments [<school>/<branch>/<trip>]

  Cleanup and records
    admin:remove [--apply --confirm <database name>]   Lists, or with --apply deletes, the old admin accounts, their sessions and the audit rows they wrote. Nothing else.
    audit:list [--limit 50]

  Which database: see DEVELOPER-CLI.md. Without a flag it is your LOCAL development database. --test is the local test
  database. A live database is refused unless you add --production and set the three safeguards described there.
`;

const FLAGS_WITH_VALUE = new Set(["school", "branch", "title", "type", "payment", "year", "destination", "email", "name", "limit", "confirm"]);
const FLAGS_BOOLEAN = new Set(["new-school", "apply", "test", "production"]);

/** { command, flags, positional } from argv. Unknown flags are refused, so a typo never silently does something else. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (FLAGS_BOOLEAN.has(key)) flags[key] = true;
      else if (FLAGS_WITH_VALUE.has(key)) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) throw new OpsError(`--${key} needs a value.`);
        flags[key] = value;
        i += 1;
      } else throw new OpsError(`Unknown option --${key}. Run: npm run ops -- help`);
    } else positional.push(a);
  }
  return { command, flags, positional };
}

const WORDS = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "<school>/<branch>/<trip>" (the last three parts of a registration link) -> { school, branch, trip }. */
export function parseTripRef(ref) {
  const clean = String(ref ?? "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/\/continue\/?$/, "").replace(/^\/?join\//, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (parts.length !== 3 || !parts.every((w) => WORDS.test(w))) {
    throw new OpsError('Name the trip by the last three parts of its link: <school>/<branch>/<trip>, for example abc-school/main/jaipur-2027.');
  }
  return { school: parts[0], branch: parts[1], trip: parts[2] };
}

/** Reads the PUBLIC_BASE_URL* settings so a printed link is the real one; none set means paths only. Never reads a secret. */
export function linkConfigFromEnv(env = {}) {
  const clean = (v) => (v ? String(v).replace(/\/$/, "") : null);
  const publicBaseUrls = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, clean(env[`PUBLIC_BASE_URL_${k.toUpperCase()}`])]));
  const publicBaseUrl = clean(env.PUBLIC_BASE_URL);
  const anySet = Object.values(publicBaseUrls).some(Boolean);
  const allSet = Object.values(publicBaseUrls).every(Boolean);
  return { publicBaseUrl, publicBaseUrls: anySet && !allSet && !publicBaseUrl ? Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, null])) : publicBaseUrls, requireBinding: false };
}

export function createOps({ db, env = {}, user = "developer" }) {
  const actor = { id: null, email: `cli:${user}`.slice(0, 100), role: "admin" };
  const catalog = createCatalogService({ db, config: linkConfigFromEnv(env) });
  const operations = createItineraryOperations({ db });
  const staff = createStaffManagement({ db });

  async function findTrip(ref) {
    const w = parseTripRef(ref);
    const { rows } = await db.query(
      `SELECT t.id, t.title, t.destination, t.status, t.public_registration, t.template_key, t.tour_type, t.payment_mode, t.academic_year,
              t.slug, s.slug AS school_slug, s.branch_slug, s.name AS school_name, s.branch AS school_branch
         FROM schools s JOIN trips t ON t.school_id = s.id WHERE s.slug = $1 AND s.branch_slug = $2 AND t.slug = $3`,
      [w.school, w.branch, w.trip],
    );
    if (!rows[0]) throw new OpsError(`No trip at ${w.school}/${w.branch}/${w.trip}. Run: npm run ops -- trip:list`);
    return rows[0];
  }
  const words = (r) => `${r.school_slug}/${r.branch_slug}/${r.slug}`;
  const schoolLine = (r) => `${r.school_name}${r.school_branch ? ` (${r.school_branch})` : ""}`;

  async function findSales(email) {
    const e = String(email ?? "").trim().toLowerCase();
    if (!e) throw new OpsError("--email is required.");
    const { rows } = await db.query("SELECT id, email_normalized, display_name, role, disabled_at FROM staff_users WHERE email_normalized = $1", [e]);
    if (!rows[0] || rows[0].role !== "sales") throw new OpsError(`${e} is not on the Sales list. Add it first: npm run ops -- sales:allow --email ${e} --name "Full Name"`);
    return rows[0];
  }

  const commands = {
    async "trip:create"({ flags }, out) {
      for (const k of ["school", "title", "type", "payment", "year"]) if (!flags[k]) throw new OpsError(`--${k} is required.`);
      const input = tripCreateSchema.safeParse({
        title: flags.title, tourType: flags.type, paymentMode: flags.payment, academicYear: flags.year, ...(flags.destination ? { destination: flags.destination } : {}),
      });
      if (!input.success) throw new OpsError(input.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n"));
      const wanted = `${normalizeSchoolName(flags.school)}|${flags.branch ? normalizeSchoolName(flags.branch) : ""}`;
      const schools = await catalog.listSchools(actor, { includeArchived: true });
      let school = schools.find((s) => `${normalizeSchoolName(s.name)}|${s.branch ? normalizeSchoolName(s.branch) : ""}` === wanted);
      if (!school) {
        if (!flags["new-school"]) throw new OpsError(`There is no school "${flags.school}"${flags.branch ? ` (${flags.branch})` : ""}. Check the spelling, or add --new-school to create it.`);
        school = await catalog.createSchool(actor, { name: flags.school, ...(flags.branch ? { branch: flags.branch } : {}) });
        out(`Created school ${school.name}${school.branch ? ` (${school.branch})` : ""}.`);
      } else if (school.status !== "active") throw new OpsError("That school is archived.");
      const trip = await catalog.createTrip(actor, school.id, input.data);
      const portal = PORTALS[trip.templateKey];
      out(`Created trip "${trip.title}" for ${school.name} as a DRAFT. Nothing is public yet.`);
      out(`  Template : ${portal.label}   (${trip.templateKey})`);
      out(`  Address  : ${trip.publicPath.replace(/^\/join\//, "")}`);
      out(`  Link     : ${trip.publicUrl ?? trip.publicPath}`);
      out(`  Portal   : ${portal.folder}`);
      out("Next: npm run ops -- trip:config " + trip.publicPath.replace(/^\/join\//, ""));
    },

    async "trip:list"({ flags }, out) {
      const { rows } = await db.query(
        `SELECT s.slug AS school_slug, s.branch_slug, t.slug, t.title, t.status, t.public_registration, t.template_key, t.academic_year, s.name, s.branch,
                (d.trip_id IS NOT NULL) AS bound
           FROM trips t JOIN schools s ON s.id = t.school_id LEFT JOIN portal_deployments d ON d.trip_id = t.id
          ${flags.school ? "WHERE s.name_normalized = $1" : ""} ORDER BY s.name, t.created_at, t.id LIMIT 500`,
        flags.school ? [normalizeSchoolName(flags.school)] : [],
      );
      if (rows.length === 0) out("No trips.");
      for (const r of rows) out(`${words(r).padEnd(48)} ${r.status.padEnd(9)} page ${r.public_registration ? "ON " : "off"}  ${r.bound ? "BOUND" : "     "}  ${r.template_key.padEnd(22)} ${r.title} · ${schoolLine({ school_name: r.name, school_branch: r.branch })}`);
    },

    async "trip:open"({ positional }, out) {
      const t = await findTrip(positional[0]);
      if (t.status === "archived") throw new OpsError("That trip is archived.");
      if (t.status !== "active") await catalog.changeTripStatus(actor, t.id, "active");
      await catalog.setPublicRegistration(actor, t.id, true);
      out(`Opened ${words(t)}: the trip is active and its public page is ON.`);
      out("Parents can register only if it is also the trip bound to its portal (npm run ops -- portal:status).");
    },

    async "trip:close"({ positional }, out) {
      const t = await findTrip(positional[0]);
      if (t.status === "archived") throw new OpsError("That trip is archived.");
      if (t.status === "active") await catalog.changeTripStatus(actor, t.id, "closed");
      if (t.public_registration) await catalog.setPublicRegistration(actor, t.id, false);
      out(`Closed ${words(t)}: no new registrations, public page OFF. Its registrations, forms and PDFs are untouched.`);
    },

    async "trip:config"({ positional }, out) {
      const t = await findTrip(positional[0]);
      const portal = PORTALS[t.template_key];
      out(`Put these values in ${portal.folder}/src/deployment.config.js (${portal.label}):`);
      out("");
      out(`  school: ${JSON.stringify(t.school_slug)},`);
      out(`  branch: ${JSON.stringify(t.branch_slug)},`);
      out(`  trip: ${JSON.stringify(t.slug)},`);
      out(`  schoolName: ${JSON.stringify(t.school_name)},`);
      out(`  tripTitle: ${JSON.stringify(t.title)},`);
      out(`  destination: ${JSON.stringify(t.destination ?? "")},`);
      out(`  // schoolLogos: add  ${JSON.stringify(`${t.school_slug}/${t.branch_slug}`)}: <the imported logo>   (keep every earlier school's entry)`);
    },

    async "portal:bind"({ positional }, out) {
      const t = await findTrip(positional[0]);
      const result = await operations.bindDeployment(actor, t.template_key, t.id);
      const portal = PORTALS[t.template_key];
      out(`${portal.label} now accepts registrations only for ${words(t)}.`);
      if (result.previousTripId && result.previousTripId !== t.id) out("The trip it served before was closed and its public page switched off. Its records are kept.");
      out("Next: open the trip (trip:open), set the portal's deployment.config.js, build and deploy that one portal.");
    },

    async "portal:status"(_args, out) {
      const rows = await operations.listDeployments(actor);
      const bound = new Map(rows.map((r) => [r.templateKey, r]));
      for (const key of TEMPLATE_KEYS) {
        const r = bound.get(key);
        out(`${PORTALS[key].label.padEnd(32)} ${r ? `${r.publicPath.replace(/^\/join\//, "")}  [${r.tripStatus}]` : "no trip bound"}`);
      }
    },

    async "sales:allow"({ flags }, out) {
      const input = staffCreateSchema.safeParse({ email: flags.email, name: flags.name });
      if (!input.success) throw new OpsError(input.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n"));
      const made = await staff.createSales(actor, input.data);
      out(`Added ${made.email} to the Sales list (status: ${made.status}).`);
      out("They can now open the Sales portal, choose 'First time or forgot your password?', and set a password with an emailed code.");
      out("They see no trips until you assign one: npm run ops -- sales:assign --email " + made.email + " <school>/<branch>/<trip>");
    },

    async "sales:list"(_args, out) {
      const { rows } = await db.query(
        `SELECT u.email_normalized AS email, u.display_name AS name, u.disabled_at, (u.password_hash IS NULL) AS pending,
                (SELECT count(*)::int FROM staff_trip_assignments a WHERE a.staff_id = u.id) AS trips
           FROM staff_users u WHERE u.role = 'sales' ORDER BY u.email_normalized`,
      );
      if (rows.length === 0) out("No Sales accounts.");
      for (const r of rows) out(`${r.email.padEnd(40)} ${(r.disabled_at ? "disabled" : r.pending ? "waiting for password" : "active").padEnd(22)} ${r.trips} trip(s)  ${r.name}`);
    },

    async "sales:disable"({ positional }, out) {
      await findSales(positional[0]);
      await setStaffDisabled(db, { email: positional[0], disabled: true });
      out(`Disabled ${positional[0]}. Their sessions ended.`);
    },
    async "sales:enable"({ positional }, out) {
      await findSales(positional[0]);
      await setStaffDisabled(db, { email: positional[0], disabled: false });
      out(`Enabled ${positional[0]}.`);
    },

    async "sales:assign"({ flags, positional }, out) {
      const s = await findSales(flags.email);
      const t = await findTrip(positional[0]);
      await operations.assign(actor, t.id, s.id);
      out(`${s.email_normalized} can now add and edit the itinerary of ${words(t)}.`);
    },
    async "sales:revoke"({ flags, positional }, out) {
      const s = await findSales(flags.email);
      const t = await findTrip(positional[0]);
      await operations.revoke(actor, t.id, s.id);
      out(`${s.email_normalized} can no longer reach the itinerary of ${words(t)}.`);
    },
    async "sales:assignments"({ positional }, out) {
      const params = [];
      let where = "";
      if (positional[0]) {
        const w = parseTripRef(positional[0]);
        params.push(w.school, w.branch, w.trip);
        where = "WHERE s.slug = $1 AND s.branch_slug = $2 AND t.slug = $3";
      }
      const { rows } = await db.query(
        `SELECT u.email_normalized AS email, s.slug AS school_slug, s.branch_slug, t.slug FROM staff_trip_assignments a
           JOIN staff_users u ON u.id = a.staff_id JOIN trips t ON t.id = a.trip_id JOIN schools s ON s.id = t.school_id
          ${where} ORDER BY u.email_normalized, s.slug, t.slug`,
        params,
      );
      if (rows.length === 0) out("No assignments.");
      for (const r of rows) out(`${r.email.padEnd(40)} ${words(r)}`);
    },

    async "admin:remove"({ flags }, out, ctx) {
      const dry = !flags.apply;
      if (!dry && flags.confirm !== ctx.databaseName) {
        throw new OpsError(`To delete, type the database name after --confirm. This run's database is "${ctx.databaseName}": add  --confirm ${ctx.databaseName}`);
      }
      const r = await removeAdminAccounts(db, { apply: !dry, actor });
      out(r.admins.length === 0 ? "There are no admin accounts." : `Admin accounts: ${r.admins.join(", ")}`);
      out(`  to delete: ${r.admins.length} account(s), ${r.sessions} sign-in session(s), ${r.setupCodes} unused set-password code(s), ${r.loginAttempts} sign-in attempt record(s), ${r.auditRows} audit row(s) they wrote`);
      out(`  pointers set to empty, rows kept: ${r.schoolsNamingThem} school(s) and ${r.tripsNamingThem} trip(s) naming an admin as creator (plus any logo, link, assignment, itinerary and portal-binding fields that named one)`);
      if (r.applied) out(`Deleted ${r.admins.length} admin account(s). Nothing else was deleted.`);
      else if (r.admins.length > 0) out(`DRY RUN: nothing was deleted. To delete, run again with:  --apply --confirm ${ctx.databaseName}`);
    },

    async "audit:list"({ flags }, out) {
      const limit = flags.limit ? Number(flags.limit) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new OpsError("--limit must be a whole number from 1 to 500.");
      const rows = await listAudit(db, { limit });
      for (const e of rows.reverse()) out(`${new Date(e.at ?? e.created_at ?? Date.now()).toISOString()}  ${String(e.staffEmail ?? e.staff_email).padEnd(28)} ${e.action} ${e.entityType ?? e.entity_type ?? ""} ${e.entityId ?? e.entity_id ?? ""}`);
    },
  };

  /** Runs one command. `ctx.databaseName` is the database the caller already chose and checked. Prints through `out`. */
  async function run(argv, out = console.log, ctx = {}) {
    if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) return out(HELP);
    const parsed = parseArgs(argv);
    const fn = commands[parsed.command];
    if (!fn) throw new OpsError(`Unknown command "${parsed.command}". Run: npm run ops -- help`);
    try {
      return await fn(parsed, out, ctx);
    } catch (err) {
      if (err instanceof OpsError || err instanceof ProvisionError) throw err;
      if (err?.code === "42P01") {
        throw new OpsError("This database is missing a table: it has not been migrated to the latest version (the itinerary and portal tables come from migration 020). For your LOCAL database run: npm run migrate -w @pp/api. Nothing was changed.");
      }
      // The services speak in HTTP error codes; say them in plain words here.
      if (err?.code && err?.message && typeof err.status === "number") {
        const fields = err.details?.fields;
        throw new OpsError(Array.isArray(fields) && fields.length ? `${err.message} ${fields.map((f) => `${f.path}: ${f.message}`).join("; ")}` : err.message);
      }
      throw err;
    }
  }

  return { run };
}
