import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createDriveClient } from "../src/modules/pdf-storage/drive-client.js";
import { PdfUnavailableError, createPdfStorage } from "../src/modules/pdf-storage/service.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables } from "./helpers.js";
import { startFakeDrive } from "./fake-drive.js";

const pool = createTestPool();
let h;
let fake;
let logs;
let renders;
let storage;
const pdfFor = (model) => Buffer.from(`%PDF-1.3 fake document for ${model.reference}\n%%EOF\n`);

after(() => pool.end());
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  fake = await startFakeDrive({ account: "dest@example.com" });
  logs = [];
  renders = 0;
  storage = makeStorage();
});
afterEach(async () => {
  await storage.drain();
  await h.close();
  await fake.close();
});

const folderNames = { school: { key: "school:s1", name: "Greenwood International School · Kolkata" }, trip: { key: "trip:t1", name: "Annual Trip 2027" } };
const lookup = { models: new Map() }; // formId -> { model, folders }

function makeStorage(over = {}) {
  const drive = over.drive === null ? null : createDriveClient({ ...fake.options, timeoutMs: 1500, ...over.driveOptions });
  return createPdfStorage({
    db: pool,
    drive,
    rootName: "Young Edsplorer",
    logger: { error: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    loadModel: over.loadModel ?? (async (formId) => lookup.models.get(formId) ?? assert.fail(`no model for ${formId}`)),
    render: over.render ?? (async (model) => {
      renders++;
      return pdfFor(model);
    }),
    ...over.options,
  });
}

/** A real submitted form in the test database (so the foreign key is real); resolves to its id. */
async function submittedForm(email = `p${Math.random().toString(36).slice(2, 8)}@example.com`, { folders = folderNames, reference } = {}) {
  const { cookie, registrationId } = await h.signUp(email); // registers as a Student
  const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: null, version: null, enrolmentId: "legacy" }, { cookie });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const sub = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: "legacy", ...ACK }, { cookie });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const id = (await pool.query("SELECT id FROM onboarding_forms WHERE registration_id = $1", [registrationId])).rows[0].id;
  lookup.models.set(id, { model: { reference: reference ?? `YE-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}` }, folders });
  return id;
}
const row = async (id) => (await pool.query("SELECT * FROM registration_pdfs WHERE form_id = $1", [id])).rows[0];
const sha = (b) => createHash("sha256").update(b).digest("hex");

describe("storing a PDF in Drive", () => {
  it("creates the folders Young Edsplorer / Parent Registrations / School / Trip and stores <reference>.pdf in the last one", async () => {
    const id = await submittedForm();
    const result = await storage.store(id);
    assert.equal(result.status, "stored");
    const names = Object.fromEntries(fake.folders().map(([fid, f]) => [fid, f]));
    const file = [...fake.files.entries()].find(([, f]) => f.bytes)[1];
    const chain = [];
    for (let p = file.parents[0]; p && p !== "root"; p = names[p].parents[0]) chain.unshift(names[p].name);
    assert.deepEqual(chain, ["Young Edsplorer", "Parent Registrations", "Greenwood International School · Kolkata", "Annual Trip 2027"]);
    assert.equal(file.name, `${lookup.models.get(id).model.reference}.pdf`);
    assert.deepEqual(file.bytes, pdfFor(lookup.models.get(id).model));
    assert.equal(file.mimeType, "application/pdf");
  });

  it("records where it is in PostgreSQL: file id, account, size, checksum and time; not the PDF itself", async () => {
    const id = await submittedForm();
    await storage.store(id);
    const r = await row(id);
    const bytes = pdfFor(lookup.models.get(id).model);
    assert.equal(r.status, "stored");
    assert.match(r.drive_file_id, /^[a-z0-9]+$/);
    assert.equal(r.destination, "dest@example.com");
    assert.equal(r.size_bytes, bytes.length);
    assert.equal(r.sha256, sha(bytes));
    assert.equal(r.file_name, `${lookup.models.get(id).model.reference}.pdf`);
    assert.equal(r.attempts, 1);
    assert.equal(r.last_error_code, null);
    assert.equal(r.claimed_at, null);
    assert.ok(r.stored_at);
    assert.ok(!Object.keys(r).some((k) => /bytes$|data$|pdf$/.test(k) && Buffer.isBuffer(r[k])), "no binary column");
  });

  it("the file name is the reference only, and folder names are made safe (slashes, control characters, length)", async () => {
    const id = await submittedForm(undefined, { folders: { school: { key: "school:x", name: "St. Mary's / North\u0000 \\ Campus\n" + "x".repeat(300) }, trip: { key: "trip:x", name: "  Trip  ‮ 2027  " } } });
    await storage.store(id);
    const file = [...fake.files.values()].find((f) => f.bytes);
    assert.match(file.name, /^YE-[0-9A-F]{8}\.pdf$/);
    for (const [, f] of fake.folders()) {
      assert.ok(!/[\\/\u0000-\u001f\u007f‪-‮]/.test(f.name), JSON.stringify(f.name));
      assert.ok(f.name.length <= 100 && f.name === f.name.trim());
    }
    assert.ok(fake.folders().some(([, f]) => f.name.startsWith("St. Mary's")));
  });

  it("keeps everything private: no sharing or permission request is ever made", async () => {
    await storage.store(await submittedForm());
    assert.ok(!fake.requests.some((r) => /permission|share|publish/i.test(r.path) || /permission|share/i.test(JSON.stringify(r.query))));
  });

  it("reuses a trip's folders for later registrations, and keeps different trips in different folders", async () => {
    const a = await submittedForm();
    const b = await submittedForm();
    const c = await submittedForm(undefined, { folders: { school: folderNames.school, trip: { key: "trip:t2", name: "Winter Trip" } } });
    await storage.store(a);
    const foldersAfterFirst = fake.folders().length;
    await storage.store(b);
    assert.equal(fake.folders().length, foldersAfterFirst, "no new folder for the same school and trip");
    await storage.store(c);
    assert.equal(fake.folders().length, foldersAfterFirst + 1, "only the new trip got a folder");
    assert.equal(fake.uploads().length, 3);
    assert.equal((await pool.query("SELECT count(*)::int n FROM drive_folders")).rows[0].n, foldersAfterFirst + 1);
  });

  it("a second process (empty folder cache) finds the existing folders instead of making duplicates", async () => {
    await storage.store(await submittedForm());
    const before = fake.folders().length;
    await pool.query("DELETE FROM drive_folders");
    await storage.store(await submittedForm());
    assert.equal(fake.folders().length, before);
  });
});

describe("no duplicates", () => {
  it("storing twice (a retry, a double click, the background sweep) uploads one file", async () => {
    const id = await submittedForm();
    await storage.store(id);
    const again = await storage.store(id);
    assert.equal(again.status, "stored");
    assert.equal(fake.uploads().length, 1);
    assert.equal(renders, 1, "no second render either");
    assert.equal((await row(id)).attempts, 1);
  });

  it("many requests at once make exactly one upload (the claim lets one worker through)", async () => {
    const id = await submittedForm();
    const results = await Promise.all(Array.from({ length: 8 }, () => storage.store(id)));
    assert.equal(fake.uploads().length, 1);
    assert.ok(results.every((r) => ["stored", "pending"].includes(r.status)));
    assert.equal((await row(id)).status, "stored");
    assert.equal((await row(id)).attempts, 1);
  });

  it("if the upload succeeded but the database was not updated (a crash), the retry finds the file and records it instead of uploading again", async () => {
    const id = await submittedForm();
    const flaky = makeStorage({ options: { afterUploadHook: () => { throw new Error("simulated crash after upload"); } } });
    const first = await flaky.store(id);
    assert.equal(first.status, "failed");
    assert.equal(fake.uploads().length, 1);
    assert.equal((await row(id)).status, "failed");
    await pool.query("UPDATE registration_pdfs SET next_retry_at = now() - interval '1 second', last_attempt_at = now() - interval '1 minute'");
    const second = await storage.store(id);
    assert.equal(second.status, "stored");
    assert.equal(fake.uploads().length, 1, "the file that was already there was adopted");
    assert.equal((await row(id)).sha256, sha(pdfFor(lookup.models.get(id).model)));
  });

  it("a stuck claim (a worker that died mid-upload) is taken over after the lease, not before", async () => {
    const id = await submittedForm();
    await storage.ensureRecord(id);
    await pool.query("UPDATE registration_pdfs SET claimed_at = now(), attempts = 1");
    assert.equal((await storage.store(id)).status, "pending", "still being worked on: left alone");
    assert.equal(fake.uploads().length, 0);
    await pool.query("UPDATE registration_pdfs SET claimed_at = now() - interval '5 minutes'");
    assert.equal((await storage.store(id)).status, "stored");
    assert.equal(fake.uploads().length, 1);
  });
});

describe("failures: recorded safely, never lost, retried without duplicates", () => {
  const cases = [
    ["Drive storage is full", { status: 403, reason: "storageQuotaExceeded" }, /POST \/upload/, "QUOTA_FULL"],
    ["Google is rate limiting", { status: 429, reason: "rateLimitExceeded" }, /POST \/upload/, "RATE_LIMITED"],
    ["Google returns 503", { status: 503, reason: "backendError" }, /POST \/upload/, "DRIVE_ERROR"],
    ["the connection drops", { drop: true }, /POST \/upload/, "NETWORK"],
    ["Google is too slow", { status: 200, delayMs: 2500, rawBody: "{}" }, /POST \/upload/, "TIMEOUT"],
    ["the folder can't be created", { status: 403, reason: "insufficientFilePermissions" }, /POST \/drive\/v3\/files$/, "PERMISSION"],
  ];
  for (const [name, fault, pattern, code] of cases) {
    it(`${name}: the registration stays, the status is failed/${code}, and a later retry stores it once`, async () => {
      const id = await submittedForm();
      fake.fail(pattern, fault);
      const first = await storage.store(id);
      assert.equal(first.status, "failed");
      const r = await row(id);
      assert.equal(r.status, "failed");
      assert.equal(r.last_error_code, code);
      assert.equal(r.drive_file_id, null);
      assert.ok(r.next_retry_at, "a retry is scheduled");
      assert.equal(r.attempts, 1);
      assert.equal((await pool.query("SELECT status FROM onboarding_forms WHERE id = $1", [id])).rows[0].status, "submitted", "the registration is untouched");
      assert.equal(fake.uploads().length, 0);
      await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute', next_retry_at = now() - interval '1 second'");
      assert.equal((await storage.store(id)).status, "stored");
      assert.equal(fake.uploads().length, 1);
      assert.equal((await row(id)).last_error_code, null, "the error is cleared once it works");
      assert.equal((await row(id)).attempts, 2);
    });
  }

  it("missing credentials: nothing is attempted, nothing is claimed to be stored, and the status says so", async () => {
    const none = makeStorage({ drive: null });
    const id = await submittedForm();
    assert.equal(none.configured, false);
    assert.deepEqual(await none.store(id), { status: "not_configured" });
    assert.deepEqual(await none.statusOf(id), { status: "not_configured" });
    assert.equal(await row(id), undefined, "no record was invented");
    assert.equal(fake.requests.length, 0);
  });

  it("revoked access: failed/AUTH_REVOKED; once authorisation is fixed the next try stores it", async () => {
    const id = await submittedForm();
    fake.revoke();
    assert.equal((await storage.store(id)).status, "failed");
    assert.equal((await row(id)).last_error_code, "AUTH_REVOKED");
    fake.state.refreshToken = "good-refresh-token"; // the owner re-authorised
    await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute'");
    assert.equal((await makeStorage().store(id)).status, "stored");
  });

  it("a token for a different Google account is never used: failed/ACCOUNT_MISMATCH and no folder or file is created", async () => {
    fake.state.account = "someone.else@example.com";
    const id = await submittedForm();
    assert.equal((await storage.store(id)).status, "failed");
    assert.equal((await row(id)).last_error_code, "ACCOUNT_MISMATCH");
    assert.equal(fake.files.size, 0);
  });

  it("the account check happens once per process, not on every upload", async () => {
    await storage.store(await submittedForm());
    await storage.store(await submittedForm());
    assert.equal(fake.requests.filter((r) => r.path === "/drive/v3/about").length, 1);
  });

  it("a registration that can't be turned into a PDF fails with a fixed code (and nothing is uploaded)", async () => {
    const broken = makeStorage({ loadModel: async () => { throw new Error("declaration acceptance could not be verified for form with private details"); } });
    const id = await submittedForm();
    assert.equal((await broken.store(id)).status, "failed");
    assert.equal((await row(id)).last_error_code, "PDF_INVALID");
    assert.equal(fake.files.size, 0);
  });

  it("the renderer failing is recorded as PDF_RENDER", async () => {
    const broken = makeStorage({ render: async () => { throw new Error("boom with Asha Rao details"); } });
    const id = await submittedForm();
    assert.equal((await broken.store(id)).status, "failed");
    assert.equal((await row(id)).last_error_code, "PDF_RENDER");
  });

  it("retries back off: each failure waits longer, up to a ceiling", async () => {
    const id = await submittedForm();
    const delays = [];
    for (let i = 0; i < 4; i++) {
      fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
      await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute', claimed_at = NULL WHERE form_id = $1", [id]);
      await storage.store(id);
      const r = await row(id);
      delays.push(new Date(r.next_retry_at) - new Date(r.last_attempt_at));
    }
    assert.ok(delays[1] > delays[0] && delays[2] > delays[1] && delays[3] > delays[2], delays.join(" < "));
    assert.ok(delays.every((d) => d <= 3600 * 1000 + 1000));
  });

  it("logs a short safe line: a code and the reference, never tokens, secrets, file ids, names, answers or response bodies", async () => {
    const id = await submittedForm();
    fake.fail(/POST \/upload/, { status: 403, reason: "storageQuotaExceeded" });
    await storage.store(id);
    fake.revoke();
    await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute', claimed_at = NULL");
    await storage.store(id);
    const text = logs.join("\n");
    assert.match(text, /QUOTA_FULL/);
    assert.match(text, /AUTH_REVOKED/);
    for (const secret of ["good-refresh-token", "test-secret", "Bearer", "at-", "dest@example.com", "storageQuotaExceeded", "Asha", "parent@", id]) assert.ok(!text.includes(secret), `log leaked: ${secret}`);
  });
});

describe("destination account", () => {
  it("a PDF stored for one account is stored again for a different one, in that account's own folders", async () => {
    const id = await submittedForm();
    await storage.store(id);
    const other = await startFakeDrive({ account: "new.destination@example.com" });
    try {
      const switched = createPdfStorage({
        db: pool, drive: createDriveClient({ ...other.options }), rootName: "Young Edsplorer", logger: { error() {}, warn() {} },
        loadModel: async (fid) => lookup.models.get(fid), render: async (m) => pdfFor(m),
      });
      assert.deepEqual(await switched.statusOf(id), { status: "pending" }, "the stored copy is in the old account, so it is not available to the new one");
      assert.equal((await switched.store(id)).status, "stored");
      assert.equal(other.uploads().length, 1);
      assert.equal(fake.uploads().length, 1, "the copy in the old account is left alone");
      assert.equal((await row(id)).destination, "new.destination@example.com");
      assert.equal((await pool.query("SELECT count(*)::int n FROM drive_folders WHERE destination = 'new.destination@example.com'")).rows[0].n, 4);
    } finally {
      await other.close();
    }
  });
});

describe("reading a stored copy back", () => {
  it("returns exactly the stored bytes", async () => {
    const id = await submittedForm();
    await storage.store(id);
    assert.deepEqual(await storage.fetchStored(id), pdfFor(lookup.models.get(id).model));
  });

  it("refuses a file whose content no longer matches the checksum (it was replaced in Drive)", async () => {
    const id = await submittedForm();
    await storage.store(id);
    [...fake.files.values()].find((f) => f.bytes).bytes = Buffer.from("%PDF-1.3 something else");
    await assert.rejects(storage.fetchStored(id), (err) => err instanceof PdfUnavailableError && err.reason === "INTEGRITY");
    assert.equal((await row(id)).status, "stored", "a mismatch alone doesn't rewrite the record");
    assert.ok(logs.some((l) => /integrity/i.test(l)));
  });

  it("a file deleted from Drive makes the record 'failed' so it is stored again, and meanwhile reads as unavailable", async () => {
    const id = await submittedForm();
    await storage.store(id);
    fake.files.clear();
    await assert.rejects(storage.fetchStored(id), (err) => err instanceof PdfUnavailableError && err.reason === "NOT_FOUND");
    const r = await row(id);
    assert.equal(r.status, "failed");
    assert.equal(r.drive_file_id, null);
    await pool.query("DELETE FROM drive_folders");
    await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '1 minute', next_retry_at = now() - interval '1 second'");
    assert.equal((await storage.store(id)).status, "stored");
    assert.deepEqual(await storage.fetchStored(id), pdfFor(lookup.models.get(id).model));
  });

  it("a Drive outage while reading is 'unavailable' and changes nothing", async () => {
    const id = await submittedForm();
    await storage.store(id);
    fake.fail(/GET \/drive\/v3\/files\//, { status: 503, reason: "backendError" });
    await assert.rejects(storage.fetchStored(id), (err) => err instanceof PdfUnavailableError && err.reason === "DRIVE_ERROR");
    assert.equal((await row(id)).status, "stored");
    assert.deepEqual(await storage.fetchStored(id), pdfFor(lookup.models.get(id).model));
  });

  it("refuses to read anything that isn't stored", async () => {
    const id = await submittedForm();
    await assert.rejects(storage.fetchStored(id), (err) => err instanceof PdfUnavailableError);
  });
});

describe("the background: schedule, sweep, retry", () => {
  it("schedule() stores in the background and drain() waits for it; a failure never escapes as an unhandled error", async () => {
    const id = await submittedForm();
    storage.schedule(id);
    await storage.drain();
    assert.equal((await row(id)).status, "stored");
    const id2 = await submittedForm();
    fake.fail(/POST \/upload/, { status: 500, reason: "internalError" });
    storage.schedule(id2);
    await storage.drain();
    assert.equal((await row(id2)).status, "failed");
  });

  it("schedule() with storage not configured does nothing", async () => {
    const none = makeStorage({ drive: null });
    none.schedule(await submittedForm());
    await none.drain();
    assert.equal(fake.requests.length, 0);
  });

  it("the sweep stores forms that have no record yet (older submissions, or a crash before the record was made) and retries due failures", async () => {
    const never = await submittedForm();
    const failedOne = await submittedForm();
    fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
    await storage.store(failedOne);
    await pool.query("UPDATE registration_pdfs SET next_retry_at = now() - interval '1 second'");
    const worked = await storage.sweep({ limit: 10 });
    assert.equal(worked, 2);
    await storage.drain();
    assert.equal((await row(never)).status, "stored");
    assert.equal((await row(failedOne)).status, "stored");
    assert.equal(fake.uploads().length, 2);
  });

  it("the sweep leaves alone what isn't due yet, what is stored, what is claimed, and what has used up its automatic attempts", async () => {
    const waiting = await submittedForm();
    const claimed = await submittedForm();
    const exhausted = await submittedForm();
    const done = await submittedForm();
    await storage.store(done);
    for (const id of [waiting, claimed, exhausted]) await storage.ensureRecord(id);
    await pool.query("UPDATE registration_pdfs SET next_retry_at = now() + interval '1 hour', status = 'failed', last_error_code = 'NETWORK' WHERE form_id = $1", [waiting]);
    await pool.query("UPDATE registration_pdfs SET claimed_at = now(), next_retry_at = now() - interval '1 second' WHERE form_id = $1", [claimed]);
    await pool.query("UPDATE registration_pdfs SET status = 'failed', last_error_code = 'NETWORK', attempts = 99, next_retry_at = now() - interval '1 second' WHERE form_id = $1", [exhausted]);
    assert.equal(await storage.sweep({ limit: 10 }), 0);
    assert.equal(fake.uploads().length, 1);
  });

  it("the sweep takes at most `limit` forms at a time", async () => {
    for (let i = 0; i < 5; i++) await submittedForm();
    assert.equal(await storage.sweep({ limit: 2 }), 2);
    await storage.drain();
    assert.equal(fake.uploads().length, 2);
  });

  it("the sweep does nothing without credentials", async () => {
    await submittedForm();
    assert.equal(await makeStorage({ drive: null }).sweep({ limit: 5 }), 0);
  });

  it("a manual retry starts a new attempt in the background, but not more than once every 15 seconds", async () => {
    const id = await submittedForm();
    fake.fail(/POST \/upload/, { status: 503, reason: "backendError" });
    await storage.store(id);
    await assert.rejects(storage.retry(id), (err) => err.status === 429 && err.code === "RATE_LIMITED" && err.details.retryAfterSeconds >= 1);
    await pool.query("UPDATE registration_pdfs SET last_attempt_at = now() - interval '20 seconds'");
    const result = await storage.retry(id);
    assert.equal(result.status, "pending");
    await storage.drain();
    assert.equal((await row(id)).status, "stored");
    assert.equal((await storage.retry(id)).status, "stored", "nothing left to retry");
    assert.equal(fake.uploads().length, 1);
  });

  it("a manual retry ignores the automatic back-off and attempt limit (the owner is asking)", async () => {
    const id = await submittedForm();
    await storage.ensureRecord(id);
    await pool.query("UPDATE registration_pdfs SET status = 'failed', last_error_code = 'NETWORK', attempts = 99, next_retry_at = now() + interval '1 hour', last_attempt_at = now() - interval '1 minute'");
    await storage.retry(id);
    await storage.drain();
    assert.equal((await row(id)).status, "stored");
  });

  it("a retry with storage not configured says so and does nothing", async () => {
    const none = makeStorage({ drive: null });
    assert.deepEqual(await none.retry(await submittedForm()), { status: "not_configured" });
  });
});

describe("status", () => {
  it("is pending for a form with no record yet (and the record is created, so it will be picked up)", async () => {
    const id = await submittedForm();
    assert.deepEqual(await storage.statusOf(id), { status: "pending" });
    assert.equal((await row(id)).status, "pending");
    assert.equal((await pool.query("SELECT count(*)::int n FROM registration_pdfs")).rows[0].n, 1);
  });

  it("never contains the Drive file id, the account, the checksum or any error text", async () => {
    const id = await submittedForm();
    await storage.store(id);
    const text = JSON.stringify(await storage.statusOf(id));
    assert.equal(text, '{"status":"stored"}');
  });
});
