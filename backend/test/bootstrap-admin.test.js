import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BootstrapError, bootstrapFirstAdmin } from "../src/modules/staff/bootstrap.js";
import { createPasswordHasher } from "../src/modules/auth/password.js";
import { createStaff } from "../src/modules/staff/provision.js";
import { runBootstrap } from "../scripts/bootstrap-admin.js";
import { TEST_SCRYPT_COST, createTestPool, resetTables } from "./helpers.js";
import { startApp } from "./harness.js";

const pool = createTestPool();
const passwords = createPasswordHasher({ cost: TEST_SCRYPT_COST });
beforeEach(() => resetTables(pool));
after(() => pool.end());

const staffRows = async () => (await pool.query("SELECT * FROM staff_users")).rows;
const audit = async () => (await pool.query("SELECT * FROM audit_log ORDER BY id")).rows;
const prod = { NODE_ENV: "production", BOOTSTRAP_ADMIN_ENABLED: "true", ALLOW_PRODUCTION_DATABASE: "true", DATABASE_URL: "postgresql://u:p@localhost:5432/portal_prod" };
const scripted = (...answers) => { const q = [...answers]; return { ask: async () => q.shift(), askHidden: async () => { throw new Error("must never ask for a password"); } }; };

describe("bootstrapFirstAdmin (service)", () => {
  it("creates one pending admin with NO password and writes an audit row", async () => {
    const made = await bootstrapFirstAdmin(pool, { email: "Owner@Example.com", name: "Olive Owner" });
    assert.equal(made.email, "owner@example.com");
    const [row] = await staffRows();
    assert.equal(row.role, "admin");
    assert.equal(row.password_hash, null);
    const [a] = await audit();
    assert.equal(a.action, "staff.bootstrap_admin");
    assert.equal(a.staff_email, "owner@example.com");
    assert.equal(a.entity_id, row.id);
    assert.doesNotMatch(JSON.stringify(a), /password|token|secret/i);
  });

  it("replay: a second run is refused, nothing changes, and the refusal is audited", async () => {
    await bootstrapFirstAdmin(pool, { email: "owner@example.com", name: "Olive" });
    await assert.rejects(bootstrapFirstAdmin(pool, { email: "attacker@example.com", name: "Mallory" }), (e) => e instanceof BootstrapError && /already/i.test(e.message));
    assert.equal((await staffRows()).length, 1);
    assert.deepEqual((await audit()).map((r) => r.action), ["staff.bootstrap_admin", "staff.bootstrap_refused"]);
  });

  it("is refused when ANY staff account exists, even a sales one or a disabled admin", async () => {
    await createStaff(pool, passwords, { email: "a@example.com", name: "A", role: "admin", password: "long-enough-password-1" });
    await pool.query("UPDATE staff_users SET disabled_at = now()");
    await assert.rejects(bootstrapFirstAdmin(pool, { email: "b@example.com", name: "B" }), BootstrapError);
    assert.equal((await staffRows()).length, 1);
  });

  it("race: concurrent runs create exactly one admin", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => bootstrapFirstAdmin(pool, { email: `race${i}@example.com`, name: "Racer" })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await staffRows()).length, 1);
  });

  it("validates the email and name", async () => {
    await assert.rejects(bootstrapFirstAdmin(pool, { email: "not-an-email", name: "X" }), BootstrapError);
    await assert.rejects(bootstrapFirstAdmin(pool, { email: "a@example.com", name: "" }), BootstrapError);
    assert.equal((await staffRows()).length, 0);
  });

  it("the pending admin can sign in only after setting a password by emailed code (no sign-in with an empty password)", async () => {
    const app = await startApp({ db: pool });
    try {
      await bootstrapFirstAdmin(pool, { email: "owner@example.com", name: "Olive" });
      for (const password of ["", "password", "null", "undefined"]) {
        const r = await app.api.post("/api/admin/auth/login", { email: "owner@example.com", password });
        assert.ok([400, 401].includes(r.status), `password ${JSON.stringify(password)} -> ${r.status}`);
      }
      const set = await app.staffSetPassword("owner@example.com", "a-brand-new-passphrase-9");
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.equal((await app.api.post("/api/admin/auth/login", { email: "owner@example.com", password: "a-brand-new-passphrase-9" })).status, 200);
    } finally { await app.close(); }
  });
});

describe("bootstrap-admin CLI guards", () => {
  const run = (env, answers, db = pool) => runBootstrap({ env, db, prompt: scripted(...answers), log: () => {} });

  it("needs production, the explicit enable switch and the production-database opt-in", async () => {
    await assert.rejects(run({ ...prod, NODE_ENV: "development" }, []), /NODE_ENV=production/);
    await assert.rejects(run({ ...prod, BOOTSTRAP_ADMIN_ENABLED: undefined }, []), /BOOTSTRAP_ADMIN_ENABLED/);
    await assert.rejects(run({ ...prod, BOOTSTRAP_ADMIN_ENABLED: "yes" }, []), /BOOTSTRAP_ADMIN_ENABLED/);
    await assert.rejects(run({ ...prod, ALLOW_PRODUCTION_DATABASE: undefined, DATABASE_URL: "postgresql://u:p@db.example.com/portal" }, []), /ALLOW_PRODUCTION_DATABASE|another host/);
    assert.equal((await staffRows()).length, 0);
  });

  it("refuses a test or development database even in production mode", async () => {
    await assert.rejects(run({ ...prod, DATABASE_URL: "postgresql://u:p@localhost/parents_portal_test" }, []), /test database/);
    await assert.rejects(run({ ...prod, DATABASE_URL: "postgresql://u:p@localhost/parents_portal_dev" }, []), /development database/);
  });

  it("needs the exact typed confirmation; anything else creates nothing", async () => {
    await assert.rejects(run(prod, ["owner@example.com", "Olive", "yes"]), /confirmation/i);
    await assert.rejects(run(prod, ["owner@example.com", "Olive", "BOOTSTRAP FIRST ADMIN other@example.com"]), /confirmation/i);
    assert.equal((await staffRows()).length, 0);
    assert.equal((await audit()).length, 0);
  });

  it("with the right confirmation creates one pending admin; running again is refused", async () => {
    const lines = [];
    await runBootstrap({ env: prod, db: pool, prompt: scripted("Owner@Example.com", "Olive", "BOOTSTRAP FIRST ADMIN owner@example.com"), log: (l) => lines.push(l) });
    assert.equal((await staffRows()).length, 1);
    assert.match(lines.join("\n"), /owner@example\.com/);
    await assert.rejects(run(prod, ["x@example.com", "X", "BOOTSTRAP FIRST ADMIN x@example.com"]), /already/i);
    assert.equal((await staffRows()).length, 1);
  });

  it("never asks for or prints a password, and the script is not reachable over HTTP", () => {
    const src = readFileSync(fileURLToPath(new URL("../scripts/bootstrap-admin.js", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /askHidden|process\.env\.[A-Z_]*PASSWORD/);
    const app = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
    assert.doesNotMatch(app, /bootstrap/i);
  });

  it("run as a program, it refuses outside production before touching any database", () => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/bootstrap-admin.js", import.meta.url))], {
      env: { PATH: process.env.PATH, NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@127.0.0.1:1/none" }, encoding: "utf8", input: "",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NODE_ENV=production/);
  });
});
