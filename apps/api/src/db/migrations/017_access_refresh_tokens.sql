-- 017_access_refresh_tokens.sql
-- Short-lived ACCESS tokens and one-time-use REFRESH tokens, for parents and staff. Applied by src/db/migrate.js in a
-- single transaction. Depends on 003 and 007. Rollback: src/db/rollbacks/017_access_refresh_tokens.down.sql.
--
-- A row in auth_sessions / staff_sessions stays ONE SIGN-IN (a "session family"). What changes is how the browser
-- proves it is that sign-in:
--  * access_token_hash / access_expires_at: the keyed hash of the current access token and when it stops working
--    (15 minutes by default). Replaced on every refresh, so only one access token per sign-in works at a time.
--  * expires_at keeps its meaning: the ABSOLUTE end of the sign-in. No refresh ever moves it.
--  * idle_expires_at: the end of the inactivity window (moves forward on each refresh, never past expires_at).
--  * revoke_reason: why it ended early (logout, password_reset, refresh_reuse ...), a fixed word, never free text.
--  * token_hash: the single long-lived token of sign-ins made BEFORE this migration. It is now optional: new sign-ins
--    have none, and an old one is retired (set to NULL) the first time it is exchanged for an access + refresh pair.
--    Existing rows and their values are not changed by this migration, so nobody is signed out by it.
--  * auth_refresh_tokens / staff_refresh_tokens: one row per refresh token ever issued (hash only). used_at marks it
--    spent; presenting a spent one again (outside a short grace window for simultaneous tabs) revokes the sign-in.

ALTER TABLE auth_sessions ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE auth_sessions
    ADD COLUMN access_token_hash text,
    ADD COLUMN access_expires_at timestamptz,
    ADD COLUMN idle_expires_at   timestamptz,
    ADD COLUMN revoke_reason     text,
    ADD CONSTRAINT auth_sessions_access_pair_chk CHECK ((access_token_hash IS NULL) = (access_expires_at IS NULL)),
    ADD CONSTRAINT auth_sessions_access_hash_chk CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT auth_sessions_revoke_reason_chk CHECK (revoke_reason IS NULL OR revoke_reason ~ '^[a-z_]{3,40}$');
CREATE UNIQUE INDEX auth_sessions_access_token_uk ON auth_sessions (access_token_hash) WHERE access_token_hash IS NOT NULL;

CREATE TABLE auth_refresh_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid        NOT NULL REFERENCES auth_sessions (id) ON DELETE CASCADE,
    token_hash text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    CONSTRAINT auth_refresh_tokens_token_key UNIQUE (token_hash),
    CONSTRAINT auth_refresh_tokens_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT auth_refresh_tokens_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens (session_id);

ALTER TABLE staff_sessions ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE staff_sessions
    ADD COLUMN access_token_hash text,
    ADD COLUMN access_expires_at timestamptz,
    ADD COLUMN idle_expires_at   timestamptz,
    ADD COLUMN revoke_reason     text,
    ADD CONSTRAINT staff_sessions_access_pair_chk CHECK ((access_token_hash IS NULL) = (access_expires_at IS NULL)),
    ADD CONSTRAINT staff_sessions_access_hash_chk CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT staff_sessions_revoke_reason_chk CHECK (revoke_reason IS NULL OR revoke_reason ~ '^[a-z_]{3,40}$');
CREATE UNIQUE INDEX staff_sessions_access_token_uk ON staff_sessions (access_token_hash) WHERE access_token_hash IS NOT NULL;

CREATE TABLE staff_refresh_tokens (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid        NOT NULL REFERENCES staff_sessions (id) ON DELETE CASCADE,
    token_hash text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    CONSTRAINT staff_refresh_tokens_token_key UNIQUE (token_hash),
    CONSTRAINT staff_refresh_tokens_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT staff_refresh_tokens_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX staff_refresh_tokens_session_idx ON staff_refresh_tokens (session_id);
