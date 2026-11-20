import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { serverBusyError } from "./errors.js";
import { createWorkGate, defaultGateOptions } from "./work-gate.js";

// Passwords are hashed with scrypt from node:crypto (no dependency), salted per
// password. The default cost is the OWASP-recommended N=2^17, r=8, p=1 (about
// 128 MiB per hash). The parameters are stored inside the hash string, so a
// hash made with older settings still verifies after the settings are raised.
export const DEFAULT_COST = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// Upper bounds applied when reading a stored hash, so a damaged row can't make a
// sign-in allocate unbounded memory.
const MAX_COST = { N: 2 ** 18, r: 16, p: 4 };

const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

const derive = (password, salt, { N, r, p }) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });

// NFKC so the same visible password always hashes the same, whatever device typed it.
const canonical = (password) => password.normalize("NFKC");

/**
 * Every hash goes through `gate` (see work-gate.js), so a burst of sign-ins can't swamp the server. A caller that has
 * work to do before hashing (a rate-limit check, a transaction) takes its place first with `reserve()` and passes the
 * ticket in; then a busy server refuses before anything is counted or consumed. Without a ticket, each call takes and
 * hands back its own place. Either way a full gate means SERVER_BUSY (503), never an unbounded wait.
 */
export function createPasswordHasher({ cost = DEFAULT_COST, gate = createWorkGate(defaultGateOptions()) } = {}) {
  /** -> a ticket to pass to hash/verify/verifyDecoy; the caller must release() it. Throws SERVER_BUSY when full. */
  function reserve() {
    const ticket = gate.reserve();
    if (!ticket) throw serverBusyError(gate.retryAfterSeconds());
    return ticket;
  }

  async function work(ticket, fn) {
    if (ticket) return ticket.run(fn);
    const own = reserve();
    try {
      return await own.run(fn);
    } finally {
      own.release();
    }
  }

  async function hash(password, { ticket } = {}) {
    const salt = randomBytes(SALT_LENGTH);
    const key = await work(ticket, () => derive(canonical(password), salt, cost));
    return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
  }

  /** true only for a matching password. Any malformed stored hash is simply "no match". */
  async function verify(password, stored, { ticket } = {}) {
    const m = typeof stored === "string" ? FORMAT.exec(stored) : null;
    if (!m) return false;
    const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (N < 2 || (N & (N - 1)) !== 0 || N > MAX_COST.N || r < 1 || r > MAX_COST.r || p < 1 || p > MAX_COST.p) return false;
    const expected = Buffer.from(m[5], "base64url");
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await work(ticket, () => derive(canonical(password), Buffer.from(m[4], "base64url"), { N, r, p }));
    return timingSafeEqual(actual, expected);
  }

  // For an email with no password: do the same amount of work as a real check, so
  // response time doesn't tell an attacker whether the account exists.
  let decoy;
  async function verifyDecoy(password, { ticket } = {}) {
    // A decoy that couldn't be made (e.g. refused as busy) is forgotten, so the next call tries again.
    decoy ??= hash(randomBytes(16).toString("hex"), { ticket }).catch((err) => {
      decoy = undefined;
      throw err;
    });
    await verify(password, await decoy, { ticket });
    return false;
  }

  return { reserve, hash, verify, verifyDecoy };
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Length matters more than composition rules, so the policy is: long enough, not
// absurdly long, and not one of the most commonly used passwords. (A short list
// only: it catches the obvious ones. A fuller breached-password check is a
// decision for later.)
const COMMON = new Set([
  "password12", "password123", "password1234", "password12345", "passw0rd123", "p@ssword123", "p@ssw0rd123",
  "1234567890", "12345678910", "123456789a", "1q2w3e4r5t", "0123456789", "0987654321", "1111111111", "0000000000",
  "qwertyuiop", "qwerty1234", "qwerty12345", "qwertyuiop1", "asdfghjkl1", "abcdefghij", "abcd123456", "abc1234567",
  "iloveyou123", "welcome123", "welcome1234", "letmein123", "admin12345", "administrator", "changeme123",
  "football123", "monkey1234", "dragon1234", "superman123", "trustno1234",
  "youngedsplorer", "parentsportal", "edsplorer123", "youngedsplorer1", "youngedsplorer123",
]);

/** Password rules, shared by every flow that sets a password. Messages never echo the password. */
export const passwordSchema = z
  .string({ error: "Password is required." })
  .refine((v) => [...v].length >= PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
  .refine((v) => [...v].length <= PASSWORD_MAX, `Password must be ${PASSWORD_MAX} characters or fewer.`)
  .refine((v) => v.trim().length > 0, "Password can't be only spaces.")
  .refine((v) => !COMMON.has(canonical(v).toLowerCase()), "That password is too common. Choose a less guessable one.");

/** The password may not simply be the email address. For a body with `password` and `email`. */
export function checkPasswordNotEmail(v, ctx) {
  if (typeof v.password === "string" && v.password.trim().toLowerCase() === v.email) {
    ctx.addIssue({ code: "custom", path: ["password"], message: "Password can't be the same as your email." });
  }
}

/**
 * Shared by password reset and staff password flows: the confirmation must match, and the
 * password may not simply be the email address. Use inside a zod superRefine on an
 * object with `password`, `confirmPassword` and `email`.
 */
export function checkPasswordPair(v, ctx) {
  if (v.confirmPassword !== v.password) {
    ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "Passwords do not match." });
  }
  if (typeof v.password === "string" && v.password.trim().toLowerCase() === v.email) {
    ctx.addIssue({ code: "custom", path: ["password"], message: "Password can't be the same as your email." });
  }
}
