import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import { defaultGateOptions } from "../src/modules/auth/work-gate.js";

const valid = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://parents_portal_app:pw@localhost:5432/parents_portal_dev",
  OTP_HMAC_SECRET: "a".repeat(64),
  OTP_DELIVERY: "dev-console",
};
// Production may no longer use the development database, so the tests that load a production configuration use this one.
const PROD_DB = "postgresql://parents_portal_app:pw@localhost:5432/portal_prod";

describe("loadConfig", () => {
  it("applies the agreed defaults", () => {
    const c = loadConfig(valid);
    assert.equal(c.otp.ttlSeconds, 300);
    assert.equal(c.otp.staffTtlSeconds, 900, "staff codes live 15 minutes by default; the parents' stay at 5");
    assert.equal(c.otp.resendCooldownSeconds, 30);
    assert.equal(c.otp.maxAttempts, 5);
    assert.equal(c.otp.verificationTokenTtlSeconds, 900);
    assert.equal(c.port, 4000);
  });

  it("lets the staff code lifetime be tuned within bounds, without touching the parents' one", () => {
    const c = loadConfig({ ...valid, STAFF_OTP_TTL_SECONDS: "600" });
    assert.equal(c.otp.staffTtlSeconds, 600);
    assert.equal(c.otp.ttlSeconds, 300);
    assert.equal(loadConfig({ ...valid, OTP_TTL_SECONDS: "120" }).otp.staffTtlSeconds, 900);
    for (const bad of ["59", "1801", "abc", "0"]) assert.throws(() => loadConfig({ ...valid, STAFF_OTP_TTL_SECONDS: bad }), ConfigError, bad);
  });

  it("defaults the password sign-in limits and lets them be tuned within bounds", () => {
    assert.deepEqual(loadConfig(valid).auth.passwordLogin, { windowSeconds: 900, maxPerEmail: 5, maxPerIp: 20 });
    assert.equal(loadConfig({ ...valid, PASSWORD_LOGIN_MAX_ATTEMPTS_PER_EMAIL: "3" }).auth.passwordLogin.maxPerEmail, 3);
    assert.throws(() => loadConfig({ ...valid, PASSWORD_LOGIN_MAX_ATTEMPTS_PER_EMAIL: "0" }), ConfigError);
  });

  it("sizes the password-hashing gate from the machine by default, and lets each limit be tuned within bounds", () => {
    assert.deepEqual(loadConfig(valid).passwordHashing, defaultGateOptions());
    assert.deepEqual(loadConfig({ ...valid, PASSWORD_HASH_CONCURRENCY: "2" }).passwordHashing, { concurrency: 2, maxQueue: defaultGateOptions().maxQueue });
    assert.deepEqual(loadConfig({ ...valid, PASSWORD_HASH_QUEUE: "", PASSWORD_HASH_CONCURRENCY: "" }).passwordHashing, defaultGateOptions(), "an empty value means unset, never 0");
    assert.deepEqual(loadConfig({ ...valid, PASSWORD_HASH_QUEUE: "0" }).passwordHashing, { concurrency: defaultGateOptions().concurrency, maxQueue: 0 });
    for (const [key, bad] of [["PASSWORD_HASH_CONCURRENCY", "0"], ["PASSWORD_HASH_CONCURRENCY", "65"], ["PASSWORD_HASH_QUEUE", "-1"], ["PASSWORD_HASH_QUEUE", "10001"], ["PASSWORD_HASH_QUEUE", "x"]]) {
      assert.throws(() => loadConfig({ ...valid, [key]: bad }), ConfigError, `${key}=${bad}`);
    }
  });

  describe("PDF storage in Google Drive", () => {
    const DRIVE = { PDF_STORAGE: "google-drive", GOOGLE_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-value", GOOGLE_DRIVE_REFRESH_TOKEN: "refresh-token-value", GOOGLE_DRIVE_ACCOUNT: "Dest@Example.com" };

    it("is off by default and needs nothing, so the portal works locally without any Google setup", () => {
      assert.deepEqual(loadConfig(valid).pdfStorage, { mode: "disabled", drive: null, missing: [], rootName: "Young Edsplorer" });
    });

    it("reads the destination account and credentials from the environment (the account is normalised, never hard-coded)", () => {
      const c = loadConfig({ ...valid, ...DRIVE, GOOGLE_DRIVE_ROOT_FOLDER_NAME: "YE Registrations" }).pdfStorage;
      assert.equal(c.mode, "google-drive");
      assert.deepEqual(c.missing, []);
      assert.deepEqual(c.drive, { clientId: DRIVE.GOOGLE_OAUTH_CLIENT_ID, clientSecret: DRIVE.GOOGLE_OAUTH_CLIENT_SECRET, refreshToken: DRIVE.GOOGLE_DRIVE_REFRESH_TOKEN, account: "dest@example.com" });
      assert.equal(c.rootName, "YE Registrations");
    });

    it("a missing credential does not stop the server: it is named (never its value) and storage stays unconfigured", () => {
      for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN", "GOOGLE_DRIVE_ACCOUNT"]) {
        const c = loadConfig({ ...valid, ...DRIVE, [key]: "" }).pdfStorage;
        assert.equal(c.drive, null, key);
        assert.deepEqual(c.missing, [key]);
        assert.ok(!JSON.stringify(c).includes("client-secret-value") && !JSON.stringify(c).includes("refresh-token-value"));
      }
      assert.deepEqual(loadConfig({ ...valid, PDF_STORAGE: "google-drive" }).pdfStorage.missing, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN", "GOOGLE_DRIVE_ACCOUNT"]);
    });

    it("credentials set while storage is off are ignored (and never copied into the configuration)", () => {
      const c = loadConfig({ ...valid, ...DRIVE, PDF_STORAGE: "disabled" }).pdfStorage;
      assert.equal(c.drive, null);
      assert.ok(!JSON.stringify(c).includes("client-secret-value"));
    });

    it("rejects an unknown mode, a malformed account and an unsafe folder name, without echoing the values", () => {
      for (const bad of [{ PDF_STORAGE: "dropbox" }, { ...DRIVE, GOOGLE_DRIVE_ACCOUNT: "not-an-email" }, { ...DRIVE, GOOGLE_DRIVE_ROOT_FOLDER_NAME: "bad/name" }, { ...DRIVE, GOOGLE_DRIVE_ROOT_FOLDER_NAME: "x".repeat(81) }, { ...DRIVE, GOOGLE_OAUTH_CLIENT_SECRET: "line\nbreak" }]) {
        assert.throws(() => loadConfig({ ...valid, ...bad }), (err) => {
          assert.ok(err instanceof ConfigError);
          for (const secret of ["client-secret-value", "refresh-token-value", "line\nbreak"]) assert.ok(!err.message.includes(secret), err.message);
          return true;
        });
      }
    });
  });

  describe("sign-in lifetimes", () => {
    it("defaults: 15-minute access tokens; parents 3 days of inactivity / 7 days at most; staff 2 hours / 8 hours; 20 s race grace", () => {
      const c = loadConfig(valid);
      assert.deepEqual([c.auth.accessTtlSeconds, c.auth.idleTimeoutSeconds, c.auth.sessionTtlSeconds, c.auth.reuseGraceSeconds], [900, 259200, 604800, 20]);
      assert.deepEqual([c.staff.accessTtlSeconds, c.staff.idleTimeoutSeconds, c.staff.sessionTtlSeconds, c.staff.reuseGraceSeconds], [900, 7200, 28800, 20]);
    });

    it("each can be configured", () => {
      const c = loadConfig({ ...valid, PARENT_ACCESS_TOKEN_TTL_SECONDS: "600", PARENT_SESSION_IDLE_TIMEOUT_SECONDS: "86400", SESSION_TTL_SECONDS: "172800", STAFF_ACCESS_TOKEN_TTL_SECONDS: "300", STAFF_SESSION_IDLE_TIMEOUT_SECONDS: "3600", STAFF_SESSION_TTL_SECONDS: "14400", REFRESH_REUSE_GRACE_SECONDS: "10" });
      assert.deepEqual([c.auth.accessTtlSeconds, c.auth.idleTimeoutSeconds, c.auth.sessionTtlSeconds], [600, 86400, 172800]);
      assert.deepEqual([c.staff.accessTtlSeconds, c.staff.idleTimeoutSeconds, c.staff.sessionTtlSeconds, c.staff.reuseGraceSeconds], [300, 3600, 14400, 10]);
    });

    it("setting only the absolute limit (as before) still works: unset shorter limits are capped to fit inside it", () => {
      const c = loadConfig({ ...valid, STAFF_SESSION_TTL_SECONDS: "600" });
      assert.deepEqual([c.staff.accessTtlSeconds, c.staff.idleTimeoutSeconds, c.staff.sessionTtlSeconds], [600, 600, 600]);
      const p = loadConfig({ ...valid, SESSION_TTL_SECONDS: "3600" });
      assert.deepEqual([p.auth.accessTtlSeconds, p.auth.idleTimeoutSeconds, p.auth.sessionTtlSeconds], [900, 3600, 3600]);
    });

    it("refuses limits that don't nest (access <= inactivity <= absolute) or are out of range", () => {
      for (const bad of [
        { PARENT_ACCESS_TOKEN_TTL_SECONDS: "3600", PARENT_SESSION_IDLE_TIMEOUT_SECONDS: "1800" },
        { PARENT_SESSION_IDLE_TIMEOUT_SECONDS: "700000" },
        { STAFF_SESSION_IDLE_TIMEOUT_SECONDS: "30000" },
        { STAFF_ACCESS_TOKEN_TTL_SECONDS: "30" },
        { PARENT_ACCESS_TOKEN_TTL_SECONDS: "7200" },
        { REFRESH_REUSE_GRACE_SECONDS: "600" },
      ]) assert.throws(() => loadConfig({ ...valid, ...bad }), ConfigError, JSON.stringify(bad));
    });
  });

  it("defaults the staff and public-link settings", () => {
    const c = loadConfig(valid);
    assert.equal(c.staff.sessionTtlSeconds, 28800);
    assert.equal(c.staff.cookieSecure, false);
    assert.equal(c.staff.publicBaseUrl, null);
    assert.deepEqual(c.staff.joinLookups, { windowSeconds: 60, max: 30 });
    assert.deepEqual(c.staff.login, c.auth.passwordLogin);
    assert.equal(loadConfig({ ...valid, STAFF_SESSION_TTL_SECONDS: "600" }).staff.sessionTtlSeconds, 600);
    assert.throws(() => loadConfig({ ...valid, STAFF_SESSION_TTL_SECONDS: "10" }), ConfigError);
  });

  describe("per-variant registration link hosts", () => {
    const names = {
      domestic_payment: "PUBLIC_BASE_URL_DOMESTIC_PAYMENT",
      domestic_none: "PUBLIC_BASE_URL_DOMESTIC_NONE",
      international_payment: "PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT",
      international_none: "PUBLIC_BASE_URL_INTERNATIONAL_NONE",
    };

    it("are optional: unset (or empty) means null for every template key, and PUBLIC_BASE_URL is untouched", () => {
      const c = loadConfig({ ...valid, PUBLIC_BASE_URL: "https://fallback.example.test", PUBLIC_BASE_URL_DOMESTIC_NONE: "" });
      assert.deepEqual(c.staff.publicBaseUrls, { domestic_payment: null, domestic_none: null, international_payment: null, international_none: null });
      assert.equal(c.staff.publicBaseUrl, "https://fallback.example.test");
    });

    it("read one variable per existing template key, and drop a trailing slash", () => {
      const env = { ...valid };
      for (const [key, name] of Object.entries(names)) env[name] = `https://${key.replace("_", "-")}.example.test/`;
      const c = loadConfig(env);
      for (const key of Object.keys(names)) assert.equal(c.staff.publicBaseUrls[key], `https://${key.replace("_", "-")}.example.test`, key);
      assert.deepEqual(Object.keys(c.staff.publicBaseUrls).sort(), Object.keys(names).sort(), "exactly the four template keys, no invented ones");
    });

    it("one variant can be set while the others stay null", () => {
      const c = loadConfig({ ...valid, PUBLIC_BASE_URL: "https://fallback.example.test", PUBLIC_BASE_URL_INTERNATIONAL_NONE: "https://intl-free.example.test" });
      assert.equal(c.staff.publicBaseUrls.international_none, "https://intl-free.example.test");
      assert.equal(c.staff.publicBaseUrls.domestic_none, null);
    });

    describe("whitespace in the value", () => {
      const all = ["PUBLIC_BASE_URL", ...Object.values(names)];
      const stored = (name, value) => {
        const env = { ...valid, PUBLIC_BASE_URL: "https://fallback.example.test", [name]: value };
        const c = loadConfig(env).staff;
        return name === "PUBLIC_BASE_URL" ? c.publicBaseUrl : c.publicBaseUrls[Object.keys(names).find((k) => names[k] === name)];
      };

      it("leading and trailing spaces, tabs and newlines are trimmed before checking and storing", () => {
        for (const name of all) {
          for (const raw of [" https://x.example.test", "https://x.example.test ", "  https://x.example.test/  ", "\thttps://x.example.test\t", "https://x.example.test\n", "\r\nhttps://x.example.test/\r\n"]) {
            assert.equal(stored(name, raw), "https://x.example.test", `${name} ${JSON.stringify(raw)}`);
          }
        }
      });

      it("a value that is only whitespace counts as not set (like an empty one)", () => {
        for (const name of Object.values(names)) {
          const c = loadConfig({ ...valid, PUBLIC_BASE_URL: "https://fallback.example.test", [name]: "   \n\t " }).staff;
          assert.equal(Object.values(c.publicBaseUrls).filter(Boolean).length, 0);
        }
        assert.equal(loadConfig({ ...valid, PUBLIC_BASE_URL: " \t " }).staff.publicBaseUrl, null);
      });

      it("embedded whitespace, tabs and line breaks are refused, without echoing the value", () => {
        for (const name of all) {
          for (const bad of ["https://x.exam ple.test", "https://x.example.test\nhttps://y.example.test", "https://x.exa\tmple.test", "https://x.exam\rple.test", "https://x.example.test /", "https://x.example\u00a0.test"]) {
            assert.throws(
              () => loadConfig({ ...valid, [name]: bad }),
              (err) => err instanceof ConfigError && err.message.includes(name) && !/x\.exam|y\.example|ple\.test/.test(err.message),
              `${name} ${JSON.stringify(bad)}`,
            );
          }
        }
      });

      it("a valid origin with a trailing slash is still accepted and normalised, and the other rules are unchanged", () => {
        for (const name of all) assert.equal(stored(name, "https://x.example.test/"), "https://x.example.test");
        for (const bad of ["ftp://x.example.test", "https://x.example.test/path", "https://x.example.test/?a=1", "https://u:p@x.example.test", "javascript:alert(1)"]) {
          assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL_DOMESTIC_NONE: ` ${bad} ` }), ConfigError, bad);
        }
      });
    });

    describe("incomplete configuration is refused at start", () => {
      it("only some variants set and no PUBLIC_BASE_URL: refused, naming exactly the missing variables and never a value", () => {
        const env = { ...valid, PUBLIC_BASE_URL_DOMESTIC_NONE: "https://domestic-free.example.test", PUBLIC_BASE_URL_INTERNATIONAL_NONE: "https://international-free.example.test" };
        assert.throws(
          () => loadConfig(env),
          (err) =>
            err instanceof ConfigError &&
            err.message.includes("PUBLIC_BASE_URL_DOMESTIC_PAYMENT") &&
            err.message.includes("PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT") &&
            !err.message.includes("PUBLIC_BASE_URL_DOMESTIC_NONE") &&
            !err.message.includes("PUBLIC_BASE_URL_INTERNATIONAL_NONE") &&
            !err.message.includes("example.test"),
        );
      });

      it("the same partial set is fine when PUBLIC_BASE_URL is the fallback", () => {
        const c = loadConfig({ ...valid, PUBLIC_BASE_URL: "https://fallback.example.test", PUBLIC_BASE_URL_DOMESTIC_NONE: "https://domestic-free.example.test" }).staff;
        assert.equal(c.publicBaseUrls.domestic_none, "https://domestic-free.example.test");
        assert.equal(c.publicBaseUrl, "https://fallback.example.test");
      });

      it("all four set without a fallback is fine; so is only the legacy PUBLIC_BASE_URL; so is nothing at all", () => {
        const four = Object.fromEntries(Object.values(names).map((n, i) => [n, `https://portal-${i}.example.test`]));
        assert.equal(loadConfig({ ...valid, ...four }).staff.publicBaseUrl, null);
        assert.equal(loadConfig({ ...valid, PUBLIC_BASE_URL: "https://legacy.example.test" }).staff.publicBaseUrl, "https://legacy.example.test");
        assert.equal(loadConfig(valid).staff.publicBaseUrl, null);
      });

      it("a single configured variant without a fallback leaves three missing (also in development)", () => {
        assert.throws(
          () => loadConfig({ ...valid, NODE_ENV: "development", PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT: "https://x.example.test" }),
          (e) => e instanceof ConfigError && /PUBLIC_BASE_URL_DOMESTIC_PAYMENT/.test(e.message) && /PUBLIC_BASE_URL_DOMESTIC_NONE/.test(e.message) && /PUBLIC_BASE_URL_INTERNATIONAL_NONE/.test(e.message),
        );
      });
    });

    it("accept only an http(s) origin, exactly like PUBLIC_BASE_URL, naming the variable and never the value", () => {
      for (const name of Object.values(names)) {
        for (const bad of ["noscheme-host.test", "ftp://x.example.com", "https://x.example.com/path", "https://x.example.com/?a=1", "https://u:p@x.example.com", "javascript:alert(1)"]) {
          assert.throws(() => loadConfig({ ...valid, [name]: bad }), (err) => err instanceof ConfigError && err.message.includes(name) && !err.message.includes(bad), `${name}=${bad}`);
        }
      }
    });
  });

  it("accepts PUBLIC_BASE_URL only as an http(s) origin, and drops a trailing slash", () => {
    assert.equal(loadConfig({ ...valid, PUBLIC_BASE_URL: "https://parents.example.com/" }).staff.publicBaseUrl, "https://parents.example.com");
    assert.equal(loadConfig({ ...valid, PUBLIC_BASE_URL: "" }).staff.publicBaseUrl, null);
    for (const bad of ["noscheme-host.test", "ftp://x.example.com", "https://x.example.com/path", "https://x.example.com/?a=1", "javascript:alert(1)"]) {
      assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL: bad }), ConfigError, bad);
    }
  });

  it("marks staff cookies Secure in production", () => {
    const prod = { ...valid, ...BINDING, DATABASE_URL: PROD_DB, NODE_ENV: "production", OTP_DELIVERY: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@example.com" };
    assert.equal(loadConfig(prod).staff.cookieSecure, true);
  });

  it("refuses a database that is not on this machine", () => {
    const env = { ...valid, DATABASE_URL: "postgresql://u:pw@erp.internal.example:5432/erp" };
    assert.throws(() => loadConfig(env), ConfigError);
  });

  it("accepts 127.0.0.1", () => {
    loadConfig({ ...valid, DATABASE_URL: "postgresql://u:pw@127.0.0.1:5432/parents_portal_dev" });
  });

  it("refuses the dev-console sender outside development", () => {
    for (const NODE_ENV of ["production", "test"]) {
      assert.throws(() => loadConfig({ ...valid, DATABASE_URL: PROD_DB, NODE_ENV }), /only allowed when NODE_ENV=development/);
    }
  });

  it("refuses an unknown or missing delivery method (no silent default)", () => {
    assert.throws(() => loadConfig({ ...valid, OTP_DELIVERY: "email" }), ConfigError);
    const { OTP_DELIVERY, ...without } = valid;
    assert.throws(() => loadConfig(without), ConfigError);
  });

  it("rejects a weak HMAC secret without echoing it", () => {
    const weak = "short-secret-value";
    assert.throws(
      () => loadConfig({ ...valid, OTP_HMAC_SECRET: weak }),
      (err) => err instanceof ConfigError && !err.message.includes(weak),
    );
  });

  it("never echoes the database password in errors", () => {
    const env = { ...valid, DATABASE_URL: "postgresql://u:supersecretpw@remote.example:5432/x" };
    assert.throws(
      () => loadConfig(env),
      (err) => err instanceof ConfigError && !err.message.includes("supersecretpw"),
    );
  });
});

const smtpEnv = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "mailer-user",
  SMTP_PASSWORD: "mailer-password-value",
  SMTP_FROM: "Young Edsplorer <no-reply@example.com>",
};
const smtp = { ...valid, OTP_DELIVERY: "smtp", ...smtpEnv };

describe("loadConfig: SMTP delivery", () => {
  it("parses a complete SMTP configuration", () => {
    const c = loadConfig(smtp);
    assert.equal(c.delivery, "smtp");
    assert.deepEqual(c.smtp, {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "mailer-user",
      pass: "mailer-password-value",
      from: "Young Edsplorer <no-reply@example.com>",
    });
  });

  it("parses SMTP_SECURE=true and allows production (SMTP is the production path)", () => {
    const c = loadConfig({ ...smtp, ...BINDING, DATABASE_URL: PROD_DB, NODE_ENV: "production", SMTP_SECURE: "true", SMTP_PORT: "465" });
    assert.equal(c.smtp.secure, true);
    assert.equal(c.smtp.port, 465);
  });

  it("accepts a bare address as SMTP_FROM", () => {
    assert.equal(loadConfig({ ...smtp, SMTP_FROM: "no-reply@example.com" }).smtp.from, "no-reply@example.com");
  });

  for (const key of Object.keys(smtpEnv)) {
    it(`fails loudly, naming ${key}, when it is missing (never falls back to console)`, () => {
      const env = { ...smtp };
      delete env[key];
      assert.throws(() => loadConfig(env), (err) => err instanceof ConfigError && err.message.includes(key) && /not falling back/.test(err.message));
    });

    it(`treats an empty ${key} as missing`, () => {
      assert.throws(() => loadConfig({ ...smtp, [key]: "" }), (err) => err instanceof ConfigError && err.message.includes(key));
    });
  }

  it("rejects malformed values and never echoes the password", () => {
    for (const bad of [
      { SMTP_SECURE: "yes" },
      { SMTP_PORT: "99999" },
      { SMTP_PORT: "abc" },
      { SMTP_HOST: "smtp.example.com/evil" },
      { SMTP_FROM: "not-an-address" },
      { SMTP_FROM: "a@example.com\r\nBcc: attacker@example.com" },
      { SMTP_USER: "user\nname" },
    ]) {
      assert.throws(() => loadConfig({ ...smtp, ...bad }), ConfigError, JSON.stringify(bad));
    }
    assert.throws(
      () => loadConfig({ ...smtp, SMTP_PORT: "abc" }),
      (err) => !err.message.includes("mailer-password-value") && !err.message.includes("mailer-user"),
    );
  });

  it("refuses dev-console when SMTP settings are present, instead of choosing for you", () => {
    assert.throws(
      () => loadConfig({ ...valid, ...smtpEnv }),
      (err) => err instanceof ConfigError && err.message.includes("SMTP_HOST") && !err.message.includes("mailer-password-value"),
    );
  });

  it("allows dev-console when the SMTP_* variables are blank", () => {
    loadConfig({ ...valid, SMTP_HOST: "", SMTP_PASSWORD: "" });
  });
});

// Railway: where the server listens, and which database a production process may use.
const SMTP = { OTP_DELIVERY: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@example.com" };
// Production must say PORTAL_BINDING_REQUIRED=true and carry at least one portal secret (see "production and portal binding" below).
const BINDING = { PORTAL_BINDING_REQUIRED: "true", PORTAL_PROXY_SECRET_DOMESTIC_NONE: "p".repeat(40) };
const railway = (over = {}) => ({
  ...valid,
  ...SMTP,
  ...BINDING,
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://postgres:db-pw-value@postgres.railway.internal:5432/railway",
  ALLOW_PRODUCTION_DATABASE: "true",
  ...over,
});

describe("where the server listens", () => {
  it("development and test listen on this machine only, as before", () => {
    assert.equal(loadConfig(valid).host, "127.0.0.1");
    assert.equal(loadConfig({ ...valid, ...SMTP, NODE_ENV: "test" }).host, "127.0.0.1");
  });

  it("production listens on every interface (no host, so Node binds all of them)", () => {
    assert.equal(loadConfig(railway()).host, null);
  });

  it("HOST overrides either default, but only with an IP address", () => {
    assert.equal(loadConfig({ ...valid, HOST: "0.0.0.0" }).host, "0.0.0.0");
    assert.equal(loadConfig({ ...valid, HOST: "::" }).host, "::");
    assert.equal(loadConfig(railway({ HOST: "127.0.0.1" })).host, "127.0.0.1");
    assert.equal(loadConfig({ ...valid, HOST: "" }).host, "127.0.0.1", "an empty value counts as not set");
    for (const bad of ["localhost", "example.com", "0.0.0.0/0", "999.1.1.1", "127.0.0.1:4000", " 0.0.0.0"]) {
      assert.throws(() => loadConfig({ ...valid, HOST: bad }), ConfigError, bad);
    }
  });

  it("reads the port Railway injects", () => {
    assert.equal(loadConfig(railway({ PORT: "8080" })).port, 8080);
    assert.throws(() => loadConfig(railway({ PORT: "0" })), ConfigError);
    assert.throws(() => loadConfig(railway({ PORT: "70000" })), ConfigError);
  });
});

describe("the production database", () => {
  it("is accepted on another host only with NODE_ENV=production and the explicit opt-in", () => {
    const c = loadConfig(railway());
    assert.equal(c.databaseUrl, railway().DATABASE_URL);
    assert.equal(c.nodeEnv, "production");
    assert.throws(() => loadConfig(railway({ ALLOW_PRODUCTION_DATABASE: undefined })), /ALLOW_PRODUCTION_DATABASE=true/);
    assert.throws(() => loadConfig(railway({ ALLOW_PRODUCTION_DATABASE: "1" })), /must be exactly "true"/);
  });

  it("is never accepted on another host outside production, whatever else is set", () => {
    for (const NODE_ENV of ["development", "test"]) {
      assert.throws(() => loadConfig({ ...valid, NODE_ENV, DATABASE_URL: railway().DATABASE_URL, ALLOW_PRODUCTION_DATABASE: "true" }), /must point at localhost or 127.0.0.1/, NODE_ENV);
    }
    const { NODE_ENV, ...unset } = railway();
    assert.throws(() => loadConfig({ ...unset, OTP_DELIVERY: "dev-console" }), ConfigError, "no NODE_ENV means development");
  });

  it("never runs production on a test database or next to the test database setting", () => {
    assert.throws(() => loadConfig(railway({ TEST_DATABASE_URL: "postgresql://u:pw@localhost:5432/parents_portal_test" })), /TEST_DATABASE_URL must not be set in production/);
    assert.throws(() => loadConfig(railway({ DATABASE_URL: "postgresql://u:pw@postgres.railway.internal:5432/parents_portal_test" })), /test database/);
  });

  it("refuses the ?host= trick that fools a plain host check", () => {
    assert.throws(() => loadConfig({ ...valid, DATABASE_URL: "postgresql://u:pw@localhost:5432/parents_portal_dev?host=erp.internal.example" }), ConfigError);
  });

  it("still needs everything else: a missing secret, a missing URL, or the console sender", () => {
    assert.throws(() => loadConfig(railway({ OTP_HMAC_SECRET: undefined })), ConfigError);
    assert.throws(() => loadConfig(railway({ DATABASE_URL: undefined })), ConfigError);
    assert.throws(() => loadConfig(railway({ OTP_DELIVERY: "dev-console" })), /only allowed when NODE_ENV=development/);
  });

  it("never echoes the database password in an error", () => {
    for (const over of [{ ALLOW_PRODUCTION_DATABASE: undefined }, { TEST_DATABASE_URL: "x" }, { DATABASE_URL: "mysql://postgres:db-pw-value@h/railway" }, { DATABASE_URL: "postgresql://postgres:db-pw-value@h/railway?host=x" }]) {
      assert.throws(() => loadConfig(railway(over)), (err) => err instanceof ConfigError && !err.message.includes("db-pw-value"), JSON.stringify(Object.keys(over)));
    }
  });
});

describe("the production database: development database and TLS", () => {
  it("never runs production on the development database, on any host", () => {
    for (const host of ["postgres.railway.internal", "localhost"]) {
      assert.throws(() => loadConfig(railway({ DATABASE_URL: `postgresql://u:db-pw-value@${host}:5432/parents_portal_dev` })), (err) => err instanceof ConfigError && /development database/.test(err.message) && !err.message.includes("db-pw-value"), host);
    }
    loadConfig({ ...valid }); // development still uses it
  });

  it("applies the TLS rules: verify-full or Railway's private host, no weakening settings", () => {
    const url = (host, q = "") => `postgresql://u:db-pw-value@${host}:5432/railway${q}`;
    assert.throws(() => loadConfig(railway({ DATABASE_URL: url("db.internal.example") })), /sslmode=verify-full/);
    loadConfig(railway({ DATABASE_URL: url("db.internal.example", "?sslmode=verify-full") }));
    assert.throws(() => loadConfig(railway({ DATABASE_URL: url("postgres.railway.internal", "?sslmode=require") })), /sslmode/);
    assert.throws(() => loadConfig(railway({ PGSSLMODE: "no-verify" })), /PGSSLMODE/);
    assert.throws(() => loadConfig(railway({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })), /NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe("Stage 2 settings: proxy, pool, shutdown, frontend", () => {
  it("defaults: no trusted proxy, safe pool timeouts, frontend served only in production", () => {
    const c = loadConfig(valid);
    assert.equal(c.trustProxyHops, 0);
    assert.deepEqual(c.db, { max: 10, connectionTimeoutMs: 5000, idleTimeoutMs: 30000, statementTimeoutMs: 15000, idleInTransactionTimeoutMs: 30000 });
    assert.equal(c.shutdownGraceMs, 10000);
    assert.equal(c.serveFrontend, false);
    assert.equal(loadConfig({ ...valid, ...BINDING, NODE_ENV: "production", DATABASE_URL: PROD_DB, OTP_DELIVERY: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@example.com" }).serveFrontend, true);
  });

  it("SERVE_FRONTEND: on by default in production only, and an explicit value always wins (the API service sets it to false)", () => {
    const prodEnv = { ...railway() };
    assert.equal(loadConfig({ ...prodEnv, SERVE_FRONTEND: undefined }).serveFrontend, true, "the production default is on");
    assert.equal(loadConfig({ ...prodEnv, SERVE_FRONTEND: "false" }).serveFrontend, false);
    assert.equal(loadConfig({ ...prodEnv, SERVE_FRONTEND: "true" }).serveFrontend, true);
    assert.equal(loadConfig({ ...valid, SERVE_FRONTEND: undefined }).serveFrontend, false, "development default is off");
    assert.equal(loadConfig({ ...valid, SERVE_FRONTEND: "true" }).serveFrontend, true, "local opt-in still works");
    assert.equal(loadConfig({ ...valid, SERVE_FRONTEND: "false" }).serveFrontend, false);
  });

  it("accepts only whole, bounded values (never a boolean or a negative hop count)", () => {
    assert.equal(loadConfig({ ...valid, TRUST_PROXY_HOPS: "1" }).trustProxyHops, 1);
    for (const bad of ["-1", "true", "6", "1.5", "abc"]) assert.throws(() => loadConfig({ ...valid, TRUST_PROXY_HOPS: bad }), ConfigError, bad);
    for (const key of ["DB_POOL_MAX", "DB_CONNECTION_TIMEOUT_MS", "DB_IDLE_TIMEOUT_MS", "DB_STATEMENT_TIMEOUT_MS", "SHUTDOWN_GRACE_MS"]) {
      for (const bad of ["0", "-5", "x"]) assert.throws(() => loadConfig({ ...valid, [key]: bad }), ConfigError, `${key}=${bad}`);
    }
    assert.throws(() => loadConfig({ ...valid, SERVE_FRONTEND: "yes" }), ConfigError);
  });
});

describe("production and portal binding", () => {
  it("production refuses to start when PORTAL_BINDING_REQUIRED is missing, and says what to set", () => {
    assert.throws(() => loadConfig(railway({ PORTAL_BINDING_REQUIRED: undefined })), /NODE_ENV=production requires PORTAL_BINDING_REQUIRED=true/);
    assert.throws(() => loadConfig(railway({ PORTAL_BINDING_REQUIRED: "" })), ConfigError);
  });

  it("production refuses PORTAL_BINDING_REQUIRED=false", () => {
    assert.throws(() => loadConfig(railway({ PORTAL_BINDING_REQUIRED: "false" })), /PORTAL_BINDING_REQUIRED=false is not allowed when NODE_ENV=production/);
  });

  it("production refuses any other value (a typo never turns enforcement off)", () => {
    for (const bad of ["TRUE", "yes", "1", " true"]) assert.throws(() => loadConfig(railway({ PORTAL_BINDING_REQUIRED: bad })), ConfigError, bad);
  });

  it("production with true and a portal secret starts, and enforces", () => {
    const c = loadConfig(railway());
    assert.equal(c.nodeEnv, "production");
    assert.equal(c.portalSecrets.domestic_none, "p".repeat(40));
    assert.equal(c.staff.requireBinding, true);
  });

  it("production with true but no portal secret still refuses (nobody could register)", () => {
    assert.throws(() => loadConfig(railway({ PORTAL_PROXY_SECRET_DOMESTIC_NONE: undefined })), /needs at least one portal secret/);
  });

  it("the error never prints a secret value", () => {
    try {
      loadConfig(railway({ PORTAL_BINDING_REQUIRED: "false" }));
      assert.fail("should refuse");
    } catch (err) {
      assert.doesNotMatch(String(err.message), /p{40}|db-pw-value/);
    }
  });

  it("development and test keep working with the variable missing or false, and enforce only when true", () => {
    for (const NODE_ENV of ["development", "test"]) {
      for (const value of [undefined, "false", "true"]) {
        const env = { ...valid, ...(NODE_ENV === "test" ? SMTP : {}), NODE_ENV, PORTAL_BINDING_REQUIRED: value };
        if (value === "true") env.PORTAL_PROXY_SECRET_DOMESTIC_NONE = "p".repeat(40);
        assert.equal(loadConfig(env).staff.requireBinding, value === "true", `${NODE_ENV}/${value}`);
      }
    }
  });
});
