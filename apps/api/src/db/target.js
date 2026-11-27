// Which database a process may use. One place, shared by the server's configuration, the migration runner and the
// local tools, so they can never disagree.
//
//   development / test  only a database on THIS machine (localhost, 127.0.0.1, ::1), as it has always been.
//   production          a database on this machine, or on another host (Railway's PostgreSQL) ONLY with the explicit
//                       opt-in ALLOW_PRODUCTION_DATABASE=true. Production refuses a test database (parents_portal_test, or any
//                       name ending _test) AND the development database parents_portal_dev, and never runs next to
//                       TEST_DATABASE_URL.
//
//   staging             (--staging only) the ONE staging database, and nothing else: STAGING_DATABASE_URL, never DATABASE_URL. It
//                       needs ALLOW_STAGING_DATABASE=true, STAGING_CONFIRM_DATABASE=railway, the exact host
//                       postgres.railway.internal, the exact database name railway, and a Railway project id (RAILWAY_PROJECT_ID) equal to
//                       STAGING_RAILWAY_PROJECT_ID. Production's variables
//                       (ALLOW_PRODUCTION_DATABASE, MIGRATE_CONFIRM_DATABASE, OPS_CONFIRM_DATABASE, DATABASE_URL) never authorise it.
//
// Nothing here connects anywhere, and no error ever repeats the connection URL or its password.
//
// TLS to the database. The driver (pg 8) turns TLS on for sslmode allow/prefer/require/verify-ca/verify-full and for any
// unknown value, with certificate and host-name checks, but its next major version gives require/prefer/verify-ca the
// weaker libpq meaning, and sslmode=no-verify or uselibpqcompat=true switch verification off. So the only values accepted
// are the two that mean the same thing in every version: disable (no TLS) and verify-full. Production also refuses a host
// that is neither on this machine nor on Railway's private network unless it uses verify-full, and refuses the
// environment settings (PGSSLMODE, NODE_TLS_REJECT_UNAUTHORIZED=0) that would change TLS behind the URL's back.
import pg from "pg";

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class DatabaseTargetError extends Error {}

// The only connection options accepted in a URL. The driver also lets ?host=, ?hostaddr=, ?dbname=, ?port= and the like
// override the URL, so a URL that says "localhost" could still connect somewhere else. Anything not listed is refused.
const ALLOWED_OPTIONS = new Set(["sslmode", "application_name", "connect_timeout"]);
const SSLMODES = new Set(["disable", "verify-full"]);
// Railway's private network: <service>.railway.internal. Traffic inside it is encrypted by Railway (WireGuard), so TLS to
// the database on top of it is optional there. Exactly this suffix, with at least one label before it.
const PRIVATE_NETWORK_HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+railway\.internal$/;
const DEVELOPMENT_DATABASE = "parents_portal_dev";

const isTestDatabase = (name) => /_test$/i.test(name);
const bare = (host) => String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();

/**
 * { host, database, local, connectionString } for a PostgreSQL URL, or a DatabaseTargetError. `label` names the variable
 * in messages. The URL is read twice, by the URL parser and by the driver's own parser, and refused unless they agree.
 */
export function parseDatabaseUrl(raw, label = "DATABASE_URL") {
  if (typeof raw !== "string" || raw === "") throw new DatabaseTargetError(`${label} is not set`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseTargetError(`${label} is not a valid connection URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseTargetError(`${label} must be a postgres:// or postgresql:// URL`);
  }
  const host = url.hostname;
  if (!host || host.includes(",")) throw new DatabaseTargetError(`${label} must name exactly one database host`);
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new DatabaseTargetError(`${label} has an invalid database name`);
  }
  if (!database || database.includes("/")) throw new DatabaseTargetError(`${label} must name a database`);
  for (const key of new Set(url.searchParams.keys())) {
    if (!ALLOWED_OPTIONS.has(key)) throw new DatabaseTargetError(`${label} has an unsupported connection option "${key}"`);
    // The driver uses the LAST value of a repeated option, a plain read uses the first: never leave that to chance.
    if (url.searchParams.getAll(key).length > 1) throw new DatabaseTargetError(`${label} gives the connection option "${key}" more than once`);
  }
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode !== null && !SSLMODES.has(sslmode)) {
    throw new DatabaseTargetError(`${label} has sslmode "${sslmode}", which is not accepted: use sslmode=verify-full (verifies the server's certificate and host name) or sslmode=disable`);
  }

  // What the driver would really connect to must be what the URL appears to say.
  let effective;
  try {
    effective = new pg.Client({ connectionString: raw }).connectionParameters;
  } catch {
    throw new DatabaseTargetError(`${label} is not a valid connection URL`);
  }
  if (bare(effective.host) !== bare(host) || effective.database !== database || (url.port && String(effective.port) !== url.port)) {
    throw new DatabaseTargetError(`${label} is ambiguous: the database driver would connect somewhere other than the host and database the URL names`);
  }

  return { host, database, local: LOCAL_HOSTS.has(host), sslmode, connectionString: raw };
}

/** A database on this machine, or a DatabaseTargetError. Used by the local tools (staff script, catalog cleanup). */
export function assertLocalDatabaseUrl(connectionString, label = "DATABASE_URL") {
  const target = parseDatabaseUrl(connectionString, label);
  if (!target.local) throw new DatabaseTargetError(`${label} must point at localhost or 127.0.0.1 (got "${target.host}")`);
  return target;
}

/**
 * The database this process may use, from its environment: { host, database, local, production, connectionString }.
 * Only the exact value NODE_ENV=production means production; anything else (including nothing) is local-only.
 */
export function resolveDatabaseTarget(env = process.env) {
  const optIn = env.ALLOW_PRODUCTION_DATABASE;
  if (optIn !== undefined && optIn !== "" && optIn !== "true") {
    throw new DatabaseTargetError('ALLOW_PRODUCTION_DATABASE must be exactly "true" or not set');
  }
  const production = env.NODE_ENV === "production";
  const target = parseDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");

  if (!production) {
    if (!target.local) throw new DatabaseTargetError(`DATABASE_URL must point at localhost or 127.0.0.1 (got "${target.host}")`);
    return { ...target, production: false };
  }

  if (env.TEST_DATABASE_URL) throw new DatabaseTargetError("TEST_DATABASE_URL must not be set in production");
  if (isTestDatabase(target.database)) {
    throw new DatabaseTargetError(`production must not use a test database (DATABASE_URL names "${target.database}")`);
  }
  if (target.database.toLowerCase() === DEVELOPMENT_DATABASE) {
    throw new DatabaseTargetError(`production must not use the development database (DATABASE_URL names "${target.database}")`);
  }
  // Settings that change TLS behind the URL's back: the driver reads PGSSLMODE when the URL says nothing (no-verify turns
  // certificate checking off), and NODE_TLS_REJECT_UNAUTHORIZED=0 turns it off for every TLS connection in the process.
  if (env.PGSSLMODE) throw new DatabaseTargetError("PGSSLMODE must not be set in production: put the TLS setting in DATABASE_URL (sslmode=verify-full or sslmode=disable)");
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new DatabaseTargetError("NODE_TLS_REJECT_UNAUTHORIZED=0 must not be set in production: it turns off certificate checking for every TLS connection");
  }
  if (!target.local) {
    if (optIn !== "true") {
      throw new DatabaseTargetError(`DATABASE_URL points at another host ("${target.host}"); production needs ALLOW_PRODUCTION_DATABASE=true to use it`);
    }
    if (!PRIVATE_NETWORK_HOST.test(target.host) && target.sslmode !== "verify-full") {
      throw new DatabaseTargetError(`DATABASE_URL points at "${target.host}", which is outside Railway's private network (*.railway.internal): production requires sslmode=verify-full for it`);
    }
  }
  return { ...target, production: true };
}

// The staging database. Railway's private DNS name is the same in every Railway project, so the host and database name
// alone cannot tell staging from production. So the process must prove which Railway project it runs in: Railway sets
// RAILWAY_PROJECT_ID itself, and STAGING_RAILWAY_PROJECT_ID (set by us, to the staging project's id) must equal it exactly.
// Both are required; the project name is not used (names are not an identity).
export const STAGING_HOST = "postgres.railway.internal";
export const STAGING_DATABASE = "railway";

/**
 * The staging database, from STAGING_DATABASE_URL only: { host, database, connectionString, staging: true }.
 * Pure: reads `env`, connects to nothing, and no message repeats the URL, user name, password or host.
 * It never looks at DATABASE_URL, TEST_DATABASE_URL, NODE_ENV or any production variable.
 */
export function resolveStagingTarget(env = process.env) {
  if (env.ALLOW_STAGING_DATABASE !== "true") throw new DatabaseTargetError('staging needs ALLOW_STAGING_DATABASE to be exactly "true"');
  if (env.STAGING_CONFIRM_DATABASE !== STAGING_DATABASE) {
    throw new DatabaseTargetError(`staging needs STAGING_CONFIRM_DATABASE to be set to the staging database name ("${STAGING_DATABASE}")`);
  }
  if (env.PGSSLMODE) throw new DatabaseTargetError("PGSSLMODE must not be set for staging: put the TLS setting in STAGING_DATABASE_URL");
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new DatabaseTargetError("NODE_TLS_REJECT_UNAUTHORIZED=0 must not be set for staging: it turns off certificate checking for every TLS connection");
  }
  const target = parseDatabaseUrl(env.STAGING_DATABASE_URL, "STAGING_DATABASE_URL");
  if (target.host !== STAGING_HOST) throw new DatabaseTargetError(`STAGING_DATABASE_URL must point at ${STAGING_HOST}`);
  if (target.database !== STAGING_DATABASE) throw new DatabaseTargetError(`STAGING_DATABASE_URL must name the database "${STAGING_DATABASE}"`);
  // Parsed once already by parseDatabaseUrl, so this cannot throw. The name must be spelled exactly (no %-escapes), and the
  // port is PostgreSQL's own: another port on that host is some other service.
  const parsed = new URL(target.connectionString);
  if (parsed.pathname !== `/${STAGING_DATABASE}`) throw new DatabaseTargetError(`STAGING_DATABASE_URL must name the database "${STAGING_DATABASE}", spelled exactly`);
  if (parsed.port !== "" && parsed.port !== "5432") throw new DatabaseTargetError("STAGING_DATABASE_URL must use port 5432 (or none)");
  // Last, so every other refusal reads the same as before. Neither value is ever printed.
  const expectedProject = env.STAGING_RAILWAY_PROJECT_ID;
  const runtimeProject = env.RAILWAY_PROJECT_ID;
  if (typeof expectedProject !== "string" || expectedProject === "") {
    throw new DatabaseTargetError("staging needs STAGING_RAILWAY_PROJECT_ID, the staging Railway project's id (Project Settings in the Railway dashboard)");
  }
  if (typeof runtimeProject !== "string" || runtimeProject === "") {
    throw new DatabaseTargetError("staging runs only inside Railway: RAILWAY_PROJECT_ID is not set in this process");
  }
  if (runtimeProject !== expectedProject) {
    throw new DatabaseTargetError("this process is not in the staging Railway project (RAILWAY_PROJECT_ID does not match STAGING_RAILWAY_PROJECT_ID)");
  }
  return { host: target.host, database: target.database, connectionString: target.connectionString, staging: true };
}
