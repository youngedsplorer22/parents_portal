-- 007_staff_auth.sql
-- Staff identities and sessions for the internal admin/sales panel (Phase 3).
-- Applied by src/db/migrate.js in a single transaction. Adds tables only; no
-- existing table, column or row is touched.
--
-- Staff are completely separate from parents: their own table, their own
-- sessions (different cookie, different path, different token hash domain), so a
-- parent session can never act as staff and a staff session can never act as a
-- parent. There is no public sign-up: rows are created only by the local
-- provisioning script (backend/scripts/staff.js).

CREATE TABLE staff_users (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_normalized text        NOT NULL,
    display_name     text        NOT NULL,
    role             text        NOT NULL,
    password_hash    text        NOT NULL,   -- "scrypt$N$r$p$salt$hash", never the password
    disabled_at      timestamptz,            -- set = cannot sign in, sessions stop working
    created_at       timestamptz NOT NULL DEFAULT now(),
    changed_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_users_email_key UNIQUE (email_normalized),
    CONSTRAINT staff_users_email_chk
        CHECK (email_normalized = lower(btrim(email_normalized))
               AND char_length(email_normalized) BETWEEN 3 AND 254
               AND email_normalized ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
    CONSTRAINT staff_users_name_chk
        CHECK (display_name = btrim(display_name)
               AND char_length(display_name) BETWEEN 1 AND 100
               AND display_name !~ '[[:cntrl:]]'),
    CONSTRAINT staff_users_role_chk CHECK (role IN ('admin', 'sales')),
    CONSTRAINT staff_users_hash_chk
        CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);

CREATE TABLE staff_sessions (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    uuid        NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
    token_hash  text        NOT NULL,   -- hex HMAC-SHA256 of the session token (own hash domain)
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,   -- absolute lifetime (STAFF_SESSION_TTL_SECONDS)
    revoked_at  timestamptz,

    CONSTRAINT staff_sessions_token_key UNIQUE (token_hash),
    CONSTRAINT staff_sessions_token_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT staff_sessions_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX staff_sessions_staff_idx ON staff_sessions (staff_id);
CREATE INDEX staff_sessions_expires_idx ON staff_sessions (expires_at);

-- Same idea as password_login_attempts (005): one row per sign-in attempt,
-- written before the password is checked; success clears the email's rows.
CREATE TABLE staff_login_attempts (
    id               bigserial   PRIMARY KEY,
    email_normalized text        NOT NULL,
    request_ip       inet,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT staff_login_attempts_email_chk CHECK (char_length(email_normalized) BETWEEN 3 AND 254)
);
CREATE INDEX staff_login_attempts_email_idx ON staff_login_attempts (email_normalized, created_at DESC);
CREATE INDEX staff_login_attempts_ip_idx ON staff_login_attempts (request_ip, created_at DESC) WHERE request_ip IS NOT NULL;
CREATE INDEX staff_login_attempts_created_idx ON staff_login_attempts (created_at);
