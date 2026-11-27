// Append-only record of administrative changes (table audit_log). Written with the caller's
// client so it commits or rolls back with the change it describes.
//
// Only small, plain values are kept, and any key that looks like a secret is dropped, so a
// password, session token or trip-link token can never end up here even by mistake.
const SECRET_KEY = /token|password|secret|hash|cookie|authorization|credential/i;

export function safeDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export async function recordAudit(q, actor, action, entityType, entityId, details) {
  await q.query(
    `INSERT INTO audit_log (staff_id, staff_email, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor.id ?? null, actor.email, action, entityType, entityId ? String(entityId) : null, JSON.stringify(safeDetails(details))],
  );
}

export async function listAudit(db, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT id, staff_email, action, entity_type, entity_id, details, created_at
       FROM audit_log ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 500)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    staffEmail: r.staff_email,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details,
    at: r.created_at,
  }));
}
