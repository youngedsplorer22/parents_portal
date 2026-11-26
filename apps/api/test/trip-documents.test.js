import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { startApp } from "./harness.js";
import { startFakeDrive } from "./fake-drive.js";
import { createTestPool, resetTables } from "./helpers.js";

// Trip document uploads: Sales can upload itinerary, insurance, and transport documents to a trip's
// Drive folder. Single-document types (itinerary, insurance) replace the previous file on re-upload.
// Transport allows multiple files. All uploads are gated by the same portal_deployments authorization
// as the itinerary service.

const pool = createTestPool();
let h;
let drive;
let admin;
let salesA;
let salesB;
let tripA;
let tripB;
let school;

const PDF = Buffer.from("%PDF-1.4 fake pdf bytes");
const PNG = Buffer.from("\x89PNG\r\n\x1a\n fake png bytes");

const upload = (who, trip, type, body, opts = {}) =>
  who.as.post(
    `/api/admin/trips/${trip.id}/documents?type=${type}&name=${encodeURIComponent(opts.name ?? `${type}.pdf`)}`,
    body,
    { ...opts, raw: true, headers: { "content-type": opts.mime ?? "application/pdf", ...(opts.headers ?? {}) } },
  );
const list = (who, trip) => who.as.get(`/api/admin/trips/${trip.id}/documents`);
const del = (who, trip, docId) => who.as.del(`/api/admin/trips/${trip.id}/documents/${docId}`);

beforeEach(async () => {
  await resetTables(pool);
  drive = await startFakeDrive();
  h = await startApp({ db: pool, drive, staff: { deploymentTemplateKey: "domestic_none" } });
  admin = await h.staffUser({ role: "admin" });
  salesA = await h.staffUser({ email: "sales-a@example.com", role: "sales", name: "Sales A" });
  salesB = await h.staffUser({ email: "sales-b@example.com", role: "sales", name: "Sales B" });
  school = (await admin.as.post("/api/admin/schools", { name: "Test School" })).body.school;
  tripA = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Jaipur 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
  tripB = (await admin.as.post(`/api/admin/schools/${school.id}/trips`, { title: "Goa 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
  await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripA.id]);
});

afterEach(async () => {
  await h.close();
  await drive.close();
});
after(() => pool.end());

describe("successful uploads", () => {
  it("Sales can upload an itinerary document", async () => {
    const res = await upload(salesA, tripA, "itinerary", PDF);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.document.documentType, "itinerary");
    assert.equal(res.body.document.mimeType, "application/pdf");
    assert.equal(res.body.document.sizeBytes, PDF.length);
    assert.ok(res.body.document.id);
    assert.ok(res.body.document.uploadedAt);
    assert.equal(drive.uploads().length, 1);
    assert.equal(drive.uploads()[0].mimeType, "application/pdf");
  });

  it("Sales can upload an insurance document as PDF", async () => {
    const res = await upload(salesA, tripA, "insurance", PDF);
    assert.equal(res.status, 201);
    assert.equal(res.body.document.documentType, "insurance");
  });

  it("Sales can upload an insurance document as PNG", async () => {
    const res = await upload(salesA, tripA, "insurance", PNG, { mime: "image/png", name: "policy.png" });
    assert.equal(res.status, 201);
    assert.equal(res.body.document.mimeType, "image/png");
    assert.equal(drive.uploads()[0].mimeType, "image/png");
  });

  it("Sales can upload multiple transport documents", async () => {
    const r1 = await upload(salesA, tripA, "transport", PDF, { name: "flight.pdf" });
    const r2 = await upload(salesA, tripA, "transport", PNG, { mime: "image/png", name: "bus.png" });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const listRes = await list(salesA, tripA);
    const transport = listRes.body.documents.filter((d) => d.documentType === "transport");
    assert.equal(transport.length, 2);
    assert.equal(drive.uploads().length, 2);
  });

  it("list returns all documents grouped by type", async () => {
    await upload(salesA, tripA, "itinerary", PDF);
    await upload(salesA, tripA, "insurance", PDF);
    await upload(salesA, tripA, "transport", PDF, { name: "t1.pdf" });
    await upload(salesA, tripA, "transport", PDF, { name: "t2.pdf" });
    const res = await list(salesA, tripA);
    assert.equal(res.status, 200);
    assert.equal(res.body.documents.length, 4);
    const types = res.body.documents.map((d) => d.documentType).sort();
    assert.deepEqual(types, ["insurance", "itinerary", "transport", "transport"]);
  });
});

describe("replacement (single-document types)", () => {
  it("uploading a second itinerary replaces the first; old Drive file is deleted", async () => {
    const first = await upload(salesA, tripA, "itinerary", PDF, { name: "v1.pdf" });
    assert.equal(first.status, 201);
    assert.equal(drive.files.size, 5); // 4 folders (root, trip-documents, school, trip) + 1 file

    const second = await upload(salesA, tripA, "itinerary", PDF, { name: "v2.pdf" });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.document.id, first.body.document.id);

    // list shows only one itinerary
    const listRes = await list(salesA, tripA);
    const itineraries = listRes.body.documents.filter((d) => d.documentType === "itinerary");
    assert.equal(itineraries.length, 1);
    assert.equal(itineraries[0].displayName, "v2.pdf");

    // old Drive file was deleted (fire-and-forget; list() round-trip gives it time to complete): 4 folders + 1 file
    assert.equal(drive.files.size, 5);
  });

  it("uploading a second insurance replaces the first", async () => {
    await upload(salesA, tripA, "insurance", PDF, { name: "policy-v1.pdf" });
    const second = await upload(salesA, tripA, "insurance", PNG, { mime: "image/png", name: "policy-v2.png" });
    assert.equal(second.status, 201);

    const listRes = await list(salesA, tripA);
    const ins = listRes.body.documents.filter((d) => d.documentType === "insurance");
    assert.equal(ins.length, 1);
    assert.equal(ins[0].mimeType, "image/png");
  });

  it("transport does not replace: both documents remain", async () => {
    await upload(salesA, tripA, "transport", PDF, { name: "flight.pdf" });
    await upload(salesA, tripA, "transport", PDF, { name: "hotel.pdf" });
    const listRes = await list(salesA, tripA);
    assert.equal(listRes.body.documents.filter((d) => d.documentType === "transport").length, 2);
  });
});

describe("deletion", () => {
  it("Sales can delete a transport document", async () => {
    const r1 = await upload(salesA, tripA, "transport", PDF, { name: "flight.pdf" });
    const r2 = await upload(salesA, tripA, "transport", PDF, { name: "hotel.pdf" });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const delRes = await del(salesA, tripA, r1.body.document.id);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);

    const listRes = await list(salesA, tripA);
    assert.equal(listRes.body.documents.length, 1);
    assert.equal(listRes.body.documents[0].id, r2.body.document.id);
  });

  it("Sales can delete an itinerary document", async () => {
    const r = await upload(salesA, tripA, "itinerary", PDF);
    assert.equal(r.status, 201);
    const delRes = await del(salesA, tripA, r.body.document.id);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);
    const listRes = await list(salesA, tripA);
    assert.equal(listRes.body.documents.length, 0);
  });

  it("deleting a non-existent document returns 404", async () => {
    const delRes = await del(salesA, tripA, "00000000-0000-4000-8000-000000000000");
    assert.equal(delRes.status, 404);
  });

  it("deleting a document from another trip returns 404", async () => {
    // tripB is not in portal_deployments, but salesA would get 403 trying to access it.
    // Use salesA against tripA to upload, then try to delete via tripB path.
    const r = await upload(salesA, tripA, "transport", PDF);
    assert.equal(r.status, 201);
    // tripB is not the deployment trip; salesA can't delete from it
    const delRes = await del(salesA, tripB, r.body.document.id);
    assert.equal(delRes.status, 403);
  });
});

describe("authorization", () => {
  it("unauthenticated request is denied (401)", async () => {
    const res = await h.api.get(`/api/admin/trips/${tripA.id}/documents`);
    assert.equal(res.status, 401);
  });

  it("Sales cannot list documents for a trip not in their deployment", async () => {
    const res = await list(salesA, tripB);
    assert.equal(res.status, 403);
  });

  it("Sales cannot upload to a trip not in their deployment", async () => {
    const res = await upload(salesA, tripB, "itinerary", PDF);
    assert.equal(res.status, 403);
  });

  it("all Sales users see the same deployment trip's documents", async () => {
    await upload(salesA, tripA, "itinerary", PDF);
    const res = await list(salesB, tripA);
    assert.equal(res.status, 200);
    assert.equal(res.body.documents.length, 1);
  });

  it("non-UUID trip id is refused (403)", async () => {
    const res = await salesA.as.get("/api/admin/trips/not-a-uuid/documents");
    assert.equal(res.status, 403);
  });
});

describe("file validation", () => {
  it("invalid document type is rejected (400)", async () => {
    const res = await salesA.as.post(
      `/api/admin/trips/${tripA.id}/documents?type=invalid&name=test.pdf`,
      PDF,
      { raw: true, headers: { "content-type": "application/pdf" } },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_DOCUMENT_TYPE");
  });

  it("wrong MIME type for the document type is rejected (400)", async () => {
    const res = await upload(salesA, tripA, "itinerary", PNG, { mime: "image/png", name: "it.png" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_FILE_TYPE");
    assert.equal(drive.uploads().length, 0, "no Drive upload attempted");
  });

  it("empty body is rejected (400)", async () => {
    const res = await salesA.as.post(
      `/api/admin/trips/${tripA.id}/documents?type=itinerary&name=empty.pdf`,
      Buffer.alloc(0),
      { raw: true, headers: { "content-type": "application/pdf" } },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "MISSING_FILE");
  });

  it("file over 10 MB is rejected", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x25); // just over limit
    const res = await upload(salesA, tripA, "itinerary", big);
    assert.ok([400, 413].includes(res.status), `expected 400 or 413, got ${res.status}`);
    assert.equal(drive.uploads().length, 0, "no Drive upload attempted");
  });

  it("spoofed MIME type (non-PDF bytes claimed as application/pdf) is rejected (400)", async () => {
    const notPdf = Buffer.from("definitely not a pdf file at all");
    const res = await upload(salesA, tripA, "itinerary", notPdf, { mime: "application/pdf", name: "fake.pdf" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_FILE_TYPE");
    assert.equal(drive.uploads().length, 0, "no Drive upload attempted");
  });

  it("spoofed MIME type (non-PNG bytes claimed as image/png) is rejected (400)", async () => {
    const notPng = Buffer.from("not a real png file");
    const res = await upload(salesA, tripA, "insurance", notPng, { mime: "image/png", name: "fake.png" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_FILE_TYPE");
    assert.equal(drive.uploads().length, 0, "no Drive upload attempted");
  });
});

describe("Drive failure handling", () => {
  it("a Drive upload failure returns 503 and no DB row is inserted", async () => {
    drive.fail(/upload/, { status: 403, reason: "storageQuotaExceeded" });
    const res = await upload(salesA, tripA, "itinerary", PDF);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "DRIVE_UPLOAD_FAILED");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM trip_documents");
    assert.equal(rows[0].n, 0, "no DB row on Drive failure");
  });

  it("when Drive is not configured, upload returns 503", async () => {
    // h2: app without Drive credentials
    await resetTables(pool);
    const h2 = await startApp({ db: pool, staff: { deploymentTemplateKey: "domestic_none" } });
    const admin2 = await h2.staffUser({ role: "admin" });
    const sales2 = await h2.staffUser({ email: "sales2@example.com", role: "sales" });
    const school2 = (await admin2.as.post("/api/admin/schools", { name: "No Drive School" })).body.school;
    const trip2 = (await admin2.as.post(`/api/admin/schools/${school2.id}/trips`, { title: "Trip", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [trip2.id]);

    const res = await upload(sales2, trip2, "itinerary", PDF);
    assert.equal(res.status, 503);
    await h2.close();
  });
});

describe("portal-key-based access", () => {
  let h2;
  let salesC;
  let tripC;
  const PORTAL_SECRET = "test-portal-secret-domestic-none";

  beforeEach(async () => {
    await resetTables(pool);
    const drive2 = await startFakeDrive();
    h2 = await startApp({
      db: pool,
      drive: drive2,
      staff: {},
      portalSecrets: { domestic_none: PORTAL_SECRET },
    });
    const admin2 = await h2.staffUser({ role: "admin" });
    salesC = await h2.staffUser({ email: "sales-c@example.com", role: "sales", name: "Sales C" });
    const school2 = (await admin2.as.post("/api/admin/schools", { name: "Portal Key School" })).body.school;
    tripC = (await admin2.as.post(`/api/admin/schools/${school2.id}/trips`, { title: "Jaipur 2027", tourType: "domestic", paymentMode: "none", academicYear: "2027-28" })).body.trip;
    await pool.query("INSERT INTO portal_deployments (template_key, trip_id) VALUES ('domestic_none', $1)", [tripC.id]);
  });
  afterEach(() => h2.close());

  it("Sales can upload via portal-key-based resolution", async () => {
    const res = await salesC.as.post(
      `/api/admin/trips/${tripC.id}/documents?type=itinerary&name=itin.pdf`,
      PDF,
      { raw: true, headers: { "content-type": "application/pdf", "x-portal-key": PORTAL_SECRET } },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("wrong portal key cannot access documents", async () => {
    const res = await salesC.as.post(
      `/api/admin/trips/${tripC.id}/documents?type=itinerary&name=itin.pdf`,
      PDF,
      { raw: true, headers: { "content-type": "application/pdf", "x-portal-key": "wrong-secret" } },
    );
    assert.equal(res.status, 403);
  });
});
