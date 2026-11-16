import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { ageFromDob } from "../src/modules/validation/rules.js";
import { PHONE_OK } from "./fixtures/form-rule-cases.js";
import { todayIso } from "../src/modules/onboarding/engine.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, TEST_PASSWORD, createTestPool, registrationFields, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let user;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  user = await h.signUp("parent@example.com");
});
afterEach(() => h.close());
after(() => pool.end());

const save = (body) => h.api.put("/api/onboarding", body, { cookie: user.cookie });
const create = (data = {}, tourType = "domestic") => save({ tourType, data, currentSection: null, version: null });
const stored = async () => (await pool.query("SELECT data FROM onboarding_forms")).rows[0].data;

describe("age is calculated by the server from the date of birth", () => {
  it("a client can't send an age: it isn't an answer on the form any more", async () => {
    const res = await create({ age: "99" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  it("saving a date of birth stores the server's age; changing it recalculates; clearing it removes the age", async () => {
    const first = await create({ dateOfBirth: "2016-05-04" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await stored()).age, String(ageFromDob("2016-05-04", todayIso())));
    assert.equal(first.body.form.data.age, String(ageFromDob("2016-05-04", todayIso())));
    const second = await save({ tourType: "domestic", data: { dateOfBirth: "2010-01-01" }, currentSection: null, version: first.body.form.version });
    assert.equal((await stored()).age, String(ageFromDob("2010-01-01", todayIso())));
    await save({ tourType: "domestic", data: {}, currentSection: null, version: second.body.form.version });
    assert.equal("age" in (await stored()), false);
  });

  it("an invalid or future date of birth gives no age, and the form can't be submitted with it", async () => {
    const future = `${Number(todayIso().slice(0, 4)) + 1}-01-01`;
    const res = await create({ ...validAnswers("domestic", "student"), dateOfBirth: future });
    assert.equal("age" in (await stored()), false);
    const sub = await h.api.post("/api/onboarding/submit", { version: res.body.form.version, ...ACK }, { cookie: user.cookie });
    assert.equal(sub.status, 422);
    assert.ok(sub.body.error.fields.some((f) => f.path === "data.dateOfBirth"));
  });

  it("a draft saved before this change, with a typed age, still loads and saves; the server's age replaces the typed one", async () => {
    const res = await create({ dateOfBirth: "2016-05-04" });
    await pool.query("UPDATE onboarding_forms SET data = data || '{\"age\": \"42\"}'::jsonb");
    const loaded = await h.api.get("/api/onboarding", { cookie: user.cookie });
    assert.equal(loaded.status, 200);
    const again = await save({ tourType: "domestic", data: { dateOfBirth: "2016-05-04", fullName: "Asha Rao" }, currentSection: null, version: loaded.body.form.version });
    assert.equal(again.status, 200);
    assert.equal((await stored()).age, String(ageFromDob("2016-05-04", todayIso())));
    assert.ok(res);
  });
});

describe("names and phone numbers are checked on the server at submission, whatever the browser does", () => {
  async function submitWith(over, tourType = "domestic") {
    const res = await create({ ...validAnswers(tourType, "student"), ...over }, tourType);
    assert.equal(res.status, 200, JSON.stringify(res.body)); // drafts may be half-typed
    return h.api.post("/api/onboarding/submit", { version: res.body.form.version, ...ACK }, { cookie: user.cookie });
  }
  const errorFor = (res, key) => res.body.error.fields.find((f) => f.path === `data.${key}`)?.message;

  it("a crafted request with digits or markup in a name is refused with a field-specific message", async () => {
    const res = await submitWith({ fullName: "Asha2 <b>Rao</b>", nomineeName: "123" });
    assert.equal(res.status, 422);
    assert.equal(errorFor(res, "fullName"), "Full name can't contain numbers.");
    assert.equal(errorFor(res, "nomineeName"), "Nominee name can't contain numbers.");
    assert.equal((await pool.query("SELECT status FROM onboarding_forms")).rows[0].status, "draft");
  });

  it("international names are accepted", async () => {
    const res = await submitWith({ fullName: "José Ñúñez-O'Brien", nomineeName: "अनन्या शर्मा" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it("the international form's name fields follow the same rule", async () => {
    const res = await submitWith({ firstName: "J0hn", lastName: "---", panHolderName: "Mr. <script>" }, "international");
    assert.equal(res.status, 422);
    assert.equal(errorFor(res, "firstName"), "First name can't contain numbers.");
    assert.equal(errorFor(res, "lastName"), "Last name must contain letters.");
    assert.match(errorFor(res, "panHolderName"), /can only contain letters/);
  });

  it("the form's phone must be exactly 10 digits: 9, 11, a country code, letters or separators are refused at submission", async () => {
    for (const [phone, message] of [["987654321", /you entered 9/], ["98765432101", /11 digits/], ["+919876543210", /without the country code/], ["919876543210", /12 digits/], ["98765 43210", /digits only/], ["98765abcde", /digits only/]]) {
      await resetTables(pool);
      user = await h.signUp("parent@example.com");
      const res = await submitWith({ phone });
      assert.equal(res.status, 422, phone);
      assert.match(errorFor(res, "phone"), message, phone);
      assert.equal((await pool.query("SELECT status FROM onboarding_forms")).rows[0].status, "draft", "not submitted");
      assert.equal((await stored()).phone, phone, "the draft keeps exactly what was typed (never shortened)");
    }
    await resetTables(pool);
    user = await h.signUp("parent@example.com");
    const ok = await submitWith({ phone: "9876543210" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await stored()).phone, "9876543210");
  });

  it("a draft saved earlier with an old-style number (+91 ...) still loads and saves, and asks for the 10 digits at submission", async () => {
    const res = await submitWith({ phone: "+91 98765 43210" });
    assert.equal(res.status, 422);
    assert.match(errorFor(res, "phone"), /without the country code/);
    const state = await h.api.get("/api/onboarding", { cookie: user.cookie });
    assert.equal(state.status, 200);
    assert.equal(state.body.form.data.phone, "+91 98765 43210");
  });
});

describe("account registration uses the same name and phone rules", () => {
  const register = async (over) => {
    const verificationToken = await h.verifiedToken("new@example.com", "registration");
    return h.api.post("/api/registrations", { ...registrationFields("new@example.com"), verificationToken, ...over });
  };

  it("refuses 9 or 11 digits, a country code, letters, separators and malformed values, and creates nothing", async () => {
    const bad = [{ phone: "987654321" }, { phone: "98765432101" }, { phone: "+919876543210" }, { phone: "+91 98765 43210" }, { phone: "919876543210" },
      { phone: "98765-43210" }, { phone: "98765abcde" }, { phone: "" }, { phone: 9876543210 }, { phone: ["9876543210"] }, { phone: null }, { phone: "9".repeat(30) },
      { firstName: "Asha1" }, { lastName: "<b>Rao</b>" }];
    // A refused request never uses up the verification, so one is enough for every case.
    const verificationToken = await h.verifiedToken("new@example.com", "registration");
    for (const over of bad) {
      const res = await h.api.post("/api/registrations", { ...registrationFields("new@example.com"), verificationToken, ...over });
      assert.equal(res.status, 400, JSON.stringify(over).slice(0, 80));
      if ("phone" in over) assert.ok(res.body.error.fields.some((f) => f.path === "phone"), JSON.stringify(over).slice(0, 80));
    }
    // A huge value never reaches validation at all: the request body itself is refused as too large.
    const huge = await h.api.post("/api/registrations", { ...registrationFields("new@example.com"), verificationToken, phone: "9".repeat(5000) });
    assert.equal(huge.status, 413);
    assert.equal((await pool.query("SELECT count(*)::int n FROM parent_registrations WHERE email_normalized = 'new@example.com'")).rows[0].n, 0);
  });

  it("the phone error names the problem (so the form can show it under the field)", async () => {
    const res = await register({ phone: "98765432101" });
    assert.equal(res.body.error.fields.find((f) => f.path === "phone").message, "That's 11 digits. Enter your 10-digit mobile number without the country code.");
  });

  it("accepts an international name and exactly 10 digits, stored exactly as entered", async () => {
    const res = await register({ firstName: "Zoë", lastName: "D’Souza", phone: " 9876543210 " });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await pool.query("SELECT phone FROM parent_registrations WHERE email_normalized = 'new@example.com'")).rows[0].phone, "9876543210");
  });

  it("every 10-digit number the rule accepts can really register (the database's own check never refuses one)", async () => {
    for (const [i, phone] of PHONE_OK.entries()) {
      await resetTables(pool);
      const email = `phone${i}@example.com`;
      const verificationToken = await h.verifiedToken(email, "registration");
      const res = await h.api.post("/api/registrations", { ...registrationFields(email), phone, verificationToken });
      assert.equal(res.status, 201, `${phone}: ${JSON.stringify(res.body)}`);
      assert.equal((await pool.query("SELECT phone FROM parent_registrations WHERE email_normalized = $1", [email])).rows[0].phone, phone);
    }
    assert.equal(h.logged.length, 0, "no server error was logged");
  });

  it("existing accounts registered with an older phone format keep working (sign-in and their registration)", async () => {
    await pool.query("UPDATE parent_registrations SET phone = '+91 98765 43210' WHERE email_normalized = 'parent@example.com'");
    const login = await h.api.post("/api/auth/login/password", { email: "parent@example.com", password: TEST_PASSWORD });
    assert.equal(login.status, 200);
    const state = await h.api.get("/api/onboarding", { cookie: h.cookieOf(login) });
    assert.equal(state.status, 200);
  });
});
