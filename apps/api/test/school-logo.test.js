import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, registrationFields, resetTables, slugsOf } from "./helpers.js";

const pool = createTestPool();
let h;
let admin;
let school;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" });
  school = (await admin.as.post("/api/admin/schools", { name: "Greenfield Public School", branch: "Kolkata" })).body.school;
});
afterEach(() => h.close());
after(() => pool.end());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(40, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const upload = (as, bytes, type = "image/png", id = school.id) => as.put(`/api/admin/schools/${id}/logo`, bytes, { raw: true, headers: { "content-type": type } });
const fetchLogo = (path) => fetch(h.base + path);

describe("school logos", () => {
  it("a new school has no logo", () => {
    assert.equal(school.logoUrl, null);
  });

  it("an admin uploads a PNG, JPEG or WebP; the school then has a versioned logo address made of its address words", async () => {
    for (const [bytes, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [WEBP, "image/webp"]]) {
      const res = await upload(admin.as, bytes, type);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.body.school.logoUrl, /^\/api\/school-logos\/greenfield-public-school\/kolkata\?v=\d+$/);
      const img = await fetchLogo(res.body.school.logoUrl);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), type);
      assert.equal(img.headers.get("x-content-type-options"), "nosniff");
      assert.match(img.headers.get("content-security-policy"), /default-src 'none'/);
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), bytes);
    }
    const listed = (await admin.as.get("/api/admin/schools")).body.schools[0];
    assert.match(listed.logoUrl, /^\/api\/school-logos\//);
    assert.equal("logo" in listed, false, "no image bytes in lists");
  });

  it("the type comes from the bytes, not the header: SVG, HTML or junk is refused whatever it claims to be", async () => {
    for (const [bytes, type] of [[SVG, "image/png"], [Buffer.from("<html><script>x</script></html>".padEnd(40)), "image/jpeg"], [Buffer.alloc(40, 7), "image/webp"]]) {
      const res = await upload(admin.as, bytes, type);
      assert.equal(res.status, 400, type);
      assert.equal(res.body.error.code, "LOGO_INVALID");
    }
    assert.equal((await upload(admin.as, PNG, "image/svg+xml")).status, 400, "an SVG content type is never read as an image");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM school_logos")).rows[0].n, 0);
  });

  it("a logo larger than 512 KB is refused", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(512 * 1024)]);
    const res = await upload(admin.as, big);
    assert.equal(res.status, 413);
  });

  it("only an admin may change it; sales and parents can't", async () => {
    const sales = await h.staffUser({ email: "sales@example.com", role: "sales" });
    assert.equal((await upload(sales.as, PNG)).status, 404);
    assert.equal((await sales.as.del(`/api/admin/schools/${school.id}/logo`)).status, 404);
    assert.equal((await h.api.put(`/api/admin/schools/${school.id}/logo`, PNG, { raw: true, headers: { "content-type": "image/png" } })).status, 401);
    assert.equal((await upload(admin.as, PNG, "image/png", "00000000-0000-4000-8000-000000000000")).status, 404);
  });

  it("replacing changes the version; removing it makes the address 404 and the school shows no logo; both are audited", async () => {
    const first = (await upload(admin.as, PNG)).body.school.logoUrl;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await upload(admin.as, JPEG, "image/jpeg")).body.school.logoUrl;
    assert.notEqual(first, second);
    const removed = await admin.as.del(`/api/admin/schools/${school.id}/logo`);
    assert.equal(removed.body.school.logoUrl, null);
    assert.equal((await fetchLogo(second)).status, 404);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'school.logo%' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action), ["school.logo_set", "school.logo_set", "school.logo_remove"]);
  });

  it("unknown or malformed logo addresses are 404", async () => {
    for (const path of ["/api/school-logos/nope/main", "/api/school-logos/Bad%20Words/main", "/api/school-logos/greenfield-public-school/kolkata"]) {
      assert.equal((await fetchLogo(path)).status, 404, path);
    }
  });

  it("parents see the logo address on the public page, in their form and in their registrations list; never an id", async () => {
    await upload(admin.as, PNG);
    const trip = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Winter Trip", tourType: "domestic", destination: "Manali", paymentMode: "none" })).body.trip;
    await admin.as.post(`/api/admin/trips/${trip.id}/status`, { status: "active" });
    await admin.as.post(`/api/admin/trips/${trip.id}/public-registration`, { enabled: true });
    const words = slugsOf(trip);
    const page = await h.api.get(`/api/join/${words.school}/${words.branch}/${words.trip}`);
    assert.match(page.body.school.logo, /^\/api\/school-logos\/greenfield-public-school\/kolkata\?v=\d+$/);

    const verificationToken = await h.verifiedToken("p@example.com", "registration");
    const reg = await h.api.post("/api/registrations", { ...registrationFields("p@example.com", { role: "Student" }), verificationToken, publicTrip: words });
    const cookie = h.cookieOf(reg);
    const state = await h.api.get("/api/onboarding", { cookie });
    assert.equal(state.body.trip.schoolLogo, page.body.school.logo);
    const list = await h.api.get("/api/enrolments", { cookie });
    assert.equal(list.body.enrolments[0].schoolLogo, page.body.school.logo);
    assert.ok(!JSON.stringify([page.body, state.body.trip]).includes(school.id));
  });
});
