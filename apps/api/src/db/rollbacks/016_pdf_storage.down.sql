-- Rollback for 016_pdf_storage.sql. NOT run automatically (migrate.js only goes forward): run it by hand, with a backup.
-- It removes only the two tables 016 created and forgets that 016 was applied. No registration, form, account or any other
-- existing data is touched. PDFs already stored in Google Drive stay there.
DROP TABLE IF EXISTS registration_pdfs;
DROP TABLE IF EXISTS drive_folders;
DELETE FROM schema_migrations WHERE name = '016_pdf_storage.sql';
