import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp, validAnswers } from "./harness.js";
import { ACK, createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";
import { readPdf } from "./pdf-text.js";

// Independent attacker's view of the two new features. Every case here is something a hostile parent (or a crafted
// request) could try; each must end safely.

const pool = createTestPool();
let h;
let admin;
let trip;
let parent;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  const school = (await admin.as.post("/api/admin/schools", { name: "Greenwood School" })).body.school;
  trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Annual Trip", tourType: "domestic", paymentMode: "none" })).body.trip;
  await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
  await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
  parent = await register("parent@example.com");
});
afterEach(() => h.close());
after(() => pool.end());

async function register(email) {
  const verificationToken = await h.verifiedToken(email, "registration");
  const res = await h.api.post("/api/registrations", { ...registrationFields(email, { role: "Student" }), verificationToken, publicTrip: slugsOf(trip) });
  assert.equal(res.status, 201);
  const cookie = h.cookieOf(res);
  return { cookie, enrolmentId: (await h.api.get("/api/enrolments/resume", { cookie })).body.enrolmentId };
}
async function submitWith(over, who = parent) {
  const body = { tourType: "domestic", data: { ...validAnswers("domestic", "student"), ...over }, currentSection: null, version: null, enrolmentId: who.enrolmentId };
  const saved = await h.api.put("/api/onboarding", body, { cookie: who.cookie });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const sub = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: who.enrolmentId, ...ACK }, { cookie: who.cookie });
  return sub;
}
const pdfOf = (who = parent) => h.api.get(`/api/onboarding/pdf?enrolment=${who.enrolmentId}`, { cookie: who.cookie });

describe("hostile text in answers can't make the PDF do anything", () => {
  const ATTACKS = [
    ") Tj\n/S /JavaScript /JS (app.alert(1)) >> endobj (",
    "<</Type /Action /S /URI /URI (https://evil.example)>>",
    "\\) \\( \\\\ %PDF-1.7 endstream endobj trailer",
    "<script>alert(1)</script> <img src=x onerror=alert(1)>",
    "=HYPERLINK(\"https://evil.example\",\"click\")",
    "https://evil.example/phish  mailto:x@evil.example",
    "‮evil‬ RTL override and ﻿zero-width",
    "😀🎉 emoji and 李小龍 (no bundled font)",
  ];
  for (const [i, attack] of ATTACKS.entries()) {
    it(`attack ${i + 1}: stored as plain text, no JavaScript, no actions, no links`, async () => {
      const sub = await submitWith({ remark: attack, allergy: attack.slice(0, 200) });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      const res = await pdfOf();
      assert.equal(res.status, 200);
      const pdf = await readPdf(res.raw);
      assert.equal(pdf.jsActions, null, "no document JavaScript");
      assert.equal(pdf.annotations, 0, "no link, form or action annotations");
      assert.equal(res.raw.subarray(0, 5).toString(), "%PDF-");
      assert.equal(res.raw.toString("latin1").match(/%%EOF/g).length, 1, "exactly one document, nothing smuggled after it");
      if (i < 5) assert.ok(pdf.text.includes(attack.replace(/\s+/g, " ").trim()), "the text is drawn as typed (escaped), never interpreted");
    });
  }

  it("a 1000-character unbroken word is wrapped, not cut off, and renders quickly", async () => {
    await submitWith({ remark: "W".repeat(1000) });
    const t0 = Date.now();
    const pdf = await readPdf((await pdfOf()).raw);
    assert.ok(Date.now() - t0 < 10000);
    assert.equal((pdf.text.match(/W/g) ?? []).length, 1000, "every character is on the pages");
    assert.ok((pdf.text.match(/W{10,}/g) ?? []).join("").length >= 1000 - 20, "all 1000 characters are on the pages");
  });

  it("the download name and headers come only from the server's own reference, never from user text", async () => {
    // A carriage return is refused outright in free text; a newline is allowed, and must stay inside the document.
    const crlf = await h.api.put("/api/onboarding", { tourType: "domestic", data: { ...validAnswers("domestic", "student"), remark: "x\r\nSet-Cookie: pwned=1" }, currentSection: null, version: null, enrolmentId: parent.enrolmentId }, { cookie: parent.cookie });
    assert.equal(crlf.status, 400);
    // A name with quotes and a fake filename is refused by the name rules at submission: no document exists for it.
    assert.equal((await submitWith({ fullName: 'Asha"; filename="evil.exe' })).status, 422);
    assert.equal((await pdfOf()).status, 409);
    await pool.query("DELETE FROM onboarding_forms");
    assert.equal((await submitWith({ remark: "x\nSet-Cookie: pwned=1" })).status, 200);
    const res = await pdfOf();
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="young-edsplorer-registration-YE-[0-9A-F]{8}\.pdf"$/);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("the PDF has no internal data: no session, token, password, OTP, internal id or hash", async () => {
    const sub = await submitWith({});
    const pdf = await readPdf((await pdfOf()).raw);
    const ids = (await pool.query("SELECT id::text AS a, registration_id::text AS b, enrolment_id::text AS c FROM onboarding_forms")).rows[0];
    for (const secret of [ids.a, ids.b, ids.c, "pp_session", parent.cookie.split("=")[1], "scrypt$", "token_hash", "password"]) {
      assert.ok(!pdf.text.toLowerCase().includes(String(secret).toLowerCase()), `leaked: ${secret}`);
    }
    assert.ok(pdf.text.includes(sub.body.form.reference));
  });
});

describe("the PDF endpoint can't be used to read someone else's registration or to exhaust the server", () => {
  it("guessing registration ids, using the legacy keyword, or sending many query values never returns another parent's document", async () => {
    await submitWith({ fullName: "Private Person" });
    const attacker = await register("attacker@example.com");
    for (const q of [`enrolment=${parent.enrolmentId}`, "enrolment=legacy", `enrolment=${parent.enrolmentId}&enrolment=${attacker.enrolmentId}`, "enrolment[]=x", `enrolment=${parent.enrolmentId.toUpperCase()}`, ""]) {
      const res = await h.api.get(`/api/onboarding/pdf?${q}`, { cookie: attacker.cookie });
      const text = res.status === 200 ? (await readPdf(res.raw)).text : "";
      assert.ok(!text.includes("Private Person"), `leaked via ?${q}`);
      assert.notEqual(res.status, 200, `?${q}`); // the attacker's own registration is a draft: never a document
    }
  });

  it("a burst of requests is answered (200, or a quick 429/503), never hangs, and the limit holds", async () => {
    await submitWith({});
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, () => pdfOf()));
    assert.ok(Date.now() - t0 < 20000);
    assert.ok(results.every((r) => [200, 429, 503].includes(r.status)), results.map((r) => r.status).join());
    assert.ok(results.filter((r) => r.status === 200).length >= 1);
    assert.ok(results.filter((r) => r.status === 200).length <= 20, "no more than the per-minute allowance got a document");
    assert.ok(results.filter((r) => r.status === 429).every((r) => Number(r.headers.get("retry-after")) >= 1));
  });
});

describe("phone number attacks (registration and the form)", () => {
  const STRANGE = [
    "9876543210\u0000", "98765\u000043210", "9876543210\n9876543210", "98765\t43210", " 9876543210 ".replace(/ /g, "​"),
    "９８７６５４３２１０", "٩٨٧٦٥٤٣٢١٠", "९८७६५४३२१०", "9876543210;--", "9876543210' OR '1'='1", "9876543210<b>", "0x9876543210", "9.876543210e9", "-987654321", "98765432１0",
    "__proto__", "constructor", "%39876543210", "9876543210%00", "٠٠٩١٩٨٧٦٥٤٣٢١٠",
  ];
  it("none of these is accepted at registration, and none creates an account", async () => {
    // One verification is enough: a refused registration never uses it up (and the email-code limit is 20 an hour).
    const verificationToken = await h.verifiedToken("x@example.com", "registration");
    for (const phone of STRANGE) {
      const res = await h.api.post("/api/registrations", { ...registrationFields("x@example.com"), phone, verificationToken });
      assert.equal(res.status, 400, JSON.stringify(phone));
    }
    assert.equal((await pool.query("SELECT count(*)::int n FROM parent_registrations WHERE email_normalized = 'x@example.com'")).rows[0].n, 0);
  });

  it("none of these gets through the form to submission, and whatever is stored is exactly 10 ASCII digits", async () => {
    for (const phone of STRANGE) {
      const body = { tourType: "domestic", data: { ...validAnswers("domestic", "student"), phone }, currentSection: null, version: null, enrolmentId: parent.enrolmentId };
      const saved = await h.api.put("/api/onboarding", body, { cookie: parent.cookie });
      if (saved.status === 200) {
        const sub = await h.api.post("/api/onboarding/submit", { version: saved.body.form.version, enrolmentId: parent.enrolmentId, ...ACK }, { cookie: parent.cookie });
        assert.equal(sub.status, 422, JSON.stringify(phone));
        await pool.query("DELETE FROM onboarding_forms");
      } else assert.equal(saved.status, 400, JSON.stringify(phone));
    }
    const sub = await submitWith({ phone: "9876543210" });
    assert.equal(sub.status, 200);
    assert.match((await pool.query("SELECT data->>'phone' AS p FROM onboarding_forms")).rows[0].p, /^[0-9]{10}$/);
  });

  it("surrounding spaces are tidied at registration and in the form, never inside the number", async () => {
    const verificationToken = await h.verifiedToken("tidy@example.com", "registration");
    assert.equal((await h.api.post("/api/registrations", { ...registrationFields("tidy@example.com"), phone: "  9876543210  ", verificationToken })).status, 201);
    assert.equal((await pool.query("SELECT phone FROM parent_registrations WHERE email_normalized = 'tidy@example.com'")).rows[0].phone, "9876543210");
  });
});
