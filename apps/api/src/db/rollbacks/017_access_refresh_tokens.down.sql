-- Rollback for 017_access_refresh_tokens.sql. NOT run automatically: run by hand, with a backup, and only together with
-- the matching code. It drops the refresh-token tables and the new columns. Sign-ins created after 017 have no long-lived
-- token, so they end (everyone signs in again). No registration, form or account data is touched.
DROP TABLE IF EXISTS auth_refresh_tokens;
DROP TABLE IF EXISTS staff_refresh_tokens;
DELETE FROM auth_sessions WHERE token_hash IS NULL;
DELETE FROM staff_sessions WHERE token_hash IS NULL;
ALTER TABLE auth_sessions DROP COLUMN IF EXISTS access_token_hash, DROP COLUMN IF EXISTS access_expires_at, DROP COLUMN IF EXISTS idle_expires_at, DROP COLUMN IF EXISTS revoke_reason, ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE staff_sessions DROP COLUMN IF EXISTS access_token_hash, DROP COLUMN IF EXISTS access_expires_at, DROP COLUMN IF EXISTS idle_expires_at, DROP COLUMN IF EXISTS revoke_reason, ALTER COLUMN token_hash SET NOT NULL;
DELETE FROM schema_migrations WHERE name = '017_access_refresh_tokens.sql';
