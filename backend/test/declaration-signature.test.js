import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { CURRENT_DECLARATION } from "../src/modules/onboarding/declaration.js";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, resetTables } from "./helpers.js";

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
const submit = (body) => h.api.post("/api/onboarding/submit", body, { cookie: user.cookie });
const row = async () => (await pool.query("SELECT status, submitted_at, declaration_version, declaration_accepted_at, signature_name FROM onboarding_forms")).rows[0];
/** A complete, saved draft; resolves to its version. */
async function completeDraft() {
  const created = await save({ tourType: "domestic", data: {}, currentSection: null, version: null });
  const saved = await save({ tourType: "domestic", data: validAnswers("domestic", "student"), currentSection: "review", version: created.body.form.version });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body.form.version;
}

describe("declaration and typed signature on final submission", () => {
  it("the onboarding state carries the current declaration wording and version, matching the database's stored text", async () => {
    const state = await h.api.get("/api/onboarding", { cookie: user.cookie });
    assert.deepEqual(state.body.declaration, { version: CURRENT_DECLARATION.version, text: CURRENT_DECLARATION.text });
    const { rows } = await pool.query("SELECT body FROM declaration_texts WHERE version = $1", [CURRENT_DECLARATION.version]);
    assert.equal(rows[0].body, CURRENT_DECLARATION.text);
    assert.match(CURRENT_DECLARATION.text, /^I confirm that the information provided in this registration form is accurate and complete/);
  });

  it("stores the declaration version, the trimmed signature and the SERVER's time with the submission", async () => {
    const version = await completeDraft();
    const before = Date.now();
    const res = await submit({ version, ...ACK, signatureName: "  Asha   Rao  ", acceptedAt: undefined });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = await row();
    assert.equal(r.status, "submitted");
    assert.equal(r.declaration_version, "2026-10-v1");
    assert.equal(r.signature_name, "Asha   Rao");
    assert.equal(r.declaration_accepted_at.getTime(), r.submitted_at.getTime(), "accepted in the same moment as the submission");
    assert.ok(r.declaration_accepted_at.getTime() >= before - 5000);
    assert.deepEqual(res.body.form.acknowledgement, { declarationVersion: "2026-10-v1", acceptedAt: r.declaration_accepted_at.toISOString(), signatureName: "Asha   Rao" });
  });

  it("a date sent by the client is refused, never used", async () => {
    const version = await completeDraft();
    const res = await submit({ version, ...ACK, acceptedAt: "2000-01-01T00:00:00Z" });
    assert.equal(res.status, 400);
    assert.equal((await row()).status, "draft");
  });

  it("refuses submission without the declaration, with the wrong wording version, or without a real signature; the form stays a draft", async () => {
    const version = await completeDraft();
    const cases = {
      noDeclaration: { version, declarationVersion: ACK.declarationVersion, signatureName: "Asha Rao" },
      declarationFalse: { version, ...ACK, declarationAccepted: false },
      declarationString: { version, ...ACK, declarationAccepted: "true" },
      oldWording: { version, ...ACK, declarationVersion: "2020-01-v0" },
      noSignature: { version, declarationAccepted: true, declarationVersion: ACK.declarationVersion },
      emptySignature: { version, ...ACK, signatureName: "" },
      spacesOnly: { version, ...ACK, signatureName: "    " },
      oneLetter: { version, ...ACK, signatureName: "A" },
      tooLong: { version, ...ACK, signatureName: "A".repeat(151) },
      controlChars: { version, ...ACK, signatureName: "Asha\u0000Rao" },
      bidiOverride: { version, ...ACK, signatureName: "Asha‮Rao" },
      notAString: { version, ...ACK, signatureName: 42 },
    };
    for (const [name, body] of Object.entries(cases)) {
      const res = await submit(body);
      assert.equal(res.status, 400, name);
      assert.equal(res.body.error.code, "VALIDATION_ERROR", name);
    }
    const r = await row();
    assert.deepEqual([r.status, r.declaration_version, r.signature_name, r.declaration_accepted_at], ["draft", null, null, null]);
  });

  it("accepts names in any script", async () => {
    for (const [i, name] of ["Ångström Ñúñez", "अनन्या शर्मा", "സ്നേഹ‍ നായർ", "李小龍", "O'Brien-Smith"].entries()) {
      await resetTables(pool);
      user = await h.signUp(`p${i}@example.com`);
      const version = await completeDraft();
      const res = await submit({ version, ...ACK, signatureName: name });
      assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
      assert.equal((await row()).signature_name, name.normalize("NFC"));
    }
  });

  it("an incomplete form is not submitted even with a valid declaration and signature", async () => {
    const created = await save({ tourType: "domestic", data: {}, currentSection: null, version: null });
    const res = await submit({ version: created.body.form.version, ...ACK });
    assert.equal(res.status, 422);
    assert.deepEqual([(await row()).status, (await row()).signature_name], ["draft", null]);
  });

  it("a draft save can't carry a signature or declaration", async () => {
    const created = await save({ tourType: "domestic", data: {}, currentSection: null, version: null });
    for (const extra of [{ signatureName: "Asha" }, { declarationAccepted: true }]) {
      const res = await save({ tourType: "domestic", data: {}, currentSection: null, version: created.body.form.version, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    // and answers named like them are just unknown answers (refused), never stored as an acknowledgement
    const sneaky = await save({ tourType: "domestic", data: { signatureName: "Asha" }, currentSection: null, version: created.body.form.version });
    assert.notEqual(sneaky.status, 200);
    assert.equal((await row()).signature_name, null);
  });

  it("after submission the signature can't be changed: a second submit or a draft save is refused, and the database refuses too", async () => {
    const version = await completeDraft();
    const done = await submit({ version, ...ACK });
    const again = await submit({ version: done.body.form.version, ...ACK, signatureName: "Someone Else" });
    assert.equal(again.status, 409);
    const edit = await save({ tourType: "domestic", data: {}, currentSection: null, version: done.body.form.version });
    assert.equal(edit.status, 409);
    await assert.rejects(pool.query("UPDATE onboarding_forms SET signature_name = 'Someone Else'"), /submitted and can no longer be changed/);
    assert.equal((await row()).signature_name, "Asha Rao");
  });

  it("the database refuses an acknowledgement on a draft, a partial acknowledgement, and changes to a stored declaration text", async () => {
    await save({ tourType: "domestic", data: {}, currentSection: null, version: null });
    await assert.rejects(
      pool.query("UPDATE onboarding_forms SET declaration_version = '2026-10-v1', signature_name = 'Asha Rao', declaration_accepted_at = now()"),
      /onboarding_forms_acknowledgement_chk/,
    );
    await assert.rejects(pool.query("UPDATE onboarding_forms SET signature_name = 'Asha Rao'"), /onboarding_forms_acknowledgement_chk/);
    await assert.rejects(pool.query("UPDATE declaration_texts SET body = 'changed'"), /can not be changed/);
    await assert.rejects(pool.query("DELETE FROM declaration_texts"), /can not be changed/);
  });

  it("each registration keeps its own acknowledgement: another parent's form is untouched", async () => {
    const other = await h.signUp("other@example.com");
    await h.api.put("/api/onboarding", { tourType: "domestic", data: {}, currentSection: null, version: null }, { cookie: other.cookie });
    const version = await completeDraft();
    await submit({ version, ...ACK });
    const { rows } = await pool.query("SELECT r.email_normalized AS email, f.status, f.signature_name FROM onboarding_forms f JOIN parent_registrations r ON r.id = f.registration_id ORDER BY 1");
    assert.deepEqual(rows, [
      { email: "other@example.com", status: "draft", signature_name: null },
      { email: "parent@example.com", status: "submitted", signature_name: "Asha Rao" },
    ]);
  });
});
