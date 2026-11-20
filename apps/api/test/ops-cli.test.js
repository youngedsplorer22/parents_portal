import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { OpsError, createOps, parseArgs, parseTripRef } from "../src/cli/ops.js";
import { chooseTarget } from "../scripts/ops.js";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

// The developer commands: they, not a website, create schools and trips, bind a trip to its portal, allowlist Sales people
// and assign them to trips. The database choice is the dangerous part, so it is tested first.
const pool = createTestPool();
const HOSTS = {
  PUBLIC_BASE_URL_DOMESTIC_PAYMENT: "https://domestic-paid.example.test",
  PUBLIC_BASE_URL_DOMESTIC_NONE: "https://domestic-free.example.test",
  PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT: "https://international-paid.example.test",
  PUBLIC_BASE_URL_INTERNATIONAL_NONE: "https://international-free.example.test",
};
let ops;
let lines;
const run = async (...argv) => {
  lines = [];
  await ops.run(argv.flat(), (l) => lines.push(l), { databaseName: "parents_portal_test" });
  return lines.join("\n");
};
const rejects = async (...argv) => assert.rejects(() => run(...argv), OpsError);
const trip = async (...extra) => run(["trip:create", "--school", "ABC School", "--branch", "Jaipur", "--title", "Jaipur 2027", "--type", "domestic", "--payment", "none", "--year", "2027-28", "--destination", "Jaipur", "--new-school", ...extra]);
const WORDS = "abc-school/jaipur/jaipur-2027";

beforeEach(async () => {
  await resetTables(pool);
  ops = createOps({ db: pool, env: HOSTS, user: "tester" });
});
after(() => pool.end());

describe("which database a command may touch", () => {
  const LOCAL = "postgresql://u:p@localhost:5432/parents_portal_dev";
  it("defaults to the local development database, and says so", () => {
    const t = chooseTarget(["trip:list"], { DATABASE_URL: LOCAL });
    assert.deepEqual([t.database, t.production], ["parents_portal_dev", false]);
  });
  it("refuses a database on another computer, and any local database with the wrong name, with no flag", () => {
    assert.throws(() => chooseTarget(["trip:list"], { DATABASE_URL: "postgresql://u:p@db.example.com:5432/parents_portal_dev" }), OpsError);
    assert.throws(() => chooseTarget(["trip:list"], { DATABASE_URL: "postgresql://u:p@localhost:5432/company_live" }), OpsError);
    assert.throws(() => chooseTarget(["trip:list"], {}), OpsError);
  });
  it("--test means the local test database only", () => {
    assert.equal(chooseTarget(["trip:list", "--test"], { TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/parents_portal_test" }).database, "parents_portal_test");
    assert.throws(() => chooseTarget(["trip:list", "--test"], { TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/parents_portal_dev" }), OpsError);
  });
  it("--production needs every one of the safeguards, and names OPS_CONFIRM_DATABASE (not the migration variable)", () => {
    const live = { DATABASE_URL: "postgresql://u:p@db.railway.internal:5432/railway" };
    for (const env of [live, { ...live, NODE_ENV: "production" }, { ...live, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true" }, { ...live, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "wrong" }]) {
      assert.throws(() => chooseTarget(["trip:list", "--production"], env), (e) => e instanceof OpsError && !/MIGRATE_CONFIRM/.test(e.message));
    }
    const ok = chooseTarget(["trip:list", "--production"], { ...live, NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "railway" });
    assert.deepEqual([ok.database, ok.production], ["railway", true]);
  });
  it("a live address without the flag is refused even if the other variables are set", () => {
    assert.throws(() => chooseTarget(["trip:list"], { DATABASE_URL: "postgresql://u:p@db.railway.internal:5432/railway", NODE_ENV: "production", ALLOW_PRODUCTION_DATABASE: "true", OPS_CONFIRM_DATABASE: "railway" }), OpsError);
  });
});

describe("reading the command line", () => {
  it("refuses an unknown option or a missing value, so a typo never does something else", () => {
    assert.throws(() => parseArgs(["trip:create", "--scool", "x"]), OpsError);
    assert.throws(() => parseArgs(["trip:create", "--school"]), OpsError);
    assert.deepEqual(parseArgs(["trip:create", "--school", "A B", "--new-school"]).flags, { school: "A B", "new-school": true });
  });
  it("names a trip by the last three parts of its link, from a full link too", () => {
    for (const ref of [WORDS, `/join/${WORDS}`, `https://domestic-free.example.test/join/${WORDS}`, `https://x.example/join/${WORDS}/continue`]) assert.deepEqual(parseTripRef(ref), { school: "abc-school", branch: "jaipur", trip: "jaipur-2027" });
    for (const bad of ["", "abc", "a/b", "A/B/C", "../x/y", "a/b/c/d"]) assert.throws(() => parseTripRef(bad), OpsError, bad);
  });
});

describe("schools and trips", () => {
  it("creates a draft trip (and its school, only with --new-school), and prints the address words and the portal folder", async () => {
    const out = await trip();
    assert.match(out, /Created school ABC School \(Jaipur\)/);
    assert.match(out, /Address\s+: abc-school\/jaipur\/jaipur-2027/);
    assert.match(out, /Domestic — Without Payment/);
    assert.match(out, /apps\/portal-domestic-free/);
    assert.match(out, /https:\/\/domestic-free\.example\.test\/join\/abc-school\/jaipur\/jaipur-2027/);
    const [row] = (await pool.query("SELECT status, public_registration, template_key FROM trips")).rows;
    assert.deepEqual(row, { status: "draft", public_registration: false, template_key: "domestic_none" });
  });

  it("refuses an unknown school without --new-school (a typo must not make a second school), and bad values", async () => {
    await trip();
    await rejects("trip:create", "--school", "ABC Scool", "--branch", "Jaipur", "--title", "Goa", "--type", "domestic", "--payment", "none", "--year", "2027-28");
    assert.equal((await pool.query("SELECT count(*)::int n FROM schools")).rows[0].n, 1);
    for (const bad of [["--type", "overseas"], ["--payment", "free"], ["--year", "2027"], ["--title", ""]]) {
      await rejects("trip:create", "--school", "ABC School", "--branch", "Jaipur", "--title", "Goa", "--type", "domestic", "--payment", "none", "--year", "2027-28", ...bad);
    }
    assert.equal((await pool.query("SELECT count(*)::int n FROM trips")).rows[0].n, 1);
  });

  it("the same school can have several trips, even of one template; each gets its own words", async () => {
    await trip();
    await run("trip:create", "--school", "ABC School", "--branch", "Jaipur", "--title", "Jaipur 2028", "--type", "domestic", "--payment", "none", "--year", "2028-29");
    const out = await run("trip:list");
    assert.match(out, /abc-school\/jaipur\/jaipur-2027/);
    assert.match(out, /abc-school\/jaipur\/jaipur-2028/);
  });

  it("prints the lines for the portal's deployment.config.js", async () => {
    await trip();
    const out = await run("trip:config", WORDS);
    for (const piece of ['school: "abc-school"', 'branch: "jaipur"', 'trip: "jaipur-2027"', 'schoolName: "ABC School"', 'tripTitle: "Jaipur 2027"', 'destination: "Jaipur"', "apps/portal-domestic-free"]) assert.ok(out.includes(piece), piece);
  });

  it("opens a trip (active, public page on) and closes it (page off) without deleting anything", async () => {
    await trip();
    await run("trip:open", WORDS);
    assert.deepEqual((await pool.query("SELECT status, public_registration FROM trips")).rows[0], { status: "active", public_registration: true });
    await run("trip:close", WORDS);
    assert.deepEqual((await pool.query("SELECT status, public_registration FROM trips")).rows[0], { status: "closed", public_registration: false });
    await run("trip:close", WORDS); // again: no error
    assert.equal((await pool.query("SELECT count(*)::int n FROM schools")).rows[0].n, 1);
    await rejects("trip:open", "abc-school/jaipur/nope");
  });
});

describe("binding a trip to its portal", () => {
  it("binds one trip per template; binding the next closes the previous one and keeps every record", async () => {
    await trip();
    await run("trip:create", "--school", "XYZ School", "--new-school", "--title", "Goa 2027", "--type", "domestic", "--payment", "none", "--year", "2027-28");
    await run("trip:open", WORDS);
    await run("trip:open", "xyz-school/main/goa-2027");
    await run("portal:bind", WORDS);
    assert.match(await run("portal:status"), /Domestic — Without Payment\s+abc-school\/jaipur\/jaipur-2027\s+\[active\]/);
    const second = await run("portal:bind", "xyz-school/main/goa-2027");
    assert.match(second, /closed and its public page switched off/);
    const rows = (await pool.query("SELECT slug, status, public_registration FROM trips ORDER BY slug")).rows;
    assert.deepEqual(rows, [{ slug: "goa-2027", status: "active", public_registration: true }, { slug: "jaipur-2027", status: "closed", public_registration: false }]);
    assert.match(await run("portal:status"), /International — With Payment\s+no trip bound/);
  });
});

describe("the Sales allowlist and assignments, end to end", () => {
  let h;
  beforeEach(async () => {
    h = await startApp({ db: pool });
    await trip();
    await run("trip:create", "--school", "ABC School", "--branch", "Jaipur", "--title", "Goa 2027", "--type", "domestic", "--payment", "none", "--year", "2027-28");
  });
  afterEach(() => h.close());

  it("only an allowlisted exact email can set a password and sign in; others cannot", async () => {
    await run("sales:allow", "--email", "Priya.Sales@Company.example", "--name", "Priya Sales");
    assert.equal((await h.staffSetPassword("priya.sales@company.example", "a-strong-pass-123")).status, 200);
    const priya = await h.staffSignIn("priya.sales@company.example", "a-strong-pass-123");
    assert.equal(priya.res.status, 200);
    assert.equal((await priya.as.get("/api/admin/itinerary/trips")).body.trips.length, 0, "no trip until one is assigned");
    const other = await h.api.post("/api/admin/auth/login", { email: "someone.else@company.example", password: "a-strong-pass-123" });
    assert.equal(other.status, 401);
    await rejects("sales:allow", "--email", "priya.sales@company.example", "--name", "Again");
    await rejects("sales:allow", "--email", "not-an-email", "--name", "X");
    assert.match(await run("sales:list"), /priya\.sales@company\.example\s+active\s+0 trip\(s\)/);
  });

  it("many-to-many: one Sales person holds several trips, one trip has several Sales people; revoke takes effect at once", async () => {
    for (const [e, n] of [["a@company.example", "A"], ["b@company.example", "B"]]) {
      await run("sales:allow", "--email", e, "--name", n);
      await h.staffSetPassword(e, "a-strong-pass-123");
    }
    const a = await h.staffSignIn("a@company.example", "a-strong-pass-123");
    const b = await h.staffSignIn("b@company.example", "a-strong-pass-123");
    await run("sales:assign", "--email", "a@company.example", WORDS);
    await run("sales:assign", "--email", "a@company.example", "abc-school/jaipur/goa-2027");
    await run("sales:assign", "--email", "b@company.example", WORDS);
    await run("sales:assign", "--email", "b@company.example", WORDS); // again: no error, no duplicate
    assert.equal((await a.as.get("/api/admin/itinerary/trips")).body.trips.length, 2);
    assert.equal((await b.as.get("/api/admin/itinerary/trips")).body.trips.length, 1);
    const jaipur = (await a.as.get("/api/admin/itinerary/trips")).body.trips.find((t) => t.title === "Jaipur 2027");
    assert.equal((await a.as.post(`/api/admin/trips/${jaipur.id}/itinerary`, { dayNumber: 1, title: "Arrive" })).status, 201);
    assert.equal((await b.as.get(`/api/admin/trips/${jaipur.id}/itinerary`)).body.items.length, 1, "both Sales people see the one itinerary");
    assert.match(await run("sales:assignments", WORDS), /a@company\.example[\s\S]*b@company\.example/);
    await run("sales:revoke", "--email", "a@company.example", WORDS);
    assert.equal((await a.as.get(`/api/admin/trips/${jaipur.id}/itinerary`)).status, 403);
    assert.equal((await b.as.get(`/api/admin/trips/${jaipur.id}/itinerary`)).status, 200);
    assert.equal((await a.as.get("/api/admin/itinerary/trips")).body.trips.length, 1, "their other trip is untouched");
  });

  it("assigning needs an allowlisted Sales address and a real trip; a disabled person cannot sign in", async () => {
    await rejects("sales:assign", "--email", "nobody@company.example", WORDS);
    await run("sales:allow", "--email", "c@company.example", "--name", "C");
    await rejects("sales:assign", "--email", "c@company.example", "abc-school/jaipur/missing");
    await h.staffSetPassword("c@company.example", "a-strong-pass-123");
    await run("sales:disable", "c@company.example");
    assert.equal((await h.staffSignIn("c@company.example", "a-strong-pass-123")).res.status, 401);
    await run("sales:enable", "c@company.example");
    assert.equal((await h.staffSignIn("c@company.example", "a-strong-pass-123")).res.status, 200);
  });
});

describe("removing the old admin accounts", () => {
  const seed = async () => {
    const admin = (await pool.query("INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ('old.admin@example.com', 'Old Admin', 'admin', NULL) RETURNING id")).rows[0].id;
    const admin2 = (await pool.query("INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ('old.admin2@example.com', 'Old Admin 2', 'admin', NULL) RETURNING id")).rows[0].id;
    const sales = (await pool.query("INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ('sam@company.example', 'Sam', 'sales', NULL) RETURNING id")).rows[0].id;
    const school = (await pool.query("INSERT INTO schools (name, name_normalized, slug, branch_slug, created_by) VALUES ('Old School', 'old school', 'old-school', 'main', $1) RETURNING id", [admin])).rows[0].id;
    const t = (await pool.query("INSERT INTO trips (school_id, title, tour_type, payment_mode, slug, created_by) VALUES ($1, 'Goa', 'domestic', 'none', 'goa', $2) RETURNING id", [school, admin])).rows[0].id;
    await pool.query("INSERT INTO staff_sessions (staff_id, expires_at) VALUES ($1, now() + interval '1 day')", [admin]);
    await pool.query("INSERT INTO staff_sessions (staff_id, expires_at) VALUES ($1, now() + interval '1 day')", [sales]);
    await pool.query("INSERT INTO staff_trip_assignments (staff_id, trip_id) VALUES ($1, $2)", [sales, t]);
    await pool.query("INSERT INTO email_otps (email_normalized, purpose, code_hash, expires_at, resend_available_at) VALUES ('old.admin@example.com', 'staff_password', repeat('a', 64), now() + interval '1 hour', now())");
    await pool.query("INSERT INTO audit_log (staff_id, staff_email, action, entity_type, details) VALUES ($1, 'old.admin@example.com', 'school.create', 'school', '{}')", [admin]);
    await pool.query("INSERT INTO audit_log (staff_id, staff_email, action, entity_type, details) VALUES ($1, 'old.admin2@example.com', 'trip.create', 'trip', '{}')", [admin2]);
    await pool.query("INSERT INTO audit_log (staff_id, staff_email, action, entity_type, details) VALUES (NULL, 'old.admin@example.com', 'staff.login', 'staff', '{}')"); // matched by address alone
    await pool.query("INSERT INTO audit_log (staff_id, staff_email, action, entity_type, details) VALUES ($1, 'sam@company.example', 'itinerary.create', 'trip', '{}')", [sales]);
    await pool.query("INSERT INTO audit_log (staff_id, staff_email, action, entity_type, details) VALUES (NULL, 'cli:developer', 'trip.create', 'trip', '{}')");
    await pool.query("INSERT INTO staff_login_attempts (email_normalized) VALUES ('old.admin@example.com'), ('old.admin2@example.com'), ('sam@company.example')");
    // Business records that must survive: a participant, their enrolment, a submitted form, its PDF record, a Drive folder,
    // an itinerary item the old admin created, and a school logo the old admin uploaded.
    const reg = (await pool.query("INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at) VALUES ('P', 'Q', 'Old School', 'student', '12345678', 'parent@example.test', now()) RETURNING id")).rows[0].id;
    const enr = (await pool.query("INSERT INTO trip_enrolments (registration_id, trip_id) VALUES ($1, $2) RETURNING id", [reg, t])).rows[0].id;
    const form = (await pool.query("INSERT INTO onboarding_forms (registration_id, tour_type, participant_role, status, data, progress_percent, submitted_at, enrolment_id) VALUES ($1, 'domestic', 'student', 'submitted', '{\"fullName\":\"Asha\"}', 100, now(), $2) RETURNING id", [reg, enr])).rows[0].id;
    await pool.query("INSERT INTO registration_pdfs (form_id, status, destination, drive_file_id, file_name, size_bytes, sha256, stored_at) VALUES ($1, 'stored', 'ops@example.test', 'abcDEF12345', 'asha.pdf', 1234, repeat('b', 64), now())", [form]);
    await pool.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ('ops@example.test', 'old-school', 'folder12345')");
    await pool.query("INSERT INTO trip_itinerary_items (trip_id, day_number, title, created_by, updated_by) VALUES ($1, 1, 'Arrive', $2, $2)", [t, admin]);
    await pool.query("INSERT INTO school_logos (school_id, content_type, data, updated_by) VALUES ($1, 'image/png', decode(repeat('ab', 20), 'hex'), $2)", [school, admin]);
    return { admin, admin2, sales, school, t };
  };
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM staff_users WHERE role = 'admin') admins, (SELECT count(*)::int FROM staff_users WHERE role = 'sales') sales,
            (SELECT count(*)::int FROM schools) schools, (SELECT count(*)::int FROM trips) trips, (SELECT count(*)::int FROM staff_sessions) sessions,
            (SELECT count(*)::int FROM staff_trip_assignments) assignments, (SELECT count(*)::int FROM audit_log) audit,
            (SELECT count(*)::int FROM staff_login_attempts) attempts,
            (SELECT count(*)::int FROM parent_registrations) registrations, (SELECT count(*)::int FROM trip_enrolments) enrolments,
            (SELECT count(*)::int FROM onboarding_forms) forms, (SELECT md5(string_agg(md5(data::text), ',')) FROM onboarding_forms) form_data,
            (SELECT count(*)::int FROM registration_pdfs WHERE status = 'stored') pdfs, (SELECT count(*)::int FROM drive_folders) drive_folders,
            (SELECT count(*)::int FROM trip_itinerary_items) itinerary, (SELECT count(*)::int FROM school_logos) logos`,
  )).rows[0];

  it("a dry run (the default) lists what it would touch and deletes nothing", async () => {
    await seed();
    const before = await counts();
    const out = await run("admin:remove");
    assert.match(out, /old\.admin@example\.com, old\.admin2@example\.com/);
    assert.match(out, /2 account\(s\), 1 sign-in session\(s\), 1 unused set-password code\(s\), 2 sign-in attempt record\(s\), 3 audit row\(s\) they wrote/);
    assert.match(out, /1 school\(s\) and 1 trip\(s\) naming an admin as creator/);
    assert.match(out, /DRY RUN/);
    assert.deepEqual(await counts(), before);
  });

  it("deleting needs --apply AND the database name typed; the wrong name changes nothing", async () => {
    await seed();
    const before = await counts();
    await rejects("admin:remove", "--apply");
    await rejects("admin:remove", "--apply", "--confirm", "company_live");
    assert.deepEqual(await counts(), before);
  });

  it("deletes the admin accounts and what existed only for them; schools, trips, Sales people, assignments and everyone else's audit rows stay", async () => {
    const ids = await seed();
    const before = await counts();
    const out = await run("admin:remove", "--apply", "--confirm", "parents_portal_test");
    assert.match(out, /Deleted 2 admin account\(s\)\. Nothing else was deleted\./);
    const after = await counts();
    assert.deepEqual(
      { ...after, audit: after.audit - 1 },
      { ...before, admins: 0, sessions: before.sessions - 1, attempts: before.attempts - 2, audit: before.audit - 3 },
      "only admins, their own sessions, their attempt counters and the audit rows THEY wrote are gone; one audit row (a count only) was added",
    );
    const school = (await pool.query("SELECT created_by FROM schools WHERE id = $1", [ids.school])).rows[0];
    const t = (await pool.query("SELECT created_by FROM trips WHERE id = $1", [ids.t])).rows[0];
    assert.deepEqual([school.created_by, t.created_by], [null, null], "they stop naming a creator; the rows stay");
    const other = (await pool.query("SELECT (SELECT created_by FROM trip_itinerary_items) ic, (SELECT updated_by FROM trip_itinerary_items) iu, (SELECT updated_by FROM school_logos) lu")).rows[0];
    assert.deepEqual([other.ic, other.iu, other.lu], [null, null, null], "itinerary and logo rows stay; their author pointer is emptied");
    assert.equal((await pool.query("SELECT count(*)::int n FROM email_otps WHERE email_normalized = 'old.admin@example.com'")).rows[0].n, 0, "unused set-password codes are gone");
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE staff_email LIKE 'old.admin%' OR staff_id = $1 OR staff_id = $2", [ids.admin, ids.admin2])).rows[0].n, 0, "no audit row of an admin is left");
    const kept = (await pool.query("SELECT action FROM audit_log WHERE action <> 'staff.remove_admins' ORDER BY id")).rows.map((r) => r.action);
    assert.deepEqual(kept, ["itinerary.create", "trip.create"], "Sales and developer-command rows stay");
    const marker = (await pool.query("SELECT staff_email, details FROM audit_log WHERE action = 'staff.remove_admins'")).rows;
    assert.equal(marker.length, 1);
    assert.deepEqual(marker[0].details, { count: 2 });
    assert.doesNotMatch(JSON.stringify(marker), /old\.admin/, "no admin address is kept anywhere");
    // the append-only rule is back on
    await assert.rejects(() => pool.query("UPDATE audit_log SET action = 'x.y'"), /append-only/);
    await assert.rejects(() => pool.query("DELETE FROM audit_log"), /append-only/);
    assert.match(await run("admin:remove"), /There are no admin accounts/);
  });

  it("a failure part-way leaves everything as it was, including the audit trigger", async () => {
    await seed();
    const before = await counts();
    // A real failure at the LAST delete (the admin accounts), after the audit rows were already deleted and the trigger switched off.
    await pool.query("CREATE FUNCTION pg_temp_refuse_admin_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$");
    await pool.query("CREATE TRIGGER refuse_admin_delete BEFORE DELETE ON staff_users FOR EACH ROW EXECUTE FUNCTION pg_temp_refuse_admin_delete()");
    try {
      await assert.rejects(() => run("admin:remove", "--apply", "--confirm", "parents_portal_test"), /simulated failure/);
    } finally {
      await pool.query("DROP TRIGGER refuse_admin_delete ON staff_users");
      await pool.query("DROP FUNCTION pg_temp_refuse_admin_delete()");
    }
    assert.deepEqual(await counts(), before, "nothing was deleted");
    await assert.rejects(() => pool.query("DELETE FROM audit_log"), /append-only/, "the audit trigger is still on");
  });

  it("an old admin row can never sign in or set a password, even before it is deleted", async () => {
    const h = await startApp({ db: pool });
    try {
      const hash = await h.services.staff.passwords.hash("a-strong-pass-123");
      await pool.query("INSERT INTO staff_users (email_normalized, display_name, role, password_hash) VALUES ('old.admin@example.com', 'Old Admin', 'admin', $1)", [hash]);
      assert.equal((await h.api.post("/api/admin/auth/login", { email: "old.admin@example.com", password: "a-strong-pass-123" })).status, 401);
      const set = await h.staffSetPassword("old.admin@example.com", "another-strong-pass-1").catch((e) => e);
      assert.ok(set instanceof Error || set.status >= 400, "no setup code is ever delivered to an admin address");
    } finally {
      await h.close();
    }
  });
});

describe("developer help", () => {
  it("prints every command and never mentions a password argument", async () => {
    const out = await run("help");
    for (const c of ["trip:create", "trip:open", "trip:close", "trip:config", "portal:bind", "portal:status", "sales:allow", "sales:assign", "sales:revoke", "admin:remove", "audit:list"]) assert.ok(out.includes(c), c);
    assert.doesNotMatch(out, /--password/);
  });
  it("an unknown command is refused in plain words", async () => {
    await rejects("trip:delete", WORDS);
  });
});
