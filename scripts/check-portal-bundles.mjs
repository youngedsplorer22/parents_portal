// Post-build guard: a public registration portal must not contain the staff application, and the staff portal must not
// contain the parent application. Also: no source maps, and no staff e-mail address or password-looking text anywhere.
// Run after `npm run build:all-portals`. Exit code 1 on any violation. This keeps code out of the wrong website; the real
// security boundary is the API, which checks every request.
//   PORTAL_APPS_DIR=<dir> overrides where apps/ is (used to test this script itself).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appsDir = process.env.PORTAL_APPS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps");
const PUBLIC = ["domestic-paid", "domestic-free", "international-paid", "international-free"];

// Strings that exist only in the staff application's code (staff API client and staff screens).
const STAFF_MARKERS = [/["'`]\/api\/admin["'`]/, /Add school/, /Create trip/, /Sales dashboard/, /Admin dashboard/, /Staff accounts/];
// Strings that exist only in the parent application's code.
const PARENT_MARKERS = [/\/api\/onboarding/, /Forgot your password/];
const STAFF_CHUNK = /^StaffApp[-.]/;
const PARENT_CHUNK = /^(App|JoinPage|JoinContinue|RetiredLink)[-.]/;
// Never in any browser file: a staff mailbox, or an assignment that looks like a password or secret.
// (A value with no spaces: UI sentences such as "Choose a password different from..." are not credentials.)
const LEAKS = [/[A-Za-z0-9._-]+@youngedsplorer\.com/i, /\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i];

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const problems = [];
const fail = (portal, msg) => problems.push(`${portal}: ${msg}`);

for (const target of [...PUBLIC, "staff"]) {
  const dist = path.join(appsDir, `portal-${target}`, "dist");
  if (!existsSync(dist)) { fail(target, `no build output at ${dist} (build it first)`); continue; }
  const forbiddenMarkers = target === "staff" ? PARENT_MARKERS : STAFF_MARKERS;
  const forbiddenChunk = target === "staff" ? PARENT_CHUNK : STAFF_CHUNK;
  for (const file of walk(dist)) {
    const name = path.basename(file);
    if (name.endsWith(".map")) fail(target, `source map published: ${name}`);
    if (/\.(js|mjs)$/.test(name) && forbiddenChunk.test(name)) fail(target, `forbidden chunk emitted: ${name}`);
    if (!/\.(js|mjs|css|html|json)$/.test(name)) continue;
    const text = readFileSync(file, "utf8");
    for (const re of LEAKS) if (re.test(text)) fail(target, `credential-looking text in ${name} (${re})`);
    if (/\.(js|mjs)$/.test(name)) for (const re of forbiddenMarkers) if (re.test(text)) fail(target, `${target === "staff" ? "parent" : "staff"} code marker ${re} in ${name}`);
  }
}

if (problems.length) {
  console.error(`Portal bundle check FAILED (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Portal bundle check passed: ${PUBLIC.length} public portals have no staff code, the staff portal has no parent code, no source maps, no credential-looking text.`);
