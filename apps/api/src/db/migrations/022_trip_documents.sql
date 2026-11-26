-- 022_trip_documents.sql
-- Trip documents (itinerary PDF, insurance, transport): one or more files per trip, stored in Google Drive.
-- ADDITIVE ONLY: one new table. No existing table, column, row or constraint is touched.
--
-- document_type IN ('itinerary', 'insurance', 'transport').
-- itinerary and insurance: at most one active file per trip (enforced by partial unique index).
-- transport: multiple files per trip are allowed.
-- The file bytes live in Google Drive; this table stores the Drive file id, account, size and checksum only.
-- Rollback: src/db/rollbacks/022_trip_documents.down.sql (drops this table; Drive files stay there).

CREATE TABLE trip_documents (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id         uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    document_type   text        NOT NULL,
    display_name    text        NOT NULL,
    mime_type       text        NOT NULL,
    size_bytes      integer     NOT NULL,
    drive_file_id   text        NOT NULL,
    drive_account   text        NOT NULL,
    sha256          text        NOT NULL,
    uploaded_by     uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    uploaded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT trip_documents_type_chk     CHECK (document_type IN ('itinerary', 'insurance', 'transport')),
    CONSTRAINT trip_documents_name_chk     CHECK (char_length(display_name) BETWEEN 1 AND 200),
    CONSTRAINT trip_documents_size_chk     CHECK (size_bytes > 0),
    CONSTRAINT trip_documents_drive_id_chk CHECK (drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
    CONSTRAINT trip_documents_sha256_chk   CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

-- itinerary and insurance: exactly one active document per trip
CREATE UNIQUE INDEX trip_documents_itinerary_one ON trip_documents (trip_id) WHERE document_type = 'itinerary';
CREATE UNIQUE INDEX trip_documents_insurance_one ON trip_documents (trip_id) WHERE document_type = 'insurance';

-- listing and filtering
CREATE INDEX trip_documents_trip_idx ON trip_documents (trip_id, document_type, uploaded_at DESC);

-- one Drive file per row (each upload produces a distinct file)
CREATE UNIQUE INDEX trip_documents_drive_file_uk ON trip_documents (drive_file_id);

COMMENT ON TABLE trip_documents IS 'Trip-level documents uploaded by Sales (itinerary, insurance, transport). File bytes live in Google Drive.';
