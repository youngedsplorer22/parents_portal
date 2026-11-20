import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";
import { startFakeDrive } from "./fake-drive.js";
import { createDriveClient } from "../src/modules/pdf-storage/drive-client.js";
import { createPdfStorage, folderName } from "../src/modules/pdf-storage/service.js";
import { readPdf } from "./pdf-text.js";

// An independent attacker's view of the Google Drive storage, the PDF endpoints and the dashboard data: everything a
// hostile parent, a hostile Drive/network, or a careless operator could do. Each case must end safely.

const pool = createTestPool();
let fake;
let h;
let admin;
let trip;
let school;
let parent;
const apps = [];
const ANSWERS = { ...validAnswers("domestic", "student"), fullName: "Asha Rao", dateOfBirth: "2016-05-04", phone: "9876543210" };

beforeEach(async () => {
  await resetTables(pool);
  fake = await startFakeDrive({ account: "dest@example.com" });
  h = await open();
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenwood", branch: "Kolkata" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  parent = await register("parent@example.com");
});
afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    await a.services.onboarding.drainPdfStorage();
    await a.close();
  }
  await fake.close();
});
after(() => pool.end());

async function open(opts = {}) {
  const app = await startApp({ db: pool, drive: fake, ...opts });
  apps.push(app);
  return app;
}
async function register(email, app = h) {
  const verificationToken = await app.verifiedToken(email, "registration");
  const res = await app.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201);
  const cookie = app.cookieOf(res);
  return { cookie, enrolmentId: (await app.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId };
}
async function submit(who = parent, data = ANSWERS) {
  const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data, currentSection: null, version: null, enrolmentId: who.enrolmentId }, { cookie: who.cookie });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: who.enrolmentId, ...ACK }, { cookie: who.cookie });
}
const settle = () => h.services.onboarding.drainPdfStorage();

describe("a hostile parent", () => {
  it("can't choose where the PDF goes: school and trip names with slashes, quotes and query syntax only ever make safe folder names", async () => {
    const evil = (await admin.as.post("/api/admin/schools", { name: "Evil' and name = 'x' or '1'='1 / ../..", branch: "B\\' ) or ( 'a" })).body.school;
    const t = (await admin.as.post(`/api/admin/schools/${evil.id}/trips`, { title: "T'; DROP TABLE x;-- / \\", tourType: "domestic", paymentMode: "none" })).body.trip;
    await admin.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true });
    const verificationToken = await h.verifiedToken("e@example.com", "registration");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("e@example.com", { role: "Student" }), verificationToken, publicTrip: slugsOf(t) });
    const cookie = h.cookieOf(reg);
    const who = { cookie, enrolmentId: (await h.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId };
    assert.equal((await submit(who)).status, 200);
    await settle();
    const rows = (await pool.query("SELECT status FROM registration_pdfs")).rows;
    assert.deepEqual(rows, [{ status: "stored" }]);
    for (const [, f] of fake.folders()) assert.ok(!/[\\/\u0000-\u001f]/.test(f.name), f.name);
    assert.equal(fake.uploads().length, 1);
  });

  it("can't make the server fetch or store anything chosen by the request: the retry and status take only a registration id", async () => {
    await submit();
    await settle();
    const before = fake.requests.length;
    for (const body of [{ enrolmentId: parent.enrolmentId, fileId: "abc" }, { enrolmentId: parent.enrolmentId, url: "http://127.0.0.1/" }, { enrolmentId: parent.enrolmentId, parentId: "root" }, { enrolmentId: parent.enrolmentId, name: "x.pdf" }, { enrolmentId: parent.enrolmentId, formId: "00000000-0000-4000-8000-000000000000" }]) {
      assert.equal((await h.api.post("/api/onboarding/pdf/retry", body, { cookie: parent.cookie })).status, 400, JSON.stringify(body));
    }
    assert.equal(fake.requests.length, before, "nothing was sent to Google");
  });

  it("can't read another parent's PDF through the stored copy, the status, the retry or the dashboard data", async () => {
    await submit();
    await settle();
    const other = await register("other@example.com");
    for (const res of [
      await h.api.get(`/api/onboarding/pdf?enrolment=${parent.enrolmentId}`, { cookie: other.cookie }),
      await h.api.get(`/api/onboarding/pdf/status?enrolment=${parent.enrolmentId}`, { cookie: other.cookie }),
      await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: parent.enrolmentId }, { cookie: other.cookie }),
      await h.api.get(`/api/onboarding?enrolment=${parent.enrolmentId}`, { cookie: other.cookie }),
      await h.api.get(`/api/onboarding/pdf?enrolment=legacy`, { cookie: other.cookie }),
    ]) {
      assert.notEqual(res.status, 200);
      assert.ok(!res.raw.toString("latin1").includes("Asha"), "no personal data in the refusal");
    }
    // and the other parent's own PDF (their draft has none) never turns into parent 1's file
    assert.equal(fake.uploads().length, 1);
  });

  it("can't use another parent's registration id for the retry to force uploads or learn that it exists (same 404 as a made-up id)", async () => {
    await submit();
    const other = await register("other@example.com");
    const real = await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: parent.enrolmentId }, { cookie: other.cookie });
    const fakeId = await h.api.post("/api/onboarding/pdf/retry", { enrolmentId: "00000000-0000-4000-9000-000000000000" }, { cookie: other.cookie });
    assert.equal(real.status, 404);
    assert.deepEqual(real.body, fakeId.body);
  });

  it("flooding the endpoints is stopped by the per-parent limits, and one parent's flood doesn't block another parent", async () => {
    await submit();
    await settle();
    const codes = [];
    for (let i = 0; i < 30; i++) codes.push((await h.api.get(`/api/onboarding/pdf?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie })).status);
    assert.ok(codes.includes(429));
    const other = await register("other@example.com");
    assert.equal((await h.api.get(`/api/onboarding?enrolment=${other.enrolmentId}`, { cookie: other.cookie })).status, 200);
  });

  it("an answer containing Drive query syntax or JSON can't change which file is found or stored", async () => {
    const sub = await submit(parent, { ...ANSWERS, remark: "' in parents or name contains '' } ] \"; {\"id\":\"root\"}" });
    assert.equal(sub.status, 200);
    await settle();
    assert.equal(fake.uploads().length, 1);
    assert.ok(fake.requests.filter((r) => r.path === "/drive/v3/files" && r.query.q).every((r) => !r.query.q.includes("contains")), "answers never appear in a Drive query");
  });
});

describe("a hostile or broken Drive", () => {
  it("a reply claiming success with no file id is treated as a failure, not as stored", async () => {
    fake.fail(/POST \/upload/, { status: 200, rawBody: "{}" });
    await submit();
    await settle();
    assert.equal((await pool.query("SELECT status FROM registration_pdfs")).rows[0].status, "failed");
  });

  it("a file id with unsafe characters is refused by the database rules and recorded as a failure", async () => {
    fake.fail(/POST \/upload/, { status: 200, rawBody: JSON.stringify({ id: "../../etc/passwd", size: "5" }) });
    await submit();
    await settle();
    const r = (await pool.query("SELECT status, drive_file_id FROM registration_pdfs")).rows[0];
    assert.equal(r.status, "failed");
    assert.equal(r.drive_file_id, null);
  });

  it("a Drive that returns different bytes later can't get its content handed to a parent (checksum)", async () => {
    await submit();
    await settle();
    fake.uploads()[0].bytes = Buffer.from("%PDF-1.3 forged by someone with Drive access");
    const res = await h.api.get(`/api/onboarding/pdf?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie });
    assert.equal(res.status, 503);
    assert.ok(!res.raw.toString("latin1").includes("forged"));
  });

  it("a Drive that never answers can't hang a parent's request for longer than the timeout", async () => {
    await submit();
    await settle();
    fake.fail(/GET \/drive\/v3\/files\//, { status: 200, delayMs: 4000, rawBody: "x" });
    const t0 = Date.now();
    const res = await h.api.get(`/api/onboarding/pdf?enrolment=${parent.enrolmentId}`, { cookie: parent.cookie });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - t0 < 3500, `${Date.now() - t0} ms`);
  });

  it("an error body from Google that contains a secret-looking string never reaches a log or a client", async () => {
    const logs = [];
    const quiet = await open({ drive: fake });
    quiet.logged.length = 0;
    fake.fail(/POST \/upload/, { status: 500, rawBody: JSON.stringify({ error: { message: "token ya29.SECRET-VALUE refresh 1//0SECRET" } }) });
    await submit();
    await settle();
    for (const text of [JSON.stringify(h.logged), JSON.stringify(quiet.logged), JSON.stringify((await pool.query("SELECT * FROM registration_pdfs")).rows)]) {
      assert.ok(!text.includes("SECRET"), "no response body text anywhere");
    }
    void logs;
  });

  it("a token for another Google account never gets a file: nothing is created in that account", async () => {
    fake.state.account = "attacker@example.com";
    await submit();
    await settle();
    assert.equal(fake.files.size, 0);
    assert.equal((await pool.query("SELECT last_error_code FROM registration_pdfs")).rows[0].last_error_code, "ACCOUNT_MISMATCH");
  });
});

describe("an operator's mistakes", () => {
  it("no credentials: every PDF endpoint still works for the owner, reports honestly, and never calls Google", async () => {
    const plain = await open({ drive: null });
    const verificationToken = await plain.verifiedToken("n@example.com", "registration");
    const reg = await plain.api.post("/api/registrations", { ...registrationFields("n@example.com", { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
    const cookie = plain.cookieOf(reg);
    const who = { cookie, enrolmentId: (await plain.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId };
    const saved = await plain.api.put("/api/onboarding", { tourType: "domestic", data: ANSWERS, currentSection: null, version: null, enrolmentId: who.enrolmentId }, { cookie });
    await plain.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: who.enrolmentId, ...ACK }, { cookie });
    assert.deepEqual((await plain.api.get(`/api/onboarding/pdf/status?enrolment=${who.enrolmentId}`, { cookie })).body.pdf, { status: "not_configured" });
    const pdf = await plain.api.get(`/api/onboarding/pdf?enrolment=${who.enrolmentId}`, { cookie });
    assert.equal(pdf.status, 200);
    assert.ok((await readPdf(pdf.raw)).text.includes("Asha Rao"));
    assert.equal(fake.requests.length, 0);
  });

  it("the wrong destination configured: the configured account is what is checked, never the token's claim of who it is", async () => {
    const drive = createDriveClient({ ...fake.options, account: "someone.else@example.com" });
    const storage = createPdfStorage({ db: pool, drive, loadModel: async () => { throw new Error("must not be reached"); }, render: async () => Buffer.alloc(1), logger: { error() {} } });
    await submit();
    await settle(); // the app's own background copy goes to the real destination first
    const uploaded = fake.uploads().length;
    const id = (await pool.query("SELECT id FROM onboarding_forms")).rows[0].id;
    // A second configuration whose destination says someone else: it must refuse, because the token belongs to dest@example.com.
    assert.equal((await storage.store(id)).status, "failed");
    assert.equal((await pool.query("SELECT last_error_code FROM registration_pdfs")).rows[0].last_error_code, "ACCOUNT_MISMATCH");
    assert.equal(fake.uploads().length, uploaded, "nothing more was uploaded");
  });
});

describe("folder names", () => {
  it("are always safe, short and never empty", () => {
    for (const bad of ["../../x", "a/b\\c", "\u0000\u0001", "   ", "‮evil", "x".repeat(500), "😀", null, undefined]) {
      const name = folderName(bad);
      assert.ok(name.length >= 1 && name.length <= 100, JSON.stringify(bad));
      assert.ok(!/[\\/\u0000-\u001f‪-‮]/.test(name), JSON.stringify(name));
    }
  });
});
