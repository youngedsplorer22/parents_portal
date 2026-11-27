import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError, resolveTarget } from "../src/db/migrate.js";

// The migration runner changes the schema, so it is the last place that may guess which database it is talking to.
// Local runs only ever touch the development or the test database on this machine. A production run needs the --production
// flag AND NODE_ENV=production AND the explicit opt-in AND the database's own name typed again as a confirmation.

const PW = "s3cret-pw-value";
const url = (host, db) => `postgresql://app_user:${PW}@${host}:5432/${db}`;
const DEV = url("localhost", "parents_portal_dev");
const TEST = url("localhost", "parents_portal_test");
const REMOTE = url("postgres.railway.internal", "railway");
const prodEnv = (over = {}) => ({ NODE_ENV: "production", DATABASE_URL: REMOTE, ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "railway", ...over });
const refuses = (fn, pattern) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(PW), "the password is never repeated in an error");
    if (pattern) assert.match(err.message, pattern);
    return true;
  });

describe("importing the migration runner", () => {
  it("does not run it (no connection, no side effects): only running the file does", () => {
    assert.equal(typeof resolveTarget, "function");
  });
});

describe("migrations: development (the default)", () => {
  it("accepts the local development database", () => {
    const t = resolveTarget([], { DATABASE_URL: DEV });
    assert.equal(t.envName, "DATABASE_URL");
    assert.equal(t.database, "parents_portal_dev");
    assert.equal(t.connectionString, DEV);
  });

  it("refuses any other database name, another host, or a missing URL", () => {
    refuses(() => resolveTarget([], { DATABASE_URL: url("localhost", "parents_portal_test") }), /must use database "parents_portal_dev"/);
    refuses(() => resolveTarget([], { DATABASE_URL: url("localhost", "erp") }), /must use database "parents_portal_dev"/);
    refuses(() => resolveTarget([], { DATABASE_URL: url("db.example", "parents_portal_dev") }), /must point at localhost or 127.0.0.1/);
    refuses(() => resolveTarget([], {}), /DATABASE_URL is not set/);
  });

  it("refuses the ?host= trick", () => {
    refuses(() => resolveTarget([], { DATABASE_URL: `${DEV}?host=erp.internal.example` }), /unsupported connection option/);
  });

  it("refuses to run without --production when NODE_ENV is production (it will not guess)", () => {
    refuses(() => resolveTarget([], { NODE_ENV: "production", DATABASE_URL: DEV }), /--production/);
    refuses(() => resolveTarget([], prodEnv()), /--production/);
  });
});

describe("migrations: the isolated test database (--test)", () => {
  it("accepts only the local test database from TEST_DATABASE_URL", () => {
    const t = resolveTarget(["--test"], { TEST_DATABASE_URL: TEST });
    assert.equal(t.envName, "TEST_DATABASE_URL");
    assert.equal(t.database, "parents_portal_test");
  });

  it("refuses another name, another host, a missing URL, or the development URL", () => {
    refuses(() => resolveTarget(["--test"], { TEST_DATABASE_URL: DEV }), /must use database "parents_portal_test"/);
    refuses(() => resolveTarget(["--test"], { TEST_DATABASE_URL: url("db.example", "parents_portal_test") }), /must point at localhost or 127.0.0.1/);
    refuses(() => resolveTarget(["--test"], { DATABASE_URL: TEST }), /TEST_DATABASE_URL is not set/);
  });

  it("never runs with NODE_ENV=production", () => {
    refuses(() => resolveTarget(["--test"], { NODE_ENV: "production", TEST_DATABASE_URL: TEST }), /never.*production|production.*--test/i);
  });

  it("cannot be combined with --production", () => {
    refuses(() => resolveTarget(["--test", "--production"], prodEnv({ TEST_DATABASE_URL: TEST })), /cannot be combined/);
  });
});

describe("migrations: production (--production)", () => {
  it("accepts the approved target when everything is set on purpose", () => {
    const t = resolveTarget(["--production"], prodEnv());
    assert.equal(t.envName, "DATABASE_URL");
    assert.equal(t.database, "railway");
    assert.equal(t.host, "postgres.railway.internal");
    assert.equal(t.production, true);
    assert.equal(t.connectionString, REMOTE);
  });

  it("requires NODE_ENV=production", () => {
    for (const NODE_ENV of [undefined, "development", "test", "Production"]) {
      refuses(() => resolveTarget(["--production"], prodEnv({ NODE_ENV })), /--production requires NODE_ENV=production/);
    }
  });

  it("requires the explicit opt-in, even for a database on this machine", () => {
    refuses(() => resolveTarget(["--production"], prodEnv({ ALLOW_PRODUCTION_DATABASE: undefined })), /ALLOW_PRODUCTION_DATABASE=true/);
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: url("localhost", "portal_prod"), ALLOW_PRODUCTION_DATABASE: undefined, MIGRATE_CONFIRM_DATABASE: "portal_prod" })), /ALLOW_PRODUCTION_DATABASE=true/);
    refuses(() => resolveTarget(["--production"], prodEnv({ ALLOW_PRODUCTION_DATABASE: "yes" })), /must be exactly "true"/);
  });

  it("requires the database name to be typed again as a confirmation", () => {
    refuses(() => resolveTarget(["--production"], prodEnv({ MIGRATE_CONFIRM_DATABASE: undefined })), /MIGRATE_CONFIRM_DATABASE/);
    refuses(() => resolveTarget(["--production"], prodEnv({ MIGRATE_CONFIRM_DATABASE: "" })), /MIGRATE_CONFIRM_DATABASE/);
    refuses(() => resolveTarget(["--production"], prodEnv({ MIGRATE_CONFIRM_DATABASE: "some_other_db" })), /MIGRATE_CONFIRM_DATABASE/);
    refuses(() => resolveTarget(["--production"], prodEnv({ MIGRATE_CONFIRM_DATABASE: "RAILWAY" })), /MIGRATE_CONFIRM_DATABASE/);
  });

  it("never targets a test database or runs next to a test database setting", () => {
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: url("localhost", "parents_portal_test"), MIGRATE_CONFIRM_DATABASE: "parents_portal_test" })), /test database/);
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: url("db.example", "x_test"), MIGRATE_CONFIRM_DATABASE: "x_test" })), /test database/);
    refuses(() => resolveTarget(["--production"], prodEnv({ TEST_DATABASE_URL: TEST })), /TEST_DATABASE_URL must not be set in production/);
  });

  it("refuses the ?host= trick, a non-PostgreSQL URL and a missing URL", () => {
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: `${REMOTE}?host=other.example` })), /unsupported connection option/);
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: `mysql://u:${PW}@db.example/railway` })), /postgres/);
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: undefined })), /DATABASE_URL is not set/);
  });

  it("does not use the test URL even when DATABASE_URL is absent", () => {
    refuses(() => resolveTarget(["--production"], { NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "parents_portal_test", TEST_DATABASE_URL: TEST }), /TEST_DATABASE_URL must not be set in production|DATABASE_URL is not set/);
  });
});

describe("how a migration failure is reported", () => {
  it("always says something: a refused connection to localhost has an empty message", () => {
    const refused = Object.assign(new AggregateError([Object.assign(new Error(""), { code: "ECONNREFUSED" }), Object.assign(new Error(""), { code: "ECONNREFUSED" })], ""), {});
    assert.equal(refused.message, "");
    assert.equal(describeError(refused), "ECONNREFUSED");
    assert.equal(describeError(Object.assign(new Error(""), { code: "ENOTFOUND" })), "ENOTFOUND");
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError(new Error("")), "unknown error");
    assert.equal(describeError(undefined), "unknown error");
  });
});

describe("migrations: production never uses the development database or weak TLS", () => {
  it("refuses parents_portal_dev, even when confirmed and opted in", () => {
    for (const host of ["postgres.railway.internal", "localhost"]) {
      refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: url(host, "parents_portal_dev"), MIGRATE_CONFIRM_DATABASE: "parents_portal_dev" })), /development database/);
    }
  });

  it("applies the same TLS rules as the server", () => {
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: url("db.internal.example", "railway") })), /sslmode=verify-full/);
    refuses(() => resolveTarget(["--production"], prodEnv({ DATABASE_URL: `${REMOTE}?sslmode=require` })), /sslmode/);
    refuses(() => resolveTarget(["--production"], prodEnv({ PGSSLMODE: "no-verify" })), /PGSSLMODE/);
    refuses(() => resolveTarget(["--production"], prodEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })), /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.equal(resolveTarget(["--production"], prodEnv({ DATABASE_URL: `${url("db.internal.example", "railway")}?sslmode=verify-full` })).production, true);
  });

  it("leaves the local development and test runs alone", () => {
    resolveTarget([], { DATABASE_URL: DEV, PGSSLMODE: "disable" });
    resolveTarget(["--test"], { TEST_DATABASE_URL: TEST, PGSSLMODE: "disable" });
  });
});
