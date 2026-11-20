import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let alice; // sales
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  alice = await h.staffUser({ email: "alice@example.com", role: "sales" });
});
afterEach(() => h.close());
after(() => pool.end());

const school = async (as, name) => (await as.post("/api/admin/schools", { name })).body.school;

describe("cross-role access attempts", () => {
  it("sales gets 404 on every old admin address, whatever the path id", async () => {
    const s = await school(admin.as, "Admin School");
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [m, path, body] of [
      ["get", "/api/admin/staff"], ["post", "/api/admin/staff", { name: "X", email: "x@example.com" }], ["patch", `/api/admin/staff/${id}`, { active: false }],
      ["get", "/api/admin/audit"], ["patch", `/api/admin/schools/${s.id}`, { name: "Renamed" }], ["del", `/api/admin/schools/${s.id}/logo`],
    ]) {
      const res = m === "get" || m === "del" ? await alice.as[m](path) : await alice.as[m](path, body);
      assert.equal(res.status, 404, `${m} ${path}`);
    }
    assert.equal((await pool.query("SELECT name FROM schools WHERE id = $1", [s.id])).rows[0].name, "Admin School");
  });

  it("a parent session has no staff access at all (401), and a staff session has no parent access (401)", async () => {
    const parent = await h.signUp("parent@example.com");
    assert.equal((await h.api.get("/api/admin/schools", { cookie: parent.cookie })).status, 401);
    assert.equal((await h.api.post("/api/admin/schools", { name: "X" }, { cookie: parent.cookie })).status, 401);
    assert.equal((await h.api.get("/api/onboarding", { cookie: alice.cookie })).status, 401);
    assert.equal((await h.api.get("/api/enrolments/resume", { cookie: admin.cookie })).status, 401);
  });

  it("the audit log still records changes (its admin API is kept, only the panel page is gone)", async () => {
    await school(admin.as, "Admin School");
    const res = await admin.as.get("/api/admin/audit");
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.some((e) => e.action === "school.create" && e.staffEmail === "admin@example.com"));
  });
});
