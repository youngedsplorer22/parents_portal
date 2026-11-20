-- 016_pdf_storage.sql
-- Where each submitted registration's PDF is stored (a private Google Drive), and its storage status.
-- Applied by src/db/migrate.js in a single transaction. Depends on 004 and 015.
--
-- ADDITIVE ONLY: two new tables. No existing table, column, row or constraint is touched, so every registration,
-- account, trip, school, session, audit entry and submitted form stays exactly as it is. A submitted form that
-- existed before this migration simply has no row yet; one is created the first time it is needed (a parent opens
-- the PDF, or the background retry picks it up). Rollback: src/db/rollbacks/016_pdf_storage.down.sql (it drops these
-- two tables; the PDFs already in Google Drive stay there).
--
--  * registration_pdfs: one row per submitted form. The PDF itself is NOT kept in PostgreSQL (the generator can always
--    rebuild it from the saved record, and the stored copy lives in Drive): only the Drive file id, which Google
--    account it is in, its size and SHA-256 (to notice if the file is ever replaced), and the upload state.
--      status        'pending' (not stored yet, or being stored), 'stored', or 'failed' (the last attempt failed).
--      last_error_code  a short fixed code such as QUOTA_FULL: never a message, a response body or a secret.
--      claimed_at    set while an upload is in progress, so two workers never upload the same PDF twice.
--      next_retry_at when the background retry may try again (backs off after each failure).
--  * drive_folders: Drive folder ids already created for a destination account (School / Trip folders), so the same
--    folder is reused instead of a new one being made for every PDF. The destination account is part of the key, so
--    pointing the portal at a different Google account never reuses another account's folder ids.

CREATE TABLE registration_pdfs (
    form_id         uuid        PRIMARY KEY REFERENCES onboarding_forms (id) ON DELETE CASCADE,
    status          text        NOT NULL DEFAULT 'pending',
    destination     text,
    drive_file_id   text,
    file_name       text,
    size_bytes      integer,
    sha256          text,
    attempts        integer     NOT NULL DEFAULT 0,
    last_attempt_at timestamptz,
    last_error_code text,
    next_retry_at   timestamptz,
    claimed_at      timestamptz,
    stored_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT registration_pdfs_status_chk CHECK (status IN ('pending', 'stored', 'failed')),
    -- 'stored' carries the whole record of where the file is; no other state carries any of it.
    CONSTRAINT registration_pdfs_stored_chk CHECK (
        (status = 'stored' AND drive_file_id IS NOT NULL AND destination IS NOT NULL AND sha256 IS NOT NULL AND stored_at IS NOT NULL)
        OR (status <> 'stored' AND drive_file_id IS NULL AND sha256 IS NULL AND stored_at IS NULL)
    ),
    CONSTRAINT registration_pdfs_file_id_chk CHECK (drive_file_id IS NULL OR drive_file_id ~ '^[A-Za-z0-9_-]{5,200}$'),
    CONSTRAINT registration_pdfs_sha256_chk CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT registration_pdfs_error_chk CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z_]{2,29}$'),
    CONSTRAINT registration_pdfs_attempts_chk CHECK (attempts >= 0),
    CONSTRAINT registration_pdfs_size_chk CHECK (size_bytes IS NULL OR size_bytes >= 0)
);
-- One Drive file belongs to one registration.
CREATE UNIQUE INDEX registration_pdfs_drive_file_uk ON registration_pdfs (drive_file_id) WHERE drive_file_id IS NOT NULL;
-- The background retry looks only at what still needs storing.
CREATE INDEX registration_pdfs_retry_idx ON registration_pdfs (next_retry_at) WHERE status <> 'stored';

CREATE TABLE drive_folders (
    destination     text        NOT NULL,
    folder_key      text        NOT NULL,
    drive_folder_id text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (destination, folder_key),
    CONSTRAINT drive_folders_id_chk CHECK (drive_folder_id ~ '^[A-Za-z0-9_-]{1,200}$'),
    CONSTRAINT drive_folders_key_chk CHECK (char_length(folder_key) BETWEEN 1 AND 120)
);

COMMENT ON TABLE registration_pdfs IS 'Storage state of each submitted registration''s PDF (the file lives in a private Google Drive, not here).';
COMMENT ON TABLE drive_folders IS 'Google Drive folders the portal created, per destination account.';
