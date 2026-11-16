import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseTargetError, assertLocalDatabaseUrl, parseDatabaseUrl, resolveDatabaseTarget } from "../src/db/target.js";

// Which database a process may use. Local work (development and tests) may only ever touch a database on this machine.
// Production may use another host (Railway's PostgreSQL), but only when it is told so on purpose, and never a test database.

const PW = "s3cret-pw-value";
const url = (host, db = "app", query = "") => `postgresql://app_user:${PW}@${host}:5432/${db}${query}`;
const prod = (over = {}) => ({ NODE_ENV: "production", DATABASE_URL: url("postgres.railway.internal", "railway"), ALLOW_PRODUCTION_DATABASE: "true", ...over });
const dev = (over = {}) => ({ NODE_ENV: "development", DATABASE_URL: url("localhost", "parents_portal_dev"), ...over });
const refuses = (fn, pattern) =>
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DatabaseTargetError, `expected DatabaseTargetError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.ok(!err.message.includes(PW), "the password is never repeated in an error");
    if (pattern) assert.match(err.message, pattern);
    return true;
  });

describe("parseDatabaseUrl", () => {
  it("reads host and database, and says whether the host is on this machine", () => {
    assert.deepEqual(
      (({ host, database, local }) => ({ host, database, local }))(parseDatabaseUrl(url("localhost", "parents_portal_dev"))),
      { host: "localhost", database: "parents_portal_dev", local: true },
    );
    assert.equal(parseDatabaseUrl(url("127.0.0.1")).local, true);
    assert.equal(parseDatabaseUrl(url("[::1]")).local, true);
    const remote = parseDatabaseUrl(url("postgres.railway.internal", "railway"));
    assert.equal(remote.local, false);
    assert.equal(remote.database, "railway");
  });

  it("accepts both PostgreSQL schemes and the harmless connection options", () => {
    parseDatabaseUrl("postgres://u:p@localhost:5432/app");
    parseDatabaseUrl(url("localhost", "app", "?sslmode=disable&application_name=portal&connect_timeout=5"));
  });

  it("refuses anything that is not a single PostgreSQL database URL", () => {
    for (const bad of [undefined, "", "not a url", "mysql://u:p@localhost/app", "http://localhost/app", "file:///tmp/app", "postgresql:///app", "postgresql://u:p@localhost:5432/", "postgresql://u:p@localhost:5432"]) {
      refuses(() => parseDatabaseUrl(bad), undefined);
    }
    refuses(() => parseDatabaseUrl(url("h1.example,h2.example")), /exactly one/);
  });

  it("refuses connection options that could send the driver somewhere other than the URL says", () => {
    // The driver lets ?host= override the host in the URL, so "localhost" in the URL proves nothing.
    for (const key of ["host", "hostaddr", "dbname", "database", "port", "user", "password", "service", "options"]) {
      refuses(() => parseDatabaseUrl(url("localhost", "parents_portal_dev", `?${key}=evil.example`)), /unsupported connection option/);
    }
  });

  it("refuses a URL that the driver would read differently from how it looks", () => {
    refuses(() => parseDatabaseUrl(url("loc%61lhost")), undefined); // looks remote, driver decodes it to localhost
  });

  it("never repeats the password, whatever is wrong", () => {
    for (const bad of [`mysql://u:${PW}@localhost/app`, `postgresql://u:${PW}@/app`, `postgresql://u:${PW}@localhost:5432/app?host=x`, `postgresql://u:${PW}@a,b/app`]) {
      refuses(() => parseDatabaseUrl(bad), undefined);
    }
  });
});

describe("assertLocalDatabaseUrl (used by the local tools: staff script, catalog cleanup)", () => {
  it("accepts a database on this machine and refuses every other host", () => {
    assertLocalDatabaseUrl(url("localhost"));
    assertLocalDatabaseUrl(url("127.0.0.1"));
    assert.throws(() => assertLocalDatabaseUrl(url("erp.internal.example")), /must point at localhost or 127.0.0.1 \(got "erp.internal.example"\)/);
    assert.throws(() => assertLocalDatabaseUrl(url("localhost", "parents_portal_dev", "?host=erp.internal.example")), /unsupported connection option/);
  });

  it("still takes a label for its message", () => {
    assert.throws(() => assertLocalDatabaseUrl(url("erp.internal.example"), "TEST_DATABASE_URL"), /TEST_DATABASE_URL must point at localhost/);
  });
});

describe("resolveDatabaseTarget: development and test", () => {
  it("allows a database on this machine", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const t = resolveDatabaseTarget(dev({ NODE_ENV }));
      assert.equal(t.production, false);
      assert.equal(t.local, true);
    }
  });

  it("treats a missing or unrecognised NODE_ENV as development, so a remote host is refused", () => {
    for (const NODE_ENV of [undefined, "", "Production", "prod", "staging", " production"]) {
      refuses(() => resolveDatabaseTarget({ ...prod(), NODE_ENV }), /must point at localhost or 127.0.0.1/);
    }
  });

  it("refuses a database on another host, even if the production opt-in is set", () => {
    refuses(() => resolveDatabaseTarget({ ...prod(), NODE_ENV: "development" }), /must point at localhost or 127.0.0.1/);
    refuses(() => resolveDatabaseTarget({ ...prod(), NODE_ENV: "test" }), /must point at localhost or 127.0.0.1/);
  });

  it("refuses the ?host= trick", () => {
    refuses(() => resolveDatabaseTarget(dev({ DATABASE_URL: url("localhost", "parents_portal_dev", "?host=erp.internal.example") })), /unsupported connection option/);
  });

  it("refuses a missing DATABASE_URL", () => {
    refuses(() => resolveDatabaseTarget({ NODE_ENV: "development" }), /DATABASE_URL is not set/);
  });
});

describe("resolveDatabaseTarget: production", () => {
  it("accepts another host only with the explicit opt-in", () => {
    const t = resolveDatabaseTarget(prod());
    assert.equal(t.production, true);
    assert.equal(t.local, false);
    assert.equal(t.database, "railway");
    refuses(() => resolveDatabaseTarget(prod({ ALLOW_PRODUCTION_DATABASE: undefined })), /ALLOW_PRODUCTION_DATABASE=true/);
    refuses(() => resolveDatabaseTarget(prod({ ALLOW_PRODUCTION_DATABASE: "" })), /ALLOW_PRODUCTION_DATABASE=true/);
  });

  it("accepts only the exact value true for the opt-in, everywhere", () => {
    for (const v of ["yes", "1", "TRUE", "True", " true", "false", "on"]) {
      refuses(() => resolveDatabaseTarget(prod({ ALLOW_PRODUCTION_DATABASE: v })), /must be exactly "true"/);
      refuses(() => resolveDatabaseTarget(dev({ ALLOW_PRODUCTION_DATABASE: v })), /must be exactly "true"/);
    }
  });

  it("allows a database on this machine without the opt-in", () => {
    resolveDatabaseTarget(prod({ DATABASE_URL: url("localhost", "portal_prod"), ALLOW_PRODUCTION_DATABASE: undefined }));
  });

  it("never lets production use the test database setting", () => {
    refuses(() => resolveDatabaseTarget(prod({ TEST_DATABASE_URL: url("localhost", "parents_portal_test") })), /TEST_DATABASE_URL must not be set in production/);
    refuses(() => resolveDatabaseTarget(prod({ TEST_DATABASE_URL: "anything" })), /TEST_DATABASE_URL must not be set in production/);
    resolveDatabaseTarget(prod({ TEST_DATABASE_URL: "" })); // an empty value counts as not set
  });

  it("never lets production run on a database named like a test database", () => {
    for (const db of ["parents_portal_test", "anything_test", "PARENTS_PORTAL_TEST"]) {
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("db.internal.example", db) })), /test database/);
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("localhost", db), ALLOW_PRODUCTION_DATABASE: undefined })), /test database/);
    }
  });

  it("refuses the ?host= trick even with the opt-in", () => {
    refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("db.internal.example", "railway", "?host=other.example") })), /unsupported connection option/);
  });

  it("refuses a URL that is not PostgreSQL, or is missing", () => {
    refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: `mysql://u:${PW}@db.internal.example/railway` })), /postgres/);
    refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: undefined })), /DATABASE_URL is not set/);
  });
});

describe("resolveDatabaseTarget: production never uses the development database", () => {
  it("refuses parents_portal_dev on any host, with or without the opt-in, whatever the case", () => {
    for (const db of ["parents_portal_dev", "PARENTS_PORTAL_DEV", "Parents_Portal_Dev"]) {
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("postgres.railway.internal", db) })), /development database/);
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("localhost", db), ALLOW_PRODUCTION_DATABASE: undefined })), /development database/);
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url("127.0.0.1", db) })), /development database/);
    }
  });

  it("still allows it in development and test (the local setup is unchanged)", () => {
    for (const NODE_ENV of ["development", "test"]) resolveDatabaseTarget(dev({ NODE_ENV, DATABASE_URL: url("localhost", "parents_portal_dev") }));
  });

  it("only refuses that exact name, not every name that contains it", () => {
    resolveDatabaseTarget(prod({ DATABASE_URL: url("postgres.railway.internal", "parents_portal_dev2") }));
    resolveDatabaseTarget(prod({ DATABASE_URL: url("postgres.railway.internal", "parents_portal") }));
  });
});

describe("database TLS settings", () => {
  // The driver treats allow/prefer/require/verify-ca as full verification today but will change them to weaker libpq
  // meanings in its next major version, and no-verify / uselibpqcompat turn verification off. Only two settings are
  // unambiguous: disable (no TLS) and verify-full (TLS that verifies the certificate and the host name).
  it("accepts no sslmode, disable and verify-full", () => {
    parseDatabaseUrl(url("localhost"));
    parseDatabaseUrl(url("localhost", "app", "?sslmode=disable"));
    parseDatabaseUrl(url("db.example", "app", "?sslmode=verify-full"));
  });

  it("refuses every other sslmode, because each is ambiguous or weaker", () => {
    for (const mode of ["require", "prefer", "allow", "verify-ca", "no-verify", "REQUIRE", "VERIFY-FULL", "Disable", "", "bogus", "true", "1"]) {
      refuses(() => parseDatabaseUrl(url("localhost", "app", `?sslmode=${mode}`)), /sslmode/);
    }
  });

  it("refuses the other ways of changing TLS behaviour in a URL", () => {
    for (const q of ["?ssl=true", "?ssl=1", "?ssl=false", "?uselibpqcompat=true", "?sslmode=verify-full&uselibpqcompat=true", "?sslrootcert=/tmp/x.pem", "?sslcert=x", "?sslkey=x", "?sslcrl=x"]) {
      refuses(() => parseDatabaseUrl(url("localhost", "app", q)), /unsupported connection option/);
    }
  });

  it("explains the refusal without repeating the password", () => {
    refuses(() => parseDatabaseUrl(url("localhost", "app", "?sslmode=require")), /verify-full/);
  });

  it("refuses a connection option given more than once (the driver uses the last, a check would read the first)", () => {
    for (const q of ["?sslmode=disable&sslmode=no-verify", "?sslmode=verify-full&sslmode=disable", "?sslmode=verify-full&sslmode=verify-full", "?sslmode=no-verify&sslmode=verify-full", "?application_name=a&application_name=b", "?connect_timeout=5&connect_timeout=6"]) {
      refuses(() => parseDatabaseUrl(url("localhost", "app", q)), /more than once/);
    }
  });
});

describe("resolveDatabaseTarget: production TLS policy", () => {
  it("accepts Railway's private network host without sslmode (that network is encrypted), or with disable or verify-full", () => {
    for (const q of ["", "?sslmode=disable", "?sslmode=verify-full"]) {
      resolveDatabaseTarget(prod({ DATABASE_URL: url("postgres.railway.internal", "railway", q) }));
      resolveDatabaseTarget(prod({ DATABASE_URL: url("my-db.railway.internal", "railway", q) }));
    }
  });

  it("requires sslmode=verify-full for any other host that is not on this machine", () => {
    for (const host of ["db.internal.example", "postgres.proxy.rlwy.net", "203.0.113.9", "railway.internal", "postgres.railway.internal.", "postgres.railway.internal.evil.example", "evilrailway.internal"]) {
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url(host, "railway") })), /sslmode=verify-full/);
      refuses(() => resolveDatabaseTarget(prod({ DATABASE_URL: url(host, "railway", "?sslmode=disable") })), /sslmode=verify-full/);
      resolveDatabaseTarget(prod({ DATABASE_URL: url(host, "railway", "?sslmode=verify-full") }));
    }
  });

  it("does not apply that rule to a database on this machine", () => {
    resolveDatabaseTarget(prod({ DATABASE_URL: url("localhost", "portal_prod"), ALLOW_PRODUCTION_DATABASE: undefined }));
  });

  it("refuses environment settings that would silently weaken TLS", () => {
    refuses(() => resolveDatabaseTarget(prod({ PGSSLMODE: "no-verify" })), /PGSSLMODE/);
    refuses(() => resolveDatabaseTarget(prod({ PGSSLMODE: "require" })), /PGSSLMODE/);
    refuses(() => resolveDatabaseTarget(prod({ PGSSLMODE: "disable" })), /PGSSLMODE/);
    refuses(() => resolveDatabaseTarget(prod({ PGSSLMODE: "verify-full" })), /PGSSLMODE/);
    refuses(() => resolveDatabaseTarget(prod({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })), /NODE_TLS_REJECT_UNAUTHORIZED/);
    resolveDatabaseTarget(prod({ PGSSLMODE: "" }));
    resolveDatabaseTarget(prod({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }));
    resolveDatabaseTarget(prod({ NODE_TLS_REJECT_UNAUTHORIZED: undefined }));
  });

  it("leaves those environment settings alone outside production (local work is unchanged)", () => {
    resolveDatabaseTarget(dev({ PGSSLMODE: "disable", NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  });
});
