import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { CleanupRefusedError, removeSchool, removeTrip, reviewCatalog } from "../src/modules/catalog/cleanup.js";
import { assertCleanupTarget, main } from "../scripts/catalog-cleanup.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let actor;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  actor = { id: (await pool.query("SELECT id FROM staff_users")).rows[0].id, email: "admin@example.com", role: "admin" };
});
afterEach(() => h.close());
after(() => pool.end());

const school = async (name) => (await admin.as.post("/api/admin/schools", { name })).body.school;
const trip = async (s, title, publish = false) => {
  const t = (await admin.as.post(`/api/admin/schools/${s.id}/trips`, { title, tourType: "domestic", paymentMode: "none" })).body.trip;
  if (publish) {
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
  }
  return t;
};
const count = async (sql) => (await pool.query(sql)).rows[0].n;
async function registerFor(t, email, { submit = false } = {}) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, publicTrip: slugsOf(t) });
  const cookie = h.cookieOf(res);
  const enrolmentId = (await pool.query("SELECT e.id FROM trip_enrolments e JOIN parent_registrations r ON r.id = e.registration_id WHERE r.email_normalized = $1", [email])).rows[0].id;
  const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: submit ? validAnswers("domestic", "student") : {}, currentSection: "review", version: null, enrolmentId }, { cookie });
  if (submit) await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId, ...ACK }, { cookie });
}

describe("reviewing schools and trips for cleanup (read only)", () => {
  it("lists every school and trip with what depends on them, and changes nothing", async () => {
    const used = await school("Used School");
    const t1 = await trip(used, "Live Trip", true);
    await registerFor(t1, "p@example.com", { submit: true });
    const unused = await school("Unused School");
    await trip(unused, "Empty Trip");
    const before = await count("SELECT count(*)::int AS n FROM audit_log");

    const review = await reviewCatalog(pool);
    const u = review.find((s) => s.name === "Used School");
    assert.equal(u.removable, false);
    assert.deepEqual(u.trips[0].dependencies, { enrolments: 1, registrations: 1, forms: 1, submitted: 1, signed: 1, links: 0, auditEntries: 3 });
    assert.match(u.blockers[0], /1 trip registration\(s\).*1 submitted, 1 signed/);
    const e = review.find((s) => s.name === "Unused School");
    assert.equal(e.removable, true);
    assert.equal(e.trips[0].removable, true);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log"), before);
    assert.equal(await count("SELECT count(*)::int AS n FROM schools"), 2);
  });

  it("a retired link record (history) blocks removal too", async () => {
    const s = await school("Linked School");
    const t = await trip(s, "Linked Trip");
    await pool.query("INSERT INTO trip_links (trip_id, token_hash, token_hint, expires_at, created_by, retired_at) VALUES ($1, NULL, 'abcd', now() + interval '1 day', $2, now())", [t.id, actor.id]);
    const review = await reviewCatalog(pool);
    assert.deepEqual(review[0].trips[0].blockers, ["1 retired link record(s) (history)"]);
  });
});

describe("removing", () => {
  it("an unused trip is removed; its audit history is kept and the removal is recorded", async () => {
    const s = await school("Test School");
    const t = await trip(s, "Test Trip");
    await removeTrip(pool, actor, t.id);
    assert.equal(await count("SELECT count(*)::int AS n FROM trips"), 0);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id", [t.id]);
    assert.deepEqual(rows.map((r) => r.action), ["trip.create", "trip.delete"]);
  });

  it("a trip with a registration, draft, submission or signature is refused, never cascaded", async () => {
    const s = await school("Busy School");
    const t = await trip(s, "Busy Trip", true);
    await registerFor(t, "p@example.com");
    await assert.rejects(removeTrip(pool, actor, t.id), (err) => err instanceof CleanupRefusedError && /linked data/.test(err.message));
    assert.equal(await count("SELECT count(*)::int AS n FROM trips"), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM onboarding_forms"), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM parent_registrations"), 1);
  });

  it("a school is removed with its trips only when every trip is unused, all or nothing", async () => {
    const s = await school("Mixed School");
    await trip(s, "Empty Trip");
    const busy = await trip(s, "Busy Trip", true);
    await registerFor(busy, "p@example.com", { submit: true });
    await assert.rejects(removeSchool(pool, actor, s.id), CleanupRefusedError);
    assert.equal(await count("SELECT count(*)::int AS n FROM trips"), 2, "the empty trip was not removed either");
    assert.equal(await count("SELECT count(*)::int AS n FROM schools"), 1);
    assert.equal((await pool.query("SELECT signature_name FROM onboarding_forms")).rows[0].signature_name, "Asha Rao");

    const clean = await school("Clean School");
    await trip(clean, "A");
    await trip(clean, "B");
    await pool.query("INSERT INTO school_logos (school_id, content_type, data) VALUES ($1, 'image/png', $2)", [clean.id, Buffer.alloc(32, 1)]);
    const res = await removeSchool(pool, actor, clean.id);
    assert.equal(res.trips.length, 2);
    assert.equal(await count("SELECT count(*)::int AS n FROM schools"), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM school_logos"), 0);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action LIKE '%.delete' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action), ["trip.delete", "trip.delete", "school.delete"]);
  });

  it("a registration made after the review still blocks the removal (checked again, with the rows locked)", async () => {
    const s = await school("Race School");
    const t = await trip(s, "Race Trip", true);
    const review = await reviewCatalog(pool);
    assert.equal(review[0].trips[0].removable, true);
    await registerFor(t, "late@example.com");
    await assert.rejects(removeTrip(pool, actor, t.id), CleanupRefusedError);
    assert.equal(await count("SELECT count(*)::int AS n FROM trip_enrolments"), 1);
  });
});

describe("the cleanup command", () => {
  it("only ever runs against local parents_portal_dev: never the test database, never a remote one", () => {
    assert.throws(() => assertCleanupTarget(process.env.TEST_DATABASE_URL), /only runs against parents_portal_dev/);
    assert.throws(() => assertCleanupTarget("postgres://u:p@db.example.com:5432/parents_portal_dev"), /localhost/);
    assert.doesNotThrow(() => assertCleanupTarget("postgres://u:p@localhost:5432/parents_portal_dev"));
  });

  it("refuses to start against the test database, before touching anything", async () => {
    await assert.rejects(main(["review"], { env: { DATABASE_URL: process.env.TEST_DATABASE_URL }, out: () => {} }), /only runs against parents_portal_dev/);
  });

  it("is a dry run without --confirm, needs an admin, and refuses linked records", async () => {
    const s = await school("Dry School");
    const t = await trip(s, "Dry Trip");
    const busy = await trip(s, "Busy Trip", true);
    await registerFor(busy, "p@example.com");
    const lines = [];
    const run = (argv) => main(argv, { env: { DATABASE_URL: "postgres://x@localhost/parents_portal_dev" }, out: (l) => lines.push(l), makePool: () => wrap(pool) });
    assert.equal(await run(["remove-trip", t.id, "--by", "admin@example.com"]), 0);
    assert.match(lines.join("\n"), /Dry run only\. Nothing was changed/);
    assert.equal(await count("SELECT count(*)::int AS n FROM trips"), 2);
    await assert.rejects(run(["remove-trip", t.id, "--by", "nobody@example.com", "--confirm"]), /active admin/);
    assert.equal(await run(["remove-trip", busy.id, "--by", "admin@example.com", "--confirm"]), 2);
    assert.match(lines.join("\n"), /Refused: 1 trip registration/);
    assert.equal(await run(["remove-trip", t.id, "--by", "admin@example.com", "--confirm"]), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM trips"), 1);
  });
});

/** The test pool, minus end(): the command ends its pool, and the test still needs this one. */
const wrap = (p) => ({ query: (...a) => p.query(...a), connect: () => p.connect(), end: async () => {} });
