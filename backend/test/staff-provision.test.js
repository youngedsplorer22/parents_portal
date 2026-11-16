import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/staff.js";
import { createPasswordHasher } from "../src/modules/auth/password.js";
import { ProvisionError, createStaff, setStaffDisabled, setStaffPassword } from "../src/modules/staff/provision.js";
import { TEST_SCRYPT_COST, createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
const passwords = createPasswordHasher({ cost: TEST_SCRYPT_COST });
const PW = "provision-passphrase-1";
beforeEach(() => resetTables(pool));
after(() => pool.end());

const make = (over = {}) => createStaff(pool, passwords, { email: "admin@example.com", name: "Alex Admin", role: "admin", password: PW, ...over });
const rows = async () => (await pool.query("SELECT * FROM staff_users ORDER BY created_at")).rows;
const refused = (promise, pattern) =>
  assert.rejects(promise, (err) => err instanceof ProvisionError && pattern.test(err.message));

describe("createStaff: controlled creation", () => {
  it("creates the first admin with a scrypt hash, never the password", async () => {
    const made = await make();
    assert.equal(made.role, "admin");
    const [row] = await rows();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!JSON.stringify(row).includes(PW));
    assert.equal(row.email_normalized, "admin@example.com");
  });

  it("the first account must be an admin", async () => {
    await refused(make({ role: "sales" }), /first staff account must be an admin/);
    assert.equal((await rows()).length, 0);
  });

  it("a second admin needs the explicit confirmation flag; sales accounts don't", async () => {
    await make();
    await refused(make({ email: "second@example.com" }), /admin already exists/);
    await make({ email: "sales@example.com", role: "sales" });
    await make({ email: "second@example.com", allowAdditionalAdmin: true });
    assert.deepEqual((await rows()).map((r) => r.role), ["admin", "sales", "admin"]);
  });

  it("never overwrites an existing email, whatever its case", async () => {
    await make();
    await refused(make({ email: "ADMIN@example.com", role: "sales", allowAdditionalAdmin: true }), /already exists/);
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0].role, "admin");
  });

  it("racing first-admin creations produce exactly one account", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => make({ email: `admin${i}@example.com` })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await rows()).length, 1);
  });

  it("validates email, name, role and password", async () => {
    await refused(make({ email: "nope" }), /valid email/);
    await refused(make({ name: "   " }), /name/);
    await refused(make({ role: "root" }), /Role must be/);
    await refused(make({ password: "short" }), /at least 10/);
    await refused(make({ password: "password123" }), /too common/);
    await refused(make({ password: undefined }), /password is required/i);
    assert.equal((await rows()).length, 0);
  });
});

describe("disable, enable, set-password", () => {
  it("disabling ends sessions, and the last active admin can't be disabled", async () => {
    await make();
    await make({ email: "sales@example.com", role: "sales" });
    const { rows: [{ id }] } = await pool.query("SELECT id FROM staff_users WHERE role = 'sales'");
    await pool.query("INSERT INTO staff_sessions (staff_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [id, "a".repeat(64)]);

    await setStaffDisabled(pool, { email: "sales@example.com", disabled: true });
    assert.notEqual((await pool.query("SELECT disabled_at FROM staff_users WHERE id = $1", [id])).rows[0].disabled_at, null);
    assert.notEqual((await pool.query("SELECT revoked_at FROM staff_sessions")).rows[0].revoked_at, null);
    await refused(setStaffDisabled(pool, { email: "admin@example.com", disabled: true }), /no active admin/);
    assert.equal((await pool.query("SELECT disabled_at FROM staff_users WHERE role = 'admin'")).rows[0].disabled_at, null, "rolled back");

    await setStaffDisabled(pool, { email: "sales@example.com", disabled: false });
    assert.equal((await pool.query("SELECT disabled_at FROM staff_users WHERE id = $1", [id])).rows[0].disabled_at, null);
    await refused(setStaffDisabled(pool, { email: "ghost@example.com", disabled: true }), /No staff account/);
  });

  it("set-password replaces the hash, ends sessions and applies the password rules", async () => {
    await make();
    const before = (await rows())[0].password_hash;
    await refused(setStaffPassword(pool, passwords, { email: "admin@example.com", password: "short" }), /at least 10/);
    await setStaffPassword(pool, passwords, { email: "admin@example.com", password: "a-brand-new-passphrase" });
    const after = (await rows())[0].password_hash;
    assert.notEqual(after, before);
    assert.equal(await passwords.verify("a-brand-new-passphrase", after), true);
    await refused(setStaffPassword(pool, passwords, { email: "ghost@example.com", password: "a-brand-new-passphrase" }), /No staff account/);
  });
});

describe("the provisioning script's prompts", () => {
  const prompt = (answers) => {
    const queue = [...answers];
    return { ask: async () => queue.shift(), askHidden: async () => queue.shift() };
  };
  const logs = () => {
    const lines = [];
    return { lines, log: (m) => lines.push(m) };
  };

  it("creates an account from prompts and never prints the password", async () => {
    const out = logs();
    await run(["create", "admin"], { db: pool, passwords, prompt: prompt(["admin@example.com", "Alex Admin", PW, PW]), log: out.log });
    assert.equal((await rows()).length, 1);
    assert.match(out.lines.join("\n"), /Created admin account for admin@example.com/);
    assert.ok(!out.lines.join("\n").includes(PW));
  });

  it("refuses when the two passwords differ, creating nothing", async () => {
    await refused(run(["create", "admin"], { db: pool, passwords, prompt: prompt(["admin@example.com", "Alex", PW, PW + "x"]) }), /do not match/);
    assert.equal((await rows()).length, 0);
  });

  it("an additional admin needs the flag AND the typed confirmation", async () => {
    await make();
    await refused(run(["create", "admin"], { db: pool, passwords, prompt: prompt(["b@example.com", "B", PW, PW]) }), /admin already exists/);
    await refused(run(["create", "admin", "--additional-admin"], { db: pool, passwords, prompt: prompt(["b@example.com", "B", "yes", PW, PW]) }), /Confirmation did not match/);
    assert.equal((await rows()).length, 1);
    await run(["create", "admin", "--additional-admin"], { db: pool, passwords, prompt: prompt(["b@example.com", "B", "CREATE ADMIN b@example.com", PW, PW]), log: () => {} });
    assert.equal((await rows()).length, 2);
  });

  it("--pending creates an account with NO password (it never prompts for one) and says how the owner sets it", async () => {
    const out = logs();
    const asked = [];
    const spy = { ask: async (label) => { asked.push(label); return ["admin@example.com", "Alex Admin"][asked.length - 1]; }, askHidden: async (label) => { asked.push(label); throw new Error("must not ask for a password"); } };
    await run(["create", "admin", "--pending"], { db: pool, passwords, prompt: spy, log: out.log });
    const [row] = await rows();
    assert.equal(row.password_hash, null);
    assert.equal(row.role, "admin");
    assert.equal(row.disabled_at, null);
    assert.equal(asked.length, 2);
    assert.match(out.lines.join("\n"), /no password yet/);
    assert.match(out.lines.join("\n"), /First time or forgot your password/);
  });

  it("--pending still obeys the admin rules: a second admin needs --additional-admin and the typed confirmation", async () => {
    await make();
    await refused(run(["create", "admin", "--pending"], { db: pool, passwords, prompt: prompt(["b@example.com", "B"]) }), /admin already exists/);
    await refused(run(["create", "admin", "--pending", "--additional-admin"], { db: pool, passwords, prompt: prompt(["b@example.com", "B", "yes"]) }), /Confirmation did not match/);
    assert.equal((await rows()).length, 1);
    await run(["create", "admin", "--pending", "--additional-admin"], { db: pool, passwords, prompt: prompt(["b@example.com", "B", "CREATE ADMIN b@example.com"]), log: () => {} });
    assert.equal((await rows()).length, 2);
    assert.equal((await rows())[1].password_hash, null);
  });

  it("createStaff pending: no hash, no overwrite of an existing email, first account still must be an admin", async () => {
    await refused(make({ role: "sales", password: undefined, pending: true }), /first staff account must be an admin/);
    await make({ password: undefined, pending: true });
    await refused(make({ password: undefined, pending: true }), /already exists/);
    await refused(make({ email: "x@example.com", pending: true }), /pending account has no password/);
    assert.equal((await rows()).length, 1);
  });

  it("set-password gives a pending account its first password (the break-glass route)", async () => {
    await make({ password: undefined, pending: true });
    await setStaffPassword(pool, passwords, { email: "admin@example.com", password: PW });
    assert.match((await rows())[0].password_hash, /^scrypt\$/);
  });

  it("rejects bad commands and roles", async () => {
    await refused(run(["wat"], { db: pool, passwords }), /Commands:/);
    await refused(run(["create", "root"], { db: pool, passwords }), /Usage: create/);
    await refused(run(["disable"], { db: pool, passwords }), /Usage/);
  });

  it("works as a real process with the password piped on stdin: nothing in argv, nothing printed", async () => {
    const url = process.env.TEST_DATABASE_URL;
    const script = fileURLToPath(new URL("../scripts/staff.js", import.meta.url));
    const child = spawn(process.execPath, [script, "create", "admin"], {
      env: { PATH: process.env.PATH, DATABASE_URL: url },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.stdin.end(`piped@example.com\nPiped Admin\n${PW}\n${PW}\n`);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    assert.match(output, /Created admin account for piped@example.com/);
    assert.ok(!output.includes(PW));
    assert.deepEqual((await rows()).map((r) => r.email_normalized), ["piped@example.com"]);
  });

  it("refuses a database that isn't local", async () => {
    const script = fileURLToPath(new URL("../scripts/staff.js", import.meta.url));
    const child = spawn(process.execPath, [script, "disable", "x@example.com"], {
      env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://u:secret-value@erp.internal.example:5432/erp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1);
    assert.match(output, /must point at localhost/);
    assert.ok(!output.includes("secret-value"));
  });
});
