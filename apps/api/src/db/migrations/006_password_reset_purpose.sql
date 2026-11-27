-- 006_password_reset_purpose.sql
-- Forgot Password (Phase 2). Applied by src/db/migrate.js in a single transaction.
-- Depends on 001 and 003.
--
-- Email OTPs and verification tokens may now also be issued for purpose
-- 'password_reset'. The constraints are replaced (as 003 did for 'login');
-- 001 and 003 are not edited. Every existing row already satisfies the wider
-- check, so no data is changed and 'registration' and 'login' behave exactly as before.
--
-- 'password_reset' is NOT reachable through the generic /api/email-otp routes
-- (their allow-list is unchanged). Only the dedicated /api/auth/password-reset
-- routes issue it, so the "does this account exist?" decision cannot be bypassed.

ALTER TABLE email_otps DROP CONSTRAINT email_otps_purpose_chk;
ALTER TABLE email_otps
    ADD CONSTRAINT email_otps_purpose_chk CHECK (purpose IN ('registration', 'login', 'password_reset'));

ALTER TABLE email_verification_tokens DROP CONSTRAINT email_verification_tokens_purpose_chk;
ALTER TABLE email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_purpose_chk CHECK (purpose IN ('registration', 'login', 'password_reset'));
