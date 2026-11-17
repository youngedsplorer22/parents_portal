// Regression for the live report: a domestic Student whose review page shows every answer was told those same
// fields were "required". Saves arrive section by section exactly as the wizard sends them (full snapshot each time).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { ACK, createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
before(async () => { h = await startApp({ db: pool }); });
beforeEach(async () => { await resetTables(pool); });
after(async () => { await h.close(); await pool.end(); });

const STEPS = [
  ["personal", { fullName: "Asha Rao", gender: "Female", classSection: "4-B", dateOfBirth: "2015-03-02" }],
  ["nominee", { nomineeName: "abc", nomineeRelation: "mother" }],
  ["meals", { mealPreference: "Veg" }],
  ["contact", { phone: "8832300919" }],
  ["review", {}],
];

describe("domestic student, five steps", () => {
  it("every saved answer is recognised by submit validation and persisted", async () => {
    const user = await h.signUp("student@example.com", { role: "Student" });
    let data = {};
    let version = null;
    for (const [section, add] of STEPS) {
      data = { ...data, ...add };
      const res = await h.api.put("/api/onboarding", { tourType: "domestic", data, currentSection: section, version }, { cookie: user.cookie });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      version = res.body.form.version;
    }
    const sub = await h.api.post("/api/onboarding/submit", { version, ...ACK }, { cookie: user.cookie });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const row = (await pool.query("SELECT data FROM onboarding_forms")).rows[0];
    assert.equal(row.data.gender, "Female");
    assert.equal(row.data.classSection, "4-B");
    assert.equal(row.data.nomineeName, "abc");
    assert.equal(row.data.nomineeRelation, "mother");
    assert.equal(row.data.mealPreference, "Veg");
    assert.equal(row.data.phone, "8832300919");
  });

  for (const key of ["fullName", "gender", "classSection", "dateOfBirth", "nomineeName", "nomineeRelation", "mealPreference", "phone"]) {
    it(`only ${key} missing -> exactly that field is reported`, async () => {
      const user = await h.signUp(`s-${key}@example.com`, { role: "Student" });
      const data = Object.assign({}, ...STEPS.map((s) => s[1]));
      delete data[key];
      const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data, currentSection: "review", version: null }, { cookie: user.cookie });
      const sub = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, ...ACK }, { cookie: user.cookie });
      assert.equal(sub.status, 422);
      assert.deepEqual(sub.body.error.fields.map((f) => f.path), [`data.${key}`]);
    });
  }
});

describe("diagnostics", () => {
  it("a refused submit logs which field NAMES the server holds, never the answers", async () => {
    h.warned.length = 0;
    const user = await h.signUp("diag@example.com", { role: "Student" });
    const saved = await h.api.put("/api/onboarding", { tourType: "domestic", data: { fullName: "Secret Name", dateOfBirth: "2015-03-02" }, currentSection: "review", version: null }, { cookie: user.cookie });
    const sub = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, ...ACK }, { cookie: user.cookie });
    assert.equal(sub.status, 422);
    const line = h.warned.find((l) => l.includes("submit refused"));
    assert.match(line, /stored=\[age,dateOfBirth,fullName\]/);
    assert.match(line, /rejected=\[classSection,gender,mealPreference,nomineeName,nomineeRelation,phone\]/);
    assert.ok(!line.includes("Secret Name") && !line.includes("2015"));
  });
});
