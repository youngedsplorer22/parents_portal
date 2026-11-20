-- 001_email_otp.sql
-- Email OTP verification for registration.
-- Applied by src/db/migrate.js inside a single transaction; it also records
-- this file in its own schema_migrations table. Requires PostgreSQL 13+
-- (gen_random_uuid() is built in).

-- One row per issued OTP. Only a keyed hash of the code is stored, never the code.
CREATE TABLE email_otps (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_normalized    text        NOT NULL,
    purpose             text        NOT NULL,
    code_hash           text        NOT NULL,   -- hex HMAC-SHA256 (keyed, bound to id and email)
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,   -- created_at + OTP_TTL_SECONDS (30s)
    resend_available_at timestamptz NOT NULL,   -- created_at + resend cooldown (30s)
    attempts            smallint    NOT NULL DEFAULT 0,
    max_attempts        smallint    NOT NULL DEFAULT 5,
    verified_at         timestamptz,            -- set once, on successful verification
    invalidated_at      timestamptz,            -- set when a resend replaces this OTP
    request_ip          inet,

    CONSTRAINT email_otps_purpose_chk
        CHECK (purpose IN ('registration')),
    CONSTRAINT email_otps_email_chk
        CHECK (email_normalized = lower(btrim(email_normalized))
               AND char_length(email_normalized) BETWEEN 3 AND 254),
    CONSTRAINT email_otps_code_hash_chk
        CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT email_otps_expiry_chk
        CHECK (expires_at > created_at),
    CONSTRAINT email_otps_cooldown_chk
        CHECK (resend_available_at >= created_at),
    CONSTRAINT email_otps_attempts_chk
        CHECK (max_attempts > 0 AND attempts >= 0)
);

-- At most one live (not verified, not invalidated) OTP per email and purpose.
-- A resend must invalidate the old row in the same transaction as the insert,
-- so concurrent resends cannot leave two usable codes.
CREATE UNIQUE INDEX email_otps_one_active_idx
    ON email_otps (email_normalized, purpose)
    WHERE verified_at IS NULL AND invalidated_at IS NULL;

-- Supports the hourly send caps (counted from rows) and the retention purge.
CREATE INDEX email_otps_email_created_idx
    ON email_otps (email_normalized, purpose, created_at DESC);
CREATE INDEX email_otps_ip_created_idx
    ON email_otps (request_ip, created_at DESC)
    WHERE request_ip IS NOT NULL;
CREATE INDEX email_otps_created_idx
    ON email_otps (created_at);

-- Short-lived, single-use proof that an email passed OTP verification.
-- Issued on successful verify; consumed by the future registration endpoint.
-- Only a keyed hash of the token is stored.
CREATE TABLE email_verification_tokens (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    otp_id           uuid        NOT NULL UNIQUE
                                 REFERENCES email_otps (id) ON DELETE CASCADE,
    email_normalized text        NOT NULL,
    purpose          text        NOT NULL,
    token_hash       text        NOT NULL UNIQUE,   -- hex HMAC-SHA256
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,          -- created_at + VERIFICATION_TOKEN_TTL_SECONDS
    consumed_at      timestamptz,                   -- set once; makes the token single-use

    CONSTRAINT email_verification_tokens_purpose_chk
        CHECK (purpose IN ('registration')),
    CONSTRAINT email_verification_tokens_email_chk
        CHECK (email_normalized = lower(btrim(email_normalized))
               AND char_length(email_normalized) BETWEEN 3 AND 254),
    CONSTRAINT email_verification_tokens_hash_chk
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT email_verification_tokens_expiry_chk
        CHECK (expires_at > created_at)
);

CREATE INDEX email_verification_tokens_email_idx
    ON email_verification_tokens (email_normalized, purpose);
