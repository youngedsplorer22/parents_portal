-- OPTIONAL, ONE-WAY, NEEDS EXPLICIT APPROVAL. Not a migration: it is never applied automatically.
--
-- After migration 014 the old secret-token links are retired: nothing reads trip_links.token_hash any more, and the
-- public trip pages never create a hash. This removes the remaining hashes of the retired links, as the project lead
-- asked, while keeping every row (trip, hint, label, who created / revoked it, dates) for history and for the existing
-- registrations and enrolments that reference it.
--
-- Take and verify a backup first. Run against the intended database only, for example:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/erase-retired-link-hashes.sql
BEGIN;
UPDATE trip_links SET token_hash = NULL WHERE retired_at IS NOT NULL AND token_hash IS NOT NULL;
COMMIT;
