import { describe, expect, it } from "vitest";
import { logoForSchool, readDeployment, sameTrip } from "./deployment.js";

const GOOD = { school: "abc-school", branch: "main", trip: "jaipur-2027", schoolName: "ABC School", tripTitle: "Jaipur 2027", destination: "Jaipur", logo: null };

describe("readDeployment: what a portal was customised for", () => {
  it("accepts a complete configuration and keeps only the known fields", () => {
    expect(readDeployment({ ...GOOD, extra: "ignored" })).toEqual({ ...GOOD, logo: null, schoolLogos: {} });
  });

  it("is null (the portal is not set up) when anything needed is missing or malformed", () => {
    for (const bad of [null, undefined, "x", [], {}, { ...GOOD, school: "" }, { ...GOOD, branch: "Main" }, { ...GOOD, trip: "a b" }, { ...GOOD, school: "../x" },
      { ...GOOD, schoolName: "" }, { ...GOOD, schoolName: "   " }, { ...GOOD, tripTitle: "" }, { ...GOOD, schoolName: 5 }, { ...GOOD, trip: "x".repeat(80) }]) {
      expect(readDeployment(bad)).toBeNull();
    }
  });

  it("destination is optional; a logo is only a same-origin built asset, never a link elsewhere", () => {
    expect(readDeployment({ ...GOOD, destination: undefined }).destination).toBe("");
    expect(readDeployment({ ...GOOD, logo: "/assets/school-logo-1a2b3c.png" }).logo).toBe("/assets/school-logo-1a2b3c.png");
    expect(readDeployment({ ...GOOD, logo: "data:image/png;base64,iVBORw0KGgo=" }).logo).toMatch(/^data:image\/png;base64,/);
    for (const logo of ["https://evil.example/x.png", "//evil.example/x.png", "javascript:alert(1)", "/assets/../x.png", "/api/school-logos/other/main?v=1", "data:image/svg+xml;base64,AAAA", "data:text/html;base64,AAAA", 5, {}]) {
      expect(readDeployment({ ...GOOD, logo }).logo, String(logo)).toBeNull();
    }
  });
});

describe("sameTrip", () => {
  const d = readDeployment(GOOD);
  it("is true only for the three exact words the portal was built for", () => {
    expect(sameTrip(d, { school: "abc-school", branch: "main", trip: "jaipur-2027" })).toBe(true);
    for (const other of [{ school: "xyz-school", branch: "main", trip: "jaipur-2027" }, { school: "abc-school", branch: "north", trip: "jaipur-2027" }, { school: "abc-school", branch: "main", trip: "jaipur-2028" }, {}, null]) {
      expect(sameTrip(d, other)).toBe(false);
    }
    expect(sameTrip(null, { school: "abc-school", branch: "main", trip: "jaipur-2027" })).toBe(false);
  });
});

describe("school logos kept in the repository, one per school", () => {
  const A = "/assets/abc-1a2b3c.png";
  const B = "/assets/xyz-4d5e6f.png";
  const MAP = { "abc-school/main": A, "xyz-school/jaipur": B };
  const deployed = (over = {}) => readDeployment({ ...GOOD, school: "xyz-school", branch: "jaipur", trip: "tokyo-2027", schoolLogos: MAP, ...over });

  it("keeps only well-formed entries: a school/branch key and a built-in image address", () => {
    const d = readDeployment({ ...GOOD, schoolLogos: { ...MAP, "no-branch": A, "Bad/Key": A, "a/b": "https://evil.example/x.png", "c/d": "/assets/../x.png", "e/f": 5 } });
    expect(d.schoolLogos).toEqual(MAP);
    expect(readDeployment({ ...GOOD, schoolLogos: [A] }).schoolLogos).toEqual({});
    expect(readDeployment({ ...GOOD, schoolLogos: "x" }).schoolLogos).toEqual({});
  });

  it("this deployment's own logo comes from the file's logo, else from its own entry in the map", () => {
    expect(deployed().logo).toBe(B);
    expect(deployed({ logo: "/assets/own-1.png" }).logo).toBe("/assets/own-1.png");
    expect(deployed({ school: "other-school" }).logo).toBeNull();
  });

  it("finds each school's logo by that school's own address: after the portal moves to school B, school A still gets A's logo", () => {
    const d = deployed();
    expect(logoForSchool(d, { school: "abc-school", branch: "main", trip: "goa-2026" })).toBe(A);
    expect(logoForSchool(d, { school: "xyz-school", branch: "jaipur", trip: "tokyo-2027" })).toBe(B);
  });

  it("never shows another school's logo: a school with no entry gets none, whatever the portal shows now", () => {
    const d = deployed();
    expect(logoForSchool(d, { school: "old-school", branch: "main", trip: "x" })).toBeNull();
    expect(logoForSchool(d, { school: "abc-school", branch: "other-branch", trip: "x" })).toBeNull(); // same school, another branch: its own identity
    expect(logoForSchool(d, { school: "xyz-school", branch: "main", trip: "x" })).toBeNull();
    for (const bad of [null, undefined, {}, { school: "abc-school" }, { branch: "main" }]) expect(logoForSchool(d, bad)).toBeNull();
    expect(logoForSchool(null, { school: "abc-school", branch: "main" })).toBeNull();
  });

  it("a portal without a map still shows its own logo for its own trip only", () => {
    const d = readDeployment({ ...GOOD, logo: "/assets/own-1.png" });
    expect(logoForSchool(d, { school: "abc-school", branch: "main", trip: "jaipur-2027" })).toBe("/assets/own-1.png");
    expect(logoForSchool(d, { school: "abc-school", branch: "main", trip: "another-trip" })).toBeNull();
    expect(logoForSchool(d, { school: "old-school", branch: "main", trip: "goa-2026" })).toBeNull();
  });
});
