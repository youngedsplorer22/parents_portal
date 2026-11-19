// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DeploymentConfigError, checkPortalConfig, onDeployPlatform, portalConfigGuard } from "../../deployment-guard.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "portal-guard-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A throw-away portal folder holding the given deployment.config.js text (and optional extra files). */
function portal(configText, files = {}) {
  const dir = path.join(tmp, `portal-${++n}`);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  if (configText !== null) writeFileSync(path.join(dir, "src", "deployment.config.js"), configText);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, "src", name), content);
  return dir;
}

const GOOD = `export default {
  school: "abc-school", branch: "jaipur", trip: "jaipur-2027",
  schoolName: "ABC School", tripTitle: "Jaipur 2027", destination: "Jaipur", logo: null,
};`;
const EMPTY = `export default { school: "", branch: "", trip: "", schoolName: "", tripTitle: "", destination: "", logo: null };`;

/** Like portal(), with empty placeholder files at the given paths under src/ (for image imports in subfolders). */
function portalWithFiles(configText, paths) {
  const dir = portal(configText);
  for (const rel of paths) {
    mkdirSync(path.dirname(path.join(dir, "src", rel)), { recursive: true });
    writeFileSync(path.join(dir, "src", rel), "img");
  }
  return dir;
}

/** What Vite would do: configResolved, then buildStart (this.warn collects warnings). */
function build(dir, { target = "domestic-free", env = {} } = {}) {
  const plugin = portalConfigGuard({ target, env });
  const warnings = [];
  plugin.configResolved({ root: dir });
  plugin.buildStart.call({ warn: (m) => warnings.push(m) });
  return warnings;
}

describe("a portal's build checks its own deployment.config.js", () => {
  it("passes a complete configuration", () => {
    const d = checkPortalConfig(portal(GOOD));
    expect(d).toMatchObject({ school: "abc-school", branch: "jaipur", trip: "jaipur-2027", schoolName: "ABC School" });
    expect(build(portal(GOOD))).toEqual([]);
  });

  it("fails the build for the shipped empty file, and names the file and the empty values", () => {
    expect(() => build(portal(EMPTY))).toThrow(DeploymentConfigError);
    expect(() => build(portal(EMPTY))).toThrow(/deployment\.config\.js is not ready: school is empty; branch is empty; trip is empty; schoolName is empty; tripTitle is empty/);
    expect(() => build(portal(EMPTY))).toThrow(/Build stopped on purpose/);
  });

  it("fails for a missing file, a file that does not parse and an export that is not an object", () => {
    expect(() => build(portal(null))).toThrow(/is missing/);
    expect(() => build(portal("export default {"))).toThrow(/could not be read/);
    expect(() => build(portal("export default 5;"))).toThrow(/is not ready/);
    expect(() => build(portal("export default null;"))).toThrow(/is not ready/);
  });

  it("fails for a bad address word (capitals, spaces, slashes, dots) or an over-long name", () => {
    for (const bad of ["ABC", "abc school", "abc/def", "../x", "a--b", "-a"]) {
      expect(() => build(portal(GOOD.replace('school: "abc-school"', `school: ${JSON.stringify(bad)}`))), bad).toThrow(/is not ready/);
    }
    expect(() => build(portal(GOOD.replace('"ABC School"', JSON.stringify("x".repeat(151)))))).toThrow(/is not ready/);
  });

  it("allows a logo import only when the image file exists, and a missing one fails", () => {
    const withLogo = GOOD.replace("logo: null", "logo: schoolLogo");
    const ok = portal(`import schoolLogo from "./school-logo.png";\n${withLogo}`, { "school-logo.png": "png" });
    expect(checkPortalConfig(ok).logo).toBe("/assets/school-logo.png");
    expect(() => build(portal(`import schoolLogo from "./school-logo.png";\n${withLogo}`))).toThrow(/logo file .* does not exist/);
  });

  it("accepts the logo map of every school the portal has served, each from an existing image file", () => {
    const cfg = `import aLogo from "./school-logos/a.png";\nimport bLogo from "./school-logos/b.webp";\n` + GOOD.replace("logo: null,", 'logo: null, schoolLogos: { "old-school/main": aLogo, "abc-school/jaipur": bLogo },');
    const d = checkPortalConfig(portalWithFiles(cfg, ["school-logos/a.png", "school-logos/b.webp"]));
    expect(Object.keys(d.schoolLogos)).toEqual(["old-school/main", "abc-school/jaipur"]);
    expect(d.logo).toBe("/assets/school-logo.png"); // this deployment's own entry is picked up
  });

  it("fails when the logo map is malformed: a bad key, a link to another site, or not an object", () => {
    for (const map of ['{ "Bad Key": "/assets/x.png" }', '{ "a/b": "https://evil.example/x.png" }', '["/assets/x.png"]', '"x"', '{ "no-branch": "/assets/x.png" }']) {
      expect(() => build(portal(GOOD.replace("logo: null,", `logo: null, schoolLogos: ${map},`))), map).toThrow(/schoolLogos must map/);
    }
  });

  it("refuses any other import, so the file stays plain data", () => {
    expect(() => build(portal(`import fs from "node:fs";\n${GOOD}`))).toThrow(/only import allowed is a logo image/);
    expect(() => build(portal(`import x from "./other.js";\n${GOOD}`))).toThrow(/only import allowed/);
  });

  it("refuses a logo value that is not a built-in image address", () => {
    expect(() => build(portal(GOOD.replace("logo: null", 'logo: "https://evil.example/x.png"')))).toThrow(/logo is not a built-in image address/);
  });

  it("cannot be used to run code: no process, no require, no filesystem", () => {
    expect(() => build(portal(GOOD.replace('school: "abc-school"', "school: process.exit(9)")))).toThrow(/could not be read/);
    expect(() => build(portal(GOOD.replace('school: "abc-school"', 'school: require("fs").readFileSync("/etc/hosts","utf8")')))).toThrow(/could not be read/);
    expect(() => build(portal(`export default (() => { while (true) {} })();`))).toThrow(/could not be read/);
  });

  it("the Sales portal needs no school or trip", () => {
    expect(build(portal(null), { target: "staff" })).toEqual([]);
  });
});

describe("the local opt-in for building an unconfigured portal", () => {
  it("lets a developer's own computer build an empty portal, with a loud warning", () => {
    const warnings = build(portal(EMPTY), { env: { ALLOW_UNCONFIGURED_PORTAL_BUILD: "true" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Do not deploy this build/);
  });

  it("is refused on Railway and in CI, whatever else is set", () => {
    for (const platform of [{ RAILWAY_ENVIRONMENT_ID: "x" }, { RAILWAY_PROJECT_ID: "x" }, { RAILWAY_SERVICE_ID: "x" }, { RAILWAY_ENVIRONMENT_NAME: "production" }, { RAILWAY_DEPLOYMENT_ID: "x" }, { CI: "true" }]) {
      expect(() => build(portal(EMPTY), { env: { ALLOW_UNCONFIGURED_PORTAL_BUILD: "true", ...platform } }), JSON.stringify(platform)).toThrow(/refused on Railway and in CI/);
      expect(onDeployPlatform(platform)).toBe(true);
    }
    expect(onDeployPlatform({})).toBe(false);
    expect(onDeployPlatform({ RAILWAY_HOME: "/Users/dev/.railway" }), "the Railway command-line tool on a developer's computer is not the platform").toBe(false);
  });

  it("only the exact value true opts in", () => {
    for (const v of ["1", "yes", "TRUE", "false", ""]) {
      expect(() => build(portal(EMPTY), { env: { ALLOW_UNCONFIGURED_PORTAL_BUILD: v } }), v).toThrow(/Build stopped on purpose/);
    }
  });
});

describe("shared code changes: Railway starts every portal's build, each decides for itself", () => {
  it("a configured portal builds, an unconfigured one fails, and the four are independent of each other", () => {
    const portals = { "domestic-paid": portal(GOOD), "domestic-free": portal(EMPTY), "international-paid": portal(GOOD.replace("jaipur-2027", "tokyo-2027")), "international-free": portal(EMPTY) };
    const outcome = Object.fromEntries(
      Object.entries(portals).map(([target, dir]) => {
        try {
          build(dir, { target });
          return [target, "built"];
        } catch (err) {
          return [target, err instanceof DeploymentConfigError ? "refused" : "crashed"];
        }
      }),
    );
    expect(outcome).toEqual({ "domestic-paid": "built", "domestic-free": "refused", "international-paid": "built", "international-free": "refused" });
  });
});
