// Build-time guard for the four public registration portals. Each portal is built from its own folder
// (apps/portal-<variant>) and carries ONE school and trip in its src/deployment.config.js. A portal built with an empty or
// invalid file would deploy fine, pass its health check and then tell every parent "this portal isn't set up yet", replacing
// the working version. So the build refuses instead: the build fails, the platform keeps the previous deployment, and the
// message says which file and which value to fix.
//
// The file is developer-written repository code, so the sandbox below only guards against mistakes; it is not a security boundary.
// The file is checked with the SAME rules the browser uses (readDeployment in src/portal/deployment.js). It is read as text and
// evaluated in an empty sandbox, because it may import a logo image, which Node cannot load.
//
// A local check can set ALLOW_UNCONFIGURED_PORTAL_BUILD=true so the portals can still be built and inspected while empty. That
// opt-in is refused on Railway and in CI, so a deployed build can never be an unconfigured one.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { readDeployment } from "./src/portal/deployment.js";

const IMAGE_IMPORT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.(?:png|jpe?g|webp))["'];?\s*$/;
const FILE_HINT = "Edit apps/portal-<name>/src/deployment.config.js (see DEPLOYMENT.md, \"Preparing a portal for a school\").";

export class DeploymentConfigError extends Error {}

// Variables Railway puts in every build and deploy. (Not every RAILWAY_* name: a developer's own computer may have RAILWAY_HOME or
// similar from the Railway command-line tool, and that must not count as being on the platform.)
const RAILWAY_BUILD_VARS = ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID", "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_GIT_COMMIT_SHA"];

/** True on Railway or in CI, where an unconfigured portal must never be built. */
export function onDeployPlatform(env = process.env) {
  return Boolean(env.CI) || RAILWAY_BUILD_VARS.some((k) => Boolean(env[k]));
}

/**
 * Reads and checks one portal's deployment.config.js. Returns the checked deployment ({ school, branch, trip, ... }).
 * Throws DeploymentConfigError saying what is wrong. `portalDir` is the portal's own folder (the one with src/).
 */
export function checkPortalConfig(portalDir) {
  const file = path.join(portalDir, "src", "deployment.config.js");
  const where = `${path.basename(portalDir)}/src/deployment.config.js`;
  if (!existsSync(file)) throw new DeploymentConfigError(`${where} is missing. ${FILE_HINT}`);

  const imports = {};
  const body = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*import\b/.test(line)) {
      const m = IMAGE_IMPORT.exec(line.trim());
      if (!m) throw new DeploymentConfigError(`${where}: the only import allowed is a logo image (png, jpg or webp). Found: ${line.trim().slice(0, 80)}`);
      if (!existsSync(path.resolve(path.dirname(file), m[2]))) throw new DeploymentConfigError(`${where}: the logo file ${m[2]} does not exist. Put the image in the portal's src folder, or remove the import and set logo: null.`);
      imports[m[1]] = "/assets/school-logo.png"; // stands in for the built address, which the real build chooses
    } else {
      body.push(line);
    }
  }
  const source = body.join("\n").replace(/\bexport\s+default\b/, "__config =");
  const sandbox = vm.createContext({ ...imports, __config: undefined });
  try {
    vm.runInContext(source, sandbox, { timeout: 1000, filename: where });
  } catch (err) {
    throw new DeploymentConfigError(`${where} could not be read: ${String(err.message).slice(0, 160)}`);
  }
  const raw = sandbox.__config;
  const problems = [];
  for (const key of ["school", "branch", "trip"]) {
    if (typeof raw?.[key] !== "string" || raw[key] === "") problems.push(`${key} is empty`);
  }
  for (const key of ["schoolName", "tripTitle"]) {
    if (typeof raw?.[key] !== "string" || raw[key].trim() === "") problems.push(`${key} is empty`);
  }
  const deployment = readDeployment(raw);
  if (!deployment && problems.length === 0) {
    problems.push("school, branch and trip must each be lowercase letters, digits and single hyphens (the last three parts of the registration link); names must be 150 characters or fewer");
  }
  if (deployment && raw.logo != null && raw.logo !== "" && !deployment.logo) problems.push("logo is not a built-in image address");
  if (deployment && raw.schoolLogos != null) {
    const given = raw.schoolLogos && typeof raw.schoolLogos === "object" && !Array.isArray(raw.schoolLogos) ? Object.keys(raw.schoolLogos).length : -1;
    if (given !== Object.keys(deployment.schoolLogos).length) problems.push('schoolLogos must map "<school>/<branch>" to an imported logo image, for example "abc-school/jaipur": abcLogo');
  }
  if (problems.length > 0) throw new DeploymentConfigError(`${where} is not ready: ${problems.join("; ")}. ${FILE_HINT}`);
  return deployment;
}

/**
 * Vite plugin for a public portal. A build with no valid deployment config stops before anything is written, so the previous
 * dist folder (and the previous deployment) is untouched.
 */
export function portalConfigGuard({ target, env = process.env }) {
  let root = process.cwd();
  return {
    name: "portal-deployment-config-guard",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      if (target === "staff") return; // the Sales portal has no school or trip
      try {
        checkPortalConfig(root);
      } catch (err) {
        if (!(err instanceof DeploymentConfigError)) throw err;
        if (env.ALLOW_UNCONFIGURED_PORTAL_BUILD === "true") {
          if (onDeployPlatform(env)) {
            throw new DeploymentConfigError(`${err.message}\nALLOW_UNCONFIGURED_PORTAL_BUILD is refused on Railway and in CI: an unconfigured portal must never be deployed.`);
          }
          this.warn(`${err.message}\n(Building anyway: ALLOW_UNCONFIGURED_PORTAL_BUILD=true on this computer. Do not deploy this build.)`);
          return;
        }
        throw new DeploymentConfigError(`${err.message}\nBuild stopped on purpose, so an unconfigured portal is never deployed.`);
      }
    },
  };
}
