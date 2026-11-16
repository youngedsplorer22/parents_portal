// Applies SQL files from ./migrations in filename order, each in its own
// transaction, and records them in schema_migrations.
//
// Usage:
//   node --env-file=.env src/db/migrate.js          -> DATABASE_URL (dev)
//   node --env-file=.env src/db/migrate.js --test   -> TEST_DATABASE_URL
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Arbitrary constant so concurrent runs of this script serialize.
const ADVISORY_LOCK_KEY = 727001;

function resolveTarget(useTest) {
  const envName = useTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const expectedDb = useTest ? "parents_portal_test" : "parents_portal_dev";
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not set`);

  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${envName} must point at localhost or 127.0.0.1 (got "${url.hostname}")`);
  }
  if (database !== expectedDb) {
    throw new Error(`${envName} must use database "${expectedDb}" (got "${database}")`);
  }
  return { envName, database, connectionString: raw };
}

async function main() {
  const target = resolveTarget(process.argv.includes("--test"));
  const client = new pg.Client({ connectionString: target.connectionString });
  await client.connect();
  console.log(`Connected to ${target.database} (${target.envName})`);

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

main().catch((err) => {
  console.error(`Migration error: ${err.message}`);
  process.exit(1);
});
