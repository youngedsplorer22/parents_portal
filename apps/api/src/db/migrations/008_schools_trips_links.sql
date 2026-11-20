-- 008_schools_trips_links.sql
-- Schools, trips and the secure parent access links (Phase 3). Depends on 007.
-- Adds tables only; parent registrations and onboarding forms are NOT touched
-- (trip-scoped forms belong to a later phase).
--
-- Payment mode is configuration only: nothing here collects or processes payments.

CREATE TABLE schools (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text        NOT NULL,
    name_normalized text        NOT NULL,   -- lower-cased, whitespace-collapsed copy used for uniqueness
    status          text        NOT NULL DEFAULT 'active',
    created_by      uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz,

    CONSTRAINT schools_name_key UNIQUE (name_normalized),
    CONSTRAINT schools_name_chk
        CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 150 AND name !~ '[[:cntrl:]]'),
    CONSTRAINT schools_name_normalized_chk
        CHECK (name_normalized = lower(btrim(name_normalized)) AND char_length(name_normalized) BETWEEN 1 AND 150),
    CONSTRAINT schools_status_chk CHECK (status IN ('active', 'archived')),
    CONSTRAINT schools_archived_chk CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE TABLE trips (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id    uuid        NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
    title        text        NOT NULL,
    tour_type    text        NOT NULL,
    destination  text,
    payment_mode text        NOT NULL,
    status       text        NOT NULL DEFAULT 'draft',
    opens_at     timestamptz,
    closes_at    timestamptz,
    -- The form template is DERIVED here, never supplied by a client:
    -- domestic_none, domestic_payment, international_none, international_payment.
    template_key text        GENERATED ALWAYS AS (tour_type || '_' || payment_mode) STORED,
    created_by   uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT trips_title_chk
        CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 150 AND title !~ '[[:cntrl:]]'),
    CONSTRAINT trips_tour_type_chk CHECK (tour_type IN ('domestic', 'international')),
    CONSTRAINT trips_destination_chk
        CHECK (destination IS NULL
               OR (destination = btrim(destination) AND char_length(destination) BETWEEN 1 AND 100
                   AND destination !~ '[[:cntrl:]]')),
    CONSTRAINT trips_payment_mode_chk CHECK (payment_mode IN ('none', 'payment')),
    CONSTRAINT trips_status_chk CHECK (status IN ('draft', 'active', 'closed', 'archived')),
    CONSTRAINT trips_window_chk CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX trips_school_idx ON trips (school_id, created_at DESC);

-- A dedicated parent link. Only a keyed hash of the token is stored; the raw
-- token (256 random bits) exists only in the URL shown once to staff.
CREATE TABLE trip_links (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    token_hash  text        NOT NULL,
    token_hint  text        NOT NULL,   -- last 4 characters, so staff can tell links apart
    label       text,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    revoked_by  uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    created_by  uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT trip_links_token_key UNIQUE (token_hash),
    CONSTRAINT trip_links_token_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT trip_links_hint_chk CHECK (token_hint ~ '^[A-Za-z0-9_-]{4}$'),
    CONSTRAINT trip_links_label_chk
        CHECK (label IS NULL OR (label = btrim(label) AND char_length(label) BETWEEN 1 AND 100 AND label !~ '[[:cntrl:]]')),
    CONSTRAINT trip_links_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX trip_links_trip_idx ON trip_links (trip_id, created_at DESC);

-- One row per public link lookup, for the per-IP rate limit.
CREATE TABLE trip_link_lookups (
    id         bigserial   PRIMARY KEY,
    request_ip inet        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX trip_link_lookups_ip_idx ON trip_link_lookups (request_ip, created_at DESC);
CREATE INDEX trip_link_lookups_created_idx ON trip_link_lookups (created_at);
