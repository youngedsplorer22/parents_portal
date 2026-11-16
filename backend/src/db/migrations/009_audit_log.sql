-- 009_audit_log.sql
-- Who changed what in the admin panel (Phase 3). Depends on 007.
-- Rows are written in the same transaction as the change they describe. They
-- hold names and ids of things, never passwords, session tokens or link tokens.
-- Append-only: updates and deletes are refused by a trigger.

CREATE TABLE audit_log (
    id          bigserial   PRIMARY KEY,
    staff_id    uuid,                   -- no foreign key on purpose: an append-only log must not be changed by a staff delete
    staff_email text        NOT NULL,   -- kept even if the account is removed later
    action      text        NOT NULL,   -- e.g. 'trip.status_change'
    entity_type text        NOT NULL,
    entity_id   text,
    details     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT audit_log_action_chk CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
    CONSTRAINT audit_log_details_chk CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 4096)
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
