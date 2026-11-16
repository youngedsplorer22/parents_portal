import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createPool, poolOptions } from "../src/db/pool.js";

// Real timeouts against the LOCAL test database only (parents_portal_test, see helpers.js).
const url = process.env.TEST_DATABASE_URL;
const pools = [];
after(() => Promise.all(pools.map((p) => p.end())));

describe("pool options", () => {
  it("maps settings onto the driver and defaults to safe values", () => {
    const o = poolOptions("postgresql://u:p@localhost/db");
    assert.equal(o.max, 10);
    assert.equal(o.connectionTimeoutMillis, 5000);
    assert.equal(o.idleTimeoutMillis, 30000);
    assert.equal(o.statement_timeout, 15000);
    assert.equal(o.idle_in_transaction_session_timeout, 30000);
    assert.ok(o.query_timeout > o.statement_timeout, "the client gives up only after the server did");
    const c = poolOptions("postgresql://u:p@localhost/db", { max: 3, statementTimeoutMs: 800 });
    assert.equal(c.max, 3);
    assert.equal(c.statement_timeout, 800);
  });
});

describe("pool behaviour", () => {
  it("cancels a statement that runs too long and the pool stays usable", async () => {
    const pool = createPool(url, { statementTimeoutMs: 500, max: 2 });
    pools.push(pool);
    await assert.rejects(pool.query("SELECT pg_sleep(5)"), (e) => e.code === "57014");
    assert.equal((await pool.query("SELECT 1 AS n")).rows[0].n, 1);
  });

  it("ends a transaction left idle", async () => {
    const pool = createPool(url, { idleInTransactionTimeoutMs: 1000, max: 2 });
    pools.push(pool);
    const client = await pool.connect();
    client.on("error", () => {});
    await client.query("BEGIN");
    await new Promise((r) => setTimeout(r, 1500));
    await assert.rejects(client.query("SELECT 1"));
    client.release(true);
  });

  it("a request for a connection fails fast when the pool is exhausted", async () => {
    const pool = createPool(url, { max: 1, connectionTimeoutMs: 500 });
    pools.push(pool);
    const held = await pool.connect();
    const t = Date.now();
    await assert.rejects(pool.query("SELECT 1"), /timeout/i);
    assert.ok(Date.now() - t < 2000);
    held.release();
  });
});
