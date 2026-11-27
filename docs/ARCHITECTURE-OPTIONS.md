# Backend architecture options: shared, per-portal, or hybrid

Status: **evaluation and recommendation only. Nothing is implemented, deployed, migrated or committed.** Phase 2 is not started.

> **SCOPE NOTICE: `docs/SCOPE-CHARTER-AND-DECISIONS.md` governs.** **Option A (one API, today's structure, with the four portals and staff portal as separate frontend deployments) is the baseline.** Option C (separate staff API and database roles) is a **proposal that needs explicit approval**, justified only by the demonstrated single-role exposure; its functionality-at-risk list is in the charter, section 6. Option B is rejected. The worker, the separate payments service and any new database are **not** part of this project. Everything in 7a and 8 that mentions a worker, `audit_append`, external audit or SA-30 protections is **withdrawn**.
Companion documents: `docs/ARCHITECTURE.md` (current monorepo), `docs/CONCURRENCY.md` (capacity review, acceptance criteria), `docs/SECURITY-ARCHITECTURE.md` (permanent security requirements, verified current state, boundary tests, future payment design), `scripts/loadtest/` (test kit).

The lead's priority is a secure, reliable, scalable, maintainable system, not a small number of services.

Two **confirmed, separate** acceptance requirements apply to every option: **R1, at least 100 concurrent in-flight requests, and R2, at least 100 requests per second, with the 100 RPS workload mostly parent registration and login submissions (R2a).** Neither proves the other
(`CONCURRENCY.md` section 1). **No option is claimed to meet either. That is decided only by a reproducible staging load test (`CONCURRENCY.md` sections 5 and 6), which has not been run.**

**Option C is retained as the preferred candidate, subject to verification** (section 7). It is only preferred if the security conditions in section 7a are met and verified; separate deployment alone is not a security boundary.

Evidence labels: **[Code]** read in this repository. **[Unverified]** assumption, not measured or not confirmed with Railway / PostgreSQL.

## 1. Facts that decide the comparison

1. **The four public variants are data, not code.** A variant is `trips.tour_type` x `trips.payment_mode` (generated `template_key`). Registration validation
   (`registrations/validation.js`), OTP, sessions, onboarding and PDF are one code path for all four. [Code]
2. **Staff code is already a separate router.** `app.js` mounts `/api/admin` (staff auth, staff management, catalog admin, live-location staff view) apart from the public routes,
   with its own cookie, session tables (`staff_sessions`, `staff_refresh_tokens`), login-attempt table and role middleware. [Code]
3. **But the two sides share services and one database identity.** Staff and parents share the OTP service (`staff_password` purpose), the catalog service (public `/api/join` and staff admin), the
   scrypt `passwordGate`, the SMTP sender, one `DATABASE_URL` (one PostgreSQL role) and one `OTP_HMAC_SECRET` (domain-separated inside the code). [Code]
4. **Tenant isolation is application logic.** "School", "trip" and "variant" are rows in one schema. Isolation is enforced by queries and foreign keys (Phase 1 migration `019`
   adds composite keys; **not applied anywhere yet**), not by process or database boundaries. [Code]
5. **Everything is stateful in PostgreSQL already** (sessions, OTP, throttles, leases), so any option can run several instances of a service. In-memory limiters are the exception. [Code]
6. **There are other clients:** the Expo team-leader app uses the parent session and the live-location and mobile routes of the same API. [Code]
7. **There is no payment gateway and no ERP code yet.** `packages/contracts` defines an ERP-ready registration record only. [Code]

## 2. The three options

```
A. One shared backend                     B. Four public backends + staff backend        C. Shared public API + staff API

 DF   DP   IF   IP    ST                   DF     DP     IF     IP     ST                DF   DP   IF   IP      ST
  \    \    |    /    /   (web-servers)     |      |      |      |      |                 \    \    |    /      |
   \    \   |   /    /                      v      v      v      v      v                  \    \   |   /       |
    +----> API (xN) <--+                    API-DF API-DP API-IF API-IP API-ST             API-public (xN)    API-staff (xM)
              |                                |      |      |      |      |                   |                  |
              v                                +------+------+------+------+                   +--------+---------+
        PostgreSQL (one)                                    |                                           |
                                                      PostgreSQL (one)                           PostgreSQL (one)
                                                                                         (two DB roles, least privilege)
 shared code: one package                  same code x5 (copies or one image, 5 configs)  shared code: packages/core used by both entrypoints
```
DF/DP/IF/IP = domestic/international x free/paid portals. ST = staff portal. Each portal keeps its small web-server proxy in every option.

### Option A: one shared backend
Today's design. Scale by running more identical replicas behind Railway's load balancing (private networking round-robin; **[Unverified]** exact balancing behaviour: confirm).

### Option B: four public backends and a staff backend
Five API services. Because the variants are data, the four public backends would run the **same code with different configuration**, or diverge as copies. Either way they connect to the one database.

### Option C: shared public API and independent staff API (preferred candidate)

Components:

- **Four independent public frontend deployments** (`apps/portal-domestic-paid`, `-domestic-free`, `-international-paid`, `-international-free`), each a static site plus the small `apps/web-server` proxy, forwarding `/api` to the **one shared public API**. A portal can be redeployed or rolled back without touching the API or the other portals.
- **Shared public API** (`apps/public-api`, new): registration, email OTP, parent sign-in, onboarding, PDF, join pages, parent live location, mobile. It contains **no staff administrative routes and no staff modules**.
- **Independently deployed staff API** (`apps/staff-api`, new): staff authentication, staff management, catalog administration, dashboards, live-location staff view. The staff portal's proxy forwards `/api` here.
- **Shared business-logic packages** (`packages/core`, plus the existing `packages/contracts`): validation rules, OTP service, session library, catalog queries, registration record. Each service imports only what it needs; an import rule enforced in CI keeps staff code out of the public API's dependency graph.
- **One PostgreSQL database**, accessed with **separate roles, credentials and session-signing secrets** per API, with the public role's permissions explicitly restricted (section 7a).
- Per-service: own pool, own scrypt gate, own rate limits, own secrets, own health checks and logs.

## 3. Comparison against the fourteen criteria

| # | Criterion | A. One shared | B. Four public + staff | C. Public API + staff API |
|---|---|---|---|---|
| 1 | Security and attack surface | One internet-facing process contains admin routes, staff auth and the staff password hashes' database access. A bug in any public route runs in a process whose DB role can read and write staff tables. Staff portal already reaches only `/api/admin` via its proxy, but the API itself answers every path on every host. | Four public processes, each with the full code (including admin routes unless removed) and the same DB credentials: **attack surface grows 5x in count, not in kind.** A flaw in one public backend gives the attacker the same database access as in A. | Public process can ship **without** admin and staff code and run under a DB role that cannot read `staff_users`, `staff_sessions`, `audit_log` writes or catalog admin writes. A compromised public API then cannot touch staff credentials. Real reduction **only if** the DB roles and secrets are actually split (section 4). |
| 2 | Authentication, authorization, session isolation | Separate cookies, tables and role checks already exist; isolation is code discipline in one process. One shared `OTP_HMAC_SECRET`. | Same as A per service, plus four copies of parent-session code to keep in step. Parent sessions are DB rows, so a parent session is valid on any of the four backends: **separation gives no session isolation** unless parent session tables were split too. | Staff sessions exist only in the staff API's trust domain: separate HMAC secret, separate cookie host (already separate portal host), separate DB role. A public-API breach cannot mint staff sessions. Parent sessions stay in the public API. |
| 3 | Tenant and data isolation (school / trip / variant) | Application-level and constraint-level (migration 019 when applied). | **No stronger.** All five services hold the same DB credentials, so a bug in the DF backend can read an IP registration. Only per-variant DB roles with row-level security would isolate, and that is a different, larger project. Separate backends also cannot stop a parent on a school's link from registering for another school; that rule is data-level (Phase 2). | Same as A for tenants. Gains only the staff/parent split. |
| 4 | R1 (100 in flight), R2 (100 RPS) and beyond | Scales by replicas. 100 in flight is a connection-pool and CPU question (section 5), not a service-count question. Unmeasured. | Capacity is split four ways: an idle portal's capacity cannot help a busy one. A trip-launch spike on one variant must fit that backend's replicas. Needs each backend sized for its own peak, so **more total capacity bought for the same load**. Unmeasured. | Public API takes all registration traffic; staff API is small and steady. Staff dashboards cannot consume public capacity. Unmeasured. |
| 5 | CPU-intensive work (scrypt, PDF) | One gate per process. Staff sign-in, parent sign-in, registration and PDF compete for the same CPU. | Each backend has its own CPU budget; a registration burst on one variant does not slow another. Small total throughput per variant, since each needs its own vCPU(s) at about 2.5 hashes/s per vCPU. | Staff hashing (few users) and PDF for staff views leave the public CPU alone. Public scrypt still shared by four variants (good: pooled capacity). Dedicated hashing or PDF workers are possible later in A, B or C. |
| 6 | PostgreSQL connections and contention | `replicas x DB_POOL_MAX`. | `(sum of replicas over 5 services) x DB_POOL_MAX`. **Fastest way to exhaust `max_connections`**; needs smaller pools or PgBouncer sooner. | `(public replicas + staff replicas) x DB_POOL_MAX`. Staff pool can be small (for example 3 to 5). |
| 7 | SMTP and background work | One sender, one place for an outbox worker. | Five senders; five housekeeping and PDF-sweep loops; five SMTP connection sources to a provider that may throttle per account. | Public API (OTP) and staff API (staff OTP, volume tiny). Outbox and sweeps best run as one separate **worker** process in A and C; in B, five. |
| 8 | Rate limiting across instances | Needs shared store for the in-memory limiters. | Same fix, once per service; DB-backed counters are shared automatically because it is one database. Per-IP limits do not add across backends, so an attacker spreading across four portals gets **4x** the per-IP allowance unless limits are keyed globally in the DB. | Same fix. Staff limits independent of public limits (a public flood cannot lock staff out of sign-in). |
| 9 | Failure isolation and availability | A bad deploy, memory leak or crash loop takes down everything, including staff. Replicas reduce process-level risk, not bad-release risk. | A bad release of one backend affects one portal (with rolling deploys, only if released independently, which is the same discipline as canarying in A). **The database is still one point of failure for all.** | Public outage does not stop staff (and the reverse). Two failure domains. Database still shared. |
| 10 | Deployment and rollback | One build, one rollback. Simplest. | Five deploys, five rollbacks, five configs, version skew across services against one schema. Highest risk of "service X is on release N, schema is at N+1". | Two deploys. Version skew between two services is manageable with expand/contract migrations (section 8). |
| 11 | Monitoring, logging, incidents | One log stream; tag by variant from the trip. | Five log streams; correlating one parent across variants (same person, same email) needs central logging. | Two streams that map to the two trust domains: public vs staff. Simple to alert on and to investigate staff-side abuse. |
| 12 | Future Sales ERP integration | ERP endpoints would live in the same process as public routes (wider blast radius for an integration credential). | Same question, five places. | A third service (or a staff API surface) with its own database role (read-only views or an outbox table) keeps ERP credentials away from the public API. Natural fit for the already-defined `@pp/contracts` record. |
| 13 | Development and maintenance | Lowest. | Highest: duplicated config, five pipelines, risk of the four copies drifting (inconsistent validation, different fixes). If kept as one image with config, the "four" backends buy nothing code-wise. | Medium. Needs a disciplined shared package and a rule on what may be imported by which service. |
| 14 | Cost on Railway | Lowest baseline. Railway bills by resource use **[Unverified: confirm current plan and pricing]**. | Highest: five always-on Node processes, each with its own memory baseline and scrypt headroom (128 MiB per concurrent hash). | One extra small service over A. |

## 4. What each architecture actually protects against

| Threat or failure mode | A | B | C |
|---|---|---|---|
| Remote code execution or injection in a public route reads staff password hashes | No | **No** (same DB role) | **Yes**, if the public DB role has no privileges on staff tables |
| Same, but writes a rogue staff session or user row | No | No | **Yes**, same condition |
| Attacker in the public API calls admin routes | Blocked only by role middleware | Same | **Yes**: the routes do not exist in the public process |
| Admin or staff bug exposes parent data | Possible | Possible | Possible (staff legitimately reads registrations) |
| Cross-school data leak from an application bug | Possible | **Possible** | Possible |
| Registration burst on one portal slows the others | Yes (shared CPU, pool) | **No** | Yes (shared public pool and CPU) |
| Public burst slows staff sign-in and dashboards | Yes | Yes for staff only if it shares nothing; staff backend is separate so **no** | **No** |
| One bad deploy takes down every portal | Yes | **Contained** if deployed one at a time | Public portals together; staff separate |
| Database outage, lock storm, runaway query | All | **All** | **All** |
| Credential-stuffing of parent passwords | DB-backed limits already cap this | Same, but per-IP allowance spread across backends unless limits are global | Same as A |
| Leaked staff-session HMAC secret | All sessions forgeable-in-principle | Same | Public secret leak does not affect staff if secrets differ |

Separate staff **deployment** alone is not a boundary. The boundary is: separate DB role (least privilege), separate secret, separate network exposure and no staff code in the public image. Without those, C is only a deployment convenience.

## 5. R1 (100 concurrent) and R2 (100 RPS) by architecture

They are different quantities. `in-flight = RPS x mean latency` (Little's law): 100 RPS at 50 ms is about 5 in flight; 100 in flight at 50 ms needs about 2000 RPS; 100 RPS and 100 in flight together need a mean latency near 1 s.
A system can pass one and fail the other, so each is tested separately and then together (`CONCURRENCY.md` section 6). In-flight is measured on the server, not assumed from virtual users.

What decides each, in every option:

- **R1 (in flight)** is decided by how long requests hold resources: a pool connection (registration holds one through the 0.4 s hash today), a worker slot in the hash gate, and an open request during SMTP delivery.
  100 in flight does **not** need 100 database connections: requests queue for the pool (5 s limit, then fail).
- **R2 (throughput)** is decided by work per request. With R2a the work is dominated by scrypt (about 0.41 s CPU and 128 MiB per hash on the authoring laptop; Railway unmeasured), database round trips (about 9 statements per registration, about 10 per login) and SMTP connection setup (no pooling today).
  **Each process runs at most `min(vCPU, UV_THREADPOOL_SIZE - 1)` hashes at once, 3 by default**, so about 5 hashes/s per 4-vCPU replica at 70% utilisation [Estimate]. The proposed profiles need 20 to 26 hashes/s (the literal reading about 89): see section 5a and `CONCURRENCY.md` section 7.

Minimum changes to have a chance of meeting each (all unmeasured):

| | Code changes (needed in every option) | R1 specifics | R2 specifics | Extra infrastructure |
|---|---|---|---|---|
| A | Hash outside the transaction; email off the request path or pooled SMTP; shared rate limits; separate health pool; HTTP timeouts; raise hash concurrency deliberately | Pool sized by connection budget; keep-alive and request deadlines | Replicas x per-process hash cap; indexes checked by `EXPLAIN` | 2+ replicas; vCPU per replica is a **lead-approved Railway change, not made** |
| B | Same, in each of 5 services; global per-IP key | Four times as many pools to fit in `max_connections`; PgBouncer likely | Each backend needs its own hash capacity, so total hashing capacity is bought four times for the same traffic | 5 services x 2 replicas |
| C | Same, plus split of `app.js` into two entrypoints, `packages/core`, DB roles and secrets split | Public pool sized for public load; staff pool small (3 to 5) | Staff hashing and staff queries stop competing with public traffic; public hashing capacity is shared by all four portals (pooled, so better utilisation than B) | 2 public replicas + 1 to 2 staff replicas, plus the DB roles |

Horizontal scaling: **A and C scale by adding identical replicas of a service** (sessions, OTP, throttles and leases are already in PostgreSQL, so replicas are interchangeable apart from the in-memory limiters). B scales each backend separately.
**All three are bounded by the one PostgreSQL**: connections, write throughput and lock contention do not grow by adding API processes (section 6). Whether a shared database is itself the limit at 100 RPS of this mix is unmeasured and is part of the staging test.

## 5a. Reassessment with the write-heavy workload (registration and login)

The confirmed workload (R2a) is dominated by operations that run an scrypt hash and write several rows (`CONCURRENCY.md` 3.9). Consequences for the choice of architecture:

1. **The limit is hashing CPU, not request routing.** Profiles 1 to 3 need about 20 to 26 hashes per second, which is about 13 to 30 vCPUs of hashing for the public API [Estimate, `CONCURRENCY.md` section 7; Railway hardware unmeasured]. That is a property of the *public* traffic and is the same in A and C.
2. **Option A and Option C perform the same for public traffic.** Both run the same code on replicas of the same size; C does not make registration or login faster. What C changes is *who suffers when public CPU is saturated*: in A, staff sign-in and dashboards share processes with 13 to 30 busy vCPUs of hashing and the same hash gate and pool;
   in C the staff API has its own small gate and pool and is unaffected. That is an isolation benefit, not a throughput benefit.
3. **Option B does not help and likely costs more.** Splitting 20 to 26 hashes/s over four backends gives each about 5 to 6 hashes/s, and each needs its own replicas, with at least two each for availability. Capacity is not shared: a launch spike on one portal cannot borrow the idle capacity of the others
   (statistical pooling is lost), so total provisioned CPU and memory is the **sum of four peaks** instead of the **peak of the sum** [Estimate: the size of the gap depends on how the portals' peaks overlap, which is unmeasured]. All four still write to the same PostgreSQL, so no database contention is removed,
   and the connection budget gets worse: pool connections multiply by the number of backends (the 4 to 8 replica estimate becomes 16 to 32 replicas, each with a pool). Failure isolation between portals, the one real benefit of B, is available in A and C through rolling deploys and replica counts.
4. **The shared PostgreSQL is not the first constraint at this workload, but it is the common one.** About 640 statements/s for the registration profile and 430/s for login [Estimate] is small for PostgreSQL if indexed [Unverified on Railway]. What the database does add is write churn (login attempts inserted and deleted per login, three session rows per sign-in)
   and the connection limit, which is a shared budget across every service in every option.
5. **Options that matter more than A versus C for this workload** (all independent of the architecture choice): hash outside the transaction (`CONCURRENCY.md` change 1), a deliberate hash gate and threadpool per replica, SMTP off the request path or pooled, the password versus OTP login balance, and (security decision) the scrypt cost parameter.
6. **A further split is not proposed.** One could separate the CPU-bound registration and login endpoints from the cheap read endpoints (join pages, onboarding reads) so reads never wait behind hashes. It is not recommended now: reads do not use the hash gate, scrypt already runs on separate threads, and nothing shows reads suffering. Revisit only if the staging run shows read latency degrading under hash load.

Estimated infrastructure by option for profiles 1 to 3 (**estimates, not measurements**; assumptions in `CONCURRENCY.md` section 7: 4 vCPU replicas, 70% hash utilisation, 0.41 to 0.78 s per hash):

| | Public hashing capacity | Staff | Pool connections (10 each) | Notes |
|---|---|---|---|---|
| A | 4 to 8 replicas (13 to 24 vCPU incl. 1) shared with staff | in the same replicas | 40 to 80 | Staff and public compete |
| B | Sum of four per-backend fleets, at least 2 replicas each: 8 to 16+ replicas | separate small service | 80 to 160+ | Exceeds the 72 budget quickly; PgBouncer likely |
| C | 4 to 8 public replicas | 1 to 2 small replicas, pool 3 to 5 | 43 to 90 | Staff isolated; one more service |

**Conclusion from the workload:** it strengthens "do not choose B" and does not change the case for C versus A, which remains a security and isolation argument (section 7a), not a performance one.

## 6. Problems that remain in every option (one shared PostgreSQL)

- **Single point of failure** and single restore point: one outage or one bad restore affects all portals and staff.
- **`max_connections` is a global budget** (`CONCURRENCY.md` 3.2); more services means smaller pools or PgBouncer.
- **Noisy neighbours:** a heavy staff report or an unindexed dashboard query competes with registration for CPU, I/O and locks. Mitigations that work in every option: per-role `statement_timeout`, a read replica for reporting, query review (`EXPLAIN` not yet run).
- **Hot rows and locks:** per-email advisory locks are fine; the unique index on `parent_registrations.email_normalized` and the `onboarding_forms` rows are low-contention. **[Unverified]** under load.
- **Schema coupling:** every service must tolerate the schema during a rollout. Migrations are run manually today; with two or more services they must be expand/contract (add first, remove later).
- **Tenant isolation is not a process property** (fact 4).
- **Storage growth** (JSONB answers, PDFs in `registration_pdfs`) is shared.
- **Backups and incident response** are one set of procedures.

## 7. Recommendation

**Adopt Option C as the target architecture, reached through a hardened Option A, and reject Option B.**

Reasoning:

1. **B buys almost nothing.** The variants share one code path and one database with one credential set, so separate public backends add no data isolation, no session isolation and no stronger security. They multiply connections, cost, config, rollbacks and logs and make the code drift. The one benefit, failure isolation between portals, can be had in A and C with replicas, rolling deploys and per-release canarying. If a portal needs its own capacity during an event, that is a scaling setting, not an architecture.
2. **A can reach 100 concurrent requests**, but it leaves the internet-facing process holding staff-table privileges and shares CPU between staff and public traffic. That is not a limit of scale; it is an exposure and noisy-neighbour problem. It is a sound **first** step because it needs no new services and the required code changes (hash outside the transaction, outbox, shared limiters, timeouts) are the same in every option.
3. **C is the only option that removes a real threat**: a compromised public API cannot read or write staff credentials, forge staff sessions or call admin routes, provided DB roles and secrets are separate. The code is already modular for it (`app.js` already assembles the staff router separately), so the split is a re-composition into two entrypoints over shared packages, not a rewrite. Cost is one more small service.
4. **C is only worth doing if the privilege split is real.** If the lead does not want separate DB roles and secrets, C reduces to a deployment convenience and A is the better choice.
5. **The write-heavy workload (section 5a) does not separate A from C on performance.** The hashing capacity (several replicas of the public API) is needed in both. C's advantage stays security and isolation.
6. **The decision between A-hardened and C should be made after the staging load test**, which will show whether staff/public contention matters in practice, but the **security** argument for C does not depend on that test.

Not recommended now: PgBouncer (add only if the connection budget requires it), Redis (decide on rate limits first), a separate ERP service (design when ERP scope exists), per-variant databases.

## 7a. What makes Option C a real security boundary (and how it is verified)

Separate deployment moves code to another process. It protects nothing by itself if both processes hold the same database credentials and the same secrets. The boundary is the following, and **none of it exists today** [Code]:

1. **Separate PostgreSQL roles, credentials and connection limits.** `pp_public` and `pp_staff`, each with `CONNECTION LIMIT` (part of the connection budget) and its own `statement_timeout`. No shared `DATABASE_URL`.
2. **Least-privilege grants for `pp_public`.** Read/write only what the public flows need; **no access** to `staff_users`, `staff_sessions`, `staff_refresh_tokens`, `staff_login_attempts`, `audit_log` (write or read); no write to catalog tables (`schools`, `trips`, `trip_links`, `school_logos`); read-only on catalog tables.
   Starting point from the migrations (**to be confirmed by reading every query before the grants are written**): `pp_public` needs `email_otps`, `email_verification_tokens`, `parent_registrations`, `password_credentials`, `password_login_attempts`, `auth_sessions`, `auth_refresh_tokens`, `onboarding_forms`, `trip_enrolments`, `registration_pdfs` and the Drive state tables, `trip_link_lookups`, and `trip_live_location` (parent writes the position), plus read on catalog tables.
3. **Least-privilege grants for `pp_staff`.** Staff tables, catalog write, audit write, read of registrations / enrolments / forms / PDF status, and the staff side of live location (**column-level grants or a separate table** where staff and parents write different columns). **No write** to `auth_sessions` or `auth_refresh_tokens` (a staff compromise must not mint parent sessions) and no write to `password_credentials`.
4. **A found weak point: staff OTP codes live in the shared `email_otps` / `email_verification_tokens` tables** (purpose `staff_password`). A role that can write those tables could insert a verified token for a staff email. What prevents misuse is that token hashes are keyed with a secret:
   the public role must **not know the staff secret**, and ideally staff OTPs move to their own tables so the public role has no write path to them at all. Both are required for the boundary to hold.
5. **Separate session-signing secrets.** Today one `OTP_HMAC_SECRET` seeds parent and staff HMAC domains [Code]. Split into `PARENT_HMAC_SECRET` (public API only) and `STAFF_HMAC_SECRET` (staff API only). A startup check refuses to run if the public process can see the staff secret or the reverse.
6. **No staff administrative routes in the public API.** The routes must not exist (404), not merely be protected by a role check. Verified by `scripts/loadtest/exposure-check.sh`, which **fails today** and must pass against the public API after the split.
7. **Separate exposure.** Staff API reachable only from the staff portal's proxy / a private network, not from the four public portals' proxies; the staff portal is separate (already a separate host).
8. **The public image contains no staff code and no staff secrets** (dependency rule in CI, build the public image from the public workspace only).

Residual risks even with all of the above: a staff API compromise still reads all parent PII (staff legitimately do); both services still depend on one PostgreSQL; shared packages can reintroduce coupling.

Verification (before any load test counts for Option C; none written or run yet):

| Check | How | Expected |
|---|---|---|
| Public API exposes no staff routes | `exposure-check.sh` against the public API | 404 for every listed path |
| Public role cannot touch staff tables | Connect as `pp_public`; try `SELECT`, `INSERT`, `UPDATE`, `DELETE` on each staff table and `audit_log` | `permission denied` every time |
| Public role cannot write catalog | `INSERT`/`UPDATE` on `schools`, `trips`, `trip_links` as `pp_public` | `permission denied` |
| Staff role cannot mint parent sessions | `INSERT` into `auth_sessions` as `pp_staff` | `permission denied` |
| Public process cannot forge a staff OTP token | Insert a token row as `pp_public` for a staff email, then call the staff password-confirm route | Rejected (wrong key and, after move, no table access) |
| Secrets are separate | Start each service with the other's secret set | Refuses to start |
| Staff API outage does not affect public traffic | Stop the staff API during the combined test | Public criteria still pass |
| Connection budget | `pg_stat_activity` per role during the combined test | `pp_public` and `pp_staff` each within `CONNECTION LIMIT`; sum within `max_connections` budget |

## 8. Migration path from the current monorepo

Each step is a separate approved change. None is started.

| Step | Change | Notes |
|---|---|---|
| 0 | Run tests A to E from `CONCURRENCY.md` against a disposable staging database, on the current single API | Gives the first real R1 and R2 numbers and the baseline; decides sizing. |
| 1 | Harden A: changes 1-8 of `CONCURRENCY.md` section 4 | Required in every option. |
| 2 | Structure for the split without moving behaviour: extract `packages/core` (db, config, otp, sessions, catalog queries, rules) and make `apps/api` compose from it | Tests keep passing; no deployment change. |
| 3 | Two entrypoints: `apps/public-api` (no `/api/admin`, no staff module, no staff HMAC secret) and `apps/staff-api` | Both still can use today's single DB role at this point. Staff portal's `API_URL` points to the staff API. Public portals' to the public API. |
| 4 | **Security gate.** PostgreSQL roles: `pp_public` (parents, OTP, registrations, onboarding, catalog read, live-location write) and `pp_staff` (staff tables, catalog write, audit, read of registrations) | `GRANT` per table; verified by a test that tries forbidden statements. Needs a migration for roles and grants: **separate approval**. Set per-role `statement_timeout` and `CONNECTION LIMIT`. Move staff OTP codes to their own tables (item 4 of section 7a). All checks in the 7a verification table must pass before step 7. |
| 5 | Split secrets: `STAFF_HMAC_SECRET`, `PARENT_HMAC_SECRET` | Existing sessions: plan for a one-time sign-out or a dual-verify window. |
| 6 | Workers: one process for outbox mail, PDF sweep, housekeeping | Removes background loops from API replicas. |
| 7 | Railway: staging environment first; then production services | Rollback = redeploy the previous image of one service; schema stays expand/contract compatible. |
| 7b | Re-run A to E (and 2-replica runs) against the split deployment, with the staff API under traffic and then stopped | Option C is only accepted if R1, R2 and the 7a checks all pass. |
| 8 | ERP: separate integration surface and DB role when requirements exist | Uses `@pp/contracts`. |

Rollback at each step: steps 1-2 are code only; 3 can be reverted by pointing the portals back at the single API; 4-5 need documented down-migrations and a session plan.

## 9. Risks, unknowns, decisions for the lead

**Unknowns (all [Unverified])**
- Real capacity of any option: no load test has run.
- Railway PostgreSQL `max_connections`, CPU and memory limits, and plan pricing.
- Railway private-network load balancing between replicas and drain time between SIGTERM and SIGKILL.
- Whether PDF rendering blocks the event loop.
- Query plans for the staff dashboards at realistic data sizes.
- SMTP provider rate limits.

**Risks**
- C without real privilege separation gives false confidence.
- Splitting secrets and roles can lock people out if done carelessly (sessions, migrations).
- Shared packages can become a hidden coupling point; needs an import rule enforced in CI.
- One PostgreSQL remains the single failure domain in every option.

**Decisions needed from the lead**
0. **What "mostly registration and login submissions" means** (about 20 to 26 hashes/s in the flow reading, about 89 in the literal reading) and the infrastructure that follows (`CONCURRENCY.md` section 8, decision 1). The architecture choice does not depend on it; the cost does.
1. Approve C as the target (with A-hardened first), or choose A-only. B is not recommended.
2. Confirm the security requirement: are separate DB roles and secrets for staff in scope? (Decides whether C is worth it.)
3. Rate-limit store: PostgreSQL counters or Redis.
4. Approval to create a staging environment sized like production, and to provision more vCPU for the API (needed for scrypt capacity). Not done.
5. Whether password hashing cost (N=2^17) may ever be lowered. Not recommended.
6. Approve, change or reject the proposed acceptance criteria P1 to P13 (`CONCURRENCY.md` section 6). R1 and R2 are fixed.
6a. **What the 100 RPS is made of** (reads, OTP, sign-in, registration, staff). If it means 100 hash-bound requests per second, the design changes (about 40 vCPUs for hashing).
6b. Per-IP limits behind shared addresses (school Wi-Fi, carrier NAT) and `TRUST_PROXY_HOPS`.
6c. Scope of the privilege split: separate DB roles, secrets, and moving staff OTP tables (7a). Without these Option C is not recommended over A.
7. Whether ERP needs its own service and credential from the start.
8. Mobile app: stays on the public API (current assumption).
