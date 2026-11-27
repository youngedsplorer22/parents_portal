-- Rollback for migration 022: drop trip_documents
-- Drive files referenced by this table are NOT deleted by this rollback.

DROP TABLE trip_documents;
