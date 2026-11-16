import pg from "pg";

export const POOL_DEFAULTS = {
  max: 10,
  connectionTimeoutMs: 5000, // waiting for a free connection (or a new one) fails after this instead of queueing forever
  idleTimeoutMs: 30000, // an unused connection is closed after this
  statementTimeoutMs: 15000, // the SERVER cancels any single statement that runs longer
  idleInTransactionTimeoutMs: 30000, // the SERVER ends a session that opened a transaction and went quiet
};

/**
 * The driver options for a pool. Timeouts are set as session parameters, not in the URL (db/target.js refuses unknown URL
 * options on purpose). query_timeout is the client-side backstop and is longer than the server's statement timeout, so the
 * server cancels first (code 57014) and the connection is not left half-used.
 */
export function poolOptions(connectionString, o = {}) {
  const c = { ...POOL_DEFAULTS, ...o };
  return {
    connectionString,
    max: c.max,
    connectionTimeoutMillis: c.connectionTimeoutMs,
    idleTimeoutMillis: c.idleTimeoutMs,
    statement_timeout: c.statementTimeoutMs,
    idle_in_transaction_session_timeout: c.idleInTransactionTimeoutMs,
    query_timeout: c.statementTimeoutMs + 5000,
    application_name: "parents-portal",
  };
}

export function createPool(connectionString, options = {}) {
  const pool = new pg.Pool(poolOptions(connectionString, options));
  // An idle client dropping must not crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}
