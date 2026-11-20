// Developer commands: schools, trips, portal bindings, Sales accounts and their trips, and the one-time removal of the old
// admin accounts. Run it from the repository folder:
//
//   npm run ops -- help
//
// WHICH DATABASE. This tool changes data, so it is careful about where it points:
//   - no flag        your LOCAL development database. DATABASE_URL must be on this computer and the database must be named
//                    parents_portal_dev. Anything else is refused.
//   - --test         the local test database (TEST_DATABASE_URL, named parents_portal_test).
//   - --staging      the staging database only (STAGING_DATABASE_URL; needs ALLOW_STAGING_DATABASE=true and
//                    STAGING_CONFIRM_DATABASE=railway; host postgres.railway.internal, database railway; and RAILWAY_PROJECT_ID equal to
//                    STAGING_RAILWAY_PROJECT_ID). Never DATABASE_URL.
//   - --production   a live database. Refused unless ALL of these are true: you also set NODE_ENV=production,
//                    ALLOW_PRODUCTION_DATABASE=true and OPS_CONFIRM_DATABASE to the exact name of that database.
// It prints the database it is about to use before it does anything, so you can stop (Ctrl-C) if it is the wrong one.
// Passwords are never typed, passed or printed here: a new Sales person sets their own by an emailed code.
import os from "node:os";
import process from "node:process";
import pg from "pg";
import { OpsError, createOps } from "../src/cli/ops.js";
import { resolveTarget } from "../src/db/migrate.js";

/** Which database to use, or an Error saying why not. Pure: connects to nothing. */
export function chooseTarget(argv, env) {
  try {
    return resolveTarget(argv, { ...env, MIGRATE_CONFIRM_DATABASE: env.OPS_CONFIRM_DATABASE });
  } catch (err) {
    throw new OpsError(String(err.message).replace(/MIGRATE_CONFIRM_DATABASE/g, "OPS_CONFIRM_DATABASE").replace(/migration/g, "operation"));
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) {
    await createOps({ db: null, env }).run(["help"]);
    return;
  }
  const target = chooseTarget(argv, env);
  const where = target.production ? "THE LIVE (PRODUCTION) DATABASE" : target.staging ? "THE STAGING DATABASE" : "a local database";
  console.log(`Using ${where}: ${target.database} on ${target.host} (${target.envName}).`);
  const db = new pg.Pool({ connectionString: target.connectionString, max: 2 });
  try {
    await createOps({ db, env, user: os.userInfo().username }).run(argv.filter((a) => a !== "--test" && a !== "--production" && a !== "--staging"), console.log, { databaseName: target.database });
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err instanceof OpsError ? `Stopped: ${err.message}` : `Error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
