import pg from "pg";

export function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client dropping must not crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}
