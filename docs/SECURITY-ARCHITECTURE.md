# Security architecture and future payment design

Status: **permanent requirement and plan. Nothing here is implemented, migrated, deployed or committed.** Payment functionality is **not** part of the current phase and nothing in this document builds it.

> **SCOPE NOTICE (governs this document): `docs/SCOPE-CHARTER-AND-DECISIONS.md`.** The project separates the four public portals and the staff portal and restructures backend services **only with a demonstrated reason**; it preserves all existing behaviour (registration, OTP, sessions, staff workflows, PDF and Google Drive, email, mobile API, logging and audit). This document is the **company's long-term security requirement and plan**; it is **not** the scope of the separation project. Marked **[OUT OF SCOPE]** below: external audit tamper-evidence (4.3 layers 2 to 5, decision Q4), additional protection of PAN, passport, address, allergy and meal data (SA-30, section 12 controls), the worker, and any new security system. The payment design (section 6) remains plan-only and future.
**Independent review of this document performed (section 10).** It found errors and gaps that are corrected below (sections 2, 3, 4) or recorded as new sections (10 to 14). Nothing was implemented as a result.
Detailed plans that follow from the review: `docs/DB-MIGRATION-AND-TEST-PLAN.md` (migration order, staging capability probes with fallbacks, composite key, connection sizing), `docs/STAFF-ACCESS-MATRIX-PROPOSAL.md`, `docs/MOBILE-DEPENDENCY-REVIEW-PLAN.md`, `docs/DB-PRIVILEGE-MANIFEST.md` (role and privilege manifest, supersedes the matrix in 4.1), `docs/DEPENDENCY-UPDATE-PLAN.md`, `docs/SECURITY-REQUIREMENTS-M1-M15.md` (acceptance tests per mandatory item; none complete).
Companion documents: `docs/ARCHITECTURE-OPTIONS.md` (service layout), `docs/CONCURRENCY.md` (capacity), `docs/ARCHITECTURE.md` (current monorepo), `AUTH_SESSIONS.md`.

## 0. Principles (permanent)

1. **Security is an architectural requirement, not a release checklist.** Every significant feature gets a threat model before implementation, tests for the attacks it invites, and review before release (section 7).
2. **Defence in depth, minimal attack surface, limited blast radius, detection, recovery.** No claim is made that the system cannot be hacked, and none may be made in its documentation.
3. **Separate services are not security by themselves.** A boundary exists only where an actual permission, credential or network path is different, and it is **verified** by a test that tries to cross it (section 4).
4. **Nothing is claimed from a green build or passing unit tests.** Security needs adversarial tests and an independent review. Capacity needs the staging load tests in `CONCURRENCY.md`, and security controls stay **on** during those tests.
5. Payment is designed now only as far as needed so it can be added later **without redesigning registration, authentication or the backend** (section 6).

Evidence labels: **[Code]** read in this repository. **[Test]** an existing automated test covers it (not independently reviewed). **[Unverified]** assumed, outside the repo, or not checked. **[Proposed]** not built.

## 1. Direction: Option C, subject to verification

```
 Internet
   |
   +--> portal-domestic-paid  \                         +--> staff portal (own host)
   +--> portal-domestic-free   |  static + proxy         |        |
   +--> portal-international-paid |  /api -> public API   |        v
   +--> portal-international-free /                      |   staff API  (private; reachable only from the staff portal proxy)
              |                                          |        |
              v                                          |        |   role pp_staff, STAFF secrets
        public API  (xN)  role pp_public, PARENT secrets |        |
              |                                          |        |
              +---------------+--------------------------+--------+
                              v
                        PostgreSQL (one instance initially)
                              ^
                  worker (outbox mail, PDF sweep, housekeeping)   role pp_worker
                  payments service (future, section 6)            role pp_payments
 Migrations run as pp_migrator (table owner), never from a running service.
```

Four independently deployed public portals, one shared public API, an independently deployed staff API, shared packages (`packages/core`, `packages/contracts`), one PostgreSQL initially, separate DB roles, service credentials and authentication boundaries, **no staff administrative routes in the public API**.
`ARCHITECTURE-OPTIONS.md` 7a lists the conditions that make this a real boundary; this document extends them. Option C stays **a candidate until its boundary tests pass** and the load tests are run.

## 2. Verified state today, by requirement

Everything below was read in the code on this date; where I could not check, it says so. "Gap" means the requirement is not met today or not provable from the repository.

### 2.1 Authentication and session security

| Requirement | Verified state | Gap / unknown |
|---|---|---|
| Strong password hashing with benchmarked resource controls | scrypt N=2^17, r=8, p=1, per-password 16-byte salt, NFKC, parameters stored in the hash (so cost can rise), timing-safe compare, bounded by a work gate (concurrency and queue) [Code]. Policy: 10 to 128 chars, short common-password list [Code]. One hash **measured** at 413 ms on the authoring laptop (`CONCURRENCY.md` 3.9); **not benchmarked on Railway**. | No benchmark on target hardware. No re-hash-on-login when cost rises [not seen in code]. No breached-password check (documented as a later decision). The gate refuses with 503 but an attacker using many addresses and emails can **exhaust hash capacity** (`CONCURRENCY.md` B7). |
| Secure OTP: generation, expiry, single use, throttling | 6 digits from `crypto.randomInt` (CSPRNG); stored only as a keyed HMAC bound to row id, email and purpose; expiry 5 min (staff 15 min); single-use verification token; 5 wrong attempts; 30 s resend cooldown; 5 sends per email and 20 per IP per hour; serialised by an advisory lock; database clock [Code, Test]. | Per-IP caps are only as good as the client address (`TRUST_PROXY_HOPS` undecided). Sends go to **any** address, so the endpoint can be used to mail strangers (capped by the limits above). The code travels by email in clear (inherent). |
| Secure session cookies, rotation, revocation, expiry | Opaque 256-bit random tokens, only keyed hashes stored; 15 min access token; one-time refresh token with **reuse detection that revokes the whole sign-in**; idle and absolute limits; cookies HttpOnly, SameSite=Strict, Secure **only when `NODE_ENV=production`** (a staging or mis-set environment sends cookies without `Secure`) [Code; Railway value Unverified], refresh cookie path-scoped; logout and password reset revoke [Code, Test: `token-attacks`, `auth-refresh-api`]. | Cookie names are not `__Host-` prefixed (they use `Path=/api`). No "sign out everywhere" or session list for parents [not seen]. One HMAC secret is shared by parents, staff, OTP (domain-separated in code): must be split (section 4). No secret rotation procedure (a rotation would invalidate all sessions and OTPs; dual-key support needed). |
| Protection against credential stuffing, brute force, enumeration | Password sign-in records the attempt **before** checking, under per-email and per-IP advisory locks; same error and same hashing work for unknown email, no password and wrong password (decoy hash); reset flow answers identically for every email; registration reveals "already registered" only after the caller proved control of the email by a spent token [Code, Test]. | Distributed attacks over many addresses are limited only per email (5). No CAPTCHA, WAF or edge rate limit [Unverified: outside the repo]. Per-account lockout is a documented denial-of-service trade-off. `TRUST_PROXY_HOPS` must be measured (`CLIENT-IP-STAGING-VERIFICATION.md`). |
| No authentication secrets in browser bundles | `scripts/check-portal-bundles.mjs` fails a build on staff markers in a public portal, source maps, and password-looking text [Code]. All secrets are server environment variables. | A heuristic scan, not a secret scanner. Not run automatically (no CI in the repository). |

### 2.2 Authorization and data isolation

| Requirement | Verified state | Gap / unknown |
|---|---|---|
| Permissions enforced server-side on every protected endpoint | Parent routes sit behind `requireSession`; staff routes behind `requireStaff`; admin-only routes behind `requireRole("admin")`; roles are `admin` and `sales` [Code]. The web bundle split is explicitly not the boundary. | **No automated route inventory** proves every route has the intended guard. Proposed: a test that enumerates the router table, calls each route unauthenticated, as a parent and as the wrong staff role, and asserts 401/403 (section 7). |
| School, trip and registration ownership | Parent data is keyed by the session's `registrationId`. The client **does** send an `enrolmentId` (onboarding, live location, mobile); the code filters it by the session's `registrationId` (`findEnrolmentContext`) [Code, spot-checked on onboarding only]. Sales ownership has tests (`sales-ownership`) [Test]. Ownership of every route taking an id has **not** been proven. Migration `019` (composite keys so school, trip, variant and enrolment must agree) is **not applied anywhere**. | Variant enforcement on `/join` is Phase 2 and not started. Tenant isolation remains application logic (one schema). Horizontal-escalation tests exist for some routes; no systematic matrix. |
| Prevent horizontal and vertical escalation | See above; staff and parent sessions use different cookies, tables and token domains; a parent token is not accepted by the staff API and the reverse [Code]. | Same process and same DB role serve both today. |
| Least-privilege database roles | **None.** One `DATABASE_URL`, one role, used by everything including staff code, public routes and housekeeping. | **The largest structural gap.** Section 4. |
| Public API credentials cannot reach staff-only tables | Not true today (same role). | Section 4. |
| Immutable or tamper-evident audit of privileged actions | `audit_log` is append-only by a trigger that refuses UPDATE and DELETE; rows are written in the same transaction as the change; secret-looking keys are stripped; covers school, trip, link, logo, team-lead, staff login/logout/password and bootstrap actions [Code]. | The trigger does **not** stop `TRUNCATE`, or a table owner dropping the trigger; the application role is the owner, so this is **append-only, not tamper-evident**. No hash chain, no off-database copy. **Staff reads of parent personal data are not audited** (only writes were found). Admin-route staff management **is** audited (`staff.create`, `staff.activate`, `staff.deactivate`); the command-line provisioning (`create`, `disable`, `set-password`) writes **no** audit row (only bootstrap does); `staff.logout` and `staff.session_reuse` are written outside the transaction of the change they describe. |

### 2.3 API and application security

| Requirement | Verified state | Gap / unknown |
|---|---|---|
| Strict input validation, safe output | Every JSON request body read by the routes reviewed goes through `parseBody` with a `zod` strict schema (a grep found no route reading `req.body` otherwise, except the raw logo upload); some admin query parameters are validated ad hoc (`idParam`, `Number.parseInt`); body limits 2 KB (OTP), 4 KB (registration, auth), 8 KB (admin), 64 KB (onboarding); compressed bodies refused (`inflate: false`); errors are a fixed JSON shape and a generic 500, stack and query strings not logged [Code, Test]. | No schema-versioned response filtering layer; output is hand-mapped per route. |
| SQL injection | Values are bound parameters. A grep of the template-literal queries found interpolation only of fixed internal constants (table names in the throttle and session code, constant column lists and select fragments) [Code, grep-level evidence, not a proof for every future change]. | No lint or static rule prevents a future string-built query. |
| XSS | React escaping; helmet's CSP (plus `img-src https:` for map tiles) on the API, and a CSP on the portal server with `script-src 'self'` [Code]. | `style-src 'unsafe-inline'` is allowed on the portal server. No Trusted Types. |
| CSRF | SameSite=Strict cookies, and a same-origin check (`Origin` host must equal `Host`) on every write; requests with no Origin (non-browsers) pass [Code, Test: `csrf`]. | Behaviour must be re-verified when portals and APIs sit on different hosts (the proxy keeps the browser's `Host`, so it works today). |
| SSRF | The server fetches only fixed hosts (Google OAuth and Drive endpoints from configuration, the SMTP host); no user-supplied URL is fetched [Code]. | The payment provider and webhooks add outbound and inbound paths (section 6). |
| Request-size limits, safe upload, abuse protection | School logo upload: admin only, raw body capped at 512 KiB, type decided from the file's own bytes (PNG, JPEG, WebP only; SVG excluded) [Code, Test]. | No antivirus or re-encoding of images. No general abuse protection at the edge. |
| Distributed rate limiting | Sign-in, staff sign-in, OTP sends and join lookups are **database-backed, correct across replicas**; refresh, PDF, live-location and mobile limiters are **in memory per process** [Code]. | Effective limit is N x per replica for the in-memory ones (`CONCURRENCY.md` 3.6). |
| Secure headers, TLS, safe errors | helmet defaults on the API (including HSTS); portal server sends CSP, HSTS, nosniff, referrer-policy, COOP [Code]. TLS terminates at Railway [Unverified: confirm certificate and redirect behaviour on the real domains]. | `TRUST_PROXY_HOPS` value undecided. |
| Dependency vulnerability checks, supply chain | Exact pins for risky packages, one root lockfile, known advisories recorded (`body-parser`, `nodemailer`, `eslint` and `minimatch`) in `ARCHITECTURE.md` [Code]. | **No CI configuration exists in the repository** (`.github` absent): no automated `npm audit`, secret scan, SAST, SBOM or provenance check. `npm audit` on this lockfile reports **5 vulnerabilities (1 high, 4 moderate)**, all left unpatched; recommended versions are in section 14. Keeping them to limit lockfile change is not acceptable. |
| No secrets or personal data in logs | The error logger prints only an error code and message; startup logs print host and database **names**, never credentials; the dev console sender prints codes but is refused outside `NODE_ENV=development` [Code]. | No central redaction layer. Database error messages and email addresses in some warnings were not exhaustively reviewed. Railway log retention and access [Unverified]. |

### 2.4 Infrastructure and operations

| Requirement | State |
|---|---|
| Secure secret storage and rotation | Secrets are environment variables on Railway [Unverified: who can read them]. No rotation procedure; `OTP_HMAC_SECRET` rotation would invalidate sessions and codes. **Gap.** |
| Restricted deployment and administrative access | Migrations are a manual, confirmed step with a production guard and advisory lock [Code]. Railway team roles, deploy permissions, database console access [Unverified]. |
| Database backups and tested restoration | [Unverified]. Nothing in the repository documents backup frequency, retention or a restore test. **Gap until a restore has been performed and timed.** |
| Security monitoring, alerting, incident response | None in the repository (no metrics, alerts or runbook). The code logs refresh-token reuse, but nothing watches for it. **Gap.** |
| Graceful shutdown and safe recovery | Implemented with tests (`shutdown.test.js`); health/readiness split [Code, Test]. Behaviour under real Railway termination [Unverified]. |
| Regular dependency and configuration reviews | No schedule or tooling. **Gap.** |

### 2.5 Ranked risks today (not a vulnerability report)

| # | Risk | Why it matters |
|---|---|---|
| 1 | One DB role for everything | Any SQL injection or code execution in a public route reaches staff credentials, sessions, audit rows and all parent data. |
| 2 | One signing secret for parents, staff and OTP | One leak affects every identity type. |
| 3 | Audit log not tamper-evident, staff PII reads unaudited | An insider or an attacker with the app role can erase evidence or read data unseen. |
| 4 | Client-address trust (`TRUST_PROXY_HOPS`) undecided | Per-IP defences either do nothing or punish whole schools. |
| 5 | Hash exhaustion by many-address attackers | Denies sign-in and registration. |
| 6 | No monitoring, alerting, incident runbook, tested restore | Attacks and failures go unseen or unrecoverable. |
| 7 | No CI security checks; known advisories unpatched | Supply-chain and known-vulnerability exposure. |
| 8 | In-memory limiters | Abuse limits multiply with replicas and reset on deploy. |

## 3. Security requirements for the target design

Stated as requirements (what must be true), each with how it is verified. These are binding for Option C and for any alternative.

**Authentication.** Hash cost **benchmarked on the production-sized staging hardware** and recorded; hash capacity protected by the gate plus edge limits; OTP and session rules as today; **separate signing secrets per identity domain**; refresh reuse detection **alerts**; secret rotation with a dual-key window; `__Host-` cookies evaluated; bundles and repository scanned for secrets in CI.
**Authorization.** A **route authorization matrix** is code, generated from the router, and a test fails if any route lacks an explicit guard; ownership tests for every parent resource (own registration, own enrolment, own trip); staff scoping tests (sales sees only own schools, admin all); no object ID from the client is trusted without an ownership check.
**Database.** Least-privilege roles (section 4); the application never owns tables; `statement_timeout` and `CONNECTION LIMIT` per role; row-level security considered for staff scoping and for payment tables.
**Audit.** Design in 4.3: INSERT-only app roles, a keyed hash chain, **checkpoints anchored in an external append-only destination**, platform and DB-administrator actions logged off the platform; privileged **reads** of personal data audited; payment-state changes audited (section 6). Without the external anchor the log is **append-only against application compromise only**, and must not be described as tamper-evident.
**API.** Strict schemas and size limits kept; distributed rate limiting for **every** limiter; edge protection for hash exhaustion; correct client IP; CSP without `unsafe-inline` styles where feasible; safe upload rules extended to any future upload.
**Supply chain.** CI with `npm audit` (production dependencies), secret scanning, static analysis, an SBOM, lockfile integrity (`npm ci`), no unreviewed install scripts, pinned base image and Node version; advisories tracked to closure.
**Operations.** Secrets in the platform's secret store with named owners and rotation dates; deploy and database access limited to named people with MFA; backups with a **restore test on a schedule**; alerts on refresh reuse, repeated 5xx, 503 busy, login failure spikes, DB connection saturation and webhook failures; an incident-response runbook (contain, preserve evidence, rotate, notify, review).

## 4. Boundaries that must be verified, not assumed

A service split is accepted as a security boundary only when each row below has a passing test. None exists yet.

> **Superseded in detail by `docs/DB-PRIVILEGE-MANIFEST.md`.** That manifest corrects this matrix: the staff API has **no** access to `onboarding_forms`, `registration_pdfs` or `drive_folders` (no staff query touches them today), and it solves SA-01 and SA-02 explicitly. Where the two differ, the manifest governs.

### 4.1 Object inventory (from migrations 001 to 019 and the code) and the proposed access matrix

The first version of this section listed 14 tables and had errors (it named `trip_live_location`, the table is `trip_live_locations`; it omitted `drive_folders`, `declaration_texts`, `schema_migrations`, sequences, functions, triggers, background jobs and command-line tools). The inventory below is complete **for the migrations in the repository**; it must be regenerated from `pg_catalog` on the staging database and compared (section 4.4).

**24 tables.** `P` = `pp_public`, `S` = `pp_staff`, `W` = `pp_worker`, `M` = `pp_migrator` only, `O` = operator CLI role (4.2). Privileges are the minimum the code appears to need; **each must be confirmed by running the service's test suite as that role**.

| Table | P | S | W | Notes |
|---|---|---|---|---|
| `schema_migrations` | - | - | - | M only |
| `email_otps`, `email_verification_tokens` | R/W, purposes `registration`, `login`, `password_reset` | **none** | purge only | Staff OTP (`staff_password`) must move to **separate tables** owned by S (finding SA-04) |
| `parent_registrations` | I/S/U | **SELECT on listed columns only** (no `verification_token_id`, `request_ip`) | S (PDF data) | No DELETE for P, S or W; deleting a row **cascades** to credentials, sessions and forms, so DELETE is O only |
| `password_credentials` | I/S/U | **none** | - | Hash material |
| `password_login_attempts` (+ sequence) | I/S/D | - | D (purge) | |
| `auth_sessions`, `auth_refresh_tokens` | I/S/U/D | **none** (S must not mint parent sessions) | D (purge) | Live-location FK to `auth_sessions` |
| `onboarding_forms` | I/S/U/D(draft) | S | S | Children's data (section 12); trigger `fill_trip` reads enrolments and trips as the writer |
| `trip_enrolments` | I/S | S | S | |
| `registration_pdfs`, `drive_folders` | I/S/U | S (status only) | I/S/U | Drive upload state |
| `declaration_texts` | S | S | - | INSERT by M only (immutable trigger) |
| `schools`, `trips`, `school_logos` | S **and a locking privilege, see 4.2 (SA-01)** | I/S/U/D | S | Staff writes audited |
| `trip_links` | - | - | - | Legacy and retired; only `catalog:cleanup` touches it (O) |
| `trip_link_lookups` (+ sequence) | I/S/D | - | D (purge) | |
| `trip_live_locations` | S/U on position and status columns | I/S/U (assignment columns, and **all columns through the trigger**, see 4.2) | D/U (purge) | Children's group location (section 12) |
| `staff_users`, `staff_sessions`, `staff_refresh_tokens`, `staff_login_attempts` (+ sequence) | **none** | R/W | purge of S-owned rows only | O for CLI provisioning |
| `audit_log` (+ sequence) | - | **INSERT and SELECT only** | - | No UPDATE, DELETE, TRUNCATE for any runtime role |

**Sequences (4):** `audit_log`, `password_login_attempts`, `staff_login_attempts`, `trip_link_lookups` ids (serial columns). INSERT needs USAGE on the sequence; grant it with the table and nothing more.
**Functions (5 in migrations, none `SECURITY DEFINER`):** `audit_log_append_only`, `onboarding_forms_lock_submitted`, `onboarding_forms_fill_trip` (019, not applied), `declaration_texts_immutable`, `trip_live_location_stop_on_trip_end`; plus a migration-time `pg_temp.portal_slug`. **Views, enums, extensions, policies: none found.** Built-ins such as `gen_random_uuid()` are executable by PUBLIC.
**Triggers (5):** `onboarding_forms_lock_submitted`, `onboarding_forms_fill_trip`, `declaration_texts_immutable`, `audit_log_no_update`, `trips_stop_live_location`.
**Background jobs and tools:** hourly housekeeping in `server.js` (parent and staff sessions, both login-attempt tables, live locations); 60 s PDF storage sweep (reads forms, writes `registration_pdfs`, calls Google Drive with scope `drive.file`, which is narrow [Code]); the OTP retention `DELETE` inside every OTP send; health probe; manual migrations; CLIs `npm run staff`, `bootstrap:admin`, `catalog:cleanup` (deletes trips, schools and touches registrations), `drive:authorize`, `drive:check`, `mail:check`.

### 4.2 Indirect privilege paths the first version missed

| Path | Why it matters | Required control |
|---|---|---|
| **Row locks need UPDATE.** `catalog/service.js` runs `SELECT ... FOR SHARE OF t` on `trips` inside every public-trip registration and enrolment (lines about 417 and 422). In PostgreSQL, `FOR SHARE` / `FOR UPDATE` requires `UPDATE` privilege on the table in addition to `SELECT` | A "read-only catalog" grant for `pp_public` **breaks registration** (SA-01) | Either a narrowly scoped `SECURITY DEFINER` function (owned by M, fixed `search_path`, returns only the fields needed) or a column-level `UPDATE` on one inert column. Verify by running registration as `pp_public` on a test database |
| **Triggers run with the caller's privileges.** `trips_stop_live_location` fires when staff change a trip's status and updates `trip_live_locations`; `onboarding_forms_fill_trip` reads `trip_enrolments` and `trips` when a parent saves a form | Without the right grants, **closing a trip or saving a form fails with "permission denied"** (SA-02) | Grant exactly what each trigger touches, and test each trigger as each role |
| **`ON CONFLICT ... DO UPDATE` needs SELECT and UPDATE** (staff team-lead assignment, password reset, PDF record, school logo) | Upserts fail under insert-only grants | Grant per statement; manifest test |
| **Foreign keys and cascades run as the table owner**, not as the caller | A role with DELETE on `parent_registrations` silently deletes credentials, sessions and forms; an FK error also reveals that an id exists | Withhold DELETE on `parent_registrations`; accept the existence signal |
| **`PUBLIC` pseudo-role** | Default `EXECUTE` on functions; on older PostgreSQL also `CREATE` on schema `public` | `REVOKE ALL ON SCHEMA public FROM PUBLIC`, `REVOKE EXECUTE ON ALL FUNCTIONS ... FROM PUBLIC` where applicable; check the Railway PostgreSQL major version |
| **Default privileges on future objects** | A new table is owned by M and is invisible, or visible to everyone, depending on defaults | `ALTER DEFAULT PRIVILEGES FOR ROLE pp_migrator` set to nothing; every migration grants explicitly; CI test (4.4) |
| **Superuser and the owner role** | Bypass every grant, can `ALTER TABLE ... DISABLE TRIGGER`, `TRUNCATE`, and set `session_replication_role = replica` (disables triggers) | Keep the platform's superuser and `pp_migrator` credentials **out of every runtime environment**; log their use externally (4.3) |
| **Advisory locks share one namespace across roles** | `pp_public` could take the lock keys staff OTP and sign-in use and stall staff sign-in | Low severity; separate the staff OTP tables and key prefixes; accept the residual |
| **Column-level needs** | `UPDATE ... WHERE col = x` needs SELECT on `col`; staff must see parents' names but not token ids or request IPs | Explicit column lists; manifest test |
| **Background jobs and CLIs run as the same single role today** | After the split they need their own identities or they re-create the single-role problem | `pp_worker`; an `O` operator role used only from an administrator's machine, **audited** (the CLIs currently write no audit rows) |
| **Cross-domain purge** | One housekeeping job purges parent and staff sessions | Each service purges its own tables, or W gets DELETE on both and is treated as high privilege |
| **The legacy combined service** (`railway.json` root: API serving the frontend, all routes, one role) | A rollback to it re-opens the single-role path | Retire it after cutover and **revoke its credentials** (SA-19) |

### 4.3 [OUT OF SCOPE under decision Q4] Audit-log design v2 (tamper-resistance and external destination)

> Not built by this project. Existing audit functionality is preserved and only its existing permissions are documented (`SCOPE-CHARTER-AND-DECISIONS.md` 4.2). The analysis below is kept so the company knows what a tamper-evident log would require if it separately asks for one.

Today: append-only by trigger, rows committed with the change, secret-looking keys stripped [Code]. **Not tamper-evident**: the application role owns the table and can drop the trigger, `TRUNCATE` is not covered by a row trigger, a superuser can disable triggers, and nothing outside the database holds a copy.
The v1 proposal (INSERT-only plus a hash chain plus an export) was **not sufficient as written**: a plain hash chain with no key and no external anchor is rebuilt by anyone who can write the table, and deleting the newest rows leaves a valid shorter chain.

| Layer | Control | Defeats | Does not defeat |
|---|---|---|---|
| 1 | Runtime roles: INSERT (and SELECT for the admin viewer) only; REVOKE UPDATE, DELETE, TRUNCATE; table owned by M; DDL event trigger that alerts on any ALTER or DROP touching `audit_log` | Application compromise editing history | Owner, superuser, platform administrator |
| 2 | **Keyed chain**: each row stores `HMAC(audit_key, previous_hmac || canonical row)`; a single head row serialises inserts (gapless sequence); the key is held by a signer **outside the database** (secret store or KMS) | DB-write-only attacker rewriting rows (no key) | Attacker who has both the key and DB write |
| 3 | **External anchor (required for any tamper-evidence claim)**: signed checkpoints `{sequence, head HMAC, time}` every few minutes to an **append-only destination the application and the database cannot overwrite or delete** (object storage with retention lock in a separate account or project, written with write-only credentials, or an external log service with a retention lock). A separate read-only verifier recomputes the chain and compares; a missing checkpoint raises an alert (dead-man's switch) | Truncation, rewriting, deletion beyond the last checkpoint | Loss inside the checkpoint interval; collusion of key holder, DB administrator and anchor administrator |
| 4 | **Platform and administrator actions** (DB superuser sessions, `pgaudit`, Railway audit and deploy logs) shipped off-platform with retention | Silent use of the credentials layers 1 to 3 do not constrain | Anything the platform does not log [Unverified what Railway exposes] |
| 5 | **Immutable offsite backups** (retention lock) | Destruction of both data and audit | |

What **requires** an external append-only destination: the checkpoints (layer 3), the platform and DB-administrator logs (layer 4), immutable backups (layer 5), and the future payment ledger export. The audit table cannot prove its own integrity.
A compromised staff API can still **append false rows**; INSERT-only protects history, not truth. Bind each row to session id, request id, service name and source address so forgeries are attributable.
Concurrency: the head-row lock is acceptable at staff volume; a high-volume payment ledger needs per-order chains or batched checkpoints.

### 4.4 Role verification: a privilege manifest, not hand-written grants

1. A **manifest** file lists, per role, every table, column set, sequence, function and the exact privilege.
2. A CI test on a migrated database **enumerates `pg_catalog`** (tables, columns, sequences, functions, triggers, views, default ACLs, role memberships, `BYPASSRLS`, superuser flags) and fails on **any object or privilege not in the manifest** (this catches a future migration that adds a table).
3. The **full service test suite runs as each runtime role** (so permission-denied breakages such as SA-01 and SA-02 surface), and the forbidden statements in the table below are executed and must fail.
4. Run the manifest test against staging after every migration.

**Secrets.** Distinct per service and per identity domain: `PARENT_HMAC_SECRET` (public API only), `STAFF_HMAC_SECRET` (staff API only), SMTP credentials per sending service, Google Drive OAuth (worker and public API only), payment provider and webhook secrets (payments service only). A service refuses to start if it can see another domain's secret.

**Network and routes.** Staff API reachable only from the staff portal's proxy / private network; public API not reachable by the staff portal; the public API contains no admin routes (they return 404, not 401).

**Verification tests (all required; written when the split is approved):**

| Test | Expected |
|---|---|
| `scripts/loadtest/exposure-check.sh` against the public API | 404 on every staff route |
| As `pp_public`: SELECT / INSERT / UPDATE / DELETE on each staff table and `audit_log` | `permission denied` |
| As `pp_public`: INSERT or UPDATE on `schools`, `trips`, `trip_links` | `permission denied` |
| As `pp_staff`: INSERT into `auth_sessions`, `auth_refresh_tokens`, `password_credentials` | `permission denied` |
| As any app role: UPDATE, DELETE, TRUNCATE on `audit_log`; DROP TRIGGER | `permission denied` |
| Forge a staff OTP token row as `pp_public`, then call the staff password-confirm route | Rejected (no table access, and a different key) |
| A parent session cookie and a mobile token against the staff API, and a staff cookie against the public API | 401 |
| Start each service with the other domain's secret present | Refuses to start |
| Stop the staff API during public load; stop the public API during staff use | The other keeps working |

## 5. Performance requirements (independent of security, same gates)

The backend must independently demonstrate, on staging sized like production: **at least 100 concurrent in-flight requests**, **at least 100 RPS predominantly registration and login traffic**, sustained, burst and multi-replica runs, and **no data-integrity violation under concurrency**. The plan, test kit, criteria and sizing estimates are in `CONCURRENCY.md` and `scripts/loadtest/`; none has been run.
Security controls (hashing cost, throttles, audit writes, same-origin checks) stay **enabled** in those runs; a test that needs a control disabled is invalid.

## 6. Future payment design (PLAN ONLY, not approved, not implemented)

Payment will be added only after explicit approval and its own threat model. The design below fixes the **constraints** now so registration, authentication and the backend need not be redesigned.

### 6.1 Principles

1. **A trusted server-side integration with a hosted payment provider.** Card entry happens on the provider's hosted page or its provider-controlled fields, so **raw card numbers and CVVs never reach this system** (no storage, no logs). The PCI scope this implies must be **confirmed with the provider and a qualified adviser** [Unverified].
2. **The server decides every amount.** Price comes from trusted tour pricing; the browser sends only an enrolment id and an idempotency key.
3. **Webhooks decide success, never the browser.** The page the parent returns to only reads server state.
4. **Payment data is its own bounded context** with its own tables, role, secrets and audit; never in the registration JSONB `answers`.
5. **Every state change is atomic, idempotent, audited and reconcilable.**

### 6.2 Data model (conceptual; no schema is created)

| Table | Purpose |
|---|---|
| `trip_prices` | Effective-dated price per trip: integer minor units, ISO 4217 currency, version. Set by staff, audited. |
| `payment_orders` | One order per enrolment attempt: enrolment id, trip, **price version, amount and currency snapshot**, state, provider order id, created / expires. Partial unique index: at most one active order per enrolment. |
| `payment_attempts` | Each provider attempt under an order (failed attempts are kept). |
| `payment_events` | Webhook inbox: provider event id **UNIQUE**, raw body hash, signature result, received / processed time, outcome. Gives duplicate-event protection and a replay record. |
| `payment_ledger` | Append-only money movements (charge, refund, chargeback, adjustment), signed integer minor units, linked to order and event; hash-chained like the audit log. |
| `refunds` | Refund requests: order, amount, reason, requested by / approved by (staff), state, provider refund id, idempotency key. |
| `idempotency_keys` | Scope, key, request hash, stored response; same key with a different request is refused. |
| `reconciliation_runs` | Each run's window, counts, differences found, resolution. |
| `enrolment.booking_status` (column) | The booking outcome, changed only by the payments path (below). |

Amounts are **integers in minor units with a currency code**; never floating point. Only provider ids, brand and last four digits (if the provider supplies them) are stored.

### 6.3 Flow

1. **Create order.** Signed-in parent calls the public API with `{ enrolmentId }` and an `Idempotency-Key`. The server checks the session owns the enrolment, the trip is open and paid, no active or paid order exists; reads the **current trusted price**; in one transaction inserts `payment_orders` (state `created`) with the amount snapshot. It then asks the provider to create an order or hosted checkout (provider call carries the idempotency key) and returns only the redirect or token.
2. **Pay.** The parent pays on the provider's page. Nothing the browser sends is trusted as proof.
3. **Webhook.** A dedicated endpoint reads the **raw body**, verifies the provider's **signature** in constant time with a **timestamp tolerance**, inserts the event into `payment_events` (**duplicate event id is refused**, answered 2xx), and processes in **one transaction**: lock the order row, check the order exists and that **amount and currency equal the snapshot**, apply the state-machine transition (only legal transitions: for example `created -> paid`, `paid -> refunded`), update `enrolment.booking_status`, append the ledger and audit rows. Unknown or illegal events are stored and alerted, not applied. Answers fast; heavy work is queued.
4. **Return page.** Polls the server for the order state; shows "pending" until the webhook has been processed. No frontend-only success decision.
5. **Reconciliation.** A scheduled job lists the provider's transactions and settlements and compares them with orders and the ledger; missed webhooks are recovered for orders pending longer than a set time; differences open a review item and an alert. Runs daily at least.
6. **Refunds and failures.** Refunds are initiated by authorised staff through the staff API with a reason; amount cannot exceed what was captured; large refunds need a second approver (**decision**); the provider call carries an idempotency key; state and ledger update on the provider's confirming event. Failed, expired and abandoned orders end in explicit states and release the booking; a retry creates a new attempt, not a second order. Chargebacks arrive as events and create ledger and review entries.

### 6.4 Placement under Option C

A **separate payments service** is recommended when payments are built, with its own DB role (`pp_payments`), its own provider and webhook secrets, and the only public inbound route for provider callbacks. Reasons: a compromise of the public API then cannot mark an order paid, read provider keys or alter the ledger;
the payments service cannot read passwords or sessions. The public API calls it (or the database through a narrow function) to create orders. Refund approvals live in the staff API and reach the payments service through a restricted, audited path. This is only possible if the **role and secret split in section 4 exists first**, which is why that work comes before payments.

### 6.5 Threats this design must answer (to expand in the full threat model)

Price tampering (amount never taken from the client); forged or replayed webhooks (signature, timestamp window, unique event id); duplicate payment from double clicks or retries (idempotency keys, one active order per enrolment); race between webhook and return page (state only changes in the webhook transaction); amount or currency mismatch (checked against the snapshot); IDOR on orders (ownership from session, unguessable ids, ownership check on every read); refund abuse (role, limits, second approval, audit); provider-charged-but-local-failed (reconciliation); secret leakage (separate role and secrets, rotation, dual-secret window for webhook secrets); denial of service on the webhook endpoint (cheap signature check first, size limit); logs containing payment data (redaction, no card data ever present).

### 6.6 What must exist before payment work starts (readiness checklist)

DB role and secret split (section 4); hardened, tamper-evident audit (section 3); a background worker with an outbox (receipts, reconciliation); a generic idempotency-key mechanism; distributed rate limiting; the booking aggregate (`trip_enrolments`) with an explicit booking status; trusted `trip_prices`; payment types added to `@pp/contracts`; monitoring and alerting; a tested backup and restore; the independent review process (section 7). The existing `trips.payment_mode` and the `paymentView` stub (reports `not_configured`, never "paid") already point the right way and **must not be changed to report success** before a verified integration exists.

### 6.7 Decisions not made

Payment provider and region/currency; refund approval policy; whether instalments, discounts, taxes or deposits are needed; seat holds while a payment is pending; legal and data-protection review for payments and for children's data; PCI scope confirmation.

## 7. Security verification process (every significant feature)

1. **Threat model before implementation**: assets, actors, trust boundaries, data flows, threats per element (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege), controls, residual risk, owner. Stored with the feature; reviewed again when the design changes.
2. **Tests written with the feature**: unit and integration tests; **regression tests for every defect found**; authentication, authorization and tenant-isolation tests (the route matrix, ownership per resource, wrong-role per route); **attack tests**: privilege escalation (parent to staff, sales to admin, parent A to parent B), replay (OTP, verification token, refresh token, webhook), race conditions (duplicate registration, double spend of a token, concurrent refresh, concurrent payments), invalid and hostile input (oversized, wrong type, unicode, injection strings), CSRF and cross-origin attempts.
3. **Vulnerability reports** use a fixed form: ID; title; **severity** (Critical, High, Medium, Low, with the rule used, for example CVSS and business impact); affected component and version; preconditions; **reproduction steps**; evidence; impact; remediation; owner; status; retest result. No finding is closed without a retest.
4. **Independent security review before any production release** that handles real personal data or money: someone who did not write the code, with a written scope, and findings tracked to closure. Payment needs a dedicated review before go-live.
5. **Release gate** (all must be true): threat model current; tests green including attack tests; dependency audit with no unaccepted high or critical production advisory; secret scan clean; load and integrity tests passed on staging (`CONCURRENCY.md`); boundary tests (section 4) passed; backup restore tested; alerts and runbook in place; review findings closed or formally accepted.
6. **Ongoing**: dependency and configuration review on a fixed schedule, secret rotation dates, restore drills, alert tuning, periodic repeat review.

Existing adversarial tests (a start, not a review): `csrf`, `hardening`, `security-probe`, `token-attacks`, `pdf-storage-attacks`, `registration-pdf-attacks`, `sales-ownership`, `password-auth`, `staff-auth`, `form-validation-api` [Test, authored with the code, not independent].

## 8. Sequencing (each step needs approval; none started)

| Step | Work | Exit gate |
|---|---|---|
| S0 | These documents; decisions in section 9 | Lead approval |
| S1 | Hardening that needs no architecture change: CI with audit, secret scan and SAST; log redaction review; distributed rate limiting for all limiters; audit hardening (INSERT-only grants plan, hash chain design, PII-read audit); `TRUST_PROXY_HOPS` measured; backup restore test; alerting and runbook | Gate list in section 7.5 for these items |
| S2 | Capacity changes from `CONCURRENCY.md` section 4 and the staging load tests | R1, R2, integrity passed |
| S3 | Option C split with DB roles, secrets and boundary tests (section 4) | All boundary tests pass |
| S4 | Worker and outbox; idempotency mechanism; `trip_prices` and booking status design | Readiness checklist (6.6) complete |
| S5 | Payments (only when approved): threat model, build, attack tests, independent review, staging soak, reconciliation drill | Release gate (7.5) |

## 9. Unknowns, risks and decisions for the lead

**Unknowns [Unverified]:** who can read Railway secrets and deploy; backup frequency and restore time; TLS and redirect behaviour on real domains; real client-address header chain; log retention and access; SMTP provider limits and credentials handling; Railway hardware for hash cost; whether the Railway PostgreSQL allows multiple roles and what `max_connections` is.

**Decisions needed:**
1. Approve Option C as the target **conditional on** the section 4 boundary tests, or choose A-only (then the privilege split is not achieved).
2. Approve the sequence in section 8 and which S1 items go first.
3. Approve separate signing secrets and the rotation approach (dual-key window; one-time sign-out acceptable?).
4. Audit design: hash chain, off-database export destination, and which staff **reads** of personal data to audit.
5. Edge protection (WAF or CDN rate limiting) and CAPTCHA policy for sign-in and OTP.
6. Payment: provider, currency, refund approval policy, whether a separate payments service is accepted, and who performs the independent review.
7. Legal and data-protection review (children's data, payments) and the owner of that review.
8. Who owns incident response, on-call, and the restore drill schedule.

## 10. Independent review of this document: findings

Reviewer: Claude, second pass over the first version of this document, reading the code, migrations, the web client and the mobile app, and running `npm audit` (reads the lockfile; sent only package names and versions). Not a penetration test; nothing was executed against a database or a running service. **Verification method** says how each finding is proven or disproven; none of those tests has been run, because no PostgreSQL is available here.
Severity: **High** (a plan step would break a core flow, or a protection described does not hold), **Medium**, **Low**, **Info**. Status: **Corrected** (text fixed in this document), **Recorded** (needs a decision or later work).

| ID | Sev | Finding | Evidence | Verification method | Remediation | Status |
|---|---|---|---|---|---|---|
| SA-01 | High | The role plan would **break registration and enrolment**: `pp_public` was given read-only catalog access, but registration runs `SELECT ... FOR SHARE OF t` on `trips`, which PostgreSQL permits only with `UPDATE` privilege as well | `catalog/service.js` lines about 417 and 422 (`resolvePublicTripForRegistration`, `FOR SHARE OF t`); `registrations/service.js` calls it | On a test database, as a role with only `SELECT` on `trips`, run the query: expect `permission denied for table trips` | `SECURITY DEFINER` function with fixed `search_path`, or one inert column-level `UPDATE` (4.2) | Corrected (4.2) |
| SA-02 | High | Triggers run with the caller's privileges (no `SECURITY DEFINER` anywhere). `trips_stop_live_location` makes a staff trip-status change write `trip_live_locations`; `onboarding_forms_fill_trip` makes a parent's form save read `trip_enrolments` and `trips` | migrations 018 and 019; grep found no `SECURITY DEFINER` | As each role, change a trip's status and save a form: expect success only with the grants in 4.1 | Grant per trigger; run the full suite per role (4.4) | Corrected (4.1, 4.2) |
| SA-03 | High | The role separation did **not account for every object**: wrong table name, missing `drive_folders`, `declaration_texts`, `schema_migrations`, 4 sequences, 5 functions, 5 triggers, background jobs, 6 CLIs, `PUBLIC` privileges, default privileges, cascades, superuser and advisory locks | Migrations 001 to 019; `grep` of tables by module | Regenerate the inventory from `pg_catalog` on staging and diff against the manifest (4.4) | Full inventory and manifest test | Corrected (4.1 to 4.4) |
| SA-04 | Medium (High if the signing secret is not split) | Staff one-time codes share `email_otps` and `email_verification_tokens` with parents. `pp_public` could **read staff email addresses and code rows and invalidate staff codes** (denial of staff password setup and reset). Forging a verified token needs the staff HMAC key, which is why the secret split matters | `staff/password-service.js` uses `email_verification_tokens`; purpose `staff_password` | As `pp_public`: `SELECT email_normalized FROM email_otps WHERE purpose='staff_password'` | **Mandatory:** separate staff OTP tables (or row-level security with a `WITH CHECK` on purpose) **and** separate keys. The first version said "or"; it is "and" | Corrected (4.1) |
| SA-05 | High | The audit design was **not tamper-resistant** as first described (see 4.3): unkeyed chain, no external anchor, TRUNCATE and trigger removal by the owner, superuser bypass, undetectable tail deletion, forged entries by a compromised staff API | `009_audit_log.sql`: `BEFORE UPDATE OR DELETE` row trigger only; application role owns the table | As the application role: `TRUNCATE audit_log;` and `ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;` today: both succeed | Layers 1 to 5 in 4.3; an **external append-only destination is required** | Corrected (3, 4.3) |
| SA-06 | High (advisory); exploitability in this app Low | `body-parser` 2.3.0: denial of service via trailing bytes after a compressed body (GHSA-27r3-jxmh-p828, affects `>=2.0.0 <2.4.0`). Every parser in this repository sets `inflate: false`, so compressed bodies are refused before parsing, which is why exploitability is low. The lockfile still holds the vulnerable version | `npm audit`; grep: no `express.json/raw/urlencoded/text` without `inflate: false` | `npm ls body-parser` shows 2.3.0 | Move the lockfile to **body-parser 2.4.0**. Express 5.3.0 (latest) declares `^2.3.0`, so this is a **lockfile-only update**, no `package.json` change and no override (section 14) | Recorded (needs approval) |
| SA-07 | Medium (advisory); exploitability Low | `nodemailer` 10.0.15: three address-parser flaws (comment, `;` in a quoted string, `>` in a quoted local part) can turn text into an extra recipient (GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h; range `>=3.0.0 <10.1.4`); `npm audit` names **10.6.0** as the fix. The API validates every recipient with a strict regex that rejects quotes, comments, `<`, `>`, `;`, so user input cannot reach the parser in that form. `SMTP_FROM` is configuration | `npm audit`; `email-otp/validation.js` regex | Unit test sending `a"b@x.org`-style input: refused by validation; after the upgrade `npm test` and `npm run mail:check` against the sink | Upgrade to **nodemailer 10.6.0** (non-major; the version is pinned exactly in `apps/api/package.json`, so that line changes) | Recorded (needs approval) |
| SA-08 | Low | `eslint` and `minimatch` (dev tooling only): minimatch denial of service (GHSA-g3hv-75wg-m249) | `npm audit`: fix available, not a major bump | `npm ls minimatch eslint` | Update eslint to the version `npm audit fix` reports; no runtime impact | Recorded |
| SA-09 | Medium | **Claims stronger than the evidence** in the first version: "every request body is a strict schema" (true for the body routes read; some query parameters are ad hoc); "never a client-sent id" (the client sends `enrolmentId`; filtered by session in the code spot-checked); "parameterised queries" (grep-level only); "staff management audit unclear" (it is audited; the CLI is not); "tamper-evident audit"; "Secure cookies in production" (depends on `NODE_ENV`); "parent and staff tokens are not interchangeable" (by cookie names and HMAC domain strings in code; the token tests were not reviewed) | See the corrected rows in 2.2 and 2.3 | Per row | Reword; add the route authorization and ownership matrix tests (7) | Corrected |
| SA-10 | High | **No multi-factor authentication for staff**, who can read children's personal data. Staff sign in with email and password; the code uses email codes only for first-time setup and reset | `staff/routes.js` login schema is email and password | Attempt staff sign-in with a known password only | **Mandatory MFA for admin and for any staff with access to personal data** (TOTP or a hardware key); session binding and re-authentication for exports | Recorded |
| SA-11 | High | **No retention, deletion or erasure design for children's data.** Code purges expired sessions, login-attempt rows, live positions and draft forms only. Registrations, submitted forms and **PDF copies in Google Drive** are never deleted | housekeeping in `server.js`; `onboarding_forms` delete is draft-only; `drive-client` has no delete | Search the code for deletion of submitted forms or Drive files: none | **Mandatory** before production use: retention schedule, erasure procedure that covers the database, backups, Drive and email logs, and a deletion record | Recorded |
| SA-12 | Medium | PDF copies of each registration (with the child's data) live in one Google account reached by a single OAuth refresh token held in an environment variable. Scope is `drive.file`, which is narrow [Code], but account compromise exposes every PDF; no MFA, membership, or alerting is specified | `pdf-storage/oauth.js` scope; GOOGLE_DRIVE_SETUP.md | Review the Drive account's sign-in methods and sharing | **Mandatory** controls: dedicated account, hardware MFA, no other members, alert on new OAuth grants and on bulk download, restore of the token on compromise; decide whether Drive copies are needed at all | Recorded |
| SA-13 | Low | The registration form lets a person choose their own `role` (`Student`, `Teacher`, `Team Leader`). Live-location eligibility filters on it (`r.role = ...`), so a self-declared "Team Leader" appears as a candidate for staff to assign. Staff assignment is the real control and is audited (`trip.team_lead_assign`) | `live-location/service.js` lines about 206 and 230 | Register as `Team Leader` and check the staff candidate list | Staff confirm identity out of band before assigning; never authorise anything from `role` alone | Recorded |
| SA-14 | Medium | Registration proves control of an **email address**, not guardianship or identity. Anyone can register against any open public trip page and submit data about any child | `registrations/service.js` | Register with a throwaway mailbox | Staff reconciliation against school lists (**mandatory process**); optional approval state before staff see data as verified | Recorded |
| SA-15 | Medium | Live location of a children's trip group: who may read the position is not documented beyond the team lead and staff; the map draws tiles from a third-party tile server (viewer address and viewport leak) | `live-location/routes.js` `GET /`; CSP `img-src https:` | Read `service.view` and `staffView` for who gets coordinates | Document and test who sees positions; self-host or proxy tiles; audit staff reads of positions | Recorded |
| SA-16 | Medium (**implemented**: per-variant hosts, `DEPLOYMENT.md`) | **Option C breaks the staff "copy the trip link" workflow**: the staff panel builds links from one `PUBLIC_BASE_URL`; with four portals each variant has a different host | `catalog/service.js` lines about 89 to 92; `PUBLIC_BASE_URL` config | In staging, create a trip of each variant and compare the displayed link with the portal that serves it | Per-variant base URL map in the staff API configuration (`tour_type`, `payment_mode` to host); test for all four | Recorded (13) |
| SA-17 | Medium | Splitting the signing secret can **end every parent, staff and mobile sign-in and invalidate pending codes** if done naively (hashes of tokens are stored with the old secret) | `sessions/token-sessions.js` hashing; `config.js` uses `OTP_HMAC_SECRET` for all domains | In staging, change the secret and sign in with an existing session | Keep the current value as `PARENT_HMAC_SECRET` (parents and mobile stay signed in); issue a **new** `STAFF_HMAC_SECRET` (staff sign in once); later rotate the parent value with a dual-key lookup window (13) | Recorded |
| SA-18 | Medium | The mobile app has the API origin **built in** (`EXPO_PUBLIC_API_BASE_URL`); installed apps cannot be repointed without a store release | `apps/mobile/src/config.ts` | Check which origin shipped builds use | The public API must keep serving `/api/mobile/*` at the existing origin; the staff API gets a new one (13) | Recorded |
| SA-19 | Medium | A rollback to the legacy combined service (`railway.json`: one process, all routes, one DB role) re-opens the single-role path | `railway.json`, `ARCHITECTURE.md` | | Retire the service after cutover and revoke its database credential and secrets | Recorded |
| SA-20 | Low | Background purges cross the domains the split separates; `cookieSecure` depends on `NODE_ENV`; advisory-lock namespace shared | `server.js`, `config.js`, `repository.js` | | Per-service purge or a high-privilege worker; startup assertion that production runs with `Secure` cookies and TLS | Recorded |
| SA-21 | Info | **Claims that held up:** CSPRNG codes, keyed single-use OTP, reuse-detecting refresh tokens, cookie flags, decoy hash for unknown emails, strict schemas on all body routes read, request-size limits and `inflate: false` on every parser, generic 500 bodies, narrow Drive scope, logo check by file bytes, `audit_log` rows stripped of secret-looking keys, no `SECURITY DEFINER` functions | Code | | None | Verified |

## 11. Mandatory requirements and optional improvements

**Mandatory** means: the item must be done and its test must pass before the stated milestone. **Optional** means useful, not a release condition.

| # | Requirement | Milestone | Mandatory |
|---|---|---|---|
| M1 | Separate DB roles, with the privilege manifest test and the service suite run per role (4.4); SA-01, SA-02, SA-03 resolved | Option C go-live | **Yes** |
| M2 | Staff OTP tables and signing keys separate from parents' (SA-04, SA-17) | Option C go-live | **Yes** |
| M3 | Public API contains no staff routes; exposure and cross-token tests pass | Option C go-live | **Yes** |
| M4 | Dependency updates: body-parser 2.4.0, nodemailer 10.6.0, eslint tooling (section 14); CI audit gate for production dependencies | Before any production use with real data | **Yes** |
| M5 | MFA for staff (admin first) (SA-10) | Before staff handle real children's data | **Yes** |
| M6 | Retention schedule and an erasure procedure covering database, backups, Drive and email (SA-11) | Before real children's data is collected | **Yes** |
| M7 | Backups with a timed, tested restore; backups encrypted and access-controlled | Before production | **Yes** |
| M8 | Monitoring and alerting for: refresh-token reuse, login failure spikes, 503 busy, 5xx, DB saturation, audit anchor gaps; an incident runbook and a named owner | Before production | **Yes** |
| M9 | Distributed rate limiting for every limiter; `TRUST_PROXY_HOPS` measured | Before multi-replica production | **Yes** |
| M10 | Route authorization and ownership matrix tests; independent review of the final system | Before production | **Yes** |
| M11 | Secrets in the platform store; named owners; rotation procedure with dual-key window | Before production | **Yes** |
| M12 | Drive account hardening or removal of Drive copies (SA-12) | Before production | **Yes** |
| M13 | Audit: INSERT-only roles and DDL alerting (layers 1 and 4 of 4.3), and PII-read auditing for staff | Before staff handle real data | **Yes** |
| M14 | Staff reconciliation process for registrations (SA-14) and team-lead identity confirmation (SA-13) | Before production | **Yes** (process) |
| M15 | Payment items in 6.6, threat model and independent payment review | Before payments, **not** before the current phase | **Yes**, for payments only |
| O1 | Keyed chain and **external anchor** for the audit log (layers 2, 3, 5 of 4.3) | Before payments (then **mandatory** for the ledger) | Optional now; mandatory for any claim of tamper-evidence and for payments |
| O2 | Row-level security for staff scoping (sales vs admin) | Later | Optional |
| O3 | `__Host-` cookie prefix; CSP without `unsafe-inline` styles; Trusted Types | Later | Optional |
| O4 | CAPTCHA on OTP send and sign-in; WAF | After measuring abuse | Optional (edge rate limiting is part of M9 scope) |
| O5 | Self-hosted map tiles (SA-15) | Later | Optional |
| O6 | Breached-password check on registration | Later | Optional |
| O7 | PgBouncer; read replica for reporting | If capacity requires | Optional |
| O8 | SBOM, build provenance, signed images | Later | Optional |

## 12. Threats for a parent portal that holds children's personal information (company risk record; **mitigations here are not part of the separation project**)

Data held (from the onboarding definitions and tables): parent and child names, dates of birth and age, gender, **allergies and health notes**, **passport numbers and validity** (international trips), school, trip, parent phone and email, a typed signature name and declaration acceptance, submitted PDFs, and the **live location of a trip group** while sharing.
This was missing or thin in the first version.

| Threat | Why it matters here | Control (all recorded; none implemented) |
|---|---|---|
| Insider misuse or curiosity by staff (read access to all or many forms) | Staff roles are scoped in application code only; no MFA; PII reads are not audited | M5, M13; least-privilege staff scoping; export controls; alert on bulk reads |
| Account takeover through the parent's **email account** | OTP login and password reset trust the mailbox | Notice emails on sign-in, password change and new device; short code lifetime (exists); optional MFA |
| Impersonation of a guardian (SA-14) | Any email can create a registration with a child's data | M14; staff reconciliation |
| False or malicious data entry, and **mail abuse** (OTP sends to arbitrary addresses, bounded to 5 per address and 20 per IP per hour) | Harassment and reputation damage to the sending domain | M9; per-recipient and global send caps; SPF, DKIM, DMARC |
| PII in third-party systems: Google Drive PDFs, SMTP provider, Railway, map tile server | Subprocessors hold children's data; breach or compromise there is a breach for us | M12; subprocessor list, regions, contracts, deletion terms; legal review |
| **Retention and erasure** (SA-11), including **backups, Drive and log copies** | Keeping children's data longer than needed increases harm and legal exposure | M6 |
| **Minors' data and consent**: who consents for a child, what the declaration covers, what the law requires where the families live | Legal duty, not only a technical one | Counsel review (decision 7 in section 9); keep the versioned, immutable declaration text (exists) |
| **Breach response and notification** | Duty and deadlines depend on jurisdiction | M8 runbook; counsel; contact list; evidence preservation |
| **Live-location safeguarding** (SA-15) | A trip group's real-time position is sensitive; exposure to the wrong person is a physical-safety risk | Access limited to staff and the assigned lead, expiry and wipe (exists: 24 h retention, wiped at trip end), audit of reads, no history kept |
| Shared or school devices left signed in | Children's data visible to the next user | Idle timeout (exists, 3 days parent default: consider shorter), sign-out everywhere, no autofill of sensitive fields |
| Data in tests, staging and logs | Real children's data copied to lower environments | **Rule: only synthetic data outside production**; the load-test kit already uses synthetic identities; log redaction review (M8) |
| Exports and PDFs shared by email or chat by staff | Uncontrolled copies | No PDF by email; download audit; watermarking optional |
| Enumeration of schools and trips from public pages | Low sensitivity; school names are public | Accept; rate limits exist |

## 13. Option C compatibility with the mobile app, sessions, registration and staff workflows

Checked from the code; each item is **predicted**, not tested.

| Area | Finding | Condition for it to keep working | Verify |
|---|---|---|---|
| Existing **parent sessions** | Cookies and tokens are hashed with `OTP_HMAC_SECRET` (domain-separated). Names, paths and proxy host are unchanged by the split | The public API runs with the **current** secret value as `PARENT_HMAC_SECRET`. The staff API gets a new value, so staff sign in once. Rotating the parent value later needs a dual-key lookup (SA-17) | Before cutover, sign in on the old service, then use the same cookie on the new public API |
| **Mobile app** (team leaders) | Uses `/api/mobile/*` with Bearer tokens, an origin baked into the build, password sign-in (a hash, so it counts toward capacity), and the live-location routes. No Origin header, so the same-origin check passes | The public API keeps that origin; mobile tokens keep their own hash domain and the same secret | Run the mobile app against staging: login, list trips, start, post location, stop, refresh, logout |
| **Registration flow** | Needs the trip row lock (SA-01), form triggers (SA-02), OTP tables and sessions, all on `pp_public` | Grants per 4.1 and 4.2; the full registration test suite passes as `pp_public` | Suite per role (4.4) |
| **Staff workflows** | Create and edit schools and trips (the trigger writes `trip_live_locations`, SA-02), assign a team lead (writes `trip_live_locations`, reads enrolments), view registrations and PDF status, staff sign-in and password reset (own OTP tables, SA-04), audit viewer | `pp_staff` grants per 4.1; staff API has its own SMTP sender and OTP tables; per-variant link host map (SA-16) | Staff end-to-end test per role: every action once |
| **Shared tables written by both sides** | `trip_live_locations` (staff assignment, parent or mobile position); `trips` (staff write, public read with a lock) | Column-level grants, or split into assignment and position tables | Role tests |
| **Portals and proxies** | Public portals proxy `/api` to the public API; the staff portal to the staff API; Host and Origin stay same-origin | Portal `API_URL` set per service; staff API reachable only from the staff portal | Exposure and cross-token tests (4) |
| **Rollback** | The legacy combined service can serve everything again | It stays only until cutover, then its credentials are revoked (SA-19) | Checklist item in the cutover runbook |
| **Capacity** | Hash work stays in the public API; staff API is small | `CONCURRENCY.md` | Load tests |

## 14. Dependency advisories: recommended versions (not applied)

`npm audit` on the current lockfile (run during this review; it read the lockfile and sent package names and versions only):

| Package | Installed | Advisory | Severity | Recommended | Change needed | Exposure in this app |
|---|---|---|---|---|---|---|
| `body-parser` (via `express` 5.3.0) | 2.3.0 | GHSA-27r3-jxmh-p828, DoS via trailing bytes after a compressed body, `>=2.0.0 <2.4.0` | **High** | **2.4.0** | Lockfile only: `express` 5.3.0 declares `^2.3.0`, so `npm update body-parser` within the workspace resolves 2.4.0. No `package.json` or override change | Low: every parser sets `inflate: false`; keep that setting as defence in depth |
| `nodemailer` | 10.0.15 (exact pin) | GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h (address parser), `>=3.0.0 <10.1.4`; `npm audit` names 10.6.0 | Moderate | **10.6.0** (current latest, non-major) | Edit the pin in `apps/api/package.json` and refresh the lockfile | Low: recipients are validated by a regex that rejects the trigger characters |
| `minimatch` (via `@eslint/config-array`, `eslint`) | 10.2.6 | GHSA-g3hv-75wg-m249, DoS, `>=7.0.0 <11.0.1` | Moderate | the version `npm audit fix` reports (non-major) | Dev dependency update | None at runtime (lint only) |
| `eslint`, `@eslint/config-array` | 10.12.0, 0.23.5 | via `minimatch` | Moderate | with the minimatch fix | Dev dependency update | None at runtime |

Procedure when approved (not run): update on a branch, `npm ci`, `npm test` (API and web), `npm run mail:check` against the sink, `npm audit --omit=dev` must report no high or critical, review the lockfile diff for unexpected packages, record in the change log. **Policy:** an advisory is not kept to avoid lockfile churn; a deliberate exception needs a written reason, an owner and an expiry date. Add `npm audit` to CI (M4).

## 15. Review result

The direction (Option C with real DB-role, secret and route boundaries, audit hardening, payment as a separate bounded context) **stands**. The review found that the first version **would have broken registration and staff trip changes if its grants had been implemented as written** (SA-01, SA-02), **overstated the audit design** (SA-05), **retained a high advisory** (SA-06) and **missed the children's-data threats** (section 12). These are corrected in the plan. **Nothing was implemented.** Approval is requested for: the dependency updates (section 14), the mandatory list (section 11), and the next planning step.

## 16. Follow-up review (privilege manifest and dependency plans)

Second-pass findings, with evidence and remediation, are in `DB-PRIVILEGE-MANIFEST.md` 12 (SA-22 composite foreign key for forms, SA-23 staff grants narrowed, SA-24 retention purge and Drive upload out of the public process, SA-25 advisory-lock exposure, SA-26 backups must include roles and ACLs, SA-27 no definer functions or views exist today) and `DEPENDENCY-UPDATE-PLAN.md` 9 (SA-28 the mobile app's separate lockfile reports 17 vulnerabilities including 2 high, mostly build tooling, shipped-bundle exposure unverified; SA-29 one new transitive dev package). The mandatory list M1 to M15 is preserved in `SECURITY-REQUIREMENTS-M1-M15.md`, every item **Not started**.

## 17. Lead decisions applied (D1 to D8 and dependencies)

D1 definer function for the registration trip lock (kept lock, no broad UPDATE); D2 worker in S4 with the public API's interim permissions listed exactly; D3 `audit_append` with the role migration and **no tamper-evidence claim until external anchoring and independent storage are operational and tested** (this supersedes the "optional now" wording in 4.3: the controlled-entry function and INSERT-only roles are adopted now; layers 2, 3 and 5 remain required for any tamper-evidence claim); D4 Railway capabilities verified first on disposable staging with fallbacks; D5 composite foreign key subject to data, safety, rollback and regression checks; D6 PDF retry kept, expensive work moved to the worker with idempotent jobs; D7 default-deny staff access with a proposed matrix for company approval; D8 connection limits and timeouts derived from measured capacity. Dependency decisions: `body-parser` 2.4.0, `nodemailer` 10.6.0 (verified patched and compatible), `minimatch` 11 and its new transitive package reviewed, security patches not subject to the seven-day rule, separate mobile review (no Expo downgrade). Details: `DB-PRIVILEGE-MANIFEST.md` 13, `DEPENDENCY-UPDATE-PLAN.md` 10.
New finding **SA-30 (High)**: passport and PAN numbers, health and address data are stored as plain JSON and copied into PDFs (`DB-PRIVILEGE-MANIFEST.md` 12). Open questions D9 and Q1 to Q5 are in manifest 13.

## 18. Scope charter overrides (2026-11-19)

`SCOPE-CHARTER-AND-DECISIONS.md` governs. Summary: SA-30 field protections, the worker and the PDF-retry redesign (D9), `audit_append` and every external audit mechanism (Q4) are **out of scope or withdrawn**; existing PDF/Google Drive behaviour, existing logging and audit, and every existing workflow are preserved; the backend and database-role split (Option C) is a **proposal needing explicit approval**, with the functionality at risk listed in charter section 6. Items M5 to M8, M11, M12, M14 and M15 remain on the company's security list but are **outside the separation project**.
