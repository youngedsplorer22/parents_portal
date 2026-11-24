// Post-build guard: public registration portals must contain BOTH the Sales application (served from the same URL as
// parent registration) and the parent application; the staff portal must not contain the parent application. Also: no
// source maps, and no staff e-mail address or password-looking text anywhere.
// Run after `npm run build:all-portals`. Exit code 1 on any violation. This keeps code out of the wrong website; the real
// security boundary is the API, which checks every request.
//   PORTAL_APPS_DIR=<dir> overrides where apps/ is (used to test this script itself).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appsDir = process.env.PORTAL_APPS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps");
const PUBLIC = ["domestic-paid", "domestic-free", "international-paid", "international-free"];

// Strings that must appear in every public portal build: the Sales API base path (confirmed present as a string literal
// in the built StaffApp chunk) and a Sales UI marker.
const SALES_MARKERS = [/["'`]\/api\/admin["'`]/, /Sales log in/];
// Strings that exist only in the parent application's code (checked in the staff build; public builds now intentionally
// include the Sales application alongside the parent application).
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
  const isPublic = target !== "staff";
  let hasStaffChunk = false;
  let hasParentChunk = false;
  for (const file of walk(dist)) {
    const name = path.basename(file);
    if (name.endsWith(".map")) fail(target, `source map published: ${name}`);
    if (/\.(js|mjs)$/.test(name)) {
      if (STAFF_CHUNK.test(name)) { if (isPublic) hasStaffChunk = true; }
      if (PARENT_CHUNK.test(name)) { if (isPublic) hasParentChunk = true; else fail(target, `forbidden chunk emitted: ${name}`); }
    }
    if (!/\.(js|mjs|css|html|json)$/.test(name)) continue;
    const text = readFileSync(file, "utf8");
    for (const re of LEAKS) if (re.test(text)) fail(target, `credential-looking text in ${name} (${re})`);
    if (/\.(js|mjs)$/.test(name)) {
      if (!isPublic) for (const re of PARENT_MARKERS) if (re.test(text)) fail(target, `parent code marker ${re} in ${name}`);
      if (isPublic && STAFF_CHUNK.test(name)) for (const re of SALES_MARKERS) if (!re.test(text)) fail(target, `Sales functionality marker ${re} missing from ${name}`);
    }
  }
  if (isPublic && !hasStaffChunk) fail(target, "Sales chunk (StaffApp) missing — public portal must include the Sales application");
  if (isPublic && !hasParentChunk) fail(target, "parent chunk (App/JoinPage/etc.) missing — public portal must include the parent application");
}

if (problems.length) {
  console.error(`Portal bundle check FAILED (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Portal bundle check passed: ${PUBLIC.length} public portals include both Sales and parent code, the staff portal has no parent code, no source maps, no credential-looking text.`);
