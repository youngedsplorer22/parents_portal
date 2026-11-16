-- 003_auth_sessions.sql
-- Login for existing registrations, and the server-side sessions it creates.
-- Applied by src/db/migrate.js in a single transaction. Depends on 001 and 002.
--
-- 1. Email OTPs and verification tokens may now also be issued for purpose
--    'login' (001 only allowed 'registration'). The constraints are replaced
--    here; 001 itself is not edited.
-- 2. auth_sessions: one row per signed-in browser. The session token is a
--    256-bit random value that only ever lives in an HttpOnly cookie; the table
--    stores its keyed hash, never the token. The identity of a session is the
--    parent_registrations row, which is what ties every later record to its owner.

ALTER TABLE email_otps DROP CONSTRAINT email_otps_purpose_chk;
ALTER TABLE email_otps
    ADD CONSTRAINT email_otps_purpose_chk CHECK (purpose IN ('registration', 'login'));

ALTER TABLE email_verification_tokens DROP CONSTRAINT email_verification_tokens_purpose_chk;
ALTER TABLE email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_purpose_chk CHECK (purpose IN ('registration', 'login'));

CREATE TABLE auth_sessions (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid        NOT NULL
                                REFERENCES parent_registrations (id) ON DELETE CASCADE,
    token_hash      text        NOT NULL,   -- hex HMAC-SHA256 of the session token
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,   -- absolute lifetime (SESSION_TTL_SECONDS)
    revoked_at      timestamptz,            -- set on logout

    CONSTRAINT auth_sessions_token_key UNIQUE (token_hash),
    CONSTRAINT auth_sessions_token_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT auth_sessions_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_registration_idx ON auth_sessions (registration_id);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);
