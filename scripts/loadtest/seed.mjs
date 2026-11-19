// Pre-creates verified, single-use email verification tokens in a DISPOSABLE test database, so load tests can call
// POST /api/registrations without sending any email. Writes tokens.json for k6.
//
//   DATABASE_URL=postgresql://localhost/parents_portal_loadtest OTP_HMAC_SECRET=<same as the API> \
//     node scripts/loadtest/seed.mjs [--singles 20000] [--dup-groups 50] [--dup-width 20] [--reuse 50] [--accounts 3000] [--otp-accounts 1500]
//
// Every identity is `lt-<run>-...@loadtest.example.org`, so cleanup.mjs can find and remove exactly these rows.
// --accounts creates parent accounts that can sign in with a password (all share one password hash made at the real
// production scrypt cost, so a login costs what a real one costs). The OTP-race and OTP-send scenarios need no seeding.
//
// Refuses anything that does not look like a local database unless LOADTEST_ALLOW_REMOTE_DB=yes-this-is-not-production.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { generateCode, generateToken, hashCode, hashToken } from "../../apps/api/src/modules/email-otp/otp-crypto.js";
import { createPasswordHasher } from "../../apps/api/src/modules/auth/password.js";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const singles = arg("singles", 20000), dupGroups = arg("dup-groups", 50), dupWidth = arg("dup-width", 20), reuse = arg("reuse", 50), accounts = arg("accounts", 3000), otpAccounts = arg("otp-accounts", 1500);
const { DATABASE_URL, OTP_HMAC_SECRET } = process.env;
if (!DATABASE_URL || !OTP_HMAC_SECRET) { console.error("DATABASE_URL and OTP_HMAC_SECRET are required."); process.exit(1); }
const host = new URL(DATABASE_URL).hostname;
const looksRemote = !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || /railway|rlwy|proxy/i.test(DATABASE_URL);
if (looksRemote && process.env.LOADTEST_ALLOW_REMOTE_DB !== "yes-this-is-not-production") {
  console.error(`Refusing to seed "${host}": not a local database. Set LOADTEST_ALLOW_REMOTE_DB=yes-this-is-not-production only for a disposable staging database.`);
  process.exit(1);
}

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const now = new Date(), expires = new Date(now.getTime() + 6 * 3600_000); // tokens live 6 h: long enough for one test session

async function make(email) {
  const otpId = randomUUID(), code = generateCode(), token = generateToken();
  await db.query(
    `INSERT INTO email_otps (id, email_normalized, purpose, code_hash, created_at, expires_at, resend_available_at, verified_at)
     VALUES ($1,$2,'registration',$3,$4,$5,$4,$4)`,
    [otpId, email, hashCode(OTP_HMAC_SECRET, { otpId, email, purpose: "registration", code }), now, expires],
  );
  await db.query(
    `INSERT INTO email_verification_tokens (otp_id, email_normalized, purpose, token_hash, created_at, expires_at)
     VALUES ($1,$2,'registration',$3,$4,$5)`,
    [otpId, email, hashToken(OTP_HMAC_SECRET, { token, email, purpose: "registration" }), now, expires],
  );
  return token;
}

const run = randomUUID().slice(0, 8);
const out = { run, singles: [], dup: [], reuse: [], accounts: [], otpAccounts: [], accountPassword: "Lt-Login-Zq7!pass" };
await db.query("BEGIN");
for (let i = 0; i < singles; i++) { const email = `lt-${run}-s${i}@loadtest.example.org`; out.singles.push({ email, token: await make(email) }); }
for (let g = 0; g < dupGroups; g++) {
  const email = `lt-${run}-d${g}@loadtest.example.org`, tokens = [];
  for (let w = 0; w < dupWidth; w++) tokens.push(await make(email));
  out.dup.push({ email, tokens });
}
for (let r = 0; r < reuse; r++) { const email = `lt-${run}-r${r}@loadtest.example.org`; out.reuse.push({ email, token: await make(email) }); }
const hash = await createPasswordHasher().hash(out.accountPassword);
// Password-login accounts ("a") and OTP-login accounts ("o"), made in bulk. Every one shares one hash made at the real cost.
// OTP-login accounts are used at most 3 times each by the test, because OTP sends are capped per email (default 5 per hour).
for (const [tag, n, key] of [["a", accounts, "accounts"], ["o", otpAccounts, "otpAccounts"]]) {
  await db.query(
    `INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at)
     SELECT 'Load','Account','LoadTest School','Student','9000000000', 'lt-' || $1::text || '-' || $2::text || g || '@loadtest.example.org', now()
       FROM generate_series(0, $3::int - 1) g`, [run, tag, n]);
  await db.query(
    `INSERT INTO password_credentials (registration_id, password_hash)
     SELECT id, $2 FROM parent_registrations WHERE email_normalized LIKE 'lt-' || $1::text || '-' || $3::text || '%@loadtest.example.org'`, [run, hash, tag]);
  out[key] = Array.from({ length: n }, (_, i) => `lt-${run}-${tag}${i}@loadtest.example.org`);
}
await db.query("COMMIT");
await db.end();
writeFileSync(new URL("./tokens.json", import.meta.url), JSON.stringify(out));
console.log(`Seeded run ${run}: ${singles} single, ${dupGroups}x${dupWidth} duplicate-email, ${reuse} token-reuse, ${accounts} password-login accounts, ${otpAccounts} OTP-login accounts. Wrote scripts/loadtest/tokens.json (git-ignored).`);
