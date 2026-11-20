-- 002_parent_registrations.sql
-- Parent registrations created after email OTP verification.
-- Applied by src/db/migrate.js in a single transaction. Depends on
-- 001_email_otp.sql (email_verification_tokens).
--
-- School and role are validated against allow-lists in the application
-- (src/modules/registrations/validation.js), not here, so adding a school or a
-- role does not need a migration. The raw verification token is never stored;
-- only the id of its (hash-only) row is referenced.

CREATE TABLE parent_registrations (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name            text        NOT NULL,
    last_name             text        NOT NULL,
    school                text        NOT NULL,
    role                  text        NOT NULL,
    phone                 text        NOT NULL,
    email_normalized      text        NOT NULL,
    email_verified_at     timestamptz NOT NULL,   -- when the OTP for this email was verified
    verification_token_id uuid,                   -- the single-use token that authorised this row
    request_ip            inet,
    created_at            timestamptz NOT NULL DEFAULT now(),

    -- One registration per email, and one registration per verification token.
    CONSTRAINT parent_registrations_email_key UNIQUE (email_normalized),
    CONSTRAINT parent_registrations_token_key UNIQUE (verification_token_id),

    -- Tokens are purged with their OTP after 24h; the registration stays.
    CONSTRAINT parent_registrations_token_fk
        FOREIGN KEY (verification_token_id)
        REFERENCES email_verification_tokens (id) ON DELETE SET NULL,

    CONSTRAINT parent_registrations_first_name_chk
        CHECK (first_name = btrim(first_name)
               AND char_length(first_name) BETWEEN 1 AND 100
               AND first_name !~ '[[:cntrl:]]'),
    CONSTRAINT parent_registrations_last_name_chk
        CHECK (last_name = btrim(last_name)
               AND char_length(last_name) BETWEEN 1 AND 100
               AND last_name !~ '[[:cntrl:]]'),
    CONSTRAINT parent_registrations_school_chk
        CHECK (school = btrim(school) AND char_length(school) BETWEEN 1 AND 100),
    CONSTRAINT parent_registrations_role_chk
        CHECK (role = btrim(role) AND char_length(role) BETWEEN 1 AND 50),
    CONSTRAINT parent_registrations_phone_chk
        CHECK (phone ~ '^\+?[0-9\s()-]{8,15}$'),
    CONSTRAINT parent_registrations_email_chk
        CHECK (email_normalized = lower(btrim(email_normalized))
               AND char_length(email_normalized) BETWEEN 3 AND 254
               AND email_normalized ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);
