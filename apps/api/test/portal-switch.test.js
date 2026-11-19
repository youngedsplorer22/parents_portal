import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { createOps, linkConfigFromEnv } from "../src/cli/ops.js";
import { createCatalogService } from "../src/modules/catalog/service.js";
import { createTestPool, resetTables } from "./helpers.js";

// Switching a portal (template) from school A to school B, step by step: exactly when each trip accepts a new registration.
// A trip accepts one only when, at that moment and on the server: it is bound to the portal's template, it is ACTIVE, its public
// page is ON, and the request carries that template's portal key. Deploying a website changes none of this: it is a separate
// step the server never sees, so these steps are the whole story of who may register.
const pool = createTestPool();
const HOSTS = {
  PUBLIC_BASE_URL_DOMESTIC_PAYMENT: "https://dp.example.test",
  PUBLIC_BASE_URL_DOMESTIC_NONE: "https://dn.example.test",
  PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT: "https://ip.example.test",
  PUBLIC_BASE_URL_INTERNATIONAL_NONE: "https://in.example.test",
};
const A = { school: "a-school", branch: "main", trip: "goa-2026" };
const B = { school: "b-school", branch: "main", trip: "jaipur-2027" };
const words = (w) => `${w.school}/${w.branch}/${w.trip}`;
const TEMPLATE = "domestic_none";

let ops;
let catalog;
beforeEach(async () => {
  await resetTables(pool);
  await pool.query("DELETE FROM portal_deployments");
  ops = createOps({ db: pool, env: HOSTS, user: "tester" });
  catalog = createCatalogService({ db: pool, config: { ...linkConfigFromEnv(HOSTS), requireBinding: true, joinLookups: { windowSeconds: 60, max: 1000 } } });
});
after(() => pool.end());

const run = (...argv) => ops.run(argv, () => {}, { databaseName: "parents_portal_test" });
// What a registration or enrolment asks the server, from the portal with this key (null = no proven portal).
const accepts = async (w, portal = TEMPLATE) => {
  try {
    await catalog.resolvePublicTripForRegistration(pool, w, { portal });
    return true;
  } catch (err) {
    assert.ok(["TRIP_NOT_OPEN", "TRIP_NOT_FOUND"].includes(err.code), `unexpected refusal ${err.code}`);
    return false;
  }
};
const publicPageOpen = async (w) => {
  try {
    return (await catalog.resolvePublicTrip(w, "203.0.113.9")).registrationOpen;
  } catch (err) {
    assert.equal(err.code, "TRIP_NOT_FOUND", "the only reason a page is missing is that it is off");
    return "page not available";
  }
};

async function schoolAIsLive() {
  await run("trip:create", "--school", "A School", "--new-school", "--title", "Goa 2026", "--type", "domestic", "--payment", "none", "--year", "2026-27");
  await run("trip:create", "--school", "B School", "--new-school", "--title", "Jaipur 2027", "--type", "domestic", "--payment", "none", "--year", "2027-28");
  await run("portal:bind", words(A));
  await run("trip:open", words(A));
  // a participant who registered for school A, with a submitted form
  const t = (await pool.query("SELECT t.id FROM trips t WHERE t.slug = 'goa-2026'")).rows[0].id;
  const reg = (await pool.query("INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at) VALUES ('P', 'Q', 'A School', 'student', '12345678', 'a-parent@example.test', now()) RETURNING id")).rows[0].id;
  const enr = (await pool.query("INSERT INTO trip_enrolments (registration_id, trip_id) VALUES ($1, $2) RETURNING id", [reg, t])).rows[0].id;
  await pool.query("INSERT INTO onboarding_forms (registration_id, tour_type, participant_role, status, data, progress_percent, submitted_at, enrolment_id) VALUES ($1, 'domestic', 'student', 'submitted', '{\"fullName\":\"Asha\"}', 100, now(), $2)", [reg, enr]);
}
const records = async () => (await pool.query("SELECT (SELECT count(*)::int FROM parent_registrations) regs, (SELECT count(*)::int FROM trip_enrolments) enrolments, (SELECT count(*)::int FROM onboarding_forms) forms, (SELECT md5(string_agg(data::text, ',')) FROM onboarding_forms) data, (SELECT count(*)::int FROM trips) trips, (SELECT count(*)::int FROM schools) schools")).rows[0];

describe("switching a portal from school A to school B", () => {
  it("one trip at a time: bind moves the portal, open turns the new trip on, and at no moment do both accept", async () => {
    await schoolAIsLive();
    const before = await records();
    const log = [];
    const snap = async (step) => log.push({ step, A: await accepts(A), B: await accepts(B) });
    await snap("A live");
    await run("portal:bind", words(B)); // closes A and turns its page off, in one transaction; B is bound but still a draft
    await snap("after bind");
    await run("trip:open", words(B));
    await snap("after open B");
    assert.deepEqual(log, [
      { step: "A live", A: true, B: false },
      { step: "after bind", A: false, B: false }, // the gap: nobody accepts, on purpose
      { step: "after open B", A: false, B: true },
    ]);
    assert.ok(log.every((s) => !(s.A && s.B)), "never both");
    assert.deepEqual(await records(), before, "no registration, form, trip or school was touched");
  });

  it("opening B first does not make B accept: it is not the bound trip until portal:bind", async () => {
    await schoolAIsLive();
    await run("trip:open", words(B));
    assert.equal(await accepts(B), false);
    assert.equal(await publicPageOpen(B), false, "its page says registration is closed");
    assert.equal(await accepts(A), true, "A is unaffected until the portal moves");
    await run("portal:bind", words(B));
    assert.equal(await accepts(B), true, "the moment the bind commits, B (already open) accepts");
    assert.equal(await accepts(A), false);
  });

  it("only the portal of the trip's own template can register for it, and never another school's trip", async () => {
    await schoolAIsLive();
    assert.equal(await accepts(A, "domestic_none"), true);
    for (const other of ["domestic_payment", "international_none", "international_payment", null]) assert.equal(await accepts(A, other), false, String(other));
    assert.equal(await accepts(B, "domestic_none"), false, "B is not open, so the domestic portal cannot register anyone for it");
  });

  it("deploying a website changes nothing on the server: no trip changes state until a command runs", async () => {
    await schoolAIsLive();
    const state = async () => JSON.stringify((await pool.query("SELECT t.slug, t.status, t.public_registration, (pd.trip_id = t.id) AS bound FROM trips t LEFT JOIN portal_deployments pd ON pd.template_key = t.template_key ORDER BY t.slug")).rows);
    const first = await state();
    // (a deployment of either website is not an API call; nothing here can be triggered by one)
    assert.equal(await state(), first);
  });

  it("the previous school's participants keep their records and their sign-in, and A's page and registrations are closed", async () => {
    await schoolAIsLive();
    await run("portal:bind", words(B));
    await run("trip:open", words(B));
    assert.equal(await publicPageOpen(A), "page not available", "A's public page is off");
    assert.equal(await accepts(A), false);
    const kept = (await pool.query("SELECT f.status, f.data->>'fullName' AS name, t.slug, t.status AS trip_status FROM onboarding_forms f JOIN trip_enrolments e ON e.id = f.enrolment_id JOIN trips t ON t.id = e.trip_id")).rows;
    assert.deepEqual(kept, [{ status: "submitted", name: "Asha", slug: "goa-2026", trip_status: "closed" }]);
  });

  it("trip:close alone also stops A at once; the portal stays bound to it (so nobody registers) until the next bind", async () => {
    await schoolAIsLive();
    await run("trip:close", words(A));
    assert.equal(await accepts(A), false);
    await run("trip:open", words(B));
    assert.equal(await accepts(B), false, "B is open but the portal is still bound to A");
    assert.match((await pool.query("SELECT t.slug FROM portal_deployments d JOIN trips t ON t.id = d.trip_id")).rows[0].slug, /goa-2026/);
  });

  it("going back is the same two commands: bind A again, open A", async () => {
    await schoolAIsLive();
    await run("portal:bind", words(B));
    await run("trip:open", words(B));
    await run("portal:bind", words(A));
    assert.equal(await accepts(B), false);
    assert.equal(await accepts(A), false, "A was closed by the first switch: it needs trip:open again");
    await run("trip:open", words(A));
    assert.equal(await accepts(A), true);
  });
});
