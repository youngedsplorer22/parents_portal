import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { allFields, getDefinition } from "../src/modules/onboarding/definitions.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, failingDb, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let broken;

before(async () => {
  h = await startApp({ db: pool });
  // Same app, but every write to onboarding_forms fails: simulates a database outage mid-request.
  broken = await startApp({ db: failingDb(pool, /UPDATE onboarding_forms|INSERT INTO onboarding_forms/) });
});
beforeEach(async () => {
  await resetTables(pool);
  h.logged.length = 0;
});
after(async () => {
  await h.close();
  await broken.close();
  await pool.end();
});

const forms = async () => (await pool.query("SELECT * FROM onboarding_forms ORDER BY created_at")).rows;
const save = (user, body) => h.api.put("/api/onboarding", body, { cookie: user.cookie });
const load = (user) => h.api.get("/api/onboarding", { cookie: user.cookie });
const submit = (user, version) => h.api.post("/api/onboarding/submit", { version, ...ACK }, { cookie: user.cookie });
const draft = (tourType, data = {}, over = {}) => ({ tourType, data, currentSection: "personal", version: null, ...over });

describe("authentication is required", () => {
  it("every endpoint answers 401 without a session, before reading the body", async () => {
    for (const [method, path, body] of [["get", "/api/onboarding"], ["put", "/api/onboarding", draft("domestic")], ["post", "/api/onboarding/submit", { version: 1 }], ["del", "/api/onboarding"]]) {
      const res = await h.api[method](path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
    assert.equal((await forms()).length, 0);
  });
  it("a logged-out cookie no longer works", async () => {
    const user = await h.signUp("a@example.com");
    await h.api.post("/api/auth/logout", undefined, { cookie: user.cookie });
    assert.equal((await load(user)).status, 401);
    assert.equal((await save(user, draft("domestic"))).status, 401);
  });
});

describe("GET /api/onboarding", () => {
  it("sends the forms for the caller's role and no draft yet", async () => {
    const user = await h.signUp("a@example.com", { role: "Teacher" });
    const res = await load(user);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "teacher");
    assert.equal(res.body.form, null);
    assert.deepEqual(Object.keys(res.body.definitions), ["domestic", "international"]);
    assert.deepEqual(res.body.definitions.domestic, JSON.parse(JSON.stringify(getDefinition("domestic", "teacher"))));
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
  it("the form variant follows the registration role, never the client", async () => {
    for (const [role, key] of [["Student", "student"], ["Teacher", "teacher"], ["Team Leader", "team_leader"]]) {
      const user = await h.signUp(`${key}@example.com`, { role });
      const res = await load(user);
      const keys = allFields(res.body.definitions.international).map((x) => x.key);
      assert.equal(res.body.role, key);
      assert.equal(keys.includes("branch"), key !== "team_leader");
      assert.equal(keys.includes("panHolderRelation"), key === "student");
    }
  });
});

describe("saving a draft", () => {
  it("creates the draft on first save and reports progress computed on the server", async () => {
    const user = await h.signUp("a@example.com");
    const res = await save(user, draft("domestic", { fullName: "  Asha  Rao ", gender: "Female" }));
    assert.equal(res.status, 200);
    const { form } = res.body;
    assert.equal(form.status, "draft");
    assert.equal(form.tourType, "domestic");
    assert.equal(form.role, "student");
    assert.deepEqual(form.data, { fullName: "Asha Rao", gender: "Female" });
    assert.equal(form.version, 1);
    assert.equal(form.currentSection, "personal");
    assert.equal(form.submittedAt, null);
    assert.equal(form.progress.percent, 25); // 2 of 8 required answers
    assert.equal(form.progress.requiredDone, 2);
    const [row] = await forms();
    assert.equal(row.status, "draft");
    assert.equal(row.progress_percent, 25);
    assert.equal(row.submitted_at, null);
  });

  it("is restored on a later session: log out, log in with a code, the answers and section come back", async () => {
    const user = await h.signUp("a@example.com");
    await save(user, draft("international", { firstName: "Asha", passportNumber: "aw246971" }, { currentSection: "passport" }));
    await h.api.post("/api/auth/logout", undefined, { cookie: user.cookie });

    const { cookie } = await h.logIn("a@example.com");
    const res = await h.api.get("/api/onboarding", { cookie });
    assert.equal(res.body.form.tourType, "international");
    assert.deepEqual(res.body.form.data, { firstName: "Asha", passportNumber: "AW246971" });
    assert.equal(res.body.form.currentSection, "passport");
    assert.equal(res.body.form.status, "draft");
  });

  it("edits persist and the version moves forward each time", async () => {
    const user = await h.signUp("a@example.com");
    const first = await save(user, draft("domestic", { fullName: "Asha" }));
    const second = await save(user, draft("domestic", { fullName: "Asha Rao", phone: "98765 43210" }, { version: first.body.form.version, currentSection: "contact" }));
    assert.equal(second.body.form.version, 2);
    const third = await save(user, draft("domestic", { fullName: "Asha R" }, { version: 2 }));
    assert.equal(third.body.form.version, 3);
    assert.deepEqual((await load(user)).body.form.data, { fullName: "Asha R" }); // a save replaces the answers; cleared fields stay cleared
    assert.equal((await forms()).length, 1);
  });

  it("stores incomplete and badly formatted answers as a draft (formats are enforced on submit)", async () => {
    const user = await h.signUp("a@example.com");
    const res = await save(user, draft("international", { panNumber: "abc", dateOfBirth: "2012-0" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.form.progress.sections[0].status, "attention");
  });

  it("validates on the server: unknown fields, wrong types, bad options, long values, bad sections", async () => {
    const user = await h.signUp("a@example.com");
    const bad = [
      draft("domestic", { admin: "1" }),
      draft("domestic", { fullName: { x: 1 } }),
      draft("domestic", { gender: "Robot" }),
      draft("domestic", { fullName: "x".repeat(500) }),
      draft("international", { passportValidity: "9 years" }),
      draft("domestic", {}, { currentSection: "nope" }),
      draft("weekend", {}),
      { ...draft("domestic"), registrationId: "00000000-0000-0000-0000-000000000000" },
      { ...draft("domestic"), userId: "1" },
      { ...draft("domestic"), version: "1" },
      { ...draft("domestic"), version: 0 },
      { tourType: "domestic", data: [] , version: null },
    ];
    for (const body of bad) {
      const res = await save(user, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    assert.equal((await forms()).length, 0);
  });

  it("rejects malformed and oversized bodies", async () => {
    const user = await h.signUp("a@example.com");
    const malformed = await h.api.put("/api/onboarding", "{nope", { cookie: user.cookie, raw: true });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_JSON");
    const big = await save(user, draft("domestic", { allergy: "x".repeat(70_000) }));
    assert.equal(big.status, 413);
  });

  it("the tour type is locked once a draft exists", async () => {
    const user = await h.signUp("a@example.com");
    const first = await save(user, draft("domestic", { fullName: "Asha" }));
    const res = await save(user, draft("international", {}, { version: first.body.form.version }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "TOUR_TYPE_LOCKED");
    assert.equal((await forms())[0].tour_type, "domestic");
  });

  it("refuses a stale version instead of overwriting newer answers (e.g. a second tab)", async () => {
    const user = await h.signUp("a@example.com");
    const first = await save(user, draft("domestic", { fullName: "Asha" }));
    await save(user, draft("domestic", { fullName: "From tab two" }, { version: first.body.form.version }));
    const stale = await save(user, draft("domestic", { fullName: "From tab one" }, { version: first.body.form.version }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");
    assert.equal(stale.body.error.currentVersion, 2);
    assert.equal((await forms())[0].data.fullName, "From tab two");
  });

  it("creating when a draft already exists, or updating when none does, is a conflict", async () => {
    const user = await h.signUp("a@example.com");
    assert.equal((await save(user, draft("domestic", {}, { version: 3 }))).body.error.code, "VERSION_CONFLICT");
    await save(user, draft("domestic", { fullName: "Asha" }));
    assert.equal((await save(user, draft("domestic", { fullName: "Other" }))).body.error.code, "VERSION_CONFLICT");
    assert.equal((await forms())[0].data.fullName, "Asha");
  });

  it("two simultaneous first saves create exactly one draft", async () => {
    const user = await h.signUp("a@example.com");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => save(user, draft("domestic", { fullName: `Tab ${i}` }))));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error.code === "VERSION_CONFLICT"));
    assert.equal((await forms()).length, 1);
  });

  it("a database failure answers 500 with nothing leaked and nothing saved", async () => {
    const user = await broken.signUp("a@example.com");
    const res = await broken.api.put("/api/onboarding", draft("domestic", { fullName: "Asha" }), { cookie: user.cookie });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(res.body).includes("simulated"));
    assert.ok(!JSON.stringify(res.body).includes("Asha"));
    assert.equal((await forms()).length, 0);
  });
});

describe("drafts belong to their owner", () => {
  it("one user cannot read another user's draft; each sees only their own", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    await save(a, draft("domestic", { fullName: "Asha Secret" }));

    const asB = await load(b);
    assert.equal(asB.body.form, null);
    assert.ok(!JSON.stringify(asB.body).includes("Asha Secret"));
  });

  it("one user cannot modify another's draft: their own save creates a separate form", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    await save(a, draft("domestic", { fullName: "Asha" }));
    const res = await save(b, draft("domestic", { fullName: "Bhav" }));
    assert.equal(res.status, 200);
    const rows = await forms();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.data.fullName).sort(), ["Asha", "Bhav"]);
    assert.equal((await load(a)).body.form.data.fullName, "Asha");
  });

  it("an owner id in the body, query string or headers is not accepted or used", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    await save(a, draft("domestic", { fullName: "Asha" }));
    const bodyAttempt = await save(b, { ...draft("domestic", { fullName: "Evil" }), registrationId: a.registrationId });
    assert.equal(bodyAttempt.status, 400);
    const queryAttempt = await h.api.get(`/api/onboarding?registrationId=${a.registrationId}`, { cookie: b.cookie, headers: { "x-registration-id": a.registrationId } });
    assert.equal(queryAttempt.body.form, null);
    assert.equal((await forms())[0].data.fullName, "Asha");
  });

  it("a user cannot submit or discard another user's form", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    const created = await save(a, draft("domestic", validAnswers("domestic", "student")));
    const attempt = await submit(b, created.body.form.version);
    assert.equal(attempt.status, 404);
    assert.equal(attempt.body.error.code, "NO_DRAFT");
    await h.api.del("/api/onboarding", { cookie: b.cookie });
    const [row] = await forms();
    assert.equal(row.status, "draft");
    assert.equal(row.registration_id, a.registrationId);
  });

  it("the database keeps one form per registration", async () => {
    const a = await h.signUp("a@example.com");
    await save(a, draft("domestic"));
    await assert.rejects(
      pool.query("INSERT INTO onboarding_forms (registration_id, tour_type, participant_role) VALUES ($1, 'domestic', 'student')", [a.registrationId]),
      (err) => err.constraint === "onboarding_forms_registration_key",
    );
  });
});

describe("final submission", () => {
  it("an empty or incomplete draft is refused with the list of problems, and stays a draft", async () => {
    const user = await h.signUp("a@example.com");
    const created = await save(user, draft("domestic", { fullName: "Asha" }));
    const res = await submit(user, created.body.form.version);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "FORM_INCOMPLETE");
    const paths = res.body.error.fields.map((f) => f.path);
    assert.ok(paths.includes("data.gender") && paths.includes("data.phone"));
    assert.ok(!paths.includes("data.fullName") && !paths.includes("data.allergy"));
    const [row] = await forms();
    assert.equal(row.status, "draft");
    assert.equal(row.submitted_at, null);
  });

  it("a complete draft with an invalid format is refused", async () => {
    const user = await h.signUp("a@example.com", { role: "Teacher" });
    const created = await save(user, draft("international", { ...validAnswers("international", "teacher"), panNumber: "NOTAPAN" }));
    const res = await submit(user, created.body.form.version);
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.fields.map((f) => f.path), ["data.panNumber"]);
  });

  it("without a saved form there is nothing to submit", async () => {
    const user = await h.signUp("a@example.com");
    const res = await submit(user, 1);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NO_DRAFT");
  });

  it("submits a complete form for every tour and role, only after the database commit", async () => {
    for (const [role, key] of [["Student", "student"], ["Teacher", "teacher"], ["Team Leader", "team_leader"]]) {
      for (const tour of ["domestic", "international"]) {
        const user = await h.signUp(`${key}-${tour}@example.com`, { role });
        const created = await save(user, draft(tour, validAnswers(tour, key)));
        assert.equal(created.body.form.progress.percent, 100, `${tour}/${key}`);
        const res = await submit(user, created.body.form.version);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.form.status, "submitted");
        assert.ok(res.body.form.submittedAt);
        assert.equal(res.body.form.progress.percent, 100);
        const row = (await forms()).find((r) => r.registration_id === user.registrationId);
        assert.equal(row.status, "submitted");
        assert.ok(row.submitted_at);
        assert.equal(row.progress_percent, 100);
      }
    }
  });

  it("the submit button's version must match what the user last saw", async () => {
    const user = await h.signUp("a@example.com");
    const created = await save(user, draft("domestic", validAnswers("domestic", "student")));
    const res = await submit(user, created.body.form.version + 5);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "VERSION_CONFLICT");
    assert.equal((await forms())[0].status, "draft");
  });

  it("a second submit does not resubmit: it reports ALREADY_SUBMITTED and changes nothing", async () => {
    const user = await h.signUp("a@example.com");
    const created = await save(user, draft("domestic", validAnswers("domestic", "student")));
    const first = await submit(user, created.body.form.version);
    const before = (await forms())[0];
    const second = await submit(user, created.body.form.version);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "ALREADY_SUBMITTED");
    const after = (await forms())[0];
    assert.equal(after.version, before.version);
    assert.equal(after.submitted_at.getTime(), before.submitted_at.getTime());
    assert.equal(first.body.form.status, "submitted");
  });

  it("concurrent submits: exactly one succeeds", async () => {
    const user = await h.signUp("a@example.com");
    const created = await save(user, draft("domestic", validAnswers("domestic", "student")));
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(user, created.body.form.version)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error.code === "ALREADY_SUBMITTED"));
    assert.equal((await forms())[0].version, created.body.form.version + 1);
  });

  it("a database failure during submit leaves the draft untouched and editable", async () => {
    const user = await broken.signUp("a@example.com");
    await pool.query(
      "INSERT INTO onboarding_forms (registration_id, tour_type, participant_role, data, progress_percent) VALUES ($1, 'domestic', 'student', $2::jsonb, 100)",
      [user.registrationId, JSON.stringify(validAnswers("domestic", "student"))],
    );
    const res = await broken.api.post("/api/onboarding/submit", { version: 1, ...ACK }, { cookie: user.cookie });
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(res.body).includes("simulated"));
    const [row] = await forms();
    assert.equal(row.status, "draft");
    assert.equal(row.submitted_at, null);
    assert.equal(row.version, 1);
  });
});

describe("after submission (policy: the form is read-only)", () => {
  const submitted = async () => {
    const user = await h.signUp("a@example.com");
    const created = await save(user, draft("domestic", validAnswers("domestic", "student")));
    const res = await submit(user, created.body.form.version);
    return { user, form: res.body.form };
  };

  it("edits are refused with FORM_SUBMITTED and nothing changes", async () => {
    const { user, form } = await submitted();
    const res = await save(user, draft("domestic", { fullName: "Changed" }, { version: form.version }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "FORM_SUBMITTED");
    assert.notEqual((await forms())[0].data.fullName, "Changed");
  });

  it("the form can be read, and is marked submitted with its answers", async () => {
    const { user } = await submitted();
    const res = await load(user);
    assert.equal(res.body.form.status, "submitted");
    assert.equal(res.body.form.progress.percent, 100);
    assert.equal(res.body.form.data.fullName, "Sample fullName");
  });

  it("'start over' cannot delete a submitted form", async () => {
    const { user } = await submitted();
    const res = await h.api.del("/api/onboarding", { cookie: user.cookie });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "FORM_SUBMITTED");
    assert.equal((await forms()).length, 1);
  });

  it("the database itself refuses to change a submitted form, even outside the app", async () => {
    await submitted();
    await assert.rejects(pool.query("UPDATE onboarding_forms SET data = '{}'::jsonb"), /can no longer be changed/);
    await assert.rejects(pool.query("UPDATE onboarding_forms SET status = 'draft', submitted_at = NULL"), /can no longer be changed/);
    assert.equal((await forms())[0].status, "submitted");
  });
});

describe("start over (discard a draft)", () => {
  it("deletes only the caller's draft, so the tour can be chosen again", async () => {
    const a = await h.signUp("a@example.com");
    const b = await h.signUp("b@example.com");
    await save(a, draft("domestic", { fullName: "Asha" }));
    await save(b, draft("domestic", { fullName: "Bhav" }));
    const res = await h.api.del("/api/onboarding", { cookie: a.cookie });
    assert.equal(res.status, 200);
    assert.equal((await load(a)).body.form, null);
    assert.equal((await load(b)).body.form.data.fullName, "Bhav");
    assert.equal((await save(a, draft("international", {}))).status, 200);
  });
  it("is a no-op when there is no draft", async () => {
    const a = await h.signUp("a@example.com");
    assert.equal((await h.api.del("/api/onboarding", { cookie: a.cookie })).status, 200);
  });
});

describe("database constraints", () => {
  it("refuse impossible rows", async () => {
    const a = await h.signUp("a@example.com");
    const insert = (cols, vals) => pool.query(`INSERT INTO onboarding_forms (registration_id, ${cols}) VALUES ($1, ${vals})`, [a.registrationId]);
    await assert.rejects(insert("tour_type, participant_role", "'local', 'student'"), (e) => e.constraint === "onboarding_forms_tour_chk");
    await assert.rejects(insert("tour_type, participant_role", "'domestic', 'parent'"), (e) => e.constraint === "onboarding_forms_role_chk");
    await assert.rejects(insert("tour_type, participant_role, status", "'domestic', 'student', 'submitted'"), (e) => e.constraint === "onboarding_forms_submitted_chk");
    await assert.rejects(insert("tour_type, participant_role, data", "'domestic', 'student', '[]'"), (e) => e.constraint === "onboarding_forms_data_chk");
    await assert.rejects(insert("tour_type, participant_role, progress_percent", "'domestic', 'student', 101"), (e) => e.constraint === "onboarding_forms_progress_chk");
    await assert.rejects(
      pool.query("INSERT INTO onboarding_forms (registration_id, tour_type, participant_role) VALUES ('00000000-0000-0000-0000-000000000000', 'domestic', 'student')"),
      (e) => e.code === "23503",
    );
  });
});
