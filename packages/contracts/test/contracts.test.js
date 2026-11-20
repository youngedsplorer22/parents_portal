import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PORTAL_TARGETS, TEMPLATE_KEYS, VARIANTS, portalMatchesTrip, toRegistrationRecord, variantForTrip } from "../src/index.js";

describe("variants", () => {
  it("are exactly the four values trips.template_key can hold", () => {
    assert.deepEqual([...TEMPLATE_KEYS].sort(), ["domestic_none", "domestic_payment", "international_none", "international_payment"]);
    for (const v of Object.values(VARIANTS)) assert.equal(v.templateKey, `${v.tourType}_${v.paymentMode}`);
  });
  it("has a staff target besides the four public portals", () => assert.equal(PORTAL_TARGETS.length, 5));
  it("maps a trip to its portal and rejects mismatches or junk", () => {
    assert.equal(variantForTrip({ tourType: "international", paymentMode: "none" }).id, "international-free");
    assert.ok(portalMatchesTrip("domestic-paid", { tourType: "domestic", paymentMode: "payment" }));
    assert.ok(!portalMatchesTrip("domestic-paid", { tourType: "domestic", paymentMode: "none" }));
    assert.ok(!portalMatchesTrip("nope", { tourType: "domestic", paymentMode: "none" }));
    assert.equal(variantForTrip({ tourType: "x", paymentMode: "none" }), null);
  });
});

describe("registration record", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const row = { id, enrolment_id: id, school_id: id, trip_id: id, variant: "domestic_none", tour_type: "domestic", payment_mode: "none",
    participant_role: "student", status: "draft", progress_percent: 40, data: { fullName: "Asha Rao" },
    created_at: new Date(0), updated_at: new Date(0), submitted_at: null };
  it("is plain JSON with the answers kept together", () => {
    const rec = toRegistrationRecord(row);
    assert.equal(rec.schemaVersion, 1);
    assert.deepEqual(rec.answers, { fullName: "Asha Rao" });
    assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
  });
  it("refuses a record whose variant is not one of the four", () => assert.throws(() => toRegistrationRecord({ ...row, variant: "other" })));
});
