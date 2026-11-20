import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import pg from "pg";
import { OpsError } from "../src/cli/ops.js";
import { resolveTarget } from "../src/db/migrate.js";
import { DatabaseTargetError, resolveDatabaseTarget, resolveStagingTarget } from "../src/db/target.js";
import { chooseTarget, main as opsMain } from "../scripts/ops.js";

// Staging is a database mode of its own. It uses ONLY STAGING_DATABASE_URL and has its own three switches, so production's
// variables can never authorise it and it can never fall back to anything else. Every test here is pure or mocked: nothing
// connects to a database, and a spy on the network layer proves a refused configuration opens no connection.

const PW = "s3cret-pw-value";
const USER = "stg_user_name";
const url = (host, db, extra = "") => `postgresql://${USER}:${PW}@${host}:5432/${db}${extra}`;
const STAGING = url("postgres.railway.internal", "railway");
const PROD = url("postgres.railway.internal", "railway"); // Railway's private DNS name is identical in every project
const LOCAL_DEV = url("localhost", "parents_portal_dev");
const LOCAL_TEST = url("localhost", "parents_portal_test");
const PROJECT = "1a2b3c4d-aaaa-bbbb-cccc-55555555555e";
const good = (over = {}) => ({ STAGING_DATABASE_URL: STAGING, ALLOW_STAGING_DATABASE: "true", STAGING_CONFIRM_DATABASE: "railway", STAGING_RAILWAY_PROJECT_ID: PROJECT, RAILWAY_PROJECT_ID: PROJECT, ...over });

const refuses = (fn, pattern) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error);
    const text = `${err.message}\n${err.stack ?? ""}`;
    for (const secret of [PW, USER, "railway.internal:5432"]) assert.ok(!text.includes(secret), `the error never repeats "${secret}"`);
    if (typeof pattern === "function") assert.ok(pattern(err), "the error is the expected kind");
    else if (pattern) assert.match(err.message, pattern);
    return true;
  });

let connectSpies;
beforeEach(() => {
  connectSpies = [
    mock.method(net.Socket.prototype, "connect", () => { throw new Error("a database connection was attempted"); }),
    mock.method(pg.Client.prototype, "connect", async () => { throw new Error("a database connection was attempted"); }),
    mock.method(pg.Pool.prototype, "connect", async () => { throw new Error("a database connection was attempted"); }),
    mock.method(pg.Pool.prototype, "query", async () => { throw new Error("a database connection was attempted"); }),
  ];
});
afterEach(() => mock.restoreAll());
const noConnection = () => assert.deepEqual(connectSpies.map((s) => s.mock.callCount()), [0, 0, 0, 0], "no connection was opened");

describe("staging target: what is accepted", () => {
  it("accepts the exact staging URL with all three switches", () => {
    const t = resolveStagingTarget(good());
    assert.deepEqual({ host: t.host, database: t.database, staging: t.staging }, { host: "postgres.railway.internal", database: "railway", staging: true });
    assert.equal(t.connectionString, STAGING);
    noConnection();
  });

  it("is accepted through the migration runner and the ops tool with --staging, in the real Railway environment", () => {
    const railway = good({ NODE_ENV: "production", DATABASE_URL: PROD, ALLOW_PRODUCTION_DATABASE: "true" });
    for (const t of [resolveTarget(["--staging"], railway), chooseTarget(["trip:list", "--staging"], railway)]) {
      assert.equal(t.envName, "STAGING_DATABASE_URL");
      assert.equal(t.staging, true);
      assert.equal(t.production, false);
      assert.equal(t.database, "railway");
      assert.equal(t.connectionString, STAGING);
    }
    noConnection();
  });

  it("accepts sslmode=verify-full and sslmode=disable, which the shared URL rules allow", () => {
    assert.equal(resolveStagingTarget(good({ STAGING_DATABASE_URL: `${STAGING}?sslmode=disable` })).database, "railway");
  });
});

describe("staging target: what is refused", () => {
  it("refuses a missing or empty STAGING_DATABASE_URL", () => {
    refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: undefined })), /STAGING_DATABASE_URL is not set/);
    refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: "" })), /STAGING_DATABASE_URL is not set/);
    noConnection();
  });

  it("refuses a missing or inexact ALLOW_STAGING_DATABASE", () => {
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      refuses(() => resolveStagingTarget(good({ ALLOW_STAGING_DATABASE: v })), /ALLOW_STAGING_DATABASE/);
    }
    noConnection();
  });

  it("refuses a missing or wrong STAGING_CONFIRM_DATABASE", () => {
    for (const v of [undefined, "", "Railway", "railway ", "parents_portal_dev", "postgres"]) {
      refuses(() => resolveStagingTarget(good({ STAGING_CONFIRM_DATABASE: v })), /STAGING_CONFIRM_DATABASE/);
    }
    noConnection();
  });

  it("refuses a URL naming another database", () => {
    for (const db of ["postgres", "parents_portal_dev", "parents_portal_test", "Railway", "railway2"]) {
      refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: url("postgres.railway.internal", db) })), /must name the database "railway"/);
    }
    noConnection();
  });

  it("refuses another host, including look-alikes and the public proxy", () => {
    const hosts = ["localhost", "127.0.0.1", "db.example.com", "api.railway.internal", "postgres.railway.internal.evil.com", "evilpostgres.railway.internal",
      "monorail.proxy.rlwy.net", "postgres.railway.internal.", "POSTGRES.RAILWAY.INTERNAL.example"];
    for (const h of hosts) refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: url(h, "railway") })), /must point at postgres\.railway\.internal/);
    // user-info trick: the host is what follows the last "@"
    refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: `postgresql://postgres.railway.internal@evil.example:5432/railway` })), /must point at/);
    noConnection();
  });

  it("refuses a malformed URL or another scheme", () => {
    for (const bad of ["not a url", "postgres.railway.internal/railway", "mysql://u:p@postgres.railway.internal:5432/railway", "postgresql://", "postgresql:///railway"]) {
      refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: bad })));
    }
    noConnection();
  });

  it("refuses URL options that could send the driver somewhere else", () => {
    for (const extra of ["?host=db.example.com", "?hostaddr=10.0.0.9", "?dbname=other", "?port=1", "?sslmode=no-verify", "?sslmode=disable&sslmode=verify-full"]) {
      refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: `${STAGING}${extra}` })));
    }
    noConnection();
  });

  it("refuses a %-escaped database name and any port other than 5432", () => {
    refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: "postgresql://u:p@postgres.railway.internal:5432/rail%77ay" })), /spelled exactly/);
    refuses(() => resolveStagingTarget(good({ STAGING_DATABASE_URL: "postgresql://u:p@postgres.railway.internal:6543/railway" })), /port 5432/);
    assert.equal(resolveStagingTarget(good({ STAGING_DATABASE_URL: "postgresql://u:p@postgres.railway.internal/railway" })).database, "railway");
    noConnection();
  });

  it("refuses settings that change TLS behind the URL's back", () => {
    refuses(() => resolveStagingTarget(good({ PGSSLMODE: "no-verify" })), /PGSSLMODE/);
    refuses(() => resolveStagingTarget(good({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })), /NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it("needs the Railway project id to match the expected id exactly (accepted when equal)", () => {
    assert.equal(resolveStagingTarget(good()).database, "railway");
    refuses(() => resolveStagingTarget(good({ RAILWAY_PROJECT_ID: "99999999-2222-3333-4444-555555555555" })), /not in the staging Railway project/);
    for (const v of [PROJECT.toUpperCase(), ` ${PROJECT}`, `${PROJECT} `, PROJECT.slice(1)]) {
      refuses(() => resolveStagingTarget(good({ RAILWAY_PROJECT_ID: v })), /not in the staging Railway project/);
    }
    noConnection();
  });

  it("refuses when the runtime RAILWAY_PROJECT_ID is missing or empty", () => {
    refuses(() => resolveStagingTarget(good({ RAILWAY_PROJECT_ID: undefined })), /RAILWAY_PROJECT_ID is not set/);
    refuses(() => resolveStagingTarget(good({ RAILWAY_PROJECT_ID: "" })), /RAILWAY_PROJECT_ID is not set/);
    noConnection();
  });

  it("refuses when the expected STAGING_RAILWAY_PROJECT_ID is missing or empty (two empty values are not a match)", () => {
    refuses(() => resolveStagingTarget(good({ STAGING_RAILWAY_PROJECT_ID: undefined })), /needs STAGING_RAILWAY_PROJECT_ID/);
    refuses(() => resolveStagingTarget(good({ STAGING_RAILWAY_PROJECT_ID: "" })), /needs STAGING_RAILWAY_PROJECT_ID/);
    refuses(() => resolveStagingTarget(good({ STAGING_RAILWAY_PROJECT_ID: "", RAILWAY_PROJECT_ID: "" })), /needs STAGING_RAILWAY_PROJECT_ID/);
    noConnection();
  });

  it("does not accept the project name in place of the id, and never prints either id", () => {
    const named = good({ RAILWAY_PROJECT_ID: undefined, RAILWAY_PROJECT_NAME: "parents-portal-staging", STAGING_RAILWAY_PROJECT_ID: "parents-portal-staging" });
    refuses(() => resolveStagingTarget(named), /RAILWAY_PROJECT_ID is not set/);
    for (const over of [{ RAILWAY_PROJECT_ID: "other-project-id-value" }, { RAILWAY_PROJECT_ID: undefined }, { STAGING_RAILWAY_PROJECT_ID: undefined }]) {
      assert.throws(() => resolveStagingTarget(good(over)), (e) => !e.message.includes(PROJECT) && !e.message.includes("other-project-id-value"));
    }
    noConnection();
  });

  it("the project check applies through the migration runner and the ops tool too, with no fallback to DATABASE_URL", () => {
    const env = good({ RAILWAY_PROJECT_ID: "another-project", DATABASE_URL: PROD, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true" });
    refuses(() => resolveTarget(["--staging"], env), /not in the staging Railway project/);
    refuses(() => chooseTarget(["trip:list", "--staging"], env), (e) => e instanceof OpsError && /not in the staging Railway project/.test(e.message));
    refuses(() => resolveTarget(["--staging"], { ...env, STAGING_DATABASE_URL: undefined }), /STAGING_DATABASE_URL is not set/);
    noConnection();
  });
});

describe("staging target: no fallback and no borrowed authority", () => {
  it("never falls back to DATABASE_URL, even when the staging URL is missing or invalid", () => {
    const withOthers = { DATABASE_URL: STAGING, TEST_DATABASE_URL: LOCAL_TEST, ALLOW_STAGING_DATABASE: "true", STAGING_CONFIRM_DATABASE: "railway", NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true" };
    refuses(() => resolveStagingTarget(withOthers), /STAGING_DATABASE_URL is not set/);
    refuses(() => resolveStagingTarget({ ...withOthers, STAGING_DATABASE_URL: "garbage" }));
    refuses(() => resolveTarget(["--staging"], withOthers), /STAGING_DATABASE_URL is not set/);
    refuses(() => chooseTarget(["trip:list", "--staging"], withOthers), /STAGING_DATABASE_URL is not set/);
    noConnection();
  });

  it("never falls back to the local development or test configuration", () => {
    const local = { DATABASE_URL: LOCAL_DEV, TEST_DATABASE_URL: LOCAL_TEST, ALLOW_STAGING_DATABASE: "true", STAGING_CONFIRM_DATABASE: "railway" };
    refuses(() => resolveTarget(["--staging"], local), /STAGING_DATABASE_URL is not set/);
    refuses(() => resolveTarget(["--staging"], { ...local, STAGING_DATABASE_URL: LOCAL_DEV }), /must point at postgres\.railway\.internal/);
    refuses(() => resolveTarget(["--staging"], { ...local, STAGING_DATABASE_URL: LOCAL_TEST }), /must point at postgres\.railway\.internal/);
    noConnection();
  });

  it("is not authorised by the production variables (or the confirmations of the migration or ops tools)", () => {
    const prodOnly = { STAGING_DATABASE_URL: STAGING, NODE_ENV: "production", DATABASE_URL: PROD, ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "railway", OPS_CONFIRM_DATABASE: "railway" };
    refuses(() => resolveStagingTarget(prodOnly), /ALLOW_STAGING_DATABASE/);
    refuses(() => resolveTarget(["--staging"], prodOnly), /ALLOW_STAGING_DATABASE/);
    refuses(() => chooseTarget(["trip:list", "--staging"], prodOnly), (e) => e instanceof OpsError);
    refuses(() => resolveStagingTarget({ ...prodOnly, ALLOW_STAGING_DATABASE: "true" }), /STAGING_CONFIRM_DATABASE/);
    noConnection();
  });

  it("is not enabled by the staging variables alone: without --staging nothing changes", () => {
    const stagingOnly = good();
    refuses(() => resolveTarget([], stagingOnly), /DATABASE_URL is not set/);
    refuses(() => chooseTarget(["trip:list"], stagingOnly), (e) => e instanceof OpsError);
    refuses(() => resolveTarget(["--production"], stagingOnly), /--production requires NODE_ENV=production/);
    refuses(() => resolveTarget(["--test"], stagingOnly), /TEST_DATABASE_URL is not set/);
  });

  it("production mode never uses the staging configuration, even when both are present", () => {
    const REAL = url("prod-db.railway.internal", "company_live");
    const both = { ...good(), NODE_ENV: "production", DATABASE_URL: REAL, ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "company_live" };
    const t = resolveTarget(["--production"], both);
    assert.equal(t.connectionString, REAL);
    assert.equal(t.database, "company_live");
    assert.equal(t.staging, undefined);
    assert.equal(resolveDatabaseTarget(both).connectionString, REAL);
    // and with the production confirmation wrong, it refuses instead of looking at the staging variables
    refuses(() => resolveTarget(["--production"], { ...both, MIGRATE_CONFIRM_DATABASE: "railway" }), /MIGRATE_CONFIRM_DATABASE/);
  });

  it("the default (development) mode never uses the staging configuration", () => {
    const t = resolveTarget([], { ...good(), DATABASE_URL: LOCAL_DEV });
    assert.equal(t.connectionString, LOCAL_DEV);
    assert.equal(t.staging, undefined);
  });
});

describe("staging flag combinations", () => {
  it("refuses --staging together with --production, --test or both", () => {
    const env = { ...good(), NODE_ENV: "production", DATABASE_URL: PROD, ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "railway", TEST_DATABASE_URL: LOCAL_TEST };
    for (const argv of [["--staging", "--production"], ["--production", "--staging"], ["--staging", "--test"], ["--test", "--staging"], ["--staging", "--test", "--production"]]) {
      refuses(() => resolveTarget(argv, env), /cannot be combined/);
      refuses(() => chooseTarget(["trip:list", ...argv], env), (e) => e instanceof OpsError && /cannot be combined/.test(e.message));
    }
    refuses(() => resolveTarget(["--test", "--production"], env), /--test and --production cannot be combined/);
    noConnection();
  });
});

describe("a refused staging configuration opens no connection (ops tool, end to end)", () => {
  it("main() stops before it creates a pool", async () => {
    const seen = [];
    const log = mock.method(console, "log", (...a) => seen.push(a.join(" ")));
    const cases = [
      [{}, /STAGING_DATABASE_URL|ALLOW_STAGING/],
      [good({ ALLOW_STAGING_DATABASE: undefined }), /ALLOW_STAGING_DATABASE/],
      [good({ STAGING_DATABASE_URL: url("db.example.com", "railway") }), /must point at/],
      [{ DATABASE_URL: STAGING, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "railway" }, /ALLOW_STAGING_DATABASE|STAGING_DATABASE_URL/],
    ];
    for (const [env, pattern] of cases) {
      await assert.rejects(() => opsMain(["trip:list", "--staging"], env), (err) => {
        assert.ok(err instanceof OpsError);
        assert.match(err.message, pattern);
        assert.ok(!err.message.includes(PW) && !err.message.includes(USER));
        return true;
      });
    }
    log.mock.restore();
    assert.deepEqual(seen, [], "nothing is printed before the target is accepted");
    noConnection();
  });
});

describe("operations CLI: validation completes before any command runs (trip:create, portal:bind)", () => {
  const TRIP_CREATE = ["trip:create", "--school", "Test School", "--branch", "Jaipur", "--title", "Jaipur Test", "--type", "domestic", "--payment", "none", "--year", "2027-28", "--new-school"];
  const PORTAL_BIND = ["portal:bind", "test-school/jaipur/jaipur-test"];
  const dbCalls = () => connectSpies[2].mock.callCount() + connectSpies[3].mock.callCount();
  const quiet = () => {
    const seen = [];
    mock.method(console, "log", (...a) => seen.push(a.join(" ")));
    return seen;
  };

  it("with a missing or wrong staging variable, no banner, no pool query, no command handler: for both commands", async () => {
    const seen = quiet();
    const base = good();
    const wrong = [
      { ALLOW_STAGING_DATABASE: undefined }, { ALLOW_STAGING_DATABASE: "false" },
      { STAGING_CONFIRM_DATABASE: undefined }, { STAGING_CONFIRM_DATABASE: "postgres" },
      { STAGING_DATABASE_URL: undefined }, { STAGING_DATABASE_URL: url("db.example.com", "railway") }, { STAGING_DATABASE_URL: url("postgres.railway.internal", "postgres") },
      { STAGING_RAILWAY_PROJECT_ID: undefined }, { RAILWAY_PROJECT_ID: undefined }, { RAILWAY_PROJECT_ID: "another-project" }, { RAILWAY_PROJECT_ID: "" },
    ];
    for (const command of [TRIP_CREATE, PORTAL_BIND]) {
      for (const over of wrong) {
        await assert.rejects(() => opsMain([...command, "--staging"], { ...base, ...over }), (err) => err instanceof OpsError && !err.message.includes(PW) && !err.message.includes(USER));
      }
    }
    assert.deepEqual(seen, [], "no banner and no command output");
    assert.equal(dbCalls(), 0, "no query reached the database layer");
    noConnection();
  });

  it("--staging with --production or --test is refused before anything runs, whatever else is set", async () => {
    const seen = quiet();
    const env = { ...good(), NODE_ENV: "production", DATABASE_URL: PROD, ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "railway", TEST_DATABASE_URL: LOCAL_TEST };
    for (const command of [TRIP_CREATE, PORTAL_BIND]) {
      for (const extra of [["--production"], ["--test"], ["--test", "--production"]]) {
        await assert.rejects(() => opsMain([...command, "--staging", ...extra], env), (err) => err instanceof OpsError && /cannot be combined/.test(err.message));
        await assert.rejects(() => opsMain([...command, ...extra, "--staging"], env), (err) => err instanceof OpsError && /cannot be combined/.test(err.message));
      }
    }
    assert.deepEqual(seen, []);
    assert.equal(dbCalls(), 0);
    noConnection();
  });

  it("with no staging variables, a local or production configuration is never used by --staging", async () => {
    const seen = quiet();
    const envs = [
      { DATABASE_URL: LOCAL_DEV, TEST_DATABASE_URL: LOCAL_TEST },
      { DATABASE_URL: PROD, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "railway", MIGRATE_CONFIRM_DATABASE: "railway" },
      { DATABASE_URL: PROD, RAILWAY_PROJECT_ID: PROJECT, STAGING_RAILWAY_PROJECT_ID: PROJECT, ALLOW_STAGING_DATABASE: "true", STAGING_CONFIRM_DATABASE: "railway" },
    ];
    for (const env of envs) {
      for (const command of [TRIP_CREATE, PORTAL_BIND]) {
        await assert.rejects(() => opsMain([...command, "--staging"], env), (err) => err instanceof OpsError && /ALLOW_STAGING_DATABASE|STAGING_DATABASE_URL is not set/.test(err.message));
      }
    }
    assert.deepEqual(seen, []);
    assert.equal(dbCalls(), 0);
    noConnection();
  });

  it("with a valid staging configuration the order is: validate, print the banner, and only then the first query, on STAGING_DATABASE_URL (never DATABASE_URL)", async () => {
    const events = [];
    mock.method(console, "log", (...a) => events.push(`log:${a.join(" ")}`));
    const used = [];
    // The database layer is replaced: it records which address the pool was built for and refuses to connect.
    pg.Pool.prototype.query.mock.mockImplementation(async function () {
      events.push("query");
      used.push(this.options.connectionString);
      throw new Error("a database connection was attempted");
    });
    const env = { ...good(), NODE_ENV: "production", DATABASE_URL: url("postgres.railway.internal", "some_other_db"), ALLOW_PRODUCTION_DATABASE: "true" };
    for (const command of [PORTAL_BIND, TRIP_CREATE]) {
      events.length = 0;
      used.length = 0;
      await assert.rejects(() => opsMain([...command, "--staging"], env), /a database connection was attempted/);
      assert.match(events[0], /^log:Using THE STAGING DATABASE: railway on postgres\.railway\.internal \(STAGING_DATABASE_URL\)\.$/);
      assert.ok(events.indexOf("query") > 0, "the first query comes after the banner");
      assert.ok(used.length > 0 && used.every((c) => c === STAGING), "every query is on the staging address");
      assert.ok(events.every((e) => !e.includes(PW) && !e.includes(USER)), "the banner shows no credentials");
    }
  });

  it("--staging is removed from the command's own arguments, so no handler sees it", async () => {
    mock.method(console, "log", () => {});
    pg.Pool.prototype.query.mock.mockImplementation(async () => { throw new Error("a database connection was attempted"); });
    // A command that would reject an unknown option proves the flag was consumed, not passed on: portal:status takes none.
    await assert.rejects(() => opsMain(["portal:status", "--staging"], good()), /a database connection was attempted/);
  });
});

describe("migration runner and operations CLI share one set of staging rules", () => {
  it("accept and refuse exactly the same configurations, with the same reasons", () => {
    const REAL = good();
    const matrix = [
      REAL, {}, good({ ALLOW_STAGING_DATABASE: "no" }), good({ STAGING_CONFIRM_DATABASE: "x" }), good({ RAILWAY_PROJECT_ID: "x" }),
      good({ RAILWAY_PROJECT_ID: undefined }), good({ STAGING_RAILWAY_PROJECT_ID: undefined }), good({ STAGING_DATABASE_URL: url("localhost", "railway") }),
      good({ STAGING_DATABASE_URL: url("postgres.railway.internal", "railway", "?host=evil") }), good({ STAGING_DATABASE_URL: "nonsense" }),
      good({ STAGING_DATABASE_URL: "postgresql://u:p@postgres.railway.internal:6543/railway" }), good({ PGSSLMODE: "prefer" }),
      { ...REAL, DATABASE_URL: LOCAL_DEV, NODE_ENV: "development" }, { ...REAL, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", DATABASE_URL: PROD },
      { DATABASE_URL: PROD, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "railway", OPS_CONFIRM_DATABASE: "railway" },
    ];
    const outcome = (fn) => { try { const t = fn(); return { ok: true, host: t.host, database: t.database, connectionString: t.connectionString, staging: t.staging, production: t.production }; } catch (e) { return { ok: false, message: e.message }; } };
    for (const env of matrix) {
      const viaMigrate = outcome(() => resolveTarget(["--staging"], env));
      const viaOps = outcome(() => chooseTarget(["trip:list", "--staging"], env));
      const viaCore = outcome(() => resolveStagingTarget(env));
      assert.equal(viaMigrate.ok, viaOps.ok, "same decision");
      assert.equal(viaMigrate.ok, viaCore.ok, "same decision as the shared resolver");
      if (viaMigrate.ok) {
        assert.deepEqual(viaMigrate, viaOps);
        assert.equal(viaMigrate.connectionString, viaCore.connectionString);
      } else {
        assert.equal(viaMigrate.message, viaOps.message, "same reason");
        assert.equal(viaMigrate.message, viaCore.message, "same reason as the shared resolver");
      }
    }
    noConnection();
  });

  it("both are wired to the one resolver in the source, and neither has a second staging path", async () => {
    const { readFile } = await import("node:fs/promises");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrate = await readFile(path.join(here, "../src/db/migrate.js"), "utf8");
    const ops = await readFile(path.join(here, "../scripts/ops.js"), "utf8");
    assert.equal((migrate.match(/resolveStagingTarget\(/g) ?? []).length, 1);
    assert.match(ops, /resolveTarget\(argv/, "ops goes through resolveTarget, which owns the staging branch");
    assert.doesNotMatch(ops, /STAGING_DATABASE_URL\s*[\]\.]/, "ops reads no staging variable itself");
    for (const src of [migrate, ops]) assert.doesNotMatch(src, /env\.STAGING_(DATABASE_URL|CONFIRM_DATABASE|RAILWAY_PROJECT_ID)|env\.ALLOW_STAGING_DATABASE/, "the variables are read in one place only (target.js)");
  });
});

describe("the migration runner as a real process", () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db/migrate.js");
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20000 });

  it("refuses bad staging configurations before connecting, with exit code 1 and no secret in the output", () => {
    const bad = [
      [["--staging"], {}],
      [["--staging"], { DATABASE_URL: STAGING, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", MIGRATE_CONFIRM_DATABASE: "railway" }],
      [["--staging"], good({ STAGING_DATABASE_URL: url("db.example.com", "railway") })],
      [["--staging"], good({ STAGING_DATABASE_URL: url("postgres.railway.internal", "postgres") })],
      [["--staging"], good({ STAGING_CONFIRM_DATABASE: "nope" })],
      [["--staging"], good({ RAILWAY_PROJECT_ID: "another-project" })],
      [["--staging"], good({ RAILWAY_PROJECT_ID: undefined })],
      [["--staging"], good({ STAGING_RAILWAY_PROJECT_ID: undefined })],
      [["--staging", "--production"], good()],
    ];
    for (const [args, env] of bad) {
      const r = run(args, env);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /^Migration error: /);
      assert.ok(!r.stdout.includes("Connected"), "no connection message");
      for (const secret of [PW, USER]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
    }
  });
});

it("the error class for refusals is the shared one", () => {
  assert.throws(() => resolveStagingTarget({}), DatabaseTargetError);
});
