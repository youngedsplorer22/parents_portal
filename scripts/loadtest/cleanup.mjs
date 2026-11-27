// Removes the rows a load-test run created, and nothing else, from a DISPOSABLE test database.
// Identities are `lt-<run>-...@loadtest.example.org` (seed.mjs, k6.js). DRY RUN unless --yes. Prefer dropping the whole test database.
//
//   DATABASE_URL=postgresql://localhost/parents_portal_loadtest node scripts/loadtest/cleanup.mjs [--run <id>] [--yes]
//
// Refuses a non-local database unless LOADTEST_ALLOW_REMOTE_DB=yes-this-is-not-production. Runs in one transaction.
import pg from "pg";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const yes = process.argv.includes("--yes"), run = arg("run");
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) { console.error("DATABASE_URL is required."); process.exit(1); }
const host = new URL(DATABASE_URL).hostname;
if ((!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || /railway|rlwy|proxy/i.test(DATABASE_URL)) && process.env.LOADTEST_ALLOW_REMOTE_DB !== "yes-this-is-not-production") {
  console.error(`Refusing "${host}": not a local database.`); process.exit(1);
}
if (run && !/^[0-9a-f]{8}$/.test(run)) { console.error("--run must be the 8-hex-digit run id printed by seed.mjs."); process.exit(1); }
const like = `lt-${run ?? "%"}-%@loadtest.example.org`;

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const count = async (sql) => (await db.query(sql, [like])).rows[0].n;
const plan = {
  parent_registrations: await count("SELECT count(*)::int n FROM parent_registrations WHERE email_normalized LIKE $1"),
  trip_enrolments: await count("SELECT count(*)::int n FROM trip_enrolments e JOIN parent_registrations r ON r.id = e.registration_id WHERE r.email_normalized LIKE $1"),
  onboarding_forms: await count("SELECT count(*)::int n FROM onboarding_forms f JOIN parent_registrations r ON r.id = f.registration_id WHERE r.email_normalized LIKE $1"),
  email_otps: await count("SELECT count(*)::int n FROM email_otps WHERE email_normalized LIKE $1"),
  password_login_attempts: await count("SELECT count(*)::int n FROM password_login_attempts WHERE email_normalized LIKE $1"),
};
console.log(`${yes ? "DELETING" : "DRY RUN, would delete"} rows matching ${like}:`, plan);
if (!yes) { console.log("Re-run with --yes to delete."); await db.end(); process.exit(0); }

await db.query("BEGIN");
try {
  // Order matters: enrolments and forms RESTRICT the registration; sessions, refresh tokens and credentials cascade from it.
  await db.query("DELETE FROM onboarding_forms WHERE registration_id IN (SELECT id FROM parent_registrations WHERE email_normalized LIKE $1)", [like]);
  await db.query("DELETE FROM trip_enrolments WHERE registration_id IN (SELECT id FROM parent_registrations WHERE email_normalized LIKE $1)", [like]);
  await db.query("DELETE FROM parent_registrations WHERE email_normalized LIKE $1", [like]);
  await db.query("DELETE FROM email_otps WHERE email_normalized LIKE $1", [like]);            // tokens cascade
  await db.query("DELETE FROM password_login_attempts WHERE email_normalized LIKE $1", [like]);
  await db.query("COMMIT");
  console.log("Done.");
} catch (err) { await db.query("ROLLBACK"); console.error("Rolled back:", err.message); process.exitCode = 1; }
await db.end();
