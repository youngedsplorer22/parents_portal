// Applies SQL files from ./migrations in filename order, each in its own
// transaction, and records them in schema_migrations.
//
// Usage:
//   node --env-file=.env src/db/migrate.js                 -> DATABASE_URL (local development database)
//   node --env-file=.env src/db/migrate.js --test          -> TEST_DATABASE_URL (local test database)
//   node src/db/migrate.js --production                    -> the production database (npm run migrate:production)
//   node src/db/migrate.js --staging                       -> the staging database ONLY (npm run migrate:staging): STAGING_DATABASE_URL,
//                                                             ALLOW_STAGING_DATABASE=true, STAGING_CONFIRM_DATABASE=railway
//
// A production run changes real data's schema, so it never happens by accident. All of these must hold, or it refuses:
//   - the --production flag, and NODE_ENV=production;
//   - ALLOW_PRODUCTION_DATABASE=true (the same explicit opt-in the server needs);
//   - MIGRATE_CONFIRM_DATABASE equal to the name of the database in DATABASE_URL (the name typed again, on purpose);
//   - the database is not a test database, and TEST_DATABASE_URL is not set.
// Local runs only ever touch parents_portal_dev (default) or parents_portal_test (--test), on this machine.
// Nothing about transactions, the advisory lock or the checksums differs between the modes.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { parseDatabaseUrl, resolveDatabaseTarget, resolveStagingTarget } from "./target.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
// Arbitrary constant so concurrent runs of this script serialize.
const ADVISORY_LOCK_KEY = 727001;

/**
 * Which database this run may change: { envName, database, host, connectionString, production }, or an Error saying why not.
 * Pure: reads only `argv` and `env`, connects to nothing.
 */
export function resolveTarget(argv = process.argv.slice(2), env = process.env) {
  const useTest = argv.includes("--test");
  const useProduction = argv.includes("--production");
  const useStaging = argv.includes("--staging");
  if (useTest && useProduction) throw new Error("--test and --production cannot be combined");
  if (useStaging && (useTest || useProduction)) throw new Error("--staging cannot be combined with --test or --production");

  if (useStaging) {
    // Its own variables and its own checks: no DATABASE_URL, no production opt-in, no MIGRATE_CONFIRM_DATABASE.
    const target = resolveStagingTarget(env);
    return { envName: "STAGING_DATABASE_URL", database: target.database, host: target.host, connectionString: target.connectionString, production: false, staging: true };
  }

  if (useProduction) {
    if (env.NODE_ENV !== "production") throw new Error("--production requires NODE_ENV=production");
    // The same rules as the server: another host only with the opt-in, never a test database, never next to TEST_DATABASE_URL.
    const target = resolveDatabaseTarget(env);
    if (env.ALLOW_PRODUCTION_DATABASE !== "true") throw new Error("a production migration requires ALLOW_PRODUCTION_DATABASE=true");
    if (!env.MIGRATE_CONFIRM_DATABASE || env.MIGRATE_CONFIRM_DATABASE !== target.database) {
      throw new Error(`a production migration requires MIGRATE_CONFIRM_DATABASE to be set to the database name ("${target.database}")`);
    }
    return { envName: "DATABASE_URL", database: target.database, host: target.host, connectionString: target.connectionString, production: true };
  }

  if (useTest && env.NODE_ENV === "production") throw new Error("--test must never run with NODE_ENV=production");
  if (env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=production: run production migrations with --production (npm run migrate:production)");
  }

  const envName = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const expectedDb = useTest ? "parents_portal_test" : "parents_portal_dev";
  const target = parseDatabaseUrl(env[envName], envName);
  if (!target.local) throw new Error(`${envName} must point at localhost or 127.0.0.1 (got "${target.host}")`);
  if (target.database !== expectedDb) throw new Error(`${envName} must use database "${expectedDb}" (got "${target.database}")`);
  return { envName, database: target.database, host: target.host, connectionString: target.connectionString, production: false };
}

/** A readable reason for a failure. Some connection errors (a refused connection to "localhost") have an empty message. */
export function describeError(err) {
  if (err?.message) return err.message;
  if (Array.isArray(err?.errors)) {
    const reasons = [...new Set(err.errors.map((e) => e?.code || e?.message).filter(Boolean))];
    if (reasons.length) return reasons.join(", ");
  }
  return err?.code || "unknown error";
}

async function main() {
  const target = resolveTarget();
  const client = new pg.Client({ connectionString: target.connectionString });
  await client.connect();
  console.log(`Connected to ${target.database} on ${target.host} (${target.production ? "PRODUCTION" : target.staging ? "STAGING" : target.envName})`);

  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text        PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Map(
      (await client.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    let ran = 0;
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`${file} was already applied but has changed since; add a new migration instead`);
        }
        console.log(`skip   ${file} (already applied)`);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file} failed and was rolled back: ${err.message}`);
      }
      console.log(`apply  ${file}`);
      ran += 1;
    }
    console.log(`Done: ${ran} applied, ${files.length - ran} skipped`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

// Run only when this file is started directly, so tests can import resolveTarget without touching a database.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Migration error: ${describeError(err)}`);
    process.exit(1);
  });
}
