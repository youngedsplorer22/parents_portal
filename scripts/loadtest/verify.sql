-- Run after every scenario against the SAME test database:  psql "$PGURL" -f scripts/loadtest/verify.sql
-- Every "violations" value must be 0. Compare "registrations_total" with k6's registrations_created.
SELECT 'duplicate_emails'            AS check, count(*) AS violations FROM (SELECT email_normalized FROM parent_registrations GROUP BY 1 HAVING count(*) > 1) d
UNION ALL SELECT 'token_used_by_2_registrations', count(*) FROM (SELECT verification_token_id FROM parent_registrations GROUP BY 1 HAVING count(*) > 1) d
UNION ALL SELECT 'registration_without_credential', count(*) FROM parent_registrations r LEFT JOIN password_credentials c ON c.registration_id = r.id WHERE c.registration_id IS NULL
UNION ALL SELECT 'registration_without_session', count(*) FROM parent_registrations r WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.registration_id = r.id)
UNION ALL SELECT 'trip_registration_without_enrolment', count(*) FROM parent_registrations r WHERE r.trip_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trip_enrolments e WHERE e.registration_id = r.id)
UNION ALL SELECT 'consumed_token_without_registration', count(*) FROM email_verification_tokens t WHERE t.consumed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parent_registrations r WHERE r.verification_token_id = t.id)
UNION ALL SELECT 'idle_in_transaction_now', count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND application_name = 'parents-portal'
UNION ALL SELECT 'registrations_total (compare with k6)', count(*) FROM parent_registrations WHERE email_normalized LIKE 'lt-%@loadtest.example.org';
