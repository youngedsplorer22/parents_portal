import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables } from "./helpers.js";

const UP = readFileSync(new URL("../src/db/migrations/016_pdf_storage.sql", import.meta.url), "utf8");
const DOWN = readFileSync(new URL("../src/db/rollbacks/016_pdf_storage.down.sql", import.meta.url), "utf8");
const pool = createTestPool();
after(() => pool.end());
beforeEach(() => resetTables(pool));

const statements = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

describe("migration 016 is additive and reversible", () => {
  it("only creates new tables, indexes and comments: it never alters, deletes, updates or inserts existing data", () => {
    for (const s of statements(UP)) assert.match(s, /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|COMMENT ON)\b/i, s.slice(0, 60));
    // ("ON DELETE CASCADE" inside the new table's own foreign key is a rule about its own rows, not a deletion.)
    assert.ok(!/\b(ALTER|DROP|TRUNCATE|UPDATE|INSERT)\b/i.test(statements(UP).join(";")), "no statement alters, drops, updates or inserts");
    assert.ok(!/\bDELETE\s+FROM\b/i.test(UP), "no statement deletes rows");
    for (const table of ["onboarding_forms", "parent_registrations", "trips", "schools", "staff_users", "auth_sessions", "audit_log"]) {
      assert.ok(!new RegExp(`ALTER TABLE ${table}`, "i").test(UP), `${table} is not altered`);
    }
  });

  it("the rollback only drops what the migration created", () => {
    const drops = statements(DOWN);
    assert.ok(drops.every((s) => /^DROP TABLE IF EXISTS (registration_pdfs|drive_folders)$/i.test(s) || /^DELETE FROM schema_migrations WHERE name = '016_pdf_storage.sql'$/i.test(s)), drops.join(" | "));
  });

  it("rolling back and re-applying in a transaction leaves every existing record exactly as it was", async () => {
    const h = await startApp({ db: pool });
    try {
      const admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
      const school = (await admin.as.post("/api/admin/schools", { name: "Greenwood School" })).body.school;
      const trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
      await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
      await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
      const verificationToken = await h.verifiedToken("p@example.com", "registration");
      const reg = await h.api.post("/api/registrations", { ...registrationFields("p@example.com", { role: "Student" }), verificationToken, publicTrip: { school: school.slug, branch: school.branchSlug, trip: trip.slug } });
      const cookie = h.cookieOf(reg);
      const enrolmentId = (await h.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId;
      const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: null, version: null, enrolmentId }, { cookie });
      assert.equal((await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId, ...ACK }, { cookie })).status, 200);

      const snapshot = async (c) => JSON.stringify((await Promise.all(["onboarding_forms", "parent_registrations", "trips", "schools", "staff_users", "audit_log"].map((t) => c.query(`SELECT * FROM ${t} ORDER BY 1`)))).map((r) => r.rows));
      const client = await pool.connect();
      try {
        const before = await snapshot(client);
        await client.query("BEGIN");
        for (const s of statements(DOWN).filter((x) => /^DROP/i.test(x))) await client.query(s);
        assert.equal((await client.query("SELECT to_regclass('registration_pdfs') AS t")).rows[0].t, null);
        for (const s of statements(UP)) await client.query(s);
        assert.equal(await snapshot(client), before, "nothing else changed");
        assert.ok((await client.query("SELECT to_regclass('registration_pdfs') AS t")).rows[0].t);
        await client.query("ROLLBACK");
        assert.equal(await snapshot(client), before);
      } finally {
        client.release();
      }
    } finally {
      await h.close();
    }
  });
});

describe("the new tables enforce their own rules", () => {
  const formId = async () => {
    const h = await startApp({ db: pool });
    try {
      const verificationToken = await h.verifiedToken("q@example.com", "registration");
      const reg = await h.api.post("/api/registrations", { ...registrationFields("q@example.com", { role: "Student" }), verificationToken });
      const cookie = h.cookieOf(reg);
      const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: null, version: null, enrolmentId: "legacy" }, { cookie });
      assert.equal(saved.status, 200);
      return (await pool.query("SELECT id FROM onboarding_forms")).rows[0].id;
    } finally {
      await h.close();
    }
  };
  const insert = (id, over = {}) => {
    const row = { status: "pending", drive_file_id: null, destination: null, sha256: null, stored_at: null, last_error_code: null, ...over };
    return pool.query(
      `INSERT INTO registration_pdfs (form_id, status, drive_file_id, destination, sha256, stored_at, last_error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, row.status, row.drive_file_id, row.destination, row.sha256, row.stored_at, row.last_error_code],
    );
  };
  const refused = (promise, constraint) => assert.rejects(promise, (err) => err.code === "23514" || err.code === "23503" || err.code === "23505", constraint);

  it("a record needs a real form (foreign key), one per form, and starts pending", async () => {
    await refused(insert("00000000-0000-4000-8000-000000000000"), "fk");
    const id = await formId();
    await insert(id);
    await refused(insert(id), "one per form");
    assert.deepEqual((await pool.query("SELECT status, attempts FROM registration_pdfs")).rows[0], { status: "pending", attempts: 0 });
  });

  it("'stored' needs the file id, account, checksum and time together; other states must not carry a file id", async () => {
    const id = await formId();
    const full = { status: "stored", drive_file_id: "1AbCdEfGhIjKlMnOp", destination: "dest@example.com", sha256: "a".repeat(64), stored_at: new Date() };
    await refused(insert(id, { ...full, drive_file_id: null }), "stored without file id");
    await refused(insert(id, { ...full, sha256: null }), "stored without checksum");
    await refused(insert(id, { status: "failed", drive_file_id: "1AbCdEfGhIjKlMnOp" }), "failed with a file id");
    await refused(insert(id, { ...full, status: "bogus" }), "unknown status");
    await insert(id, full);
  });

  it("file ids, checksums and error codes have a safe shape, and a file id belongs to one registration only", async () => {
    const id = await formId();
    const full = { status: "stored", drive_file_id: "1AbCdEfGhIjKlMnOp", destination: "dest@example.com", sha256: "a".repeat(64), stored_at: new Date() };
    await refused(insert(id, { ...full, drive_file_id: "has space/or slash" }), "file id shape");
    await refused(insert(id, { ...full, sha256: "XYZ" }), "checksum shape");
    await refused(insert(id, { status: "failed", last_error_code: "Some free text with a token" }), "error code shape");
    await insert(id, { status: "failed", last_error_code: "QUOTA_FULL" });
  });

  it("drive_folders keeps one folder id per destination account and key", async () => {
    await pool.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ('a@example.com', 'root', 'f1')");
    await pool.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ('b@example.com', 'root', 'f2')");
    await refused(pool.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ('a@example.com', 'root', 'f3')"), "unique");
  });
});
