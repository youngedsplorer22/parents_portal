import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import { createTokenSessions } from "../src/modules/sessions/token-sessions.js";
import { createTestPool, resetTables } from "./helpers.js";

// The engine behind both parent and staff sign-in: a short-lived ACCESS token for every request, and a one-time-use
// REFRESH token that renews it. Both are random and opaque; only keyed hashes are stored. Every rule below is about
// what a stolen, replayed, expired or raced token can and cannot do.

const pool = createTestPool();
after(() => pool.end());
const SECRET = "a".repeat(64);
const POLICY = { accessTtlSeconds: 900, idleTimeoutSeconds: 3 * 86400, absoluteTtlSeconds: 7 * 86400, reuseGraceSeconds: 20 };
let sessions;
let ownerId;

beforeEach(async () => {
  await resetTables(pool);
  ownerId = (await pool.query(
    "INSERT INTO parent_registrations (first_name, last_name, school, role, phone, email_normalized, email_verified_at) VALUES ('A','B','S','Student','9876543210','p@example.com', now()) RETURNING id",
  )).rows[0].id;
  sessions = make();
});
function make(policy = POLICY) {
  return createTokenSessions({ db: pool, secret: SECRET, domain: "session-token-v1", sessions: "auth_sessions", refreshTokens: "auth_refresh_tokens", owner: "registration_id", policy });
}
async function signIn(s = sessions) {
  const client = await pool.connect();
  try {
    return await s.createIn(client, ownerId);
  } finally {
    client.release();
  }
}
const sessionRow = async (id) => (await pool.query("SELECT * FROM auth_sessions WHERE id = $1", [id])).rows[0];
const refreshRows = async (id) => (await pool.query("SELECT * FROM auth_refresh_tokens WHERE session_id = $1 ORDER BY created_at", [id])).rows;
const age = (table, set, where = "TRUE", params = []) => pool.query(`UPDATE ${table} SET ${set} WHERE ${where}`, params);

describe("signing in", () => {
  it("issues a random access token and a random refresh token; only their keyed hashes are stored", async () => {
    const out = await signIn();
    assert.match(out.access.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(out.refresh.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(out.access.token, out.refresh.token);
    const row = await sessionRow(out.sessionId);
    const dump = JSON.stringify([row, await refreshRows(out.sessionId)]);
    assert.ok(!dump.includes(out.access.token) && !dump.includes(out.refresh.token), "no plaintext token in the database");
    assert.match(row.access_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.token_hash, null, "new sessions have no long-lived legacy token");
  });

  it("the access token lives 15 minutes, the refresh token until the inactivity limit, the session until its absolute limit", async () => {
    const out = await signIn();
    assert.equal(out.access.maxAgeSeconds, 900);
    assert.equal(out.refresh.maxAgeSeconds, 3 * 86400);
    const row = await sessionRow(out.sessionId);
    const span = (a, b) => Math.round((new Date(a) - new Date(b)) / 1000);
    assert.equal(span(row.access_expires_at, row.created_at), 900);
    assert.equal(span(row.expires_at, row.created_at), 7 * 86400);
    assert.equal(span((await refreshRows(out.sessionId))[0].expires_at, row.created_at), 3 * 86400);
  });

  it("access and refresh tokens use different hash domains (an access token can never pass as a refresh token)", async () => {
    const out = await signIn();
    assert.equal((await sessions.refresh(out.access.token)).status, "invalid");
    assert.equal(await sessions.sessionForAccess(pool, out.refresh.token), null);
  });
});

describe("the access token", () => {
  it("is accepted while fresh, and refused once expired, revoked, or past the absolute limit", async () => {
    const out = await signIn();
    assert.deepEqual(await sessions.sessionForAccess(pool, out.access.token), { sessionId: out.sessionId, ownerId });
    await age("auth_sessions", "access_expires_at = now() - interval '1 second'");
    assert.equal(await sessions.sessionForAccess(pool, out.access.token), null, "expired");
    const two = await signIn();
    await age("auth_sessions", "revoked_at = now()", "id = $1", [two.sessionId]);
    assert.equal(await sessions.sessionForAccess(pool, two.access.token), null, "revoked");
    const three = await signIn();
    await age("auth_sessions", "created_at = now() - interval '8 days', expires_at = now() - interval '1 second', access_expires_at = now() + interval '5 minutes'", "id = $1", [three.sessionId]);
    assert.equal(await sessions.sessionForAccess(pool, three.access.token), null, "past the absolute limit");
  });

  it("refuses junk, empty and wrong-shape tokens without touching anything", async () => {
    for (const t of [null, undefined, "", "x", "a".repeat(43), "' OR 1=1 --"]) assert.equal(await sessions.sessionForAccess(pool, t), null);
  });
});

describe("refreshing", () => {
  it("issues a NEW access token and a NEW refresh token; the old access token stops working at once", async () => {
    const out = await signIn();
    const r = await sessions.refresh(out.refresh.token);
    assert.equal(r.status, "ok");
    assert.equal(r.ownerId, ownerId);
    assert.equal(r.sessionId, out.sessionId, "the same sign-in continues");
    assert.notEqual(r.access.token, out.access.token);
    assert.notEqual(r.refresh.token, out.refresh.token);
    assert.equal(await sessions.sessionForAccess(pool, out.access.token), null, "the replaced access token is dead");
    assert.ok(await sessions.sessionForAccess(pool, r.access.token));
  });

  it("each refresh token works once (rotation): the old one is marked used", async () => {
    const out = await signIn();
    await sessions.refresh(out.refresh.token);
    const rows = await refreshRows(out.sessionId);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].used_at, "the first one is spent");
    assert.equal(rows[1].used_at, null);
  });

  it("refreshing moves the inactivity limit forward but NEVER past the absolute limit", async () => {
    const out = await signIn();
    await age("auth_sessions", "expires_at = now() + interval '1 hour'");
    const r = await sessions.refresh(out.refresh.token);
    const row = await sessionRow(out.sessionId);
    const latest = (await refreshRows(out.sessionId)).at(-1);
    assert.ok(new Date(latest.expires_at) <= new Date(row.expires_at), "the new refresh token ends with the session");
    assert.ok(new Date(row.access_expires_at) <= new Date(row.expires_at), "so does the access token");
    assert.ok(r.refresh.maxAgeSeconds <= 3600 && r.access.maxAgeSeconds <= 900);
  });

  it("after the absolute limit nothing renews the session, however recently it was used", async () => {
    const out = await signIn();
    await age("auth_sessions", "expires_at = now() - interval '1 second', created_at = now() - interval '8 days'");
    assert.equal((await sessions.refresh(out.refresh.token)).status, "expired");
  });

  it("a refresh token unused for longer than the inactivity limit has expired", async () => {
    const out = await signIn();
    await age("auth_refresh_tokens", "created_at = now() - interval '4 days', expires_at = now() - interval '1 second'");
    assert.equal((await sessions.refresh(out.refresh.token)).status, "expired");
  });

  it("a revoked session can't be refreshed", async () => {
    const out = await signIn();
    await age("auth_sessions", "revoked_at = now()");
    assert.equal((await sessions.refresh(out.refresh.token)).status, "expired");
  });

  it("an unknown or malformed refresh token is simply invalid", async () => {
    for (const t of [null, "", "x", "b".repeat(43), "' OR 1=1 --"]) assert.equal((await sessions.refresh(t)).status, "invalid");
  });
});

describe("replay and races", () => {
  it("reusing a spent refresh token after the grace window is a replay: the WHOLE sign-in is revoked", async () => {
    const out = await signIn();
    const r1 = await sessions.refresh(out.refresh.token);
    await age("auth_refresh_tokens", "used_at = now() - interval '1 minute'", "used_at IS NOT NULL");
    const replay = await sessions.refresh(out.refresh.token);
    assert.equal(replay.status, "reused");
    assert.equal(replay.ownerId, ownerId);
    const row = await sessionRow(out.sessionId);
    assert.ok(row.revoked_at);
    assert.equal(row.revoke_reason, "refresh_reuse");
    assert.equal(await sessions.sessionForAccess(pool, r1.access.token), null, "the legitimate holder's newest access token dies too");
    assert.equal((await sessions.refresh(r1.refresh.token)).status, "expired", "and so does the newest refresh token");
  });

  it("two refreshes with the same token at the same moment: one wins, the other is told it was a race (no revocation, nothing issued)", async () => {
    const out = await signIn();
    const results = await Promise.all([sessions.refresh(out.refresh.token), sessions.refresh(out.refresh.token), sessions.refresh(out.refresh.token)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["ok", "race", "race"]);
    assert.ok(results.filter((r) => r.status === "race").every((r) => !r.access && !r.refresh), "a race answer carries no tokens");
    assert.equal((await sessionRow(out.sessionId)).revoked_at, null);
    assert.equal((await refreshRows(out.sessionId)).length, 2, "exactly one rotation happened");
  });

  it("a race inside the grace window never gives the caller anything usable, so it is no help to an attacker", async () => {
    const out = await signIn();
    await sessions.refresh(out.refresh.token);
    const raced = await sessions.refresh(out.refresh.token);
    assert.equal(raced.status, "race");
    assert.equal(raced.access, undefined);
  });
});

describe("revoking", () => {
  it("logout by access token, by refresh token, or by either alone, revokes the sign-in (and nothing else)", async () => {
    const a = await signIn();
    const b = await signIn();
    const c = await signIn();
    assert.equal(await sessions.revoke({ accessToken: a.access.token }, "logout"), a.sessionId);
    assert.equal(await sessions.revoke({ refreshToken: b.refresh.token }, "logout"), b.sessionId);
    assert.equal((await sessionRow(a.sessionId)).revoke_reason, "logout");
    assert.ok((await sessionRow(b.sessionId)).revoked_at);
    assert.equal((await sessionRow(c.sessionId)).revoked_at, null, "another sign-in of the same person is untouched");
    assert.equal(await sessions.revoke({}, "logout"), null);
  });

  it("logout still works after the access token has expired (via the refresh token)", async () => {
    const out = await signIn();
    await age("auth_sessions", "access_expires_at = now() - interval '1 second'");
    assert.equal(await sessions.revoke({ refreshToken: out.refresh.token }, "logout"), out.sessionId);
    assert.equal((await sessions.refresh(out.refresh.token)).status, "expired");
  });
});

describe("sessions from before this change (one long-lived token)", () => {
  const legacyHash = (t) => createHmac("sha256", SECRET).update(`session-token-v1:${t}`).digest("hex");
  async function legacySession(token = "L".repeat(43)) {
    return (await pool.query("INSERT INTO auth_sessions (registration_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 days') RETURNING id", [ownerId, legacyHash(token)])).rows[0].id;
  }

  it("are upgraded once into an access + refresh pair, keeping their original absolute expiry; the old token then stops working", async () => {
    const id = await legacySession();
    const before = await sessionRow(id);
    const up = await sessions.upgradeLegacy(legacyHash("L".repeat(43)));
    assert.equal(up.status, "ok");
    assert.equal(up.sessionId, id);
    const after = await sessionRow(id);
    assert.equal(after.token_hash, null, "the long-lived token is retired");
    assert.equal(String(after.expires_at), String(before.expires_at), "no extension of the original lifetime");
    assert.equal((await sessions.upgradeLegacy(legacyHash("L".repeat(43)))).status, "invalid", "one upgrade only");
    assert.ok(await sessions.sessionForAccess(pool, up.access.token));
  });

  it("an expired or revoked old session is not upgraded", async () => {
    const id = await legacySession("M".repeat(43));
    await age("auth_sessions", "revoked_at = now()", "id = $1", [id]);
    assert.equal((await sessions.upgradeLegacy(legacyHash("M".repeat(43)))).status, "invalid");
  });

  it("revoking by the old token works too (logging out from an old browser)", async () => {
    const id = await legacySession("N".repeat(43));
    assert.equal(await sessions.revoke({ legacyHash: legacyHash("N".repeat(43)) }, "logout"), id);
  });
});

describe("housekeeping", () => {
  it("deletes sessions (and their refresh tokens) a day after their absolute expiry, and keeps live ones", async () => {
    const dead = await signIn();
    const live = await signIn();
    await age("auth_sessions", "expires_at = now() - interval '2 days', created_at = now() - interval '9 days'", "id = $1", [dead.sessionId]);
    await sessions.purgeExpired();
    assert.equal(await sessionRow(dead.sessionId), undefined);
    assert.deepEqual(await refreshRows(dead.sessionId), []);
    assert.ok(await sessionRow(live.sessionId));
  });
});

describe("policy", () => {
  it("refuses a policy where the access token outlives the inactivity limit, or the inactivity limit the absolute one", () => {
    for (const bad of [{ ...POLICY, accessTtlSeconds: 4 * 86400 }, { ...POLICY, idleTimeoutSeconds: 8 * 86400 }, { ...POLICY, accessTtlSeconds: 0 }]) assert.throws(() => make(bad), /policy/i);
  });
});
