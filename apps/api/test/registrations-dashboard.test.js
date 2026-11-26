import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { slugify } from "../src/modules/catalog/slug.js";
import domesticFreeConfig from "../../portal-domestic-free/src/deployment.config.js";
import domesticPaidConfig from "../../portal-domestic-paid/src/deployment.config.js";
import internationalFreeConfig from "../../portal-international-free/src/deployment.config.js";
import internationalPaidConfig from "../../portal-international-paid/src/deployment.config.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let school;

beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School" })).body.school;
});
afterEach(() => h.close());
after(() => pool.end());

async function openTrip({ title, tourType = "domestic", paymentMode = "none", forSchool = school } = {}) {
  const trip = (await admin.as.post(`/api/admin/schools/${forSchool.id}/trips`, { title, tourType, paymentMode })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  return { trip, path: trip.publicPath, token: slugsOf(trip) }; // token = the page's address words (no secret)
}
async function parent(email, token) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, ...(token ? { publicTrip: token } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { cookie: h.cookieOf(res), id: res.body.registrationId };
}
const enrol = (who, token) => h.api.post("/api/enrolments", { trip: token }, { cookie: who.cookie });
const lookup = (t) => h.api.get(`/api/join/${t.token.school}/${t.token.branch}/${t.token.trip}`);
const list = (who) => h.api.get("/api/enrolments", { cookie: who.cookie });
const state = (who, enrolment) => h.api.get(`/api/onboarding${enrolment ? `?enrolment=${enrolment}` : ""}`, { cookie: who.cookie });
const save = (who, body) => h.api.put("/api/onboarding", body, { cookie: who.cookie });
const submit = (who, body) => h.api.post("/api/onboarding/submit", { ...ACK, ...body }, { cookie: who.cookie });
const discard = (who, enrolment) => h.api.del(`/api/onboarding?enrolment=${enrolment}`, { cookie: who.cookie });

describe("public page addresses", () => {
  it("slugify makes a tidy, URL-safe word and never fails", () => {
    const cases = [
      ["Greenfield Public School", "greenfield-public-school"],
      ["St. Xavier's School, Noida", "st-xaviers-school-noida"],
      ["Délhi   Public  School & Co.", "delhi-public-school-and-co"],
      ["  --Winter Trip 2026-27--  ", "winter-trip-2026-27"],
      ["", "link"],
      ["!!!", "link"],
    ];
    for (const [input, out] of cases) assert.equal(slugify(input), out, input);
    assert.ok(slugify("x".repeat(200)).length <= 60);
    assert.equal(slugify("", "trip"), "trip");
  });

  it("each portal's tripTitle produces exactly the trip slug in its deployment.config.js", () => {
    for (const config of [domesticPaidConfig, domesticFreeConfig, internationalPaidConfig, internationalFreeConfig]) {
      assert.equal(slugify(config.tripTitle), config.trip, `${config.trip}: slugify("${config.tripTitle}") !== "${config.trip}"`);
    }
  });

  it("a trip's address reads /join/<school>/<branch>/<trip> and finds exactly that trip", async () => {
    const t = await openTrip({ title: "Winter Trip" });
    assert.equal(t.path, "/join/greenfield-public-school/main/winter-trip");
    const res = await lookup(t);
    assert.equal(res.body.trip.title, "Winter Trip");
  });

  it("two schools' trips with the same name have different addresses, each resolving to its own trip", async () => {
    const other = (await admin.as.post("/api/admin/schools", { name: "Beta School" })).body.school;
    const a = await openTrip({ title: "Annual Trip" });
    const b = await openTrip({ title: "Annual Trip", tourType: "international", forSchool: other });
    assert.notEqual(a.path, b.path);
    assert.equal((await lookup(a)).body.school.name, "Greenfield Public School");
    assert.equal((await lookup(b)).body.school.name, "Beta School");
    assert.equal((await lookup(b)).body.trip.tourType, "international");
  });

  it("renaming the school later cannot move an address to another trip", async () => {
    const t = await openTrip({ title: "Winter Trip" });
    await admin.as.patch(`/api/admin/schools/${school.id}`, { name: "Greenfield International School" });
    const res = await lookup(t);
    assert.equal(res.body.trip.title, "Winter Trip");
    assert.equal(res.body.school.name, "Greenfield International School");
  });
});

describe("saving and resuming each registration separately", () => {
  it("enrolling returns the registration id; the list shows each one with school, trip, status and payment from real records", async () => {
    const a = await openTrip({ title: "Jaipur", paymentMode: "payment" });
    const b = await openTrip({ title: "Shimla", paymentMode: "none" });
    const p = await parent("p@example.com", a.token);
    const enrolled = await enrol(p, b.token);
    assert.equal(enrolled.status, 201);
    assert.match(enrolled.body.enrolmentId, /^[0-9a-f-]{36}$/);
    const body = (await list(p)).body;
    assert.deepEqual(body.enrolments.map((e) => [e.title, e.form, e.payment]), [
      ["Shimla", null, { required: false, status: "not_required" }],
      ["Jaipur", null, { required: true, status: "not_configured" }],
    ]);
    assert.ok(body.enrolments.every((e) => e.payment.status !== "paid"));
    assert.equal(body.legacy, null);
  });

  it("the same parent keeps separate drafts for two trips, each resumed at its own section", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const b = await openTrip({ title: "Japan", tourType: "international" });
    const p = await parent("p@example.com", a.token);
    const idB = (await enrol(p, b.token)).body.enrolmentId;
    const idA = (await list(p)).body.enrolments.find((e) => e.title === "Jaipur").id;

    const sa = await save(p, { tourType: "domestic", data: { fullName: "Asha for Jaipur" }, currentSection: "personal", version: null, enrolmentId: idA });
    assert.equal(sa.status, 200, JSON.stringify(sa.body));
    const sb = await save(p, { tourType: "international", data: { firstName: "Asha for Japan" }, currentSection: "passport", version: null, enrolmentId: idB });
    assert.equal(sb.status, 200, JSON.stringify(sb.body));

    // a new session (log out / another device / browser restart)
    const again = await h.logIn("p@example.com");
    const who = { cookie: again.cookie };
    const ra = (await state(who, idA)).body;
    const rb = (await state(who, idB)).body;
    assert.equal(ra.form.data.fullName, "Asha for Jaipur");
    assert.equal(ra.form.currentSection, "personal");
    assert.equal(ra.trip.title, "Jaipur");
    assert.equal(rb.form.data.firstName, "Asha for Japan");
    assert.equal(rb.form.currentSection, "passport");
    assert.equal(rb.enrolmentId, idB);
    // each trip still decides its own form
    assert.equal((await save(who, { tourType: "domestic", data: {}, currentSection: null, version: rb.form.version, enrolmentId: idB })).body.error.code, "TOUR_FIXED_BY_TRIP");
  });

  it("another parent can never read, change, submit or discard someone else's registration by its id", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const owner = await parent("owner@example.com", a.token);
    const id = (await list(owner)).body.enrolments[0].id;
    await save(owner, { tourType: "domestic", data: { fullName: "Owner" }, currentSection: null, version: null, enrolmentId: id });
    const intruder = await parent("intruder@example.com");
    for (const res of [
      await state(intruder, id),
      await save(intruder, { tourType: "domestic", data: { fullName: "Evil" }, currentSection: null, version: 1, enrolmentId: id }),
      await submit(intruder, { version: 1, enrolmentId: id }),
      await discard(intruder, id),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "REGISTRATION_NOT_FOUND");
    }
    assert.equal((await state(owner, id)).body.form.data.fullName, "Owner");
    assert.equal((await list(intruder)).body.enrolments.length, 0);
    assert.equal((await h.api.get("/api/onboarding?enrolment=not-a-uuid", { cookie: owner.cookie })).status, 400);
  });

  it("a completed registration stays completed: a second submit, a later save or following the link again changes nothing", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const p = await parent("p@example.com", a.token);
    const id = (await list(p)).body.enrolments[0].id;
    const created = await save(p, { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: "review", version: null, enrolmentId: id });
    const done = await submit(p, { version: created.body.form.version, enrolmentId: id });
    assert.equal(done.status, 200);
    assert.equal((await submit(p, { version: done.body.form.version, enrolmentId: id })).body.error.code, "ALREADY_SUBMITTED");
    assert.equal((await save(p, { tourType: "domestic", data: {}, currentSection: null, version: done.body.form.version, enrolmentId: id })).body.error.code, "FORM_SUBMITTED");
    const again = await enrol(p, a.token);
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.enrolmentId, id);
    const listed = (await list(p)).body.enrolments;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].form.status, "submitted");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM onboarding_forms")).rows[0].n, 1);
  });

  it("an incomplete draft can never be submitted", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const p = await parent("p@example.com", a.token);
    const id = (await list(p)).body.enrolments[0].id;
    const created = await save(p, { tourType: "domestic", data: { fullName: "Asha" }, currentSection: null, version: null, enrolmentId: id });
    const res = await submit(p, { version: created.body.form.version, enrolmentId: id });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "FORM_INCOMPLETE");
    assert.equal((await state(p, id)).body.form.status, "draft");
  });

  it("a password or code can't be stored as a form answer (only the form's own fields are accepted)", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const p = await parent("p@example.com", a.token);
    const id = (await list(p)).body.enrolments[0].id;
    for (const extra of [{ password: "secret-pass-123" }, { otp: "123456" }, { verificationToken: "x" }]) {
      const res = await save(p, { tourType: "domestic", data: { fullName: "Asha", ...extra }, currentSection: null, version: null, enrolmentId: id });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM onboarding_forms")).rows[0].n, 0);
  });

  it("after public registration is switched off, and the trip closed, the parent still reaches their saved registration from the list", async () => {
    const a = await openTrip({ title: "Jaipur" });
    const p = await parent("p@example.com", a.token);
    const id = (await list(p)).body.enrolments[0].id;
    await save(p, { tourType: "domestic", data: { fullName: "Asha" }, currentSection: "personal", version: null, enrolmentId: id });
    await admin.as.post(`/api/admin/trips/${a.trip.id}/public-registration`, { enabled: false });
    assert.equal((await enrol(p, a.token)).status, 404, "the page itself no longer takes registrations");
    await admin.as.post(`/api/admin/trips/${a.trip.id}/status`, { status: "closed" });
    assert.equal((await list(p)).body.enrolments[0].id, id);
    const st = (await state(p, id)).body;
    assert.equal(st.form.data.fullName, "Asha");
    assert.equal(st.trip.title, "Jaipur");
  });

  it("a form from before trips is reached explicitly as 'legacy' and listed separately", async () => {
    const p = await parent("old@example.com");
    await save(p, { tourType: "international", data: { firstName: "Old form" }, currentSection: null, version: null });
    const a = await openTrip({ title: "Jaipur" });
    await enrol(p, a.token);
    const body = (await list(p)).body;
    assert.equal(body.enrolments.length, 1);
    assert.deepEqual(body.legacy.form.status, "draft");
    const legacy = (await state(p, "legacy")).body;
    assert.equal(legacy.form.data.firstName, "Old form");
    assert.equal(legacy.enrolmentId, null);
    assert.equal(legacy.trip, null);
  });
});
