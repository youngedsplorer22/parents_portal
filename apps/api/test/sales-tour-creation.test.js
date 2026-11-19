import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { createTestPool, resetTables } from "./helpers.js";

// The tour workflow end to end over HTTP, run by an admin (Sales cannot create schools or tours): template -> school and tour details -> tour -> registration link on the right
// portal -> parents reach the right school and tour. Everything the "Create a tour" screen does goes through these calls.
const pool = createTestPool();
const HOSTS = {
  domestic_payment: "https://domestic-paid.example.test",
  domestic_none: "https://domestic-free.example.test",
  international_payment: "https://international-paid.example.test",
  international_none: "https://international-free.example.test",
};
const TEMPLATES = [
  ["domestic", "payment", "domestic_payment"],
  ["domestic", "none", "domestic_none"],
  ["international", "payment", "international_payment"],
  ["international", "none", "international_none"],
];
let h;
let admin;
let salesA;
let salesB;
beforeEach(async () => {
  await resetTables(pool);
  h = await startApp({ db: pool, staff: { publicBaseUrls: HOSTS, publicBaseUrl: null } });
  admin = await h.staffUser({ email: "admin@example.com", role: "admin" }); // the first staff account must be an admin
  salesA = admin; // the creator used by every test below
  salesB = await h.staffUser({ email: "sales-b@example.com", role: "sales", name: "Sales B" });
});
afterEach(() => h.close());
after(() => pool.end());

const school = async (who, name = "Delhi Public School", branch) =>
  (await who.as.post("/api/admin/schools", { name, ...(branch ? { branch } : {}) })).body.school;
const tour = (who, schoolId, body) => who.as.post(`/api/admin/schools/${schoolId}/trips`, body);
const publish = async (who, t) => {
  assert.equal((await who.as.post(`/api/admin/trips/${t.id}/status`, { status: "active" })).status, 200);
  assert.equal((await who.as.post(`/api/admin/trips/${t.id}/public-registration`, { enabled: true })).status, 200);
};
const wordsOf = (path) => path.split("/").slice(2); // /join/<school>/<branch>/<trip>

describe("template -> tour -> link on the right portal", () => {
  for (const [tourType, paymentMode, key] of TEMPLATES) {
    it(`${key}: the tour gets that template, its own id, and the link of that template's portal; parents reach it`, async () => {
      const s = await school(salesA);
      const res = await tour(salesA, s.id, { title: "Kerala 2027", tourType, paymentMode, destination: "Kochi", academicYear: "2027-28" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const t = res.body.trip;
      assert.equal(t.templateKey, key);
      assert.equal(t.status, "draft", "always created as a draft");
      assert.equal(t.publicRegistration, false);
      assert.match(t.id, /^[0-9a-f-]{36}$/);
      assert.equal(t.publicPath, "/join/delhi-public-school/main/kerala-2027");
      assert.equal(t.publicUrl, `${HOSTS[key]}/join/delhi-public-school/main/kerala-2027`);
      for (const [other, host] of Object.entries(HOSTS)) if (other !== key) assert.ok(!t.publicUrl.startsWith(host), `not the ${other} portal`);

      await publish(salesA, t);
      const [sw, bw, tw] = wordsOf(t.publicPath);
      const page = await h.api.get(`/api/join/${sw}/${bw}/${tw}`);
      assert.equal(page.status, 200);
      assert.equal(page.body.school.name, "Delhi Public School");
      assert.equal(page.body.trip.title, "Kerala 2027");
      assert.equal(page.body.trip.tourType, tourType);
      assert.equal(page.body.registrationOpen, true);
    });
  }
});

describe("one school, several tours", () => {
  it("Kerala 2027 and Kerala 2028 (same template) are two records with two ids, two links, and nothing is overwritten", async () => {
    const s = await school(salesA);
    const a = (await tour(salesA, s.id, { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    const b = (await tour(salesA, s.id, { title: "Kerala 2028", tourType: "domestic", paymentMode: "none", academicYear: "2028-29" })).body.trip;
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.publicPath, b.publicPath);
    assert.equal(a.publicUrl, `${HOSTS.domestic_none}/join/delhi-public-school/main/kerala-2027`);
    assert.equal(b.publicUrl, `${HOSTS.domestic_none}/join/delhi-public-school/main/kerala-2028`);
    const listed = (await salesA.as.get(`/api/admin/trips?schoolId=${s.id}`)).body.trips;
    assert.deepEqual(listed.map((t) => [t.title, t.academicYear]).sort(), [["Kerala 2027", "2027-28"], ["Kerala 2028", "2028-29"]]);
    assert.equal((await salesA.as.get(`/api/admin/trips/${a.id}`)).body.trip.academicYear, "2027-28", "the first tour is unchanged");
  });

  it("the same school can have tours of different templates, each on its own portal", async () => {
    const s = await school(salesA);
    const free = (await tour(salesA, s.id, { title: "Goa 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    const paid = (await tour(salesA, s.id, { title: "Japan 2027", tourType: "international", paymentMode: "payment", academicYear: "2027-28" })).body.trip;
    assert.ok(free.publicUrl.startsWith(HOSTS.domestic_none));
    assert.ok(paid.publicUrl.startsWith(HOSTS.international_payment));
  });

  it("the same tour name and year twice still gives two separate tours with distinct links (never one overwriting the other)", async () => {
    const s = await school(salesA);
    const body = { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" };
    const a = (await tour(salesA, s.id, body)).body.trip;
    const b = (await tour(salesA, s.id, body)).body.trip;
    assert.notEqual(a.id, b.id);
    assert.equal(a.publicPath, "/join/delhi-public-school/main/kerala-2027");
    assert.equal(b.publicPath, "/join/delhi-public-school/main/kerala-2027-2");
  });

  it("different schools using the same template stay independent; the same tour name is a different address", async () => {
    const dps = await school(salesA, "Delhi Public School");
    const gps = await school(salesA, "Green Public School");
    const body = { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" };
    const a = (await tour(salesA, dps.id, body)).body.trip;
    const b = (await tour(salesA, gps.id, body)).body.trip;
    assert.equal(a.publicPath, "/join/delhi-public-school/main/kerala-2027");
    assert.equal(b.publicPath, "/join/green-public-school/main/kerala-2027");
    assert.equal(a.schoolId, dps.id);
    assert.equal(b.schoolId, gps.id);
    await publish(salesA, a);
    await publish(salesA, b);
    assert.equal((await h.api.get("/api/join/delhi-public-school/main/kerala-2027")).body.school.name, "Delhi Public School");
    assert.equal((await h.api.get("/api/join/green-public-school/main/kerala-2027")).body.school.name, "Green Public School");
  });

  it("closing one tour does not close another tour of the same school", async () => {
    const s = await school(salesA);
    const a = (await tour(salesA, s.id, { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    const b = (await tour(salesA, s.id, { title: "Kerala 2028", tourType: "domestic", paymentMode: "none", academicYear: "2028-29" })).body.trip;
    await publish(salesA, a);
    await publish(salesA, b);
    assert.equal((await salesA.as.post(`/api/admin/trips/${a.id}/status`, { status: "closed" })).status, 200);
    assert.equal((await salesA.as.get(`/api/admin/trips/${a.id}`)).body.trip.status, "closed");
    assert.equal((await salesA.as.get(`/api/admin/trips/${b.id}`)).body.trip.status, "active");
    assert.equal((await h.api.get("/api/join/delhi-public-school/main/kerala-2027")).body.registrationOpen, false);
    assert.equal((await h.api.get("/api/join/delhi-public-school/main/kerala-2028")).body.registrationOpen, true);
  });
});

describe("who may create tours", () => {
  it("no session: 401 for creating a school and for creating a tour; nothing is created", async () => {
    const s = await school(salesA);
    assert.equal((await h.api.post("/api/admin/schools", { name: "X" })).status, 401);
    assert.equal((await h.api.post(`/api/admin/schools/${s.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none" })).status, 401);
    assert.equal((await salesA.as.get(`/api/admin/trips?schoolId=${s.id}`)).body.trips.length, 0);
  });

  it("a parent session is not a staff session: 401", async () => {
    const s = await school(salesA);
    const parent = await h.signUp("parent@example.com");
    const res = await h.api.post(`/api/admin/schools/${s.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none" }, { cookie: parent.cookie });
    assert.equal(res.status, 401);
    assert.equal((await h.api.post("/api/admin/schools", { name: "Y" }, { cookie: parent.cookie })).status, 401);
  });

  it("a forged or garbage staff cookie is refused", async () => {
    const s = await school(salesA);
    for (const cookie of ["pp_staff_access=" + "A".repeat(43), "pp_staff_access=garbage", "pp_access=" + "A".repeat(43)]) {
      assert.equal((await h.api.post(`/api/admin/schools/${s.id}/trips`, { title: "T", tourType: "domestic", paymentMode: "none" }, { cookie })).status, 401, cookie);
    }
  });

  it("a salesperson cannot create a school or a tour at all (404, nothing created)", async () => {
    const theirs = await school(admin, "Theirs");
    assert.equal((await salesB.as.post("/api/admin/schools", { name: "Sneaky School" })).status, 404);
    const res = await tour(salesB, theirs.id, { title: "Sneaky", tourType: "domestic", paymentMode: "none" });
    assert.equal(res.status, 404);
    assert.equal((await salesB.as.get("/api/admin/trips")).status, 404);
    assert.equal((await admin.as.get(`/api/admin/trips?schoolId=${theirs.id}`)).body.trips.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM schools")).rows[0].n, 1);
  });

  it("an admin may create a tour for any school", async () => {
    const s = await school(salesA);
    const res = await tour(admin, s.id, { title: "Admin tour", tourType: "international", paymentMode: "none" });
    assert.equal(res.status, 201);
    assert.ok(res.body.trip.publicUrl.startsWith(HOSTS.international_none));
  });
});

describe("tampering and validation", () => {
  let s;
  beforeEach(async () => {
    s = await school(salesA);
  });
  const ok = { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" };

  it("a template key (or any server-decided field) in the body is refused, whatever its value", async () => {
    const extras = [
      { templateKey: "international_payment" }, { template_key: "international_payment" }, { template: "international_payment" },
      { status: "active" }, { publicRegistration: true }, { slug: "chosen-slug" }, { id: "00000000-0000-4000-8000-000000000000" },
      { schoolId: "00000000-0000-4000-8000-000000000000" }, { createdBy: "00000000-0000-4000-8000-000000000000" }, { publicUrl: "https://evil.example/x" },
    ];
    for (const extra of extras) {
      const res = await tour(salesA, s.id, { ...ok, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal((await salesA.as.get(`/api/admin/trips?schoolId=${s.id}`)).body.trips.length, 0, "nothing was created by any refused request");
  });

  it("only the four existing tour type and payment combinations are accepted", async () => {
    for (const bad of [{ tourType: "overseas" }, { tourType: "" }, { tourType: null }, { tourType: ["domestic"] }, { paymentMode: "free" }, { paymentMode: "paid" }, { paymentMode: "" }, { paymentMode: 1 }, { paymentMode: "NONE" }]) {
      assert.equal((await tour(salesA, s.id, { ...ok, ...bad })).status, 400, JSON.stringify(bad));
    }
    const missing = { ...ok };
    delete missing.tourType;
    assert.equal((await tour(salesA, s.id, missing)).status, 400);
  });

  it("title, year, destination and dates are validated", async () => {
    for (const bad of [
      { title: "" }, { title: "   " }, { title: "x".repeat(151) }, { title: "Bad\u0000name" }, { title: "Bad\nname" },
      { academicYear: "2027" }, { academicYear: "2027-30" }, { academicYear: "27-28" }, { academicYear: "2027-28; DROP" },
      { destination: "y".repeat(101) }, { destination: "Bad\u0007" },
      { opensAt: "tomorrow" }, { opensAt: "2027-02-01T10:00:00Z", closesAt: "2027-01-01T10:00:00Z" },
    ]) {
      assert.equal((await tour(salesA, s.id, { ...ok, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await tour(salesA, s.id, { ...ok, title: "'; DROP TABLE trips; --" })).status, 201, "odd text is data, never SQL");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trips")).rows[0].n, 1);
  });

  it("an unknown or malformed school id gives 404 or 400, never a tour", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1", "%00"]) {
      const res = await tour(salesA, id, ok);
      assert.ok([400, 404].includes(res.status), `${id}: ${res.status}`);
    }
  });

  it("the template can't be changed after the tour is active, so a link can never move to another portal", async () => {
    const t = (await tour(salesA, s.id, ok)).body.trip;
    await publish(salesA, t);
    const res = await salesA.as.patch(`/api/admin/trips/${t.id}`, { tourType: "international" });
    assert.equal(res.status, 409);
    assert.equal((await salesA.as.get(`/api/admin/trips/${t.id}`)).body.trip.publicUrl, t.publicUrl);
  });

  it("an archived school takes no new tours", async () => {
    assert.equal((await admin.as.patch(`/api/admin/schools/${s.id}`, { status: "archived" })).status, 200);
    assert.equal((await tour(salesA, s.id, ok)).status, 409);
  });
});

describe("duplicate submissions", () => {
  it("five identical requests at once make five separate tours with distinct ids and links, never an error or a crash (the screen prevents the duplicates; the server never merges tours)", async () => {
    const s = await school(salesA);
    const body = { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" };
    const results = await Promise.all(Array.from({ length: 5 }, () => tour(salesA, s.id, body)));
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
    const trips = results.map((r) => r.body.trip);
    assert.equal(new Set(trips.map((t) => t.id)).size, 5);
    assert.equal(new Set(trips.map((t) => t.publicPath)).size, 5, "every address names exactly one tour");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM trips WHERE school_id = $1", [s.id])).rows[0].n, 5);
  });

  it("two simultaneous creations of the same new school: one wins, the other is told it exists (no duplicate school)", async () => {
    const res = await Promise.all([
      salesA.as.post("/api/admin/schools", { name: "Sunrise Academy", branch: "Kolkata Branch" }),
      salesA.as.post("/api/admin/schools", { name: "Sunrise Academy", branch: "Kolkata Branch" }),
    ]);
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schools")).rows[0].n, 1);
    assert.equal(res.find((r) => r.status === 409).body.error.code, "SCHOOL_EXISTS");
  });
});

describe("registrations stay with their own school and tour", () => {
  it("parents who register from two tours of one school are tied to their own tour", async () => {
    const s = await school(salesA);
    const a = (await tour(salesA, s.id, { title: "Kerala 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    const b = (await tour(salesA, s.id, { title: "Kerala 2028", tourType: "domestic", paymentMode: "none", academicYear: "2028-29" })).body.trip;
    await publish(salesA, a);
    await publish(salesA, b);
    const reg = async (email, words) => {
      const verificationToken = await h.verifiedToken(email, "registration");
      const [sw, bw, tw] = words;
      const res = await h.api.post("/api/registrations", {
        firstName: "Asha", lastName: "Rao", role: "Student", phone: "9876543210", email, password: "Correct-horse-9", verificationToken,
        publicTrip: { school: sw, branch: bw, trip: tw },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.registrationId;
    };
    const r1 = await reg("one@example.com", wordsOf(a.publicPath));
    const r2 = await reg("two@example.com", wordsOf(b.publicPath));
    const rows = (await pool.query("SELECT r.id, e.trip_id FROM parent_registrations r JOIN trip_enrolments e ON e.registration_id = r.id")).rows;
    assert.equal(rows.find((x) => x.id === r1).trip_id, a.id);
    assert.equal(rows.find((x) => x.id === r2).trip_id, b.id);
  });
});
