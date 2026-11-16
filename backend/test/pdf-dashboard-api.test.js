import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, failingDb, registrationFields, resetTables, slugsOf } from "./helpers.js";
import { startFakeDrive } from "./fake-drive.js";
import { declarationMarks, readPdf } from "./pdf-text.js";

// The dashboard's view of the PDF: status, retry and download, with the PDF kept in a (fake) private Google Drive.
// Submission never waits for Drive and never depends on it; the copy in Drive is what a parent downloads once it is stored.

const pool = createTestPool();
const apps = [];
let fake;
let h;
let admin;
let trip;
let school;
let parent;

const ANSWERS = { ...validAnswers("domestic", "student"), fullName: "Asha Rao", dateOfBirth: "2016-05-04", phone: "9876543210", remark: "Window seat please" };
const row = async () => (await pool.query("SELECT * FROM registration_pdfs")).rows[0];
const formRows = async () => (await pool.query("SELECT status FROM onboarding_forms")).rows;

async function open({ drive = fake, db = pool, ...rest } = {}) {
  const app = await startApp({ db, drive, ...rest });
  apps.push(app);
  return app;
}
beforeEach(async () => {
  await resetTables(pool);
  fake = await startFakeDrive({ account: "dest@example.com" });
  h = await open();
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenwood International School", branch: "Kolkata" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Annual Trip 2027", tourType: "domestic", destination: "Darjeeling", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  parent = await registerForTrip("parent@example.com");
});
afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    await app.services.onboarding.drainPdfStorage();
    await app.close();
  }
  await fake.close();
});
after(() => pool.end());

async function registerForTrip(email, app = h) {
  const verificationToken = await app.verifiedToken(email, "registration");
  const res = await app.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const cookie = app.cookieOf(res);
  return { cookie, enrolmentId: (await app.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId };
}
async function submit(who = parent, app = h, data = ANSWERS) {
  const saved = await app.api.put("/api/onboarding", { tourType: "domestic", data, currentSection: null, version: null, enrolmentId: who.enrolmentId }, { cookie: who.cookie });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return app.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: who.enrolmentId, ...ACK }, { cookie: who.cookie });
}
const get = (path, who = parent, app = h) => app.api.get(`/api/onboarding${path}${path.includes("?") ? "&" : "?"}enrolment=${who.enrolmentId}`, { cookie: who.cookie });
const retry = (who = parent, app = h) => app.api.post("/api/onboarding/pdf/retry", { enrolmentId: who.enrolmentId }, { cookie: who.cookie });
const settle = (app = h) => app.services.onboarding.drainPdfStorage();

describe("submitting", () => {
  it("returns at once with the registration and a pending PDF; the copy then appears in Drive in the right folders", async () => {
    const sub = await submit();
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.form.status, "submitted");
    assert.match(sub.body.form.reference, /^YE-[0-9A-F]{8}$/);
    assert.ok(["pending", "stored"].includes(sub.body.pdf.status));
    await settle();
    assert.equal((await row()).status, "stored");
    const folders = Object.fromEntries(fake.folders().map(([id, f]) => [id, f]));
    const file = fake.uploads()[0];
    const chain = [];
    for (let p = file.parents[0]; p && p !== "root"; p = folders[p].parents[0]) chain.unshift(folders[p].name);
    assert.deepEqual(chain, ["Young Edsplorer", "Parent Registrations", "Greenwood International School · Kolkata", "Annual Trip 2027"]);
    assert.equal(file.name, `${sub.body.form.reference}.pdf`);
    assert.equal(fake.uploads().length, 1);
  });

  it("does not wait for Google: a slow Drive doesn't slow the submission, and the PDF follows when Drive answers", async () => {
    fake.fail(/POST \/upload/, { status: 200, delayMs: 1200, rawBody: JSON.stringify({ id: "slowfile1", size: "10" }) });
    const t0 = Date.now();
    const sub = await submit();
    assert.equal(sub.status, 200);
    assert.ok(Date.now() - t0 < 900, `submit took ${Date.now() - t0} ms`);
    assert.equal(sub.body.pdf.status, "pending");
  });

  it("a Drive failure never loses the registration: it stays submitted, the PDF is failed with a code, and it says so", async () => {
    fake.fail(/POST \/upload/, { status: 403, reason: "storageQuotaExceeded" });
    const sub = await submit();
    assert.equal(sub.status, 200);
    await settle();
    assert.deepEqual((await formRows()).map((r) => r.status), ["submitted"]);
    assert.equal((await row()).status, "failed");
    assert.equal((await row()).last_error_code, "QUOTA_FULL");
    const state = await get("");
    assert.equal(state.body.form.status, "submitted");
    assert.deepEqual(state.body.pdf, { status: "failed" });
    const pdf = await get("/pdf");
    assert.equal(pdf.status, 409);
    assert.equal(pdf.body.error.code, "PDF_NOT_READY");
    assert.equal(pdf.body.error.status, "failed");
    assert.notEqual(pdf.headers.get("content-type"), "application/pdf");
  });

  it("repeating the submit changes nothing: still one submission and one file", async () => {
    await submit();
    const again = await h.api.post("/api/onboarding/submit", { version: 2, enrolmentId: parent.enrolmentId, ...ACK }, { cookie: parent.cookie });
    assert.equal(again.status, 409);
    await settle();
    assert.equal(fake.uploads().length, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM registration_pdfs")).rows[0].n, 1);
  });

  it("with no Drive configured at all the submission works and the status says so (nothing is claimed as stored)", async () => {
    const plain = await open({ drive: null });
    const verificationToken = await plain.verifiedToken("solo@example.com", "registration");
    const reg = await plain.api.post("/api/registrations", { ...registrationFields("solo@example.com", { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
    const who = { cookie: plain.cookieOf(reg), enrolmentId: (await plain.api.get("/api/enrolments/resume", { cookie: plain.cookieOf(reg) })).body.enrolmentId };
    const sub = await submit(who, plain);
    assert.equal(sub.status, 200);
    assert.deepEqual(sub.body.pdf, { status: "not_configured" });
    assert.equal((await pool.query("SELECT count(*)::int n FROM registration_pdfs")).rows[0].n, 0);
    assert.deepEqual((await get("/pdf/status", who, plain)).body.pdf, { status: "not_configured" });
    assert.deepEqual((await retry(who, plain)).body.pdf, { status: "not_configured" });
    assert.equal(fake.requests.length, 0, "no network call to Google");
  });

  it("credentials missing from the configuration behave the same way (the server runs, storage is unconfigured)", async () => {
    const half = await startApp({ db: pool, pdfStorage: { mode: "google-drive", drive: null, missing: ["GOOGLE_DRIVE_REFRESH_TOKEN"], rootName: "Young Edsplorer" } });
    apps.push(half);
    assert.deepEqual(half.services.onboarding.pdfStorageInfo(), { mode: "google-drive", configured: false, missing: ["GOOGLE_DRIVE_REFRESH_TOKEN"] });
  });
});

describe("the dashboard's data", () => {
  it("a submitted registration comes back from the server with its account details, reference and PDF status", async () => {
    await submit();
    await settle();
    const state = await get("");
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.pdf, { status: "stored" });
    assert.deepEqual(state.body.account, { name: "Asha Rao", role: "Student", email: "parent@example.com", phone: "9876543210" });
    assert.equal(state.body.form.data.fullName, "Asha Rao");
    assert.equal(state.body.trip.school, "Greenwood International School");
    assert.ok(state.body.form.acknowledgement.signatureName);
    assert.match(state.body.form.reference, /^YE-/);
  });

  it("a draft has no PDF status and no account block (nothing is shown before submission)", async () => {
    await h.api.put("/api/onboarding", { tourType: "domestic", data: { fullName: "Asha Rao" }, currentSection: null, version: null, enrolmentId: parent.enrolmentId }, { cookie: parent.cookie });
    const state = await get("");
    assert.equal(state.body.pdf, undefined);
    assert.equal(state.body.account, undefined);
  });

  it("no response ever contains a Drive file or folder id, the destination account, a token or a checksum", async () => {
    await submit();
    await settle();
    const fileId = (await row()).drive_file_id;
    const folderIds = fake.folders().map(([id]) => id);
    const seen = [];
    for (const res of [await get(""), await get("/pdf/status"), await retry(), await get("/pdf")]) seen.push(res.raw.toString("latin1"), JSON.stringify([...res.headers]));
    const text = seen.join("\n");
    for (const secret of [fileId, ...folderIds, "dest@example.com", "good-refresh-token", "test-secret", (await row()).sha256]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  });

  it("a form that was submitted before PDF storage existed (no record) is picked up: its status is pending, and the sweep stores it", async () => {
    await submit();
    await settle();
    // As if it had been submitted before this feature: no record, and nothing in Drive.
    await pool.query("DELETE FROM registration_pdfs");
    await pool.query("DELETE FROM drive_folders");
    fake.files.clear();
    assert.deepEqual((await get("/pdf/status")).body.pdf, { status: "pending" }, "asking for the status makes the record");
    await pool.query("DELETE FROM registration_pdfs");
    assert.equal(await h.services.onboarding.sweepPdfStorage(), 1, "and without that, the sweep finds the form itself");
    await settle();
    assert.equal((await row()).status, "stored");
  });
});

describe("opening the dashboard starts any missing storing straight away", () => {
  const asIfSubmittedBefore = async () => {
    await submit();
    await settle();
    await pool.query("DELETE FROM registration_pdfs");
    await pool.query("DELETE FROM drive_folders");
    fake.files.clear();
  };

  it("loading the dashboard for a registration with no stored copy (an older submission) stores it, without waiting for the sweep", async () => {
    await asIfSubmittedBefore();
    const state = await get("");
    assert.deepEqual(state.body.pdf, { status: "pending" });
    await settle();
    assert.equal((await row()).status, "stored");
    assert.equal(fake.uploads().length, 1);
  });

  it("the page's regular status checks do the same, and many of them make one file", async () => {
    await asIfSubmittedBefore();
    await Promise.all([get("/pdf/status"), get("/pdf/status"), get("/pdf/status"), get(""), get("")]);
    await settle();
    assert.equal((await row()).status, "stored");
    assert.equal(fake.uploads().length, 1);
  });

  it("a registration that already failed is NOT retried just by looking at it (the back-off and Try again decide that)", async () => {
    fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
    await submit();
    await settle();
    assert.equal((await row()).status, "failed");
    const attempts = (await row()).attempts;
    for (let i = 0; i < 3; i++) await get("/pdf/status");
    await settle();
    assert.equal((await row()).attempts, attempts);
    assert.equal(fake.uploads().length, 0);
  });
});

describe("downloading", () => {
  it("serves the stored copy from Drive (not a fresh render), as an attachment, with the checked declaration box", async () => {
    const sub = await submit();
    await settle();
    const before = fake.requests.filter((r) => r.method === "GET" && /files\/[a-z0-9]+$/.test(r.path) && r.query.alt === "media").length;
    const res = await get("/pdf");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="young-edsplorer-registration-${sub.body.form.reference}.pdf"`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(res.raw, fake.uploads()[0].bytes, "the very bytes that were stored");
    assert.equal(fake.requests.filter((r) => r.method === "GET" && r.query.alt === "media").length, before + 1);
    const pdf = await readPdf(res.raw);
    for (const s of ["Asha Rao", "Annual Trip 2027", ACK.signatureName, sub.body.form.reference, "Declaration and signature"]) assert.ok(pdf.text.includes(s), s);
    const marks = await declarationMarks(res.raw);
    assert.equal(marks.checked.length, 1, "the declaration box is ticked in the stored PDF");
  });

  it("downloading again and again never creates another file or another submission", async () => {
    await submit();
    await settle();
    for (let i = 0; i < 4; i++) assert.equal((await get("/pdf")).status, 200);
    assert.equal(fake.uploads().length, 1);
    assert.equal((await formRows()).length, 1);
  });

  it("while the copy isn't stored yet there is no download (409 with the status), and no document is invented", async () => {
    fake.fail(/POST \/upload/, { status: 200, delayMs: 800, rawBody: JSON.stringify({ id: "slowfile2", size: "10" }) });
    await submit();
    const res = await get("/pdf");
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "PDF_NOT_READY");
    assert.equal(res.body.error.status, "pending");
  });

  it("a Drive outage while reading is a 503 with a retry delay, and the record is untouched", async () => {
    await submit();
    await settle();
    fake.fail(/GET \/drive\/v3\/files\//, { status: 503, reason: "backendError" });
    const res = await get("/pdf");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "PDF_UNAVAILABLE");
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.equal((await row()).status, "stored");
    assert.equal((await get("/pdf")).status, 200, "and it works again straight after");
  });

  it("a stored file that was replaced in Drive is refused rather than handed over", async () => {
    await submit();
    await settle();
    fake.uploads()[0].bytes = Buffer.from("%PDF-1.3 not the registration");
    const res = await get("/pdf");
    assert.equal(res.status, 503);
    assert.ok(!res.raw.toString().includes("not the registration"));
  });
});

describe("retrying", () => {
  it("a parent's retry stores the PDF without another submission, and without a second file however many times it is pressed", async () => {
    fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
    await submit();
    await settle();
    assert.equal((await row()).status, "failed");
    await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute'");
    const results = await Promise.all([retry(), retry(), retry()]);
    // One of them starts the attempt (202); the others are either told it is already under way / done, or to wait a
    // moment (429) if they arrive after it began. All three are fine: what matters is the single file below.
    assert.ok(results.some((r) => r.status === 202), JSON.stringify(results.map((r) => [r.status, r.body])));
    assert.ok(results.every((r) => [200, 202, 429].includes(r.status)), JSON.stringify(results.map((r) => [r.status, r.body])));
    await settle();
    assert.equal((await row()).status, "stored");
    assert.equal(fake.uploads().length, 1);
    assert.equal((await formRows()).length, 1);
    assert.equal((await get("/pdf")).status, 200);
  });

  it("too soon after an attempt it is refused with a wait time (429), and nothing is changed", async () => {
    fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
    await submit();
    await settle();
    const res = await retry();
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, "RATE_LIMITED");
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
  });

  it("endpoint limits: downloads, status checks and retries are each limited per parent", async () => {
    await submit();
    await settle();
    const statuses = [];
    for (let i = 0; i < 22; i++) statuses.push((await get("/pdf")).status);
    assert.equal(statuses.filter((s) => s === 200).length, 20);
    assert.deepEqual(statuses.slice(20), [429, 429]);
    const limited = await get("/pdf");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    const retries = [];
    for (let i = 0; i < 8; i++) retries.push((await retry()).status);
    assert.equal(retries.filter((s) => s === 429).length, 2, "6 allowed, then refused");
    const other = await registerForTrip("other@example.com");
    assert.notEqual((await get("/pdf/status", other)).status, 429, "another parent has their own allowance");
  });
});

describe("only the owner", () => {
  it("another parent changing the registration id gets 404 for the status, the retry and the download", async () => {
    await submit();
    await settle();
    const other = await registerForTrip("other@example.com");
    const mine = parent.enrolmentId;
    for (const res of [
      await h.api.get(`/api/onboarding/pdf/status?enrolment=${mine}`, { cookie: other.cookie }),
      await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: mine }, { cookie: other.cookie }),
      await h.api.get(`/api/onboarding/pdf?enrolment=${mine}`, { cookie: other.cookie }),
      await h.api.get(`/api/onboarding?enrolment=${mine}`, { cookie: other.cookie }),
    ]) {
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "REGISTRATION_NOT_FOUND");
      assert.notEqual(res.headers.get("content-type"), "application/pdf");
    }
  });

  it("no session, a staff session or a garbage cookie get 401 everywhere", async () => {
    await submit();
    const paths = [["get", `/api/onboarding/pdf?enrolment=${parent.enrolmentId}`], ["get", `/api/onboarding/pdf/status?enrolment=${parent.enrolmentId}`], ["post", "/api/onboarding/pdf/retry", { enrolmentId: parent.enrolmentId }]];
    for (const [method, path, body] of paths) {
      for (const cookie of [undefined, admin.cookie, "pp_session=garbage"]) {
        const res = await h.api[method](path, ...(method === "post" ? [body, { cookie }] : [{ cookie }]));
        assert.equal(res.status, 401, `${method} ${path} with ${cookie?.slice(0, 18)}`);
      }
    }
  });

  it("malformed registration ids and extra fields are refused (400)", async () => {
    for (const bad of ["1 OR 1=1", "../../x", "x".repeat(80)]) {
      assert.equal((await h.api.get(`/api/onboarding/pdf/status?enrolment=${encodeURIComponent(bad)}`, { cookie: parent.cookie })).status, 400, bad);
      assert.equal((await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: bad }, { cookie: parent.cookie })).status, 400, bad);
    }
    assert.equal((await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: parent.enrolmentId, driveFileId: "x", formId: "y" }, { cookie: parent.cookie })).status, 400);
  });

  it("a draft has no status or retry (409), and the status of a registration that doesn't exist is 404 not a leak", async () => {
    assert.equal((await get("/pdf/status")).status, 409);
    assert.equal((await retry()).status, 409);
    assert.equal((await h.api.get("/api/onboarding/pdf/status?enrolment=00000000-0000-4000-8000-000000000000", { cookie: parent.cookie })).status, 404);
  });
});

describe("the declaration box and verified acceptance", () => {
  it("is drawn ticked only for a form whose acceptance was verified; an unverifiable one stores nothing and says so safely", async () => {
    const hidden = { query: (sql, ...rest) => (/FROM declaration_texts/.test(String(sql)) ? Promise.resolve({ rows: [] }) : pool.query(sql, ...rest)), connect: () => pool.connect() };
    const broken = await open({ db: hidden });
    const sub = await submit(parent, broken);
    assert.equal(sub.status, 200);
    await settle(broken);
    assert.equal((await row()).status, "failed");
    assert.equal((await row()).last_error_code, "PDF_INVALID");
    assert.equal(fake.uploads().length, 0);
    assert.ok(!JSON.stringify(broken.logged).includes("Asha"));
  });
});

describe("failures at the database", () => {
  it("if recording the PDF status itself fails after submitting, the submission still stands", async () => {
    const flaky = await open({ db: failingDb(pool, /INSERT INTO registration_pdfs/) });
    const sub = await submit(parent, flaky);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal((await formRows())[0].status, "submitted");
  });
});
