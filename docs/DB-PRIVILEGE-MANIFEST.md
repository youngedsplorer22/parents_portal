# PostgreSQL role and privilege manifest (PLAN ONLY)

Status: **design, re-scoped by `SCOPE-CHARTER-AND-DECISIONS.md` (section 13 shows what stands); awaiting approval to implement.** No role has been created, no GRANT or REVOKE executed, no migration written or changed, no database touched.** SQL snippets below are **drafts for review**, not scripts to run.
> **SCOPE NOTICE (governs this document): `docs/SCOPE-CHARTER-AND-DECISIONS.md`.** This manifest applies **only if the backend split and database-role split (Option C) are approved**. The following are **withdrawn or out of scope**: the worker and `pp_worker`, the PDF-retry redesign, `audit_append` and every external audit mechanism, and all SA-30 field protections. Existing behaviour (registration, OTP, sessions, PDF generation, Google Drive storage and parent downloads, email, Sales/Admin rules, mobile API, existing audit and logging) is preserved. Sections that describe withdrawn items are kept only as a record and are marked **[OUT OF SCOPE]**.

Parent documents: `docs/SECURITY-ARCHITECTURE.md` (sections 4, 10, 11), `docs/ARCHITECTURE-OPTIONS.md` (Option C). Companion plans: `docs/DB-MIGRATION-AND-TEST-PLAN.md` (migration order, staging capability checks, connection sizing, rollback), `docs/STAFF-ACCESS-MATRIX-PROPOSAL.md`, `docs/DEPENDENCY-UPDATE-PLAN.md`, `docs/MOBILE-DEPENDENCY-REVIEW-PLAN.md`, `docs/SECURITY-REQUIREMENTS-M1-M15.md`.

## 0. How this was derived, and its limits

- **Inputs:** migrations 001 to 019 (019 is unapplied everywhere), every SQL string literal in `apps/api/src` and `apps/api/scripts` (166 statements found by a pattern scan), plus a read of the modules that run them.
- **Limits:** the scan finds literal SQL. It can miss statements assembled from variables or constants (for example `TRIP_SELECT`, `PUBLIC_SELECT`, `LIVE_COLUMNS`) and cannot prove column lists that were truncated in the scan. **The manifest is therefore a hypothesis until a runtime capture confirms it** (section 10.1): run the whole test suite with the driver-level statement recorder (the same idea as `scripts/loadtest/inflight-preload.mjs`), group distinct normalised statements by service, and diff against this document. Any statement not listed is a defect in this manifest.
- **Target state:** the Option C layout (public API, staff API, operator tools) **if approved**; there is no worker. Where today's code must change first, the row says **[needs code change]**; those changes are listed in section 9. Nothing in this plan changes behaviour.
- **PostgreSQL version and hosting are unverified.** Railway's major version, whether custom roles, `ALTER DEFAULT PRIVILEGES`, event triggers and `REVOKE ... ON pg_catalog` functions are permitted, and `max_connections`, must be confirmed on the **staging** database before any step.

## 1. Roles

All runtime roles: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, `INHERIT` off where memberships exist, **no role memberships between them**, no `SET ROLE` path, own password (or certificate) held only by the service that uses it.

| Role | Login | Used by | Owns | Per-role limits (proposed starting values, tune by measurement) |
|---|---|---|---|---|
| `pp_migrator` | yes | The manual `migrate` step only (never a running service) | **Every table, sequence, function, trigger** | `statement_timeout` off for DDL; credentials kept **outside every runtime environment** |
| `pp_public` | yes | Public API (parents, OTP, registration, onboarding, mobile) | nothing | `CONNECTION LIMIT`, `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` **derived from measured Railway capacity, planned replicas, worker needs and break-glass headroom** (`DB-MIGRATION-AND-TEST-PLAN.md` section 5); today's code defaults (pool 10, statement 15 s, idle-in-transaction 30 s, connect 5 s) are the **current** values, not proposals |
| `pp_staff` | yes | Staff API | nothing | limits derived from measurement (`DB-MIGRATION-AND-TEST-PLAN.md` section 5) |
| ~~`pp_worker`~~ | **[OUT OF SCOPE: no worker in this project]** | | | |
| `pp_ops` | yes | Administrator CLIs from an administrator's machine (`staff`, `bootstrap:admin`, `catalog:cleanup`) | nothing | named people only; sessions logged off-platform |
| `pp_def_live` | **no login** | Owner of the trip-end `SECURITY DEFINER` trigger function (5.1). **Only if the role split is approved** | that function | n/a |
| `pp_def_catalog` | no login | Owner of `resolve_public_trip_for_registration` (decision D1, 5.3). **Only if the role split is approved** | that function | n/a |
| ~~`pp_def_audit`~~ | **[OUT OF SCOPE: `audit_append` withdrawn]** | | | |
| ~~`pp_audit_verify`~~ | **[OUT OF SCOPE: no external verifier]** | | | |
| `pp_payments` (future) | **[OUT OF SCOPE: payments are future and plan-only]** | | | |

**Why `pp_migrator` owns everything:** an owner can drop triggers, change grants and truncate; runtime roles must therefore own nothing. **Why no login for definer roles:** nobody can authenticate as them; they exist only to own functions and to hold the few privileges those functions need.

**State under this charter:** there is **no worker**. `pp_public` permanently holds the rows in **3a** (PDF storage state, Drive credentials, purges) because that is how the application works today and it is preserved; `pp_staff` purges its own tables.

## 2. Global, schema, database and default privileges

| Item | Plan |
|---|---|
| Database `CONNECT` | `REVOKE ALL ON DATABASE <db> FROM PUBLIC`; grant `CONNECT` to each runtime role by name |
| Schema `public` | `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (needed on PostgreSQL before 15; harmless after); `USAGE` to runtime roles; **owner `pp_migrator`**; no runtime role has `CREATE` |
| Other schemas | None exist [Code]. Do not create any in the first step. `pg_temp` is used only by a migration (`pg_temp.portal_slug`) |
| `PUBLIC` on application functions | `REVOKE EXECUTE ON FUNCTION <each app function> FROM PUBLIC` (trigger functions need no `EXECUTE` at fire time; only the creator needs it) |
| `PUBLIC` on built-ins | `gen_random_uuid`, `clock_timestamp`, `hashtextextended`, `pg_advisory_xact_lock`, `make_interval` stay executable (the code needs them). **Optional:** revoke `pg_advisory_lock*` (session-level) and `pg_sleep*` from `PUBLIC` for runtime roles if the platform permits; the migrator needs `pg_advisory_lock` |
| Default privileges | `ALTER DEFAULT PRIVILEGES FOR ROLE pp_migrator ... REVOKE ALL ON TABLES/SEQUENCES/FUNCTIONS FROM PUBLIC` so a **new object is invisible to every runtime role until a migration grants it explicitly**. Every future migration must grant what it adds; the manifest test (section 10.2) fails otherwise |
| Row-level security | Not used today. **Optional, later (O2):** RLS for staff scoping and payment tables. Note that **table owners and superusers bypass RLS** unless `FORCE ROW LEVEL SECURITY` is set; plan for it if adopted |
| Role defaults | `ALTER ROLE <r> SET search_path = public, pg_catalog` (fixed, so session `search_path` cannot be hijacked); `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` per table in section 1 |
| Superuser | The platform's superuser credential stays out of every service; used only for break-glass and the one-time role setup; its use is logged off-platform |
| Connection path | TLS to the database; private network address only (Unverified on Railway) |

## 3. Tables and columns

Legend: **S** SELECT, **I** INSERT, **U** UPDATE, **D** DELETE. Column lists are the **minimum the statements in section 8 need**. A bare letter means all columns. `-` means no privilege at all. **Interim** rows are marked.

| Table | `pp_public` | `pp_staff` | ~~`pp_worker`~~ (not used) | `pp_ops` | Notes |
|---|---|---|---|---|---|
| `schema_migrations` | - | - | - | - | `pp_migrator` only |
| `parent_registrations` | S(`id`,`first_name`,`last_name`,`role`,`phone`,`email_normalized`,`trip_id`,`created_at`); I(`first_name`,`last_name`,`school`,`role`,`phone`,`email_normalized`,`email_verified_at`,`verification_token_id`,`request_ip`,`trip_id`,`trip_link_id`) | S(`id`,`first_name`,`last_name`,`role`,`email_normalized`) | S(`id`,`first_name`,`last_name`,`role`,`phone`,`email_normalized`,`trip_id`) | S | **No UPDATE or DELETE for any runtime role.** DELETE cascades to credentials, sessions and forms (section 6) |
| `password_credentials` | S(`registration_id`,`password_hash`); I(`registration_id`,`password_hash`); U(`password_hash`,`changed_at`) | - | - | - | Reset uses `ON CONFLICT ... DO UPDATE`: needs S, I and U |
| `auth_sessions` | S(`id`,`registration_id`,`access_token_hash`,`access_expires_at`,`idle_expires_at`,`expires_at`,`revoked_at`,`token_hash`); I(`registration_id`,`expires_at`); U(`access_token_hash`,`access_expires_at`,`idle_expires_at`,`revoked_at`,`revoke_reason`,`token_hash`) | **-** (staff must not mint or read parent sessions) | S(`id`,`revoked_at`,`expires_at`); D (purge) | - | Mobile sessions use the same table (different hash domain). Purge runs on `pp_public` as it does today |
| `auth_refresh_tokens` | S; I(`session_id`,`token_hash`,`expires_at`); U(`used_at`) | - | - | - | Purged by cascade from `auth_sessions` |
| `email_otps`, `email_verification_tokens` (parent purposes `registration`, `login`, `password_reset`) | S; I; U(`invalidated_at`,`attempts`,`verified_at`,`consumed_at`); D on `email_otps` (retention) **[needs code change: move retention purge out of the send transaction]** | **-** | D (retention) | - | The **staff** purpose moves to its own tables `staff_email_otps`, `staff_verification_tokens` **[needs code change]** owned by `pp_staff` with the same grants. Until moved, this table pair is a shared-table risk (SA-04) |
| `password_login_attempts` | S; I(`email_normalized`,`request_ip`); D | - | D (purge) | - | Sequence `password_login_attempts_id_seq` USAGE |
| `trip_link_lookups` | S; I(`request_ip`); D | - | D (purge) | - | Sequence `trip_link_lookups_id_seq` USAGE |
| `onboarding_forms` | S; I(`registration_id`,`enrolment_id`,`tour_type`,`participant_role`,`data`,`current_section`,`progress_percent`); U(`data`,`current_section`,`progress_percent`,`version`,`updated_at`,`status`,`submitted_at`,`declaration_version`,`signature_name`,`declaration_accepted_at`); D | **-** (**staff code reads no form today** [Code]) | S (PDF generation) | S | Holds children's data. **Staff access to forms must be a deliberate future grant with its own audit.** Trigger `onboarding_forms_fill_trip` reads `trip_enrolments` and `trips` as the writer |
| `trip_enrolments` | S(`id`,`registration_id`,`trip_id`,`trip_link_id`,`created_at`); I(`registration_id`,`trip_id`,`trip_link_id`) | S(`id`,`registration_id`,`trip_id`,`created_at`) | S(`id`,`registration_id`,`trip_id`) | S | `ON CONFLICT ON CONSTRAINT ... DO NOTHING` needs I |
| `registration_pdfs` | S; I(`form_id`); U(`next_retry_at`,`updated_at`) (see 3a: the public API keeps all state columns because the PDF workflow is unchanged) | - | S; I; U (all state columns) | - | Existing PDF workflow unchanged: all state columns stay with `pp_public` (3a) |
| `drive_folders` | S; I(`destination`,`folder_key`,`drive_folder_id`); D | - | (not used) | - | Google Drive folder ids (existing Drive flow, 3a) |
| `declaration_texts` | S(`version`,`body`) | - | S | - | INSERT only by migrations (immutable trigger) |
| `schools` | S(`id`,`name`,`branch`,`status`,`slug`,`branch_slug`) | S; I(`name`,`name_normalized`,`branch`,`branch_normalized`,`slug`,`branch_slug`,`created_by`); U(`name`,`name_normalized`,`status`,`archived_at`, and the other columns the update statement sets: **confirm from the runtime capture**) | S(`id`,`name`,`branch`) | S; D | |
| `trips` | S(`id`,`school_id`,`title`,`destination`,`academic_year`,`tour_type`,`payment_mode`,`status`,`public_registration`,`opens_at`,`closes_at`,`slug`,`template_key`) ; **no locking privilege and no UPDATE**: the registration lock is taken by the definer function in 5.3 (decision D1); EXECUTE on `resolve_public_trip_for_registration` | S; I(`school_id`,`title`,`tour_type`,`destination`,`academic_year`,`payment_mode`,`opens_at`,`closes_at`,`created_by`,`slug`); U(`title`,`tour_type`,`payment_mode`,`destination`,`opens_at`,`closes_at`,`academic_year`,`status`,`public_registration`,`updated_at`) | S(`id`,`school_id`,`title`,`destination`,`tour_type`,`academic_year`,`payment_mode`) | S; D | `created_by` hidden from `pp_public` |
| `school_logos` | S(`school_id`,`content_type`,`data`,`updated_at`) | S; I; U(`content_type`,`data`,`updated_by`,`updated_at`); D | S | D | |
| `trip_links` | - | - | - | S | Legacy and retired. Only the cleanup tool reads it |
| `trip_live_locations` | S(all except `assigned_by`,`assigned_at`); U(`status`,`sharing_session_id`,`started_at`,`stopped_at`,`stop_reason`,`latitude`,`longitude`,`accuracy_m`,`captured_at`,`received_at`,`updated_at`) | S (all); I(`trip_id`); U(`tracker_enrolment_id`,`assigned_by`,`assigned_at`,`updated_at`) | S(`trip_id`,`status`,`received_at`,`started_at`,`sharing_session_id`); U (same wipe columns as `pp_public`) | - | **Staff get no write on position columns.** The trip-end wipe runs through the definer trigger (section 5, SA-02) |
| `staff_users` | - | S; I(`email_normalized`,`display_name`,`role`,`password_hash`); U(`password_hash`,`changed_at`,`disabled_at`) | - | S; I; U | |
| `staff_sessions`, `staff_refresh_tokens` | - | S; I; U; D (purge own) | - | U(`revoked_at`) | |
| `staff_login_attempts` | - | S; I; D | - | - | Sequence `staff_login_attempts_id_seq` USAGE |
| `audit_log` | - | **I, S** (existing behaviour) | - | I, S | Sequence `audit_log_id_seq` USAGE for `pp_staff` and `pp_ops`. **No UPDATE, DELETE or TRUNCATE for any runtime role**; the existing append-only trigger stays unchanged. Existing permissions only; see `SCOPE-CHARTER-AND-DECISIONS.md` 4.2 |

**Corrections to `SECURITY-ARCHITECTURE.md`:** its first matrix gave `pp_staff` read access to `onboarding_forms`, `registration_pdfs` and registrations. The code shows **no staff query touches them** (staff read only a few `parent_registrations` columns for team-lead candidates). Least privilege means they get none until a feature needs them (section 12, SA-23).

### 3a. Permissions `pp_public` holds for the existing PDF workflow and purges (permanent, nothing is moved)

Under `SCOPE-CHARTER-AND-DECISIONS.md` (decision D9) the registration PDF workflow is **unchanged**: on successful registration the PDF is stored automatically in the company's Google Drive folder; parents download their own PDF through the API (the stored copy is read from Drive by the API and checked against its SHA-256); parents never get access to the Drive folder. The API process therefore keeps the Drive credentials and the privileges below, exactly as today. The role split only gives them to `pp_public` instead of the single role.

| Need (existing behaviour) | Privileges on `pp_public` |
|---|---|
| PDF storage state (claim, store, fail, not-found, sweep selection, parent "try again") | `registration_pdfs`: S, I(`form_id`), U(`status`,`destination`,`drive_file_id`,`file_name`,`size_bytes`,`sha256`,`stored_at`,`claimed_at`,`attempts`,`last_attempt_at`,`last_error_code`,`next_retry_at`,`updated_at`) |
| Drive folder cache | `drive_folders`: S, I(`destination`,`folder_key`,`drive_folder_id`), D |
| PDF content for storing and download | S on `onboarding_forms`, `parent_registrations`, `trips`, `schools`, `school_logos`, `declaration_texts` (columns the PDF model uses) |
| Hourly purges (existing housekeeping) | `auth_sessions`: D; `password_login_attempts`: D; `trip_link_lookups`: D; `email_otps`: D (the retention delete inside every send); live-location expiry wipe via the update columns already granted |

**Accepted residual risk (unchanged by this project):** a compromise of the public API can reach the Google Drive credential and stored PDFs, as it can today. Limiting who can open the Drive folder is an existing company-managed control that this project does not change and cannot verify. `pp_staff` purges only its own tables (`staff_sessions`, `staff_login_attempts`).

### 3b. [OUT OF SCOPE] Future worker permissions

Withdrawn with the worker (decision D9). Not part of this project. If the company later requests background processing, it must be an internal change that does not alter the parent experience or company workflow, and this section would be rewritten then.

## 4. Sequences, functions, triggers, views, schemas, extensions

| Object | Kind | Owner | Execution | Who can run it | Plan |
|---|---|---|---|---|---|
| `audit_log_id_seq`, `staff_login_attempts_id_seq` | sequence | `pp_migrator` | USAGE | `pp_staff` (and `pp_ops` for the first) | USAGE only; no SELECT/UPDATE on the sequence |
| `password_login_attempts_id_seq`, `trip_link_lookups_id_seq` | sequence | `pp_migrator` | USAGE | `pp_public` | as above |
| `audit_log_append_only()` + trigger `audit_log_no_update` (BEFORE UPDATE OR DELETE) | function + trigger | `pp_migrator` | INVOKER | fires for any writer | Keep **unchanged**. No trigger is added (runtime roles simply hold no TRUNCATE privilege) |
| `onboarding_forms_lock_submitted()` + trigger | function + trigger | `pp_migrator` | INVOKER | fires for writers of forms | Keep. Needs no privileges (raises) |
| `onboarding_forms_fill_trip()` + trigger (019, unapplied) | function + trigger | `pp_migrator` | **INVOKER** (decision in section 5) | `pp_public` | Needs S on `trip_enrolments(id,trip_id)` and `trips(id,school_id,template_key)` for the writer; `pp_public` already holds these |
| `declaration_texts_immutable()` + trigger | function + trigger | `pp_migrator` | INVOKER | any writer | Keep |
| `trip_live_location_stop_on_trip_end()` + trigger `trips_stop_live_location` | function + trigger | **`pp_def_live`** (after change) | **SECURITY DEFINER** | fires on `trips.status` updates by `pp_staff` / `pp_ops` | **SA-02 solution** (section 5) |
| **`resolve_public_trip_for_registration(text,text,text)`** (new, D1) | function | `pp_def_catalog` | **SECURITY DEFINER**, VOLATILE, pinned `search_path` | `pp_public` only | 5.3 |
| `pg_temp.portal_slug` | function | migration-time temp | n/a | migrator | Not persistent |
| Views, materialized views, enums, domains, extensions, policies, publications, event triggers | - | - | - | - | **None exist** [Code]. Add only: a DDL **event trigger** that alerts on `ALTER`/`DROP` of `audit_log` (SECURITY-ARCHITECTURE 4.3) if the platform allows event triggers |
| Large objects, `COPY ... PROGRAM`, `pg_read_server_files` | - | - | - | none | Runtime roles are never members of `pg_*` privileged roles |

## 5. SECURITY DEFINER: what to use, what not to, and the implications

### 5.1 SA-02 (trigger rights): make the trip-end trigger a narrow definer function

**Problem.** `trips_stop_live_location` runs as the user who updates `trips.status` (`pp_staff`). Its body updates `trip_live_locations` position and status columns. As an INVOKER function, `pp_staff` would need `UPDATE` on those columns, which would also let a compromised staff API overwrite or erase children's group location at will.
**Solution.** Re-create the function as `SECURITY DEFINER` owned by the no-login role `pp_def_live`, with:
- `SET search_path = pg_catalog, public` on the function; every object **schema-qualified** (`public.trip_live_locations`); no dynamic SQL; no parameters; returns `trigger`;
- `pp_def_live` holds only `SELECT(trip_id,status)` and `UPDATE(status,stop_reason,stopped_at,sharing_session_id,latitude,longitude,accuracy_m,captured_at,received_at,updated_at)` on `trip_live_locations` and nothing else;
- `REVOKE EXECUTE ... FROM PUBLIC` (a trigger function cannot be called directly anyway; it returns `trigger`);
- `pp_staff` then needs on that table only `S`, `I(trip_id)` and `U(tracker_enrolment_id,assigned_by,assigned_at,updated_at)`.

**Implications.** (1) It runs with owner rights: a mistake in the body, or a mutable `search_path`, is privilege escalation; hence the pinned path, no dynamic SQL, and a test that inspects `pg_proc` (`prosecdef`, `proconfig`, owner) in CI. (2) Anyone able to update `trips.status` to a non-active value can wipe a live position: intended (trip ended), and only `pp_staff` and `pp_ops` can. (3) The owner role must never own tables or hold broader grants. (4) Changing the function needs a migration by `pp_migrator` and a re-check of its ACL. (5) It does not execute on `INSERT`, only on `status` change, as today.

### 5.2 SA-02 (form trigger): keep INVOKER

`onboarding_forms_fill_trip` reads two rows the writer already may read. Making it DEFINER would add risk for nothing. Keep INVOKER; grant `pp_public` S on `trip_enrolments(id,trip_id)` and `trips(id,school_id,template_key)` (already in section 3). **Test:** a parent saves a form under `pp_public`.

### 5.3 SA-01 (row lock): decision D1 = option B, a narrowly scoped definer function

**Decision (lead):** keep the lock, grant no broad UPDATE. The registration trip resolution moves behind `SECURITY DEFINER` function `public.resolve_public_trip_for_registration(p_school text, p_branch text, p_trip text)`.

**Why a function is needed at all:** PostgreSQL requires `UPDATE` on a table for any row-lock clause (`FOR SHARE`, `FOR UPDATE`, ...). The lock stops a staff status or `public_registration` change committing between "this trip is open and public" and the enrolment INSERT.

**Specification (to be implemented later, nothing exists):**
- **Owner:** `pp_def_catalog` (no login). Owner privileges: `SELECT` on `schools`(`id`,`name`,`branch`,`status`,`slug`,`branch_slug`) and `trips`(`id`,`school_id`,`title`,`destination`,`academic_year`,`tour_type`,`status`,`public_registration`,`opens_at`,`closes_at`,`slug`), and **`UPDATE(updated_at)` on `trips` only** (the minimum PostgreSQL accepts for the lock). Nothing else.
- **Properties:** `SECURITY DEFINER`, `VOLATILE` (a function containing `FOR SHARE` cannot be `STABLE`), `LANGUAGE sql` or `plpgsql` with no dynamic SQL, `SET search_path = pg_catalog, public`, every object schema-qualified, `PARALLEL UNSAFE` (default), **`REVOKE ALL ... FROM PUBLIC`**, `GRANT EXECUTE` to `pp_public` only.
- **Behaviour:** validates the three arguments against the slug pattern in the function (`^(?=.{1,70}$)[a-z0-9]+(-[a-z0-9]+)*$`); runs the same select as today's `PUBLIC_SELECT` with `FOR SHARE OF t`; **applies the publishing rule itself** (school `active`, trip `public_registration`, trip status `active` or `closed`) and returns **zero rows** for anything else, so it cannot be used to enumerate drafts or archived trips; returns only `trip_id`, `school_name`, `tour_type`, `title`, `destination`, `academic_year`, `trip_status`, `is_open` (`status = 'active'` and inside the open window). No `created_by`, no school id, no slugs, no logo data.
- **Caller change [needs code change]:** `resolvePublicTripForRegistration` calls the function and maps results exactly as today (no rows to 404, `is_open = false` to 409). Used by registration and by enrolment (both run it inside their transaction).
- **The read-only public page** (`resolvePublicTrip`) needs no lock and keeps a plain `SELECT` under the `pp_public` column grants.

**Security requirements (each has a test below):**
1. The owner role cannot log in and owns nothing else; its grants are exactly those above.
2. `search_path` is pinned on the function and cannot be changed by the caller; all references are schema-qualified.
3. No `EXECUTE`, no dynamic SQL, no writes: the body is one `SELECT ... FOR SHARE`. The function never changes a row (`pg_stat_user_tables.n_tup_upd` for `trips` does not move across calls).
4. `EXECUTE` only for `pp_public`; `PUBLIC` and `pp_staff` cannot call it.
5. It reveals nothing a public page does not already reveal, and returns nothing for unpublished trips.
6. **Lock abuse is bounded:** the share lock lasts to the end of the caller's transaction. A compromised public API could hold shared locks and delay staff edits. Mitigations: `idle_in_transaction_session_timeout` and `lock_timeout` on `pp_public` and `pp_staff` (values from the measured sizing in `DB-MIGRATION-AND-TEST-PLAN.md` section 5, not fixed here), `statement_timeout`, and an alert on long lock waits. Residual risk: Low.
7. The function is code that runs with elevated rights: reviewed as a security component, covered by the definer rules in 5.4, and its definition (`prosecdef`, `provolatile`, `proconfig`, owner, ACL, source hash) is asserted by the manifest test.

**Concurrency and behaviour tests (required before acceptance):**

| # | Test | Expected |
|---|---|---|
| C1 | Connection A (`pp_public`) opens a transaction and calls the function; connection B (`pp_staff`) runs `UPDATE trips SET status = 'closed'` | B **blocks** until A commits or rolls back, then proceeds |
| C2 | A holds the lock, then inserts the enrolment and commits; B then commits the close | The registration exists; the trip is closed afterwards; no error |
| C3 | B closes first and commits; A calls the function afterwards | `is_open = false`, registration answers 409, **no enrolment row** |
| C4 | A holds the lock past B's `lock_timeout` | B fails with SQLSTATE `55P03`; A is unaffected |
| C5 | A goes idle inside the transaction past `pp_public`'s `idle_in_transaction_session_timeout` | A's session is terminated, the lock is released, B proceeds |
| C6 | Stress: 100 parallel registrations against one trip while staff toggle the trip `active`/`closed` 50 times (repeat 20 runs) | **Invariant:** every enrolment's trip was `active` and in window at the moment of its function call (recorded with the function's own `clock_timestamp()` and the status history); zero deadlocks (`40P01`); zero unexplained 5xx; counts match |
| C7 | The same stress with the `trips_stop_live_location` definer trigger active and a sharing location | No deadlock; staff close still wipes the location |
| C8 | Lock order check: registration transaction (token UPDATE, trip FOR SHARE, inserts) versus staff transaction (trip FOR UPDATE, trigger UPDATE on `trip_live_locations`) | No cycle; documented lock-order diagram; test of both interleavings |
| V1 | Unpublished states: draft trip, archived trip, school archived, `public_registration = false`, unknown slugs, wrong branch, malformed slugs | zero rows, no error |
| V2 | Hostile inputs: SQL metacharacters, 10 KB strings, NUL, unicode look-alikes | zero rows or rejected, no error text leak |
| V3 | As `pp_public`: `SELECT ... FROM trips FOR SHARE`, `UPDATE trips SET updated_at = ...`, `SELECT created_by FROM trips` | all `42501` (proves the function is the only path) |
| V4 | As `pp_staff` and `PUBLIC`: call the function | `42501` |
| V5 | `SET search_path = evil` in the caller's session, with an `evil` schema holding look-alike objects (created by the test owner) | the function still uses `pg_catalog, public` objects only |
| V6 | `pg_proc` inspection | `prosecdef = true`, `provolatile = 'v'`, `proconfig` contains the pinned path, owner `pp_def_catalog`, ACL exactly `{pp_def_catalog=X/pp_def_catalog,pp_public=X/pp_def_catalog}` |
| V7 | Registration and enrolment regression suites (`trip-registration`, `registrations-api`, `enrolments-api`, `join-api`) under `pp_public` | green, same responses (404 unpublished, 409 not open, 201 created) |
| V8 | Compare function output with the old inline query over a generated set of trips and windows | identical decisions |

**Fallback if the platform cannot create a definer-owner role with these narrow grants (decision D4):** see `DB-MIGRATION-AND-TEST-PLAN.md` 3.2.

### 5.4 Other candidates considered

| Candidate | Use DEFINER? | Reason |
|---|---|---|
| `audit_append(...)` | **No (out of scope, decision Q4)** | Withdrawn; the existing direct inserts are kept and only their permissions are documented (3, `SCOPE-CHARTER-AND-DECISIONS.md` 4.2) |
| Registration transaction | No | Plain INSERTs by `pp_public` are enough; DEFINER would hide logic in the database |
| OTP and session operations | No | Row-level hot paths; INVOKER with column grants |
| Staff team-lead assignment (`ON CONFLICT DO NOTHING` + update) | No | Column grants on one table suffice |
| Session purge, expiry wipe | No | Each API holds the narrow DELETE/UPDATE it needs for its own tables (unchanged) |
| Retention and erasure (future) | **Out of scope** | A single audited `erase_registration(id)` definer function, executable only by `pp_ops`, is safer than granting DELETE broadly. Design with the retention decision (M6) |

### 5.5 [OUT OF SCOPE] `audit_append` and external audit mechanisms (decision Q4)

The earlier design (`audit_append`, an `audit_head` table, a keyed hash chain, external checkpoints, independent log storage, a verifier, DDL event-trigger alerting, administrator-action logging) is **withdrawn**. The company has not requested external tamper-evidence infrastructure, and none is built by this project.
**Preserved:** the existing `audit_log` table, its append-only trigger, the existing calls that write it, the admin audit viewer and all existing logging.
**What the role split needs, and nothing more:** `pp_staff` and `pp_ops`: `INSERT`, `SELECT`, `USAGE` on `audit_log_id_seq`; `pp_public`: nothing; no runtime role: `UPDATE`, `DELETE`, `TRUNCATE`.
**Wording rule:** documents do not claim the audit log is tamper-evident, tamper-proof or immutable. It is an append-only table protected by a trigger; a database owner or administrator can still alter it. This is stated plainly and accepted unless the company separately requests more.

**Rules for every definer function (to be a CI check):** owner is a no-login role with only the grants the body needs; `SET search_path` pinned on the function; all names schema-qualified; no `EXECUTE` (dynamic SQL); `REVOKE EXECUTE ... FROM PUBLIC` then grant to the exact roles; return only what is needed; code reviewed as a security component; listed in this manifest with its caller roles.

## 6. Cascade, restrict and set-null paths (what a DELETE or UPDATE silently touches)

Foreign-key actions run **with the owner's rights, not the caller's**. A role with `DELETE` on a parent row therefore deletes child rows it has no privilege on, and an FK error reveals that an id exists.

| Parent row deleted | Effect | Consequence for the manifest |
|---|---|---|
| `parent_registrations` | CASCADE: `password_credentials`, `auth_sessions` (then `auth_refresh_tokens`), `onboarding_forms` (then `registration_pdfs`). RESTRICT: `trip_enrolments` | **DELETE on `parent_registrations` is not granted to any runtime role.** Erasure is a future definer function for `pp_ops` |
| `trips` | CASCADE: `trip_live_locations`. RESTRICT: `trip_enrolments`, `trip_links` | DELETE only by `pp_ops` (cleanup tool) |
| `schools` | CASCADE: `school_logos`. RESTRICT: `trips` | DELETE only by `pp_ops` |
| `staff_users` | SET NULL: `schools.created_by`, `trips.created_by`, `trip_links.created_by/revoked_by`, `trip_live_locations.assigned_by`. `audit_log` has **no FK on purpose** | Disabling is by flag, not delete |
| `auth_sessions` | CASCADE: `auth_refresh_tokens`. SET NULL: `trip_live_locations.sharing_session_id` | Session purge touches live location (SET NULL runs as owner) |
| `email_otps` | CASCADE: `email_verification_tokens`. `parent_registrations.verification_token_id` is SET NULL when a token goes | Retention purge safe for registrations |
| `trip_enrolments` | RESTRICT from `onboarding_forms.enrolment_id` | A form blocks deleting its enrolment |
| `onboarding_forms` | CASCADE: `registration_pdfs` | Form delete (draft only) removes the PDF record |

## 7. Advisory locks

All locks are **transaction-scoped** (`pg_advisory_xact_lock(hashtextextended(key, 0))`) except the migrator's session lock. Any role can take any advisory lock because the functions are executable by `PUBLIC` and the keys are derivable.

| Key pattern | Taken by | Purpose |
|---|---|---|
| `email-otp:<purpose>:<email>` | OTP service (`pp_public`; staff after table split) | One code per email and purpose at a time |
| `pwlogin:email:<email>`, `pwlogin:ip:<ip>` (and the staff equivalents) | login throttle | Count attempts without races |
| trip lookups per address | `catalog/service.js` (public) | Join-page lookup limit |
| `staff-provisioning` | staff management, bootstrap, CLI | One admin change at a time |
| slug locks (school, trip) | staff catalog | Unique slug assignment |
| `schema_migrations` lock (session) | `migrate.js` | One migration at a time |

**Risk:** a compromised `pp_public` can hold `staff-provisioning` or a staff OTP key and stall staff operations. **Controls:** `lock_timeout` and `idle_in_transaction_session_timeout` per role, separate staff OTP tables and key prefixes (already distinct by purpose), alert on long lock waits (`pg_locks`), optional revoke of session-level lock functions. Residual: Low.

## 8. Application queries: executing role and exact privileges

`Role` is the **target** executor. IDs are for the test mapping in section 10. Privileges are the minimum; confirm each by the runtime capture.

| ID | Module and function | Role | Statement (summary) | Privileges |
|---|---|---|---|---|
| Q-OTP-1 | `email-otp/repository` lock | P (S for staff tables) | `pg_advisory_xact_lock(hashtextextended($1,0))` | EXECUTE (PUBLIC) |
| Q-OTP-2 | `dbNow` | P, S | `SELECT clock_timestamp()` | EXECUTE (PUBLIC) |
| Q-OTP-3 | `findActive` | P, S | `SELECT *, ... FROM email_otps WHERE email,purpose,verified_at IS NULL,invalidated_at IS NULL FOR UPDATE` | S on all used columns, **U** (row lock) on `email_otps` |
| Q-OTP-4 | `findLatest`, `sendWindowByEmail`, `sendWindowByIp` | P, S | SELECTs by email / `request_ip` / `created_at` | S |
| Q-OTP-5 | `insertOtp`, `invalidate`, `incrementAttempts`, `markVerified` | P, S | INSERT 9 columns; UPDATE `invalidated_at`/`attempts`/`verified_at` | I, U on those columns |
| Q-OTP-6 | `purgeCreatedBefore` (inside every send) | P today; **W after code change** | `DELETE FROM email_otps WHERE created_at < $1` | D on `email_otps` |
| Q-OTP-7 | `insertToken`, `consumeToken` | P, S | INSERT token; `UPDATE ... SET consumed_at WHERE token_hash,email,purpose,consumed_at IS NULL,expires_at` | I; U(`consumed_at`) + S on the WHERE columns |
| Q-REG-1 | `registrations/repository.insertRegistration` | P | INSERT `parent_registrations` (11 columns) RETURNING | I on those columns; S(`id`,`created_at`) for RETURNING |
| Q-REG-2 | `insertPasswordCredential` | P | INSERT `password_credentials` | I |
| Q-REG-3 | enrolment on registration | P | INSERT `trip_enrolments` ON CONFLICT ON CONSTRAINT DO NOTHING RETURNING id | I, S(`id`) |
| Q-REG-4 | `resolvePublicTripForRegistration` | P | **`SELECT * FROM public.resolve_public_trip_for_registration($1,$2,$3)`** (replaces the inline `FOR SHARE OF t`; D1) | EXECUTE only; the function's owner holds the table privileges and the lock privilege |
| Q-SES-1 | `sessions.createIn`, `issue` | P (S for staff tables) | INSERT `auth_sessions`; UPDATE `access_token_hash`,`access_expires_at`,`idle_expires_at` RETURNING; INSERT refresh token | I, U on those columns, S for RETURNING |
| Q-SES-2 | `sessionForAccess` | P, S | `SELECT id, owner FROM sessions WHERE access_token_hash,... ` | S |
| Q-SES-3 | `refresh` | P, S | `SELECT ... FOR UPDATE OF rt, s`; UPDATE `used_at`; UPDATE `revoked_at` | S, U(`used_at`), U(`revoked_at`,`revoke_reason`) (row lock needs U) |
| Q-SES-4 | `upgradeLegacy` | P, S | SELECT `token_hash` FOR UPDATE; UPDATE `token_hash = NULL` | S, U(`token_hash`) |
| Q-SES-5 | `revoke` | P, S | SELECTs by hash; UPDATE `revoked_at`,`revoke_reason` | S, U |
| Q-SES-6 | `purgeExpired` | P (parent tables) / S (staff tables) | `DELETE FROM <sessions> WHERE expires_at < ...` | D on that sessions table |
| Q-AUTH-1 | `auth/service.authenticate`, `userOf`, `login` | P | SELECT `parent_registrations` by id / email | S(`id`,`email_normalized`,`first_name`,`last_name`,`role`) |
| Q-AUTH-2 | `passwordLogin` | P | `SELECT r.*, c.password_hash FROM parent_registrations r LEFT JOIN password_credentials c` | S on both |
| Q-THR-1 | `login-throttle.begin` | P (S for staff tables) | two advisory locks; `count(*)` by email and by `request_ip`; INSERT attempt; COMMIT | EXECUTE, S, I(`email_normalized`,`request_ip`), sequence USAGE |
| Q-THR-2 | `clearIn`, `purgeOld` | P (S); purge W | `DELETE ... WHERE email_normalized` / `created_at <` | D |
| Q-RST-1 | `password-reset.hasAccount`, `confirm` | P | SELECT account; advisory lock; `INSERT password_credentials ON CONFLICT (registration_id) DO UPDATE`; `UPDATE auth_sessions SET revoked_at... WHERE registration_id`; `UPDATE email_verification_tokens SET consumed_at` | S, I, **U on `password_credentials`**, U on `auth_sessions`, U on tokens |
| Q-ONB-1 | `onboarding/repository` find/insert/update/submit/delete | P | SELECT forms (optionally FOR UPDATE); INSERT ... ON CONFLICT DO NOTHING; UPDATE draft; UPDATE submit; DELETE draft | S, I, U (12 columns), D on `onboarding_forms`. Triggers: lock (raises), fill_trip (needs S on `trip_enrolments`, `trips`) |
| Q-ONB-2 | context lookups (`findContext`, `findEnrolmentContext`, legacy variants) | P | joins `trip_enrolments`, `trips`, `schools`, `school_logos`, `parent_registrations` | S on listed columns |
| Q-ONB-3 | account view, declaration text, school logo | P | SELECT `parent_registrations` (5 columns), `declaration_texts`, `school_logos` | S |
| Q-ENR-1 | `enrolments/repository` insert, find, list, resume | P | INSERT `trip_enrolments` ON CONFLICT DO NOTHING; SELECTs joining `trips`, `schools`, `onboarding_forms` | I, S |
| Q-PDF-1 | `pdf-storage` ensureRecord, status | P / W | INSERT `registration_pdfs ON CONFLICT (form_id) DO NOTHING`; SELECT | I, S |
| Q-PDF-2 | claim, fail, store, not-found, sweep queries | **P** (unchanged flow) | UPDATE `registration_pdfs` (state columns); SELECT due rows and submitted forms without a record | S, U on `registration_pdfs`; S(`id`,`status`,`submitted_at`) on `onboarding_forms` |
| Q-PDF-3 | `drive_folders` get, insert, delete | P | SELECT; INSERT ON CONFLICT DO NOTHING; DELETE by destination | S, I, D |
| Q-PDF-4 | PDF content for a form | P / W | `onboarding/repository.findForPdf`, account view | S on `onboarding_forms`, `parent_registrations`, `trips`, `schools` |
| Q-JOIN-1 | public join pages, lookup limit | P | `PUBLIC_SELECT` (schools JOIN trips); `SELECT ... FROM school_logos`; advisory lock; count; INSERT `trip_link_lookups`; DELETE older than a day | S, I(`request_ip`), D, sequence USAGE |
| Q-LIVE-1 | `loadForParent`, `view`, `assignedTrips` | P | joins `trip_enrolments`, `parent_registrations`, `trips`, `schools`, `trip_live_locations`, `auth_sessions` | S on listed columns (incl. position columns) |
| Q-LIVE-2 | `start`, `update`, `stop` | P | `SELECT 1 FROM trip_live_locations WHERE trip_id FOR UPDATE`; UPDATE status/position/session columns | S, **U on those columns** (row lock) |
| Q-LIVE-3 | `staffView` | S | joins as above | S (all) |
| Q-LIVE-4 | `assignTeamLead` | S | candidate query (S `trip_enrolments`, `parent_registrations`); `INSERT trip_live_locations (trip_id) ON CONFLICT (trip_id) DO NOTHING`; `SELECT ... FOR UPDATE`; UPDATE assignment columns; audit | S, I(`trip_id`), U(`tracker_enrolment_id`,`assigned_by`,`assigned_at`,`updated_at`); `ON CONFLICT` target needs S(`trip_id`) |
| Q-LIVE-5 | `purgeExpired` | P | UPDATE `trip_live_locations` wipe columns WHERE status = 'sharing' AND (stale OR session invalid via `auth_sessions`) | U wipe columns, S(`status`,`received_at`,`started_at`,`sharing_session_id`) and S on `auth_sessions` |
| Q-CAT-1 | `catalog` list, get | S | `SELECT t.*, s.name ... FROM trips t JOIN schools s`; `SELECT s.*, ...` | S on both |
| Q-CAT-2 | createSchool | S | advisory lock; slug lookup; INSERT `schools` RETURNING *; audit | S, I |
| Q-CAT-3 | updateSchool | S | `SELECT ... FOR UPDATE`; UPDATE `schools` | S, U |
| Q-CAT-4 | createTrip | S | `SELECT ... FROM schools FOR SHARE`; lock; slug lookup; INSERT `trips` | S, U (row-lock), I |
| Q-CAT-5 | updateTrip, setStatus, setPublic | S | `SELECT ... FOR UPDATE OF t`; UPDATE `trips`. **Fires the live-location trigger** (SA-02) | S, U; trigger runs as `pp_def_live` |
| Q-CAT-6 | school logo set, remove, read | S | `SELECT id FROM schools FOR UPDATE`; `INSERT school_logos ... ON CONFLICT (school_id) DO UPDATE`; DELETE | S, I, U, D |
| Q-CLN-1 | `catalog/cleanup` (CLI) | O | `BEGIN READ ONLY` listing with audit counts; `SELECT ... FOR UPDATE`; DELETE `trips`, `school_logos`, `schools`; audit INSERT | S on listed tables, U (locks), D on `trips`, `school_logos`, `schools`, I on `audit_log` |
| Q-STF-1 | `staff/auth-service` login, session, logout | S | SELECT `staff_users`; sessions via Q-SES; audit INSERT | S, I |
| Q-STF-2 | `staff/password-service` | S | SELECT `staff_users`; advisory lock; `... FOR UPDATE`; UPDATE `staff_users`, `staff_sessions`, tokens | S, U |
| Q-STF-3 | `staff/management` list, create, activate | S | `SELECT ... ORDER BY LIMIT 500`; advisory lock; INSERT `staff_users`; `FOR UPDATE`; UPDATE `disabled_at`; UPDATE `staff_sessions` | S, I, U |
| Q-STF-4 | `staff/bootstrap`, `staff/provision` (CLI) | O | advisory lock; counts; INSERT `staff_users`; UPDATE; revoke sessions; audit | S, I, U |
| Q-AUD-1 | `recordAudit` | S (O for CLI) | `INSERT INTO audit_log (6 columns)` (existing, unchanged) | I on `audit_log`, sequence USAGE |
| Q-AUD-2 | `listAudit` | S | `SELECT ... FROM audit_log ORDER BY id DESC LIMIT` | S on `audit_log` |
| Q-MOB-1 | `mobile/routes` login, refresh, logout, me, trips | P | same as Q-AUTH, Q-SES, Q-LIVE with mobile hash domain | as above |
| Q-HLT-1 | `health` readiness | every API | `SELECT 1` | none |
| Q-MIG-1 | `migrate.js` | M | session advisory lock; `SELECT name, checksum FROM schema_migrations`; DDL; `INSERT INTO schema_migrations` | owner rights |
| Q-HK-1 | hourly housekeeping (`server.js`) | each API for its own tables | Q-SES-6, Q-THR-2, Q-LIVE-5 | as listed |

## 9. Application changes the manifest needs (all **[needs code change]**, none made)

1. **Staff OTP tables (decision pending, `SCOPE-CHARTER-AND-DECISIONS.md` 6 item 3):** either separate tables with a table-name parameter in the OTP repository and service (a schema change), or accept that a compromised public API can read staff OTP rows (SA-04). Not decided.
2. **Call `resolve_public_trip_for_registration`** from the public trip resolution instead of the inline `FOR SHARE OF t` (decision D1); the read-only public page keeps a plain `SELECT`.
3. ~~Move the OTP retention `DELETE` to a worker~~ **[withdrawn]**: the retention delete stays in the send path and `pp_public` keeps DELETE on `email_otps` (3a).
4. ~~Public API records a PDF request; a worker uploads to Drive~~ **[withdrawn, decision D9]**: the PDF and Drive flow is unchanged and stays in the API.
5. **Split `app.js`** into `public-api` and `staff-api` entrypoints of the same codebase; per-service pools and URLs (`DATABASE_URL_PUBLIC`, `DATABASE_URL_STAFF`). Only if the backend split is approved.
6. **Test harness**: seed and clean as `pp_migrator`/an owner connection, but run the application under test on the role pool (section 10.3).
7. **Composite foreign key** `onboarding_forms (enrolment_id, registration_id) -> trip_enrolments (id, registration_id)` so the database enforces "your form, your enrolment" (finding SA-22). Needs a migration; separate approval.
8. **Definer function and `TRUNCATE` trigger migrations** (section 4, 5.1).
9. Per-variant link base URL map in the staff API (SA-16): required by the portal separation itself; **needs approval** (`SCOPE-CHARTER-AND-DECISIONS.md` 6 item 1).
10. ~~`recordAudit` calls `audit_append`~~ **[withdrawn, decision Q4]**.
11. ~~PDF retry becomes a request~~ **[withdrawn, decision D9]**.
12. Connection pool sizes, timeouts and per-role limits read from configuration, set from the measured sizing (D8).

## 9b. [OUT OF SCOPE] PDF retry redesign (earlier D6) and the worker: the PDF workflow is unchanged (decision D9)

**Preserved exactly, nothing redesigned or removed:**
- On successful registration the registration PDF is stored automatically in the company's designated Google Drive folder (existing background store after submission and the 60-second sweep that retries failures).
- The Drive folder is accessible only to authorised company personnel (an existing company-managed control).
- Parents keep the existing option to download their PDF to their own device (`GET /api/onboarding/pdf`; served from the stored copy, checked against its SHA-256) and to use "try again" (`POST /api/onboarding/pdf/retry`: 202 pending, 200 stored, 429 inside the 15-second cooldown) and the status check (`GET /api/onboarding/pdf/status`).
- Parents never receive access to the Drive folder.
Any future internal separation of Drive credentials or background processing would have to be invisible to parents and to the company's workflow, and needs a separate request. Question D9 (how a public API would serve a stored PDF without Drive credentials) is **closed as not applicable**.

## 10. Automated tests (defined; none written, none run)

### 10.1 Runtime capture (builds and proves the manifest)
Run the **entire** existing suite with a driver-level statement recorder against a database where the application uses a single permissive role. Record `service -> distinct normalised statements -> tables and columns touched`. A script converts this into the **required privileges**, and CI diffs it against this manifest. Any difference fails the build and must be explained (new query, or manifest error).

### 10.2 Privilege manifest test (static, on a migrated empty database)
Enumerates `pg_catalog` and asserts **exact equality** with the manifest for: schemas and owners; tables, columns and column ACLs; sequences; functions (`prosecdef`, `proconfig`, owner, ACL, language); triggers; views and extensions (must be empty); default ACLs; `PUBLIC` ACLs; role attributes (`rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcanlogin`, `rolconnlimit`); role memberships (none); event triggers. **Any object or privilege not listed fails.** A "new table" case: create a table as `pp_migrator` in a scratch copy and confirm no runtime role can see it.

### 10.3 Role-scoped integration suites (the real application under each role)
Each suite starts the real service (`createApp` with the role pool) against a migrated test database. Data is seeded and cleaned with the owner connection (`pp_migrator`). No test uses a superuser to make assertions pass.

| Suite (role) | Existing test files to run, unchanged in intent | Flows covered |
|---|---|---|
| **public (`pp_public`)** | `otp-api`, `otp-service`, `otp-crypto`, `registrations-api`, `registrations-service`, `trip-registration`, `auth-api`, `auth-refresh-api`, `password-auth`, `password-reset`, `password-busy`, `token-attacks`, `token-sessions`, `onboarding-api`, `onboarding-review-mismatch`, `resume`, `form-validation-api`, `enrolments-api`, `join-api`, `live-location-api` (parent part), `mobile-api`, `csrf`, `hardening`, `security-probe`, `health` | Registration (OTP send, verify, register), password and OTP login, refresh, logout, password reset, onboarding draft, **form save and submit (fires the form triggers)**, enrolment, join pages, parent live location, mobile login and location |
| **staff (`pp_staff`)** | `staff-auth`, `staff-password`, `staff-management`, `catalog-api` (admin part), `school-branch`, `school-logo`, `sales-ownership`, `sales-workflow`, `live-location-api` (staff part), `staff-sales-otp-delivery` | Staff login and password flows, school and trip management, **trip status change that fires the definer trigger and wipes a live position**, team-lead assignment, **audit writes**, logo upload |
| **PDF and purge tests (under `pp_public`)** | `pdf-storage`, `pdf-storage-attacks`, `pdf-storage-migration`, `pdf-dashboard-api`, `registration-pdf*`, fake-Drive sweep tests; housekeeping and purge functions; live-location expiry | Existing PDF storage, retry, download and purge behaviour, unchanged |
| **operator (`pp_ops`)** | `staff-provision`, `bootstrap-admin`, `catalog-cleanup` | CLI provisioning, bootstrap, cleanup, with audit rows |

The harness needs three changes (section 9, item 6): configurable role URLs, owner-connection seeding, and a per-suite assertion that **no connection used by the application is a superuser or the owner**.

### 10.4 Permitted and forbidden operations (direct SQL under each login role)
Each row is run as the named role on a database with test data. Permitted rows must succeed; forbidden rows must fail with SQLSTATE `42501` (insufficient privilege) or the trigger error shown.

| # | Role | Operation | Expected |
|---|---|---|---|
| F1 | `pp_public` | `SELECT * FROM staff_users`, `staff_sessions`, `staff_refresh_tokens`, `staff_login_attempts`, `audit_log` | 42501 |
| F2 | `pp_public` | INSERT or UPDATE on `schools`, `trips`, `school_logos`, `trip_links`, `declaration_texts` | 42501 |
| F3 | `pp_public` | `SELECT ... FROM trips FOR SHARE` / `FOR UPDATE` (option A) | 42501 (proves no locking privilege) |
| F4 | `pp_public` | `UPDATE trip_live_locations SET tracker_enrolment_id = ...`, `assigned_by` | 42501 |
| F5 | `pp_public` | `DELETE FROM parent_registrations`; `UPDATE parent_registrations ...` | 42501 |
| F6 | `pp_public` | `TRUNCATE` any table; `DROP`, `ALTER`, `CREATE` anything; `CREATE TABLE` in `public` | 42501 |
| F7 | `pp_public` | `SELECT created_by FROM trips`; `SELECT verification_token_id, request_ip FROM parent_registrations`-type columns outside its grant (where excluded) | 42501 |
| F8 | `pp_public` | read the staff OTP tables (`staff_email_otps`, `staff_verification_tokens`) | 42501 |
| F9 | `pp_public` | `SET ROLE pp_staff`, `SET ROLE pp_migrator`, `SET SESSION AUTHORIZATION` | error |
| F10 | `pp_public` | call the definer function directly | not callable (trigger function) |
| F11 | `pp_staff` | `INSERT/UPDATE/DELETE/SELECT` on `auth_sessions`, `auth_refresh_tokens`, `password_credentials`, `password_login_attempts`, `email_otps`, `email_verification_tokens` (parent tables) | 42501 |
| F12 | `pp_staff` | `SELECT * FROM onboarding_forms`, `registration_pdfs`, `drive_folders` | 42501 |
| F13 | `pp_staff` | `UPDATE trip_live_locations SET latitude = ...` / `longitude`; `INSERT` rows with `status = 'sharing'` | 42501 |
| F14 | `pp_staff` | `UPDATE audit_log`, `DELETE FROM audit_log`, `TRUNCATE audit_log`, `ALTER TABLE audit_log DISABLE TRIGGER ...`, `DROP TRIGGER` | 42501 (and the trigger error for any path that reaches it) |
| F15 | `pp_staff` | `DELETE FROM trips`, `schools`, `parent_registrations`, `staff_users` | 42501 |
| F16 | `pp_staff` | `SELECT password_hash FROM staff_users` | **permitted** (the staff service verifies passwords); verify no other role can |
| F17 | all runtime roles | `CREATE TABLE`, `CREATE FUNCTION`, `COPY ... TO PROGRAM`, `pg_read_file`, `CREATE EXTENSION`, `ALTER ROLE` | 42501 |
| P1 | `pp_public` | register path statements Q-REG-1..4, Q-OTP-1..7, Q-SES-1..5, Q-AUTH-1..2, Q-THR-1..2, Q-RST-1, Q-ONB-1..3, Q-ENR-1, Q-JOIN-1, Q-LIVE-1..2 | succeed |
| P2 | `pp_staff` | Q-CAT-1..6, Q-STF-1..3, Q-AUD-1, Q-LIVE-3..4 | succeed |
| P3 | `pp_staff` | `UPDATE trips SET status = 'closed'` on a trip with a sharing live location | succeeds **and** the location is wiped by the definer trigger (SA-02) |
| P4 | `pp_public` | `INSERT onboarding_forms` with an `enrolment_id` | succeeds and the `fill_trip` trigger fills `trip_id`, `school_id`, `variant` |
| P5 | `pp_public` / `pp_staff` | `INSERT audit_log` by staff, none by public | staff succeeds, public 42501 |
| P6 | `pp_public` | PDF storage and purge statements Q-PDF-2..3, Q-LIVE-5, Q-SES-6, Q-THR-2 | succeed |
| D1 | catalog | inspect `pg_proc` for each function: `prosecdef`, `proconfig` contains `search_path=pg_catalog, public`, owner, ACL | exactly the manifest |

### 10.5 Compromise simulation (the point of the exercise)
For each runtime role, a test opens a raw connection as that role and runs a prepared list of "what an attacker with SQL injection would try": read other domains' secrets, forge or delete audit rows, mint staff sessions, change prices or trip status, read children's data outside the role's purpose, lock tables, create objects, escalate through functions, drop triggers. Each must fail. The list is extended whenever a finding is fixed (regression).

### 10.6 Background jobs
Housekeeping purge (each API for its own tables: parent sessions, staff sessions, login-attempt tables, live locations), PDF sweep with `fake-drive.js`, OTP retention purge, and the health probe run as their target role in the worker suite; each statement must succeed and **no purge may fail with 42501 silently** (failures are logged by message only today: the test asserts on the outcome, not on the absence of a crash).

### 10.7 Regression and load
After the role switch, rerun the full functional suites, the integrity scenarios and one `combined` load run from `scripts/loadtest/` under the role pools (the load results must be recorded with the role setup and the per-role `CONNECTION LIMIT`).

## 11. Rollout, rollback and recovery

**Rollout (each step separately approved; staging first):**
1. **Create roles and grants additively** (no service changes; the old single role keeps working). Run the manifest test.
2. **Deploy code changes** from section 9 behind the existing single role (no behaviour change; staging suites green).
3. (only if the split is approved) **Switch one service at a time to its role** by changing only its connection string: first a **canary replica** of the public API, then the rest, then the staff API, then the worker. Watch `permission denied` (42501) in logs and alerts.
4. **Revoke the old general role's access** and rotate its password. Retire the legacy combined service (SA-19).

**Rollback:**
- Steps 1 to 3: point the service back at the previous connection string (config only, minutes). Keep the old role **enabled and unchanged** until step 4 has been stable for a defined period.
- Role grants are reversible: keep a **down script per grant migration** (`REVOKE` mirror) and a documented sequence to remove roles (`REASSIGN OWNED BY ... TO pp_migrator; DROP OWNED BY ...; DROP ROLE ...`). **Never drop a role that owns objects.**
- The definer-function migration is reversible by re-creating the original INVOKER function; the down script also restores the earlier grants.
- A bad manifest (a missing grant) shows as 42501 on one flow. The canary and a smoke script that exercises each flow once under each role catch it before full rollout.

**Recovery:**
- **Backups and restore must include roles and privileges.** A logical dump with `--no-privileges` or without roles restores data that **nobody can use or that everybody can read**. Capture `pg_dumpall --roles-only` (or the platform equivalent) and the ACLs; the **restore drill** (M7) must restore into a fresh instance, apply the manifest test, and run a role smoke test. Time it.
- **Break-glass:** a superuser credential stored offline with a named owner and an audit of every use; never present in a service environment. A lock-out (all roles broken by a bad change) is recovered with it.
- **Credential rotation:** each runtime role has its own secret; rotate by creating a second password/role generation (`pp_public_b`), moving replicas, revoking the first. Document who holds each secret.
- **Connection budget:** the sum of per-role `CONNECTION LIMIT` must stay within the budget in `CONCURRENCY.md` 3.2.
- **Migrations:** every future migration includes its own `GRANT`s and a manifest update; CI fails otherwise (10.2).

## 12. Findings from this design pass

| ID | Severity | Finding | Evidence | Verification | Remediation | Status |
|---|---|---|---|---|---|---|
| SA-22 | Medium | The database does not enforce that a form's `enrolment_id` belongs to the form's `registration_id`. Only the application does (`findEnrolmentContext`). A compromised or buggy public API could create a **draft form for someone else's enrolment**, which the unique index `onboarding_forms_enrolment_key` then turns into a **denial of that person's form** (and 019's trigger copies the victim's trip into the attacker's row) | `011_trip_enrolments.sql` lines 37, 40 to 41; `019` trigger | As `pp_public` (or owner): `INSERT INTO onboarding_forms (registration_id, enrolment_id, ...)` with a mismatched pair: succeeds today | Composite FK `(enrolment_id, registration_id) -> trip_enrolments (id, registration_id)` (needs a unique constraint on that pair); migration, separate approval | Recorded |
| SA-23 | Low | The first role matrix granted staff reads that the code does not perform (forms, PDF records, registrations) | grep of staff modules; section 3 | Capture (10.1) | Granted nothing until a feature needs it; each future staff read is a reviewed, audited addition | Corrected here |
| SA-24 | Info | `pp_public` needs `DELETE` on `email_otps` (retention delete inside each send) and keeps Google Drive upload and credentials. **Accepted: existing behaviour is preserved (decision D9); no worker.** | `email-otp/service.js`, `onboarding/service.js` | none | Accepted, out of scope |
| SA-25 | Low | Any role can hold any advisory lock; a compromised role can stall another service's serial sections | section 7 | Open a transaction as `pp_public` holding the `staff-provisioning` key and try staff creation | Per-role `lock_timeout` and idle timeouts, alerts; optional revoke of session-level lock functions | Recorded |
| SA-26 | Medium | Backups and restores that omit roles or ACLs are a recovery risk | section 11 | Restore drill | Include roles and privileges in backup and the restore test | Recorded |
| SA-27 | Info | No `SECURITY DEFINER`, views, enums, extensions, RLS policies or non-`public` schemas exist today; the privilege surface is smaller than a typical application | migrations, grep | `pg_catalog` listing on staging | Keep it that way: definer functions only by rule in 5.4 | Verified (by reading) |
| SA-30 | **OUT OF SCOPE (decision)** | Passport, PAN, address, allergy and meal data are collected, stored (JSON) and rendered into PDFs as today. **Additional encryption, new field-level restrictions and changes to collection are out of scope; existing collection, storage, PDF and access behaviour are preserved; no extra protection mechanism is added by this project.** The observation is recorded for the company, not acted on here | `onboarding/definitions.js`, `004_onboarding_forms.sql` | n/a | Closed by scope decision |

## 13. Decisions record (re-scoped by `SCOPE-CHARTER-AND-DECISIONS.md`) and remaining questions

| # | Decision | Status under the charter |
|---|---|---|
| D1 | Definer function for the registration trip lock (kept lock, no broad UPDATE); security requirements and tests | **Stands, conditional** on the database-role split being approved (5.3) |
| D2 | Worker in S4; interim public permissions documented | **Worker withdrawn.** The public API's permissions are permanent (3a) |
| D3 | `audit_append` with the role migration | **Withdrawn (Q4).** Existing audit permissions only (3, 5.5); no tamper-evidence claim |
| D4 | Verify Railway capabilities on disposable staging first; fallbacks | **Stands**, reduced to the probes the role split needs (migration plan 3) |
| D5 | Composite foreign key | **Retained; reconfirm** (charter 6 item 6); independent of the split |
| D6 | Keep PDF retry; move Drive/PDF work to a worker | **Withdrawn (D9).** PDF workflow unchanged (9b) |
| D7 | Default-deny staff access; proposed matrix | **Baseline documentation only.** Existing Sales/Admin permissions preserved; proposed restrictions deferred |
| D8 | Connection limits from measured capacity | **Stands** (no worker role) |
| D9 | PDF workflow | **Closed:** preserved exactly; the open question about serving stored PDFs without Drive credentials does not arise |
| SA-30 | Sensitive-field protections | **Out of scope** |
| Q4 | External audit checkpoint infrastructure | **Out of scope** |

**Questions still open** (all in `SCOPE-CHARTER-AND-DECISIONS.md` 8): whether the backend and role split proceed at all; staff OTP tables decision; staff secret handling (session continuity); per-variant link host; operator tool credentials; legacy combined-service retirement; migration `019`; D5 reconfirmation; Railway capability probes; company confirmation of the Drive folder access list.
