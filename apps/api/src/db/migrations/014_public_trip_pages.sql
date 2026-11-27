-- 014_public_trip_pages.sql
-- Registration pages become PUBLIC, one per trip, at /join/<school>/<branch>/<trip> (decided by the project lead).
-- Applied by src/db/migrate.js in a single transaction. Depends on 008, 011 and 013.
--
-- What this adds (no existing value is changed or deleted):
--  * schools.slug + schools.branch_slug, trips.slug: the readable, URL-safe words. They are set ONCE (here for existing
--    rows, by the application for new ones) and never change on a rename, and rows are never deleted, so an address can
--    never be moved to another school or trip. Duplicates get "-2", "-3", ... (pair (slug, branch_slug) is unique;
--    a trip slug is unique within its school). A school with no branch uses the branch word "main".
--  * trips.public_registration: staff-controlled, DEFAULT false. A trip's public page accepts registrations only when
--    this is on AND the trip is active and inside its registration dates AND the school is active. Separate from
--    payment mode and status. Existing trips start OFF: staff turn it on per trip.
--  * trip_links: the old secret-token links are RETIRED. The table and every row stay (they are referenced by existing
--    registrations and enrolments, and they are the history of who issued which link). retired_at records the
--    retirement; token_hash may now be NULL because the new public pages never create one. Existing hashes are NOT
--    erased here: that is a separate, explicitly approved step (backend/scripts/erase-retired-link-hashes.sql).

CREATE FUNCTION pg_temp.portal_slug(t text, fallback text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    nullif(trim(both '-' from left(trim(both '-' from regexp_replace(regexp_replace(lower(coalesce(t, '')), '[''’]', '', 'g'), '[^a-z0-9]+', '-', 'g')), 60)), ''),
    fallback)
$$;

ALTER TABLE schools ADD COLUMN slug text, ADD COLUMN branch_slug text;
WITH base AS (
    SELECT id, created_at,
           pg_temp.portal_slug(name, 'school') AS s,
           CASE WHEN branch IS NULL THEN 'main' ELSE pg_temp.portal_slug(branch, 'branch') END AS b
      FROM schools
), ranked AS (
    SELECT id, s, b, row_number() OVER (PARTITION BY s, b ORDER BY created_at, id) AS n FROM base
)
UPDATE schools x
   SET slug = CASE WHEN r.n = 1 THEN r.s ELSE r.s || '-' || r.n END,
       branch_slug = r.b
  FROM ranked r WHERE x.id = r.id;
ALTER TABLE schools
    ALTER COLUMN slug SET NOT NULL,
    ALTER COLUMN branch_slug SET NOT NULL,
    ADD CONSTRAINT schools_slug_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 70),
    ADD CONSTRAINT schools_branch_slug_chk CHECK (branch_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(branch_slug) <= 70),
    ADD CONSTRAINT schools_slug_key UNIQUE (slug, branch_slug);

ALTER TABLE trips ADD COLUMN slug text, ADD COLUMN public_registration boolean NOT NULL DEFAULT false;
WITH base AS (
    SELECT id, school_id, created_at, pg_temp.portal_slug(title, 'trip') AS s FROM trips
), ranked AS (
    SELECT id, s, row_number() OVER (PARTITION BY school_id, s ORDER BY created_at, id) AS n FROM base
)
UPDATE trips x SET slug = CASE WHEN r.n = 1 THEN r.s ELSE r.s || '-' || r.n END FROM ranked r WHERE x.id = r.id;
ALTER TABLE trips
    ALTER COLUMN slug SET NOT NULL,
    ADD CONSTRAINT trips_slug_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 70),
    ADD CONSTRAINT trips_slug_key UNIQUE (school_id, slug);

ALTER TABLE trip_links ADD COLUMN retired_at timestamptz;
UPDATE trip_links SET retired_at = clock_timestamp() WHERE retired_at IS NULL;
ALTER TABLE trip_links ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE trip_links DROP CONSTRAINT trip_links_token_hash_chk;
ALTER TABLE trip_links ADD CONSTRAINT trip_links_token_hash_chk CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$');
COMMENT ON TABLE trip_links IS 'Retired secret-token parent links (history only). Registration now uses public trip pages (trips.public_registration).';
