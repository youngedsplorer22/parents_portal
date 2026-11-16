-- 005_password_credentials.sql
-- Password sign-in (Phase 1). Applied by src/db/migrate.js in a single transaction.
-- Depends on 002 (parent_registrations). Only ADDS tables: no existing table,
-- column, constraint or row is changed, so existing accounts keep working with
-- their email code and have simply no password until they set one.

-- One password per account. Only the scrypt hash is stored, never the password.
-- The hash string is self-describing ("scrypt$N$r$p$salt$hash", base64url), so
-- the cost parameters can be raised later without a schema change.
CREATE TABLE password_credentials (
    registration_id uuid        PRIMARY KEY
                                REFERENCES parent_registrations (id) ON DELETE CASCADE,
    password_hash   text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    changed_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT password_credentials_hash_chk
        CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);

-- One row per password sign-in attempt, written BEFORE the password is checked
-- so a burst of parallel guesses is counted. A successful sign-in deletes that
-- email's rows, so what remains is failed attempts. Used for the per-account
-- and per-IP limits. The key is the email as typed (normalised), whether or
-- not an account exists, so the limiter reveals nothing about which emails exist.
CREATE TABLE password_login_attempts (
    id               bigserial   PRIMARY KEY,
    email_normalized text        NOT NULL,
    request_ip       inet,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT password_login_attempts_email_chk
        CHECK (char_length(email_normalized) BETWEEN 3 AND 254)
);

CREATE INDEX password_login_attempts_email_idx
    ON password_login_attempts (email_normalized, created_at DESC);
CREATE INDEX password_login_attempts_ip_idx
    ON password_login_attempts (request_ip, created_at DESC)
    WHERE request_ip IS NOT NULL;
CREATE INDEX password_login_attempts_created_idx
    ON password_login_attempts (created_at);
