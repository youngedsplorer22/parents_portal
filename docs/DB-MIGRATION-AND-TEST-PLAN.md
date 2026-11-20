# Database role migration and test plan (PLAN ONLY)

Status: **plan for review. Nothing has been created, granted, migrated, deployed or connected.** All steps run first on a **disposable staging environment**; production is never touched by this plan without a separate approval.
> **SCOPE NOTICE (governs this plan): `docs/SCOPE-CHARTER-AND-DECISIONS.md`.** This plan applies **only if the backend split and database-role split are approved** (charter 4.2 and 8). **Withdrawn from this plan:** the `audit_append` migration and `TRUNCATE` trigger (decision Q4), the worker, the `requested_at` column and the Drive credential move (decision D9), and probes or fallbacks whose only purpose was external audit or event-trigger alerting. Existing behaviour is preserved throughout.

Applies the lead's decisions D1, D4, D5 and D8 (D2, D3 and D6 are withdrawn) (`docs/DB-PRIVILEGE-MANIFEST.md` 13). Read with `DB-PRIVILEGE-MANIFEST.md` (the manifest), `STAFF-ACCESS-MATRIX-PROPOSAL.md`, `SECURITY-REQUIREMENTS-M1-M15.md` (M1, M2, M7, M13).
Migration numbers below are **placeholders** for planning (`02x`); no file exists. Migration `019` is unapplied everywhere and its position is open question Q2.

## 1. Stages and approval gates

| Gate | Content | Stops until |
|---|---|---|
| **G0** | Capability probes on a disposable staging database (section 3) and the capability report | Lead reads the report and picks a fallback if any probe failed |
| **G1** | Read-only data checks on a **restored copy** of the data (section 4.2), not on production | Results reviewed |
| **G2** | Final manifest, migration scripts and tests written and **reviewed** (no execution) | Lead approves implementation |
| **G3** | Everything applied and tested on staging; load tests with the role pools; restore drill | Evidence accepted (M1, M7 acceptance tests) |
| **G4** | Production cutover plan with canary, separately approved | Lead approves, with a change window and break-glass owner named |

No step crosses a gate without the evidence for it.

## 2. Ordered change set (all on staging first)

| Step | Change | Kind | Rollback | Key tests |
|---|---|---|---|---|
| 0 | Capability probes (section 3) | read-only checks on disposable staging | destroy the staging instance | probe report |
| 1 | Create roles, revoke `PUBLIC` defaults, set role attributes | **Infrastructure script** run once by the platform superuser (a normal `pp_migrator` cannot create roles) | `DROP OWNED BY` / `DROP ROLE` in the documented order; old role untouched | catalog test (manifest 10.2) |
| 2 | Migration `02a`: definer functions: `resolve_public_trip_for_registration` (D1); re-create `trip_live_location_stop_on_trip_end` as `SECURITY DEFINER` (SA-02). **No `TRUNCATE` trigger.** | schema migration, **only if roles are split** | down script re-creates the INVOKER function and drops the new one | D1 tests C1 to C8, V1 to V8; P3 (trip close wipes location) |
| 3 | ~~Migration `02b`: `audit_append` and `audit_head`~~ **[withdrawn, decision Q4]**. The existing `audit_log` stays; the role grants in step 6 give `pp_staff` and `pp_ops` the existing INSERT and SELECT | n/a | n/a | existing audit tests |
| 4 | Migration `02c`: staff OTP tables and copy of live `staff_password` rows. **Decision-dependent** (charter 6 item 3: separate tables, or accept the exposure and skip this step) | schema migration, only if chosen | keep old rows until verified; down script drops the new tables | OTP and staff-password suites; F8 |
| 5 | Migration `02d`: composite foreign key for forms (D5, section 4) | schema migration | `DROP CONSTRAINT` (instant, no data change) | section 4.4 |
| 6 | Migration `02e`: **grants** generated from the manifest (including the definer owners' narrow grants and `EXECUTE` grants) | schema migration | down script `REVOKE`s exactly the same grants | manifest test, F1 to F17, P1 to P6 |
| 7 | **Compatibility release** of the application: calls `resolve_public_trip_for_registration`, optionally uses the staff OTP tables, reads per-service connection settings; **still connected with the old single role**. Includes the per-variant link host map (charter 6 item 1) if approved | application deploy | redeploy the previous release | full functional suites |
| 8 | Switch services to their roles one at a time, canary replica first (public, then staff) | configuration only | point the connection string back to the old role | role-scoped suites (manifest 10.3), canary window without unexplained `42501` |
| 9 | ~~(S4) worker, `requested_at`, Drive credential move~~ **[withdrawn, decision D9]** | n/a | n/a | n/a |
| 10 | Revoke the old general role, rotate its secret, retire the legacy combined service | grants, configuration | break-glass restore of the old role | exposure and boundary tests (M1, M3) |

**Note on transactions:** `migrate.js` applies each file in one transaction, so statements that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, some role operations) are separate manual steps with their own rollback.

## 3. Decision D4: verify Railway PostgreSQL capabilities first, with fallbacks

### 3.1 Capability probes (run on a **disposable staging** database only)

Create a throwaway Railway environment with its own PostgreSQL service of the same plan size as the intended production, run the probes below with the credentials Railway gives, record results in a **capability report**, then destroy it. Nothing is assumed from documentation.

| # | Probe | How | Needed for | If it fails |
|---|---|---|---|---|
| P1 | Server version and settings | `SELECT version(); SHOW server_version;` | all grants and syntax | adapt syntax |
| P2 | Admin privileges | `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user;` | everything | **F-A** |
| P3 | Create login and no-login roles; `CONNECTION LIMIT`; `ALTER ROLE ... SET` | `CREATE ROLE ...` | M1 | **F-A**, **F-G**, **F-H** |
| P4 | Column-level `GRANT`; `REVOKE ... FROM PUBLIC`; `ALTER DEFAULT PRIVILEGES` | scratch tables | manifest | **F-A** |
| P5 | Empirical lock rule: with `SELECT` only, `SELECT ... FOR SHARE` fails; with `UPDATE(updated_at)` it works | scratch table and role | D1 | confirms the design; if different, revise |
| P6 | Create a `SECURITY DEFINER` function owned by a no-login role and callable by another role only | `ALTER FUNCTION ... OWNER TO`, `GRANT EXECUTE` | D1, D3, SA-02 | **F-B** |
| P7 | Event triggers (informational only; **not needed** now that external audit is out of scope) | `CREATE EVENT TRIGGER ...` | none in this project | none |
| P8 | Extensions (informational; `pg_stat_statements` helps D8 measurement) | `SELECT name FROM pg_available_extensions WHERE name IN ('pg_stat_statements');` | measurement only | none |
| P9 | Logging parameters (informational; existing logging is preserved unchanged) | `SHOW log_statement;` | none | none |
| P10 | Revoke `EXECUTE` on `pg_catalog` functions from `PUBLIC` (`pg_advisory_lock`, `pg_sleep`) | `REVOKE EXECUTE ON FUNCTION ...` | advisory-lock hardening (optional) | **F-E** |
| P11 | Capacity: `SHOW max_connections; SHOW superuser_reserved_connections; SHOW reserved_connections;` plus the plan's CPU and memory from the Railway dashboard | measurement | D8 | recompute budget |
| P12 | Per-role timeouts: `ALTER ROLE ... SET statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` | scratch role | D8 | **F-G** |
| P13 | (withdrawn with the `TRUNCATE` trigger) | | | |
| P14 | TLS and network: `SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();`; private-network address | connection test | transport security | **F-I** |
| P15 | Backups: what Railway offers; `pg_dumpall --roles-only` allowed; a restore into a second instance includes roles and ACLs | restore drill (M7) | recovery | **F-J** |
| P16 | Rolling deploy behaviour: how many old and new replicas overlap, and the signal timing | deploy a scratch service twice | connection headroom (D8) | adjust surge |
| P17 | Row-level security available | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on scratch | optional O2 | optional |

### 3.2 Fallback designs (decided at G0, not assumed)

| ID | If this fails | Fallback | Cost and honesty note |
|---|---|---|---|
| **F-A** | Cannot create roles (no `CREATEROLE`/superuser) | (1) run PostgreSQL as a Railway service from a standard image where the project owns the superuser; (2) or an external managed PostgreSQL that allows roles; (3) or separate databases/instances per trust domain. **Do not** continue with one role and call M1 met | New operational duties (backups, patching) for (1); data-sync design for (3); **needs a lead decision** |
| **F-B** | Cannot make a no-login role own a function | Create the function while connected as the owner role (grant it a temporary `LOGIN`, then remove it); else grant membership for the `ALTER OWNER` step only | Operational detail |
| ~~**F-C**~~ | **[OUT OF SCOPE]** no event-trigger or DDL-alert fallback is needed (external audit infrastructure is out of scope) | | |
| ~~**F-D**~~ | **[OUT OF SCOPE]** no `pgaudit` or administrator-action logging (decision Q4) | | |
| **F-E** | Cannot revoke `pg_catalog` function execution | Accept; rely on `lock_timeout`, idle timeouts, `pg_locks` alerts | Low residual risk (SA-25) |
| **F-G** | Cannot set per-role parameters | Set them as connection startup parameters in the application's pool options (the pool already sends `statement_timeout` and `idle_in_transaction_session_timeout` this way; add `lock_timeout`) | Enforced by the client, so weaker against a compromised service |
| **F-H** | `CONNECTION LIMIT` unavailable or ignored | Enforce with pool sizes and monitor `pg_stat_activity` per role; alert on breach | Detective |
| **F-I** | No TLS or private network | Do not proceed to production; raise to the platform | Blocking |
| **F-J** | Restore does not carry roles or ACLs | Keep the role-creation script and grant script in the repository as the recovery path and run them after restore; the restore drill proves it | Longer recovery time |
| **F-K** | The definer pattern cannot be made to work with narrow grants (P6 fails after F-B) | **Stop and report.** The lead's decision D1 forbids removing the lock or granting broad UPDATE; any alternative (for example option A or C from the earlier review) needs a new decision | No silent substitution |

## 4. Decision D5: composite foreign key `onboarding_forms (enrolment_id, registration_id)`

**Purpose (SA-22):** make the database enforce that a form's enrolment belongs to the form's registration. Today only the application does.

### 4.1 Design
1. `ALTER TABLE trip_enrolments ADD CONSTRAINT trip_enrolments_id_registration_key UNIQUE (id, registration_id)`. `id` is already unique, so this cannot fail on data. It builds an index; on a large table use `CREATE UNIQUE INDEX CONCURRENTLY` first (outside a transaction) then `ADD CONSTRAINT ... USING INDEX`.
2. `ALTER TABLE onboarding_forms ADD CONSTRAINT onboarding_forms_enrolment_owner_fk FOREIGN KEY (enrolment_id, registration_id) REFERENCES trip_enrolments (id, registration_id) ON DELETE RESTRICT NOT VALID;`
3. `ALTER TABLE onboarding_forms VALIDATE CONSTRAINT onboarding_forms_enrolment_owner_fk;` (a scan that does not block normal writes).
4. Default `MATCH SIMPLE`: **legacy forms with `enrolment_id IS NULL` are exempt**, which is the intended meaning of "legacy". The existing single-column foreign key stays until the new one is validated and proven, then may be dropped in a later migration.

### 4.2 Existing-data checks (read-only; run on a **restored copy**, never on production without approval)
```sql
-- expect 0 rows: forms whose enrolment belongs to a different registration
SELECT f.id, f.registration_id, e.registration_id AS enrolment_owner
  FROM onboarding_forms f JOIN trip_enrolments e ON e.id = f.enrolment_id
 WHERE e.registration_id <> f.registration_id;
-- expect 0: forms pointing at a missing enrolment (the existing FK should already prevent it)
SELECT count(*) FROM onboarding_forms f LEFT JOIN trip_enrolments e ON e.id = f.enrolment_id
 WHERE f.enrolment_id IS NOT NULL AND e.id IS NULL;
-- sizes, to choose the lock strategy
SELECT (SELECT count(*) FROM onboarding_forms) AS forms, (SELECT count(*) FROM trip_enrolments) AS enrolments;
```
If the first query returns rows, **stop**: those rows are either bugs or the attack in SA-22; investigate and repair before validation. The constraint can still be added `NOT VALID` (it then protects new rows) while the old rows are fixed.

### 4.3 Migration safety and rollback
- Locks: `ADD CONSTRAINT ... NOT VALID` takes a brief `SHARE ROW EXCLUSIVE` lock on both tables; `VALIDATE` takes `SHARE UPDATE EXCLUSIVE`. Measure on the staging copy; apply in a quiet window.
- **Rollback is instant and data-neutral:** `ALTER TABLE onboarding_forms DROP CONSTRAINT onboarding_forms_enrolment_owner_fk;` then `ALTER TABLE trip_enrolments DROP CONSTRAINT trip_enrolments_id_registration_key;`. The migration changes no rows.
- If `VALIDATE` fails, the constraint stays `NOT VALID` (new rows enforced), the failure is reported, and the data is repaired before a retry.
- Interplay with `019` (unapplied): `019` adds a different composite key `(enrolment_id, trip_id)` and a trigger; the two coexist. Run the tests with and without `019` (Q2).

### 4.4 Tests
- Seeded database with one deliberately mismatched form: the pre-check finds it; `VALIDATE` fails; after repair it succeeds; applying and rolling back twice is clean.
- **SA-22 reproduction now fails:** inserting a form with another registration's `enrolment_id` returns `23503`.
- Regression suites under the old and the new role setup: `trip-registration`, `registrations-api`, `onboarding-api`, `onboarding-review-mismatch`, `resume`, `enrolments-api`, `form-validation-api`, `pdf-dashboard-api`; plus a legacy-form case (`enrolment_id` NULL) and a parent with several enrolments.
- Concurrency: form saves and registrations during the `NOT VALID` step wait briefly and then succeed; no deadlock.
- `catalog:cleanup` and any deletion path still work (the foreign key is `RESTRICT` like the existing one).

## 5. Decision D8: derive connection limits and timeouts from measured capacity

**No fixed limit is proposed here.** Today's code defaults (`DB_POOL_MAX` 10, connect timeout 5 s, statement timeout 15 s, idle-in-transaction timeout 30 s) are the **current** values, not recommendations.

### 5.1 Inputs to measure (staging, same plan size as production)
| Input | Source |
|---|---|
| `M` = `max_connections`; `R_s` = `superuser_reserved_connections`; `R_r` = `reserved_connections` (PostgreSQL 16 and later) | probe P11 |
| Instance CPU and memory | Railway plan |
| Planned replica counts `n_pub`, `n_staff` | `CONCURRENCY.md` sizing and the load tests |
| Rolling-deploy overlap `surge` (extra replicas alive during a deploy) | probe P16 |
| Per-request connection hold time and statement latency by type | the load-test probe (`queries.ms`, `pool.connectWaitMs`) and a transaction-duration capture |
| Burst overshoot: peak connections during the burst test divided by steady | the burst scenario |
| Break-glass and operational connections: superuser session, `pp_migrator`, monitoring, backup (`pg_dump`), audit verifier, one health-probe connection per service | the operations plan |

### 5.2 Formulas
- **Usable connections** `U = M - R_s - R_r - (break-glass) - (migrator) - (monitoring) - (backup jobs) - (audit verifier) - (health connections)`.
- **Safety margin** `g`: an explicit parameter **for the lead**, not a constant here; the minimum is the measured burst overshoot so a spike does not starve break-glass access.
- **Pool size per replica** `p = ceil( lambda_db x h / u )`, where `lambda_db` is the measured database-bound request rate per replica at the target load, `h` the measured mean connection hold time per request, and `u` the target pool utilisation (a parameter, chosen so measured pool wait p95 meets the agreed criterion in `CONCURRENCY.md` P9). Check `p` is at least the number of operations that must hold a connection at the same time (for example a registration transaction plus the throttle and session lookups of other requests).
- **Role `CONNECTION LIMIT`** `= (n_replicas + surge) x p` for each runtime role, so a rolling deploy cannot lock a new replica out.
- **Budget check:** `sum over roles of CONNECTION LIMIT <= U x (1 - g)`. If it fails: reduce `p` using the measured hold times (for example after hashing moves out of the registration transaction), reduce replicas, add PgBouncer (decision O7), or move to a larger database. Do not exceed the budget by raising `max_connections` without measuring memory per connection.
- **`statement_timeout`** per role `= k_s x (measured p99.9 statement latency under peak load)`, never above the request deadline and never below the longest legitimate statement of that role; `k_s` is a parameter with the measured justification recorded.
- **`idle_in_transaction_session_timeout`** per role: greater than the longest measured in-transaction application time (today the registration transaction includes the hash wait, which is why moving hashing out matters), and as small as that allows.
- **`lock_timeout`** per role: at least the measured p99 lock wait in the D1 concurrency tests (C1 to C8) and in normal staff operations, and below `statement_timeout`.
- **Client connect timeout:** at least the measured p99 pool wait.
- (No worker in this project, so no worker pool is sized.)

### 5.3 Output and verification
A **connection budget sheet** (one table: each input with its measured value and source, each formula result, the chosen limits) is part of the G2 package. After deployment: run the combined load test and the burst test with the role pools; `pg_stat_activity` per role must stay within its limit; **exceeding a role's limit must fail fast** (`too many connections for role`) and the service must answer 503 with `Retry-After`, never hang; the break-glass and migrator connections must still succeed during the burst.

## 6. Test plan summary and gates

| Layer | Tests | Gate |
|---|---|---|
| Capability | Probes P1 to P17 and the report | G0 |
| Static | Manifest equality test on the migrated staging database (manifest 10.2); definer-function definition checks (V6) | G3 |
| Privilege | F1 to F17 forbidden, P1 to P6 permitted, compromise simulation (manifest 10.4, 10.5) | G3 |
| D1 | C1 to C8 concurrency, V1 to V8 behaviour and security | G3 |
| ~~D3~~ | withdrawn (Q4): existing audit tests run unchanged under the roles | G3 |
| D5 | Section 4.4 | G1, G3 |
| ~~D6~~ | withdrawn (D9): existing PDF tests run unchanged under `pp_public` | G3 |
| Integration | Existing suites run under `pp_public`, `pp_staff`, `pp_ops` (manifest 10.3), with the harness changes | G3 |
| Capacity | Role-pooled `combined` and `burst` load runs; connection checks (5.3) | G3 |
| Recovery | Restore drill with roles and ACLs, manifest test after restore (M7) | G3 |
| Rollback | Each migration's down script applied and reapplied; service switch-back | G3 |

## 7. Rollback and recovery summary
- Every migration has a down script written and **tested** before it is approved; application releases remain compatible with both the old and the new role setup until step 10.
- Service switches are configuration only. Keep the old role enabled until step 10 has been stable for an agreed window.
- (Only if the split is approved.) A break-glass superuser credential is held offline by a named owner; every use is logged off-platform.
- Backups include roles and ACLs (SA-26); the restore drill is a gate.
- If a step fails its tests: stop, roll that step back, report; do not skip ahead.

## 8. Findings from this plan

| ID | Severity | Finding | Evidence | Remediation |
|---|---|---|---|---|
| SA-31 | Medium | `migrate.js` runs each migration file inside one transaction, so non-transactional operations (`CREATE INDEX CONCURRENTLY`, some role changes) cannot be part of the normal migration path | `db/migrate.js` | Separate, documented manual steps with their own rollback (section 2 note) |
| SA-32 | Low | Role creation cannot be done by the migration role; it needs a privileged one-time step whose credential must not live in any service | design | Infrastructure script run by the platform admin; credential kept offline |
| SA-33 | Medium | Railway capabilities (roles, definer ownership, event triggers, `pgaudit`, restore with roles) are **unverified** | none yet | Probes P1 to P17 and the fallbacks in 3.2 before any implementation |
