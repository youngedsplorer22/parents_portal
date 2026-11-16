// One-time creation of the FIRST admin in a production database. A private command, never an HTTP route.
//
//   On the platform, in a shell attached to the running service (Railway: `railway ssh`), with the service's own variables:
//     1. In the service's Variables set BOOTSTRAP_ADMIN_ENABLED=true (this is the deliberate "open the window" switch).
//     2. npm run bootstrap:admin --prefix backend      (asks for email and name, then a typed confirmation)
//     3. Remove BOOTSTRAP_ADMIN_ENABLED again.
//   The new account has NO password. Its owner opens /admin/login -> "First time or forgot your password?" and sets one
//   with a code emailed to that address. No password is typed here, kept in a variable, or printed.
//
// It refuses unless: NODE_ENV=production, BOOTSTRAP_ADMIN_ENABLED=true, the database passes the same production checks as the
// server (never a test or development database; another host needs ALLOW_PRODUCTION_DATABASE=true), and NO staff account
// exists yet. The result (or refusal) is recorded in audit_log. Local development keeps using `npm run staff`.
import pg from "pg";
import { poolOptions } from "../src/db/pool.js";
import { DatabaseTargetError, resolveDatabaseTarget } from "../src/db/target.js";
import { BootstrapError, bootstrapFirstAdmin } from "../src/modules/staff/bootstrap.js";
import { createPrompter } from "./staff.js";

/** Checks the environment, asks, confirms, creates. `db` and `prompt` are injectable for tests. */
export async function runBootstrap({ env = process.env, db, prompt = createPrompter(), log = console.log }) {
  if (env.NODE_ENV !== "production") throw new BootstrapError("Refused: this command runs only with NODE_ENV=production (use `npm run staff` for local development).");
  if (env.BOOTSTRAP_ADMIN_ENABLED !== "true") throw new BootstrapError('Refused: set BOOTSTRAP_ADMIN_ENABLED=true for this run (and remove it afterwards).');
  try {
    resolveDatabaseTarget(env);
  } catch (err) {
    throw err instanceof DatabaseTargetError ? new BootstrapError(`Refused: ${err.message}`) : err;
  }
  const email = (await prompt.ask("Email of the first admin: ")).trim();
  const name = await prompt.ask("Name: ");
  const expected = `BOOTSTRAP FIRST ADMIN ${email.toLowerCase()}`;
  const typed = await prompt.ask(`This creates the first admin and can never be run again. Type "${expected}" to confirm: `);
  if (typed.trim() !== expected) throw new BootstrapError("Confirmation did not match. Nothing was created.");
  const made = await bootstrapFirstAdmin(db, { email, name });
  log(`Created the first admin ${made.email} with no password yet. They set it at /admin/login ("First time or forgot your password?") with a code sent to that email. Now remove BOOTSTRAP_ADMIN_ENABLED.`);
}

async function main() {
  // Check everything that needs no database first, so a refusal never opens a connection.
  const env = process.env;
  let db = { end: async () => {} }; // replaced by a real pool only once the guards below pass
  if (env.NODE_ENV === "production" && env.BOOTSTRAP_ADMIN_ENABLED === "true") {
    resolveDatabaseTarget(env); // throws a readable error before connecting
    db = new pg.Pool(poolOptions(env.DATABASE_URL, { max: 2 }));
  }
  try {
    await runBootstrap({ env, db });
  } finally {
    await db.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof BootstrapError ? err.message : err instanceof DatabaseTargetError ? `Refused: ${err.message}` : `Failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
