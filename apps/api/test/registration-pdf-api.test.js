import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, failingDb, registrationFields, resetTables, slugsOf } from "./helpers.js";
import { readPdf } from "./pdf-text.js";

// The PDF of a submitted registration: GET /api/onboarding/pdf?enrolment=<id>. It is made from the SAVED, submitted
// record only, for the signed-in owner only, and never for a draft. Submission and PDF are separate steps: the
// database submission is the source of truth, and a PDF failure can't undo or duplicate it.

const pool = createTestPool();
const PNG = readFileSync(new URL("../src/modules/onboarding/pdf/young-edsplorer-logo.png", import.meta.url));
const apps = [];
let h;
let admin;
let trip;
let parent; // { cookie, enrolmentId }

async function open(opts = {}) {
  const app = await startApp({ db: opts.db ?? pool, renderPdf: opts.renderPdf, pdfRendering: opts.pdfRendering });
  apps.push(app);
  return app;
}
beforeEach(async () => {
  await resetTables(pool);
  h = await open();
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  const school = (await admin.as.post("/api/admin/schools", { name: "Greenwood International School", branch: "Kolkata" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Annual Trip 2027", tourType: "domestic", destination: "Darjeeling", paymentMode: "none", academicYear: "2026-27" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  parent = await registerForTrip("parent@example.com");
});
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});
after(() => pool.end());

async function registerForTrip(email, app = h, over = {}) {
  const verificationToken = await app.verifiedToken(email, "registration");
  const res = await app.api.post("/api/registrations", { ...registrationFields(email, { role: "Student", ...over }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = app.cookieOf(res);
  const enrolmentId = (await app.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId;
  return { cookie, enrolmentId };
}
const ANSWERS = { ...validAnswers("domestic", "student"), fullName: "Asha Rao", dateOfBirth: "2016-05-04", phone: "9876543210", remark: "Window seat please" };
async function saveDraft(who = parent, data = ANSWERS, app = h) {
  const res = await app.api.put("/api/onboarding", { tourType: "domestic", data, currentSection: null, version: null, enrolmentId: who.enrolmentId }, { cookie: who.cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.form;
}
const submit = (version, who = parent, app = h) => app.api.post("/api/onboarding/submit", { version, enrolmentId: who.enrolmentId, ...ACK }, { cookie: who.cookie });
const pdfFor = (who = parent, app = h, query = "") => app.api.get(`/api/onboarding/pdf?enrolment=${who.enrolmentId}${query}`, { cookie: who.cookie, binary: true });
const formRows = async () => (await pool.query("SELECT status, data, submitted_at FROM onboarding_forms")).rows;

describe("successful submission, then the PDF", () => {
  it("the saved, submitted registration downloads as a PDF with the right data, as an attachment that is never cached", async () => {
    const draft = await saveDraft();
    const sub = await submit(draft.version);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.match(sub.body.form.reference, /^YE-[0-9A-F]{8}$/);

    const res = await pdfFor();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="young-edsplorer-registration-${sub.body.form.reference}.pdf"`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.raw.subarray(0, 5).toString(), "%PDF-");

    const pdf = await readPdf(res.raw);
    for (const s of ["Young Edsplorer", "Greenwood International School", "Kolkata", "Annual Trip 2027", "Darjeeling", "2026-27", sub.body.form.reference,
      "Asha Rao", "Student", "parent@example.com", "9876543210", "4 May 2016", "Window seat please", "Declaration and signature", ACK.signatureName]) {
      assert.ok(pdf.text.includes(s), `missing: ${s}`);
    }
    const declaration = (await pool.query("SELECT body FROM declaration_texts WHERE version = $1", [ACK.declarationVersion])).rows[0].body;
    assert.ok(pdf.text.includes(declaration), "the exact declaration wording the parent accepted");
    assert.ok(pdf.text.includes(sub.body.form.reference));
  });

  it("can be downloaded again later (after a refresh or another visit), from the same saved record", async () => {
    await submit((await saveDraft()).version);
    const first = await pdfFor();
    const state = await h.api.get(`/api/onboarding?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie });
    assert.equal(state.body.form.status, "submitted");
    const again = await pdfFor();
    assert.equal(again.status, 200);
    assert.deepEqual(again.raw, first.raw, "the same record gives the same document");
    assert.equal((await formRows()).length, 1);
  });

  it("the school's logo is included when the school has a PNG or JPEG logo", async () => {
    const without = await (async () => {
      await submit((await saveDraft()).version);
      return (await pdfFor()).raw.length;
    })();
    const schoolId = (await pool.query("SELECT id FROM schools")).rows[0].id;
    assert.equal((await admin.as.put(`/api/admin/schools/${schoolId}/logo`, PNG, { raw: true, headers: { "content-type": "image/png" } })).status, 200);
    assert.ok((await pdfFor()).raw.length > without + 5000);
  });

  it("only saved data is used: anything else in the request (extra query values) changes nothing", async () => {
    await submit((await saveDraft()).version);
    const res = await pdfFor(parent, h, "&name=Hacker&school=Evil+School&data=%7B%7D");
    const pdf = await readPdf(res.raw);
    assert.ok(!pdf.text.includes("Hacker") && !pdf.text.includes("Evil School"));
    assert.ok(pdf.text.includes("Asha Rao"));
  });
});

describe("no PDF unless the database says the registration is submitted", () => {
  it("a draft has no PDF (409), so no 'success' document can exist before submission", async () => {
    await saveDraft();
    const res = await pdfFor();
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "FORM_NOT_SUBMITTED");
    assert.notEqual(res.headers.get("content-type"), "application/pdf");
  });

  it("a registration with no form yet has no PDF either", async () => {
    const res = await pdfFor();
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "FORM_NOT_SUBMITTED");
  });

  it("failed validation: the submission is refused (422), the form stays a draft and there is no PDF", async () => {
    const draft = await saveDraft(parent, { ...ANSWERS, phone: "98765" });
    const sub = await submit(draft.version);
    assert.equal(sub.status, 422);
    assert.equal((await formRows())[0].status, "draft");
    assert.equal((await pdfFor()).status, 409);
  });

  it("a database failure while submitting gives an error (never a false success), keeps the draft, has no PDF, and a retry works", async () => {
    const draft = await saveDraft();
    const broken = await open({ db: failingDb(pool, /SET status = 'submitted'/) });
    const sub = await submit(draft.version, parent, broken);
    assert.equal(sub.status, 500);
    assert.equal(sub.body.error.code, "INTERNAL_ERROR");
    assert.equal((await formRows())[0].status, "draft");
    assert.equal((await pdfFor()).status, 409);
    const retry = await submit(draft.version);
    assert.equal(retry.status, 200, "the same submission can safely be retried");
    assert.equal((await pdfFor()).status, 200);
  });
});

describe("PDF failure never loses or duplicates the submitted registration", () => {
  it("if the PDF can't be made, the submission stays saved, the error says so, and a later retry downloads it", async () => {
    const failing = await open({ renderPdf: async () => { throw new Error("simulated PDF engine failure"); } });
    const sub = await submit((await saveDraft(parent, ANSWERS, failing)).version, parent, failing);
    assert.equal(sub.status, 200, "the submission itself succeeded and was committed");
    const res = await pdfFor(parent, failing);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "PDF_FAILED");
    assert.match(res.body.error.message, /registration is saved/i);
    assert.ok(!JSON.stringify(failing.logged).includes("Asha"), "no personal data in the log");
    assert.ok(failing.logged.some((m) => /pdf/i.test(m)), "the failure is logged");
    const rows = await formRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "submitted");
    const retry = await pdfFor(parent, h);
    assert.equal(retry.status, 200);
    assert.equal((await formRows()).length, 1, "retrying the download creates nothing");
  });
});

describe("repeated submits", () => {
  it("only one submission is ever recorded, whatever the number of clicks or requests", async () => {
    const draft = await saveDraft();
    const results = await Promise.all([submit(draft.version), submit(draft.version), submit(draft.version)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
    const rows = await formRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "submitted");
    assert.equal((await pdfFor()).status, 200);
  });
});

describe("only the signed-in owner can download a registration's PDF", () => {
  it("another parent changing the registration id in the address gets 404 and no document", async () => {
    await submit((await saveDraft()).version);
    const other = await registerForTrip("other@example.com");
    const res = await h.api.get(`/api/onboarding/pdf?enrolment=${parent.enrolmentId}`, { cookie: other.cookie, binary: true });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "REGISTRATION_NOT_FOUND");
    assert.notEqual(res.headers.get("content-type"), "application/pdf");
  });

  it("no session, a staff session, or an expired/garbage cookie get 401", async () => {
    await submit((await saveDraft()).version);
    const url = `/api/onboarding/pdf?enrolment=${parent.enrolmentId}`;
    assert.equal((await h.api.get(url)).status, 401);
    assert.equal((await h.api.get(url, { cookie: admin.cookie })).status, 401);
    assert.equal((await h.api.get(url, { cookie: "pp_session=not-a-real-token" })).status, 401);
  });

  it("a malformed registration id is refused (400), never used in a query", async () => {
    for (const bad of ["1 OR 1=1", "../../etc/passwd", "%00", "x".repeat(100)]) {
      const res = await h.api.get(`/api/onboarding/pdf?enrolment=${encodeURIComponent(bad)}`, { cookie: parent.cookie });
      assert.equal(res.status, 400, bad);
    }
  });

  it("a registration that belongs to no trip (older accounts) uses enrolment=legacy, for its owner only", async () => {
    const verificationToken = await h.verifiedToken("legacy@example.com", "registration");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("legacy@example.com", { role: "Student" }), verificationToken });
    const cookie = h.cookieOf(reg);
    const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: ANSWERS, currentSection: null, version: null, enrolmentId: "legacy" }, { cookie });
    assert.equal((await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: "legacy", ...ACK }, { cookie })).status, 200);
    const res = await h.api.get("/api/onboarding/pdf?enrolment=legacy", { cookie, binary: true });
    assert.equal(res.status, 200);
    assert.ok((await readPdf(res.raw)).text.includes("Asha Rao"));
    assert.equal((await h.api.get("/api/onboarding/pdf?enrolment=legacy", { cookie: parent.cookie })).status, 409, "the other parent has no such form");
  });
});

describe("existing data stays compatible", () => {
  it("an account registered with an older phone format still gets its PDF, showing the number as it was saved", async () => {
    await submit((await saveDraft()).version);
    await pool.query("UPDATE parent_registrations SET phone = '+91 98765 43210' WHERE email_normalized = 'parent@example.com'");
    const pdf = await readPdf((await pdfFor()).raw);
    assert.ok(pdf.text.includes("+91 98765 43210"));
  });
});

describe("PDF rendering can't be used to slow the server down", () => {
  it("repeated downloads of the same registration are rendered once (a submitted record never changes)", async () => {
    let renders = 0;
    const counting = await open({ renderPdf: async (model) => { renders++; return Buffer.from(`%PDF-1.3 fake ${model.reference}`); } });
    await submit((await saveDraft(parent, ANSWERS, counting)).version, parent, counting);
    const results = await Promise.all(Array.from({ length: 5 }, () => pdfFor(parent, counting)));
    results.push(await pdfFor(parent, counting));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(renders, 1);
  });

  it("a changed school logo (or trip details) gives a fresh document, not the cached one", async () => {
    let renders = 0;
    const counting = await open({ renderPdf: async () => { renders++; return Buffer.from("%PDF-1.3 fake"); } });
    await submit((await saveDraft(parent, ANSWERS, counting)).version, parent, counting);
    await pdfFor(parent, counting);
    await admin.as.patch(`/api/admin/trips/${trip.id}`, { destination: "Gangtok" });
    await pdfFor(parent, counting);
    assert.equal(renders, 2);
  });

  it("when PDFs are already being made for others, a new request is told to retry shortly (503) instead of waiting", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = await open({ renderPdf: async () => { await gate; return Buffer.from("%PDF-1.3 fake"); }, pdfRendering: { concurrency: 1, maxQueue: 0 } });
    const other = await registerForTrip("other@example.com", slow);
    await submit((await saveDraft(parent, ANSWERS, slow)).version, parent, slow);
    await submit((await saveDraft(other, ANSWERS, slow)).version, other, slow);
    const first = pdfFor(parent, slow);
    await new Promise((r) => setTimeout(r, 100));
    const busy = await pdfFor(other, slow);
    assert.equal(busy.status, 503);
    assert.equal(busy.body.error.code, "SERVER_BUSY");
    assert.ok(Number(busy.headers.get("retry-after")) >= 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await pdfFor(other, slow)).status, 200, "the retry works");
  });
});
