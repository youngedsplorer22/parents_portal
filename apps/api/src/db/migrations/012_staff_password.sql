-- 012_staff_password.sql
-- Staff accounts can exist before they have a password, and set it themselves by email code.
-- Applied by src/db/migrate.js in a single transaction. Depends on 001, 003, 006 and 007.
--
-- ADDITIVE ONLY. No row is changed: every existing staff account keeps its password hash and stays
-- active. Migrations 001-011 are not edited.
--
--  * staff_users.password_hash may now be NULL. NULL means "pending setup": the row was added by an
--    authorised person (the admin panel, the provisioning script, or SQL by IT) and its owner has not
--    chosen a password yet. A pending account cannot sign in. Any hash that IS stored must still be a
--    valid scrypt hash (the check is widened to allow NULL, not loosened otherwise).
--  * Email codes and verification tokens may be issued for the purpose 'staff_password' (first-time
--    setup AND forgot-password). It is separate from the parents' 'password_reset' on purpose: a
--    verification is bound to (email, purpose), so a parent's code can never set a staff password even if
--    a person has both. It is NOT reachable through the generic /api/email-otp routes (their allow-list
--    is unchanged); only the dedicated /api/admin/auth/password routes issue it.

ALTER TABLE staff_users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE staff_users DROP CONSTRAINT staff_users_hash_chk;
ALTER TABLE staff_users
    ADD CONSTRAINT staff_users_hash_chk
        CHECK (password_hash IS NULL
               OR password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$');

ALTER TABLE email_otps DROP CONSTRAINT email_otps_purpose_chk;
ALTER TABLE email_otps
    ADD CONSTRAINT email_otps_purpose_chk
        CHECK (purpose IN ('registration', 'login', 'password_reset', 'staff_password'));

ALTER TABLE email_verification_tokens DROP CONSTRAINT email_verification_tokens_purpose_chk;
ALTER TABLE email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_purpose_chk
        CHECK (purpose IN ('registration', 'login', 'password_reset', 'staff_password'));
