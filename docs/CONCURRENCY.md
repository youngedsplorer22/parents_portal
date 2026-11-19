# Capacity: 100 concurrent requests and 100 requests per second

Status: **review and plan only. Nothing in this document has been load-tested, and no application code was changed for it.**

> **SCOPE NOTICE: `docs/SCOPE-CHARTER-AND-DECISIONS.md` governs.** The capacity requirements (100 concurrent, 100 RPS) stay. Every code change listed in section 4 is **conditional on a measured failure in the staging load test** and must preserve existing behaviour. **Out of scope:** change 3's email outbox and any background mail worker (the interim pooled-SMTP configuration is the only mail change, and only if measured), change 10 (separate PDF gate) unless measured, change 11 (edge protection) and any new service, worker or database. Parent registration, OTP, login, sessions, PDF/Google Drive, email and mobile behaviour are not changed to meet the numbers; if the numbers cannot be met without changing behaviour, the project **stops and asks**.
Added so far: this document, `docs/ARCHITECTURE-OPTIONS.md` and `scripts/loadtest/` (a test kit that has been written and partly smoke-tested, never run against the API).

## 1. Requirements

Confirmed by the lead. R1 and R2 are **separate** acceptance requirements; neither is evidence for the other.

| # | Requirement | Status |
|---|---|---|
| R1 | At least **100 concurrent in-flight HTTP requests** (measured on the server) | Confirmed |
| R2 | At least **100 requests per second** (100 RPS) | Confirmed |
| R2a | The 100 RPS workload is **mostly parent registration and login submissions**, not lightweight reads | Confirmed. How to read "mostly" is a decision (section 8) |
| R3 | Latency, error-rate, CPU, memory, pool and database limits | **Not set. Section 6 proposes values for approval** |

Why R1 and R2 differ (Little's law, `in-flight = RPS x mean latency`): 100 RPS at 50 ms mean latency is about 5 requests in flight; 100 in flight at 1 s is 100 RPS; 100 in flight at 50 ms needs about 2000 RPS.
**R2a changes the problem.** Registration and password login each run an scrypt hash (about 0.41 s of CPU, 128 MiB, measured on the authoring laptop, section 3.9). 100 RPS of mostly such requests is a **CPU-bound write workload**,
not a connection or request-rate problem. Hashes per second, not requests per second, decide the infrastructure (section 7).

- Architecture: Option C is the preferred **candidate**, subject to verification (`docs/ARCHITECTURE-OPTIONS.md`). Nothing in this document depends on the option except where marked.
- Not allowed as part of this work: load tests against production, production database access, Railway resource changes, application changes, migrations, installs or provisioning, commits, deployments, Phase 2.

Legend: **[Code]** read in this repository. **[Measured]** a number measured on the authoring laptop (4 threads, not Railway). **[Estimate]** calculated from stated assumptions. **[Unverified]** assumed or unmeasured. **[Proposed]** not built.

## 2. What is verified today

**[Tested]: nothing about concurrency.** The existing `apps/api/test` suite is functional. A few tests touch concurrency
logic (`work-gate.test.js`, `pool.test.js`, `shutdown.test.js`, `rate-limit.test.js`, `health-cache.test.js`), but none runs
100 concurrent requests against a real server and database. Passing unit tests or a successful build says nothing about
this requirement.

Local tooling on the review machine: Node 24.22.1, 4 CPUs, **no PostgreSQL, k6 or autocannon installed** (nothing was installed for this work). So no load run was possible. Parts of the test kit were exercised in isolation (see section 8).

## 3. Review findings

### 3.1 Stateless design and horizontal scaling

| Item | State | Notes |
|---|---|---|
| Parent and staff sessions, refresh tokens | **[Implemented]** in PostgreSQL (`auth_sessions`, `staff_sessions`, `*_refresh_tokens`) | Token hashes only. Any replica can serve any session. |
| OTP codes, attempts, cooldown, hourly send caps | **[Implemented]** in PostgreSQL, serialised by `pg_advisory_xact_lock` per email+purpose | Safe across replicas. Clock comes from the database. |
| Password and staff sign-in throttle, join-link lookups | **[Implemented]** in PostgreSQL (`*_login_attempts`, `trip_link_lookups`) | Safe across replicas. |
| Migrations | **[Implemented]** advisory lock in `migrate.js`, run manually | Two runs cannot overlap. |
| Google Drive PDF upload | **[Implemented]** lease via `claimed_at` in `registration_pdfs` | Safe across replicas. |
| `createRateLimiter` (in-memory) | **[Implemented], NOT replica-safe** | See 3.6. |
| `pdfCache` Map in `onboarding/service.js` | In-memory cache only | Harmless across replicas (a miss re-renders). Memory use per replica is **[Unverified]**. |
| `passwordGate` (scrypt concurrency) | Per process by design | Correct: it protects that process's CPU. See 3.3. |
| Housekeeping timer and PDF sweep in `server.js` | Run on **every** replica | Deletes are idempotent and the sweep uses leases, so correct, just redundant. |

Verdict: the data model is already replica-safe except the in-memory limiters. Replicas can be added on Railway without a code
change to sessions or OTP. **[Unverified]**: no test runs two API instances against one database.

### 3.2 PostgreSQL connection budget

Defaults: `DB_POOL_MAX=10` per replica, `DB_CONNECTION_TIMEOUT_MS=5000`, `DB_STATEMENT_TIMEOUT_MS=15000`,
`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=30000` (`apps/api/src/config.js`, `db/pool.js`).

Formula:

```
replicas x DB_POOL_MAX  <=  max_connections - superuser_reserved(3) - admin_and_migration(5) - safety(20% of max_connections)
```

Example, **if** the Railway PostgreSQL has `max_connections=100` (**[Unverified]**: run `SHOW max_connections;` on the staging
database before relying on this):

```
budget = 100 - 3 - 5 - 20 = 72
3 replicas x 20 = 60   OK
4 replicas x 15 = 60   OK
6 replicas x 10 = 60   OK
```

100 in-flight requests do **not** need 100 connections. Requests wait in the pool queue up to 5 s, then fail with a
connection-timeout error (a 500 today). Capacity is therefore decided by (requests per second x seconds a connection is held),
not by 100. Rule of thumb: connections needed = arrival rate x mean hold time. Measure hold time in the load test.

If the connection budget gets tight, put PgBouncer (transaction mode) in front of PostgreSQL. Caveat: the code uses session-level
features only inside a single transaction (`pg_advisory_xact_lock`, `SET` via startup parameters). `statement_timeout` and
`idle_in_transaction_session_timeout` are sent as startup parameters, which PgBouncer must be told to pass through
(`ignore_startup_parameters` / `track_extra_parameters`). **[Proposed]**, only if the budget requires it.

### 3.3 Slow operations on the request path (main bottleneck)

| Operation | Where | Problem | Severity |
|---|---|---|---|
| scrypt password hash, N=2^17 (about 128 MiB, about 0.4 s of CPU) | `registrations/service.js`, login, reset | The gate allows `concurrency = min(CPUs, UV_THREADPOOL_SIZE-1)` jobs and `maxQueue = 8 x concurrency`. On a **1 vCPU** container: 1 running + 8 waiting = 9 admitted. A burst of 100 registrations gets about 9 admitted and **about 91 immediate 503 SERVER_BUSY**. Throughput is about 2.5 registrations/s per vCPU. Memory: `concurrency x 128 MiB` extra. | **High. The real limit for registration and login.** |
| Hash runs **inside** the registration transaction | `registerWith` in `registrations/service.js` | The transaction holds a pooled connection, the consumed-token row, and the email-unique-index slot while queued and hashing (up to several seconds). Pool connections are used for waiting, not for database work. | **High** |
| OTP email send | `email-otp/service.js` `deliver()`, default `delivery: "await"` | The HTTP response waits for the SMTP exchange (timeouts 10 s / 10 s / 20 s). The DB connection is released first (good), but the request stays open. `createTransport` has no pool, so each mail opens a new TLS connection. 100 simultaneous sends = 100 SMTP handshakes and possible provider throttling. | **Medium to high** |
| PDF rendering | `onboarding/service.js` line about 358, `renderPdf` run through the **same gate** as password hashing | PDF and hash jobs compete for the same slots. If pdfkit runs on the main thread it also blocks the event loop. **[Unverified]**. | Medium |
| Google Drive upload | `pdf-storage` | Backgrounded with lease and sweep. Not on the request path. | OK |
| Hash concurrency cap | `auth/work-gate.js` `defaultGateOptions` | `concurrency = min(vCPU, UV_THREADPOOL_SIZE - 1)`. With Node's default threadpool of 4 that is **at most 3 concurrent hashes per process (about 7.5 hashes/s), however many vCPUs the container has**, unless `UV_THREADPOOL_SIZE` or `PASSWORD_HASH_CONCURRENCY` is raised. Adding vCPU alone does not raise sign-in or registration throughput. | **High** |
| OTP `issueNew` | `email-otp/service.js` | Runs a retention `DELETE ... WHERE created_at < ...` and two `count(*)` queries inside every send transaction, holding the per-email advisory lock. Indexes exist (`email_otps_created_idx`, `..._email_created_idx`, `..._ip_created_idx`). Write amplification, not a correctness issue. | Low |

### 3.4 Race conditions, duplicate submissions, transaction safety

Reviewed by reading code and migrations. **[Unverified] under load**; the functional tests only run sequentially or in small groups.

| Flow | Protection found | Gap |
|---|---|---|
| OTP send / resend / verify | Advisory lock per email+purpose; partial unique index `email_otps_one_active_idx`; attempts incremented under lock | None found by reading. |
| Verification token | `UPDATE ... WHERE consumed_at IS NULL` is atomic; `parent_registrations_token_key` UNIQUE | None found. Token is spent inside the registration transaction, so a failed insert does not burn it. |
| Registration create | `parent_registrations_email_key` UNIQUE; unique-violation mapped to 409 / verification-required; session created in the same transaction | Duplicate email under concurrency returns the right error **by design**; to be confirmed by the burst test (section 5). |
| Enrolment | `trip_enrolments_person_trip_key` UNIQUE (registration_id, trip_id) | Not reviewed in depth. |
| Onboarding save | `onboarding_forms.version` column, unique index per registration / enrolment | Whether `version` is enforced as optimistic concurrency on save is **[Unverified]**; read `onboarding/repository.js` and `service.js` before the write test. |
| Payment | **There is no payment code.** `enrolments/payment.js` only reports `not_configured` / `not_required`. | Nothing to race today. When a gateway is added it needs an idempotency key per enrolment, a unique order row, and webhook de-duplication. Not designed here. |
| Staff writes (catalog, links) | Unique constraints on school / trip slugs | Not load-reviewed. Low traffic. |

### 3.5 Indexes and queries

Indexes cover the hot lookups: token hashes (UNIQUE), `auth_sessions(registration_id)`, `auth_sessions(expires_at)`,
login-attempt tables `(email, created_at DESC)` and `(ip, created_at DESC)`, OTP tables, `trip_enrolments(trip_id)`,
`parent_registrations(trip_id)`. No missing index was found by reading.
**[Unverified]**: no `EXPLAIN (ANALYZE, BUFFERS)` has been run. Run it on the staging dataset for: session authenticate, OTP send windows,
login throttle `begin`, join lookup, staff dashboard / registrations list (the likeliest to need a new index or pagination once
tables hold tens of thousands of rows).
Authenticated requests do one session lookup each (a read; no per-request "last seen" write was found), so every authenticated
in-flight request costs one pool checkout.

### 3.6 Rate limiting across replicas

DB-backed (correct across replicas): password sign-in, staff sign-in, OTP send caps, join lookups, PDF storage retry pause.

In memory (per process, **effective limit = configured limit x replicas**, and reset on every deploy):

| Limiter | File | Purpose | Risk |
|---|---|---|---|
| refresh (parent) | `auth/routes.js` | token refresh | Low-medium |
| refresh (staff) | `staff/routes.js` | token refresh | Low-medium |
| PDF download/status/retry | `onboarding/routes.js` | per signed-in parent | Low (and PDF work is also gated) |
| live-location read/write (parent, staff) | `live-location/*routes.js` | per user | Low |
| mobile | `mobile/routes.js` | per user | Low |

**Per-IP limits and shared addresses (product risk, [Code]).** The DB-backed per-IP limits default to 20 OTP sends per hour (`OTP_MAX_SENDS_PER_IP_PER_HOUR`), 20 password attempts per 15 minutes and 30 join-page lookups per minute (`JOIN_LOOKUPS_PER_MINUTE`).
Parents at a school event often share one public address (school Wi-Fi, mobile carrier NAT). Forty parents registering from one classroom can exhaust the OTP and join limits for everyone behind that address. The correct client address also depends on `TRUST_PROXY_HOPS`, whose value is still undecided (`docs/CLIENT-IP-STAGING-VERIFICATION.md`).
Load tests must therefore present many client addresses (the kit's `SPREAD_IPS` with `TRUST_PROXY_HOPS=1` on the test API) **and** a separate NAT scenario (many registrations from one address) should be added once the limits' intended values are decided. Decision for the lead.

None of these in-memory limiters protects a credential-guessing path (those are DB-backed), so this is an abuse-control gap, not an authentication gap.
**[Proposed]** option A (recommended): a small PostgreSQL fixed-window counter (`INSERT ... ON CONFLICT (key, window) DO UPDATE SET n = n + 1 RETURNING n`), consistent with the existing approach, no new infrastructure, but adds one write per limited request.
Option B: Redis on Railway, cheaper per hit, but a new service to run and secure. **Decision needed from the lead.** Until then, document that
limits are per replica.

### 3.7 Timeouts, shutdown, failure recovery

| Item | State |
|---|---|
| Graceful shutdown (readiness 503, stop accepting, drain, close pool, exit code) | **[Implemented]**, has unit tests (`shutdown.test.js`). Grace `SHUTDOWN_GRACE_MS=10000`. How long Railway waits between SIGTERM and SIGKILL is **[Unverified]**; keep grace below it. |
| Pool timeouts (connection 5 s, statement 15 s, idle-in-transaction 30 s) | **[Implemented]** |
| Readiness `/api/health/ready` | **[Implemented]**: 2 s probe timeout, 1 s cache, shared in-flight query. **Gap:** it uses the **same pool**. If the pool is saturated by real traffic, the probe waits, times out, and returns 503, so the platform may pull a busy but healthy replica and shift its load onto the others (cascade). **[Proposed]**: probe on a separate pool of 1. |
| Node HTTP server timeouts | Defaults (`keepAliveTimeout` 5 s, `requestTimeout` 300 s). No per-request deadline middleware. **[Proposed]**: set `server.keepAliveTimeout` above the Railway edge's idle timeout (commonly 60 s; **[Unverified]**) to avoid sporadic 502s on reused connections; add a request deadline (about 30 s) that answers 503 and releases resources. |
| Database outage | Pool `error` handler logs and survives; liveness does not touch the DB, readiness does. A failed query returns 500. **[Proposed]**: map pool timeout / `57014` / connection errors to 503 + `Retry-After` so clients back off instead of seeing "500". |
| SMTP outage | Send fails, code is voided, client gets 502 `DELIVERY_FAILED`. Correct, but slow (up to 10 s to fail). |
| Web-server proxy (`apps/web-server`) | Upstream timeout 60 s, 502 on upstream error. On SIGTERM it calls `server.close()` with no forced drain deadline, so a kept-alive connection can delay exit. Minor. |

### 3.8 Portals

Four public portals and the staff portal stay thin static servers that forward `/api` to the one API (`docs/ARCHITECTURE.md`).
Nothing proposed here changes that or the API contract. Each portal's web-server is light (static files plus a streaming proxy),
but every API call from a portal also passes through its proxy, so the 100 in-flight requests are measured **end to end through a
portal proxy** in one scenario and **direct to the API** in another, to separate proxy cost from API cost.

### 3.9 Bottleneck analysis: registration and login (from the code)

**Registration**, `POST /api/registrations` [Code], in order: (1) reserve a hash-gate ticket (503 `SERVER_BUSY` if full); (2) parse and validate (4 KB, zod); (3) take a pool connection, `BEGIN`;
(4) spend the verification token (`UPDATE ... WHERE consumed_at IS NULL`); (5) resolve the public trip (`SELECT`, school and trip public / active / open); (6) **scrypt hash, with the transaction open and the connection held**;
(7) `INSERT parent_registrations`; (8) `INSERT password_credentials`; (9) `INSERT trip_enrolments`; (10) `INSERT auth_sessions`, `UPDATE auth_sessions`, `INSERT auth_refresh_tokens`; (11) `COMMIT`. About 9 statements.
The OTP calls before it: **send** (one transaction: advisory lock, clock, `SELECT ... FOR UPDATE`, latest-row `SELECT`, two `count(*)`, retention `DELETE`, `INSERT`; then the **SMTP exchange inside the HTTP request**, no connection held) and **verify** (one transaction: lock, clock, `SELECT ... FOR UPDATE`, `UPDATE`, `INSERT` token).

**Password login**, `POST /api/auth/login/password` [Code]: (1) reserve a ticket; (2) `throttle.begin`: its own transaction with **two advisory locks (per email, per IP)**, two `count(*)`, `INSERT` of the attempt, `COMMIT`; (3) `SELECT` the account; (4) scrypt **verify, no connection held**
(an unknown email or wrong password costs the same hash, by design); (5) one transaction: `DELETE` the email's attempt rows, `INSERT auth_sessions`, `UPDATE auth_sessions`, `INSERT auth_refresh_tokens`. About 4 connection checkouts and 10 statements.

Ranked bottlenecks:

| # | Bottleneck | Evidence | Effect at the lead's workload |
|---|---|---|---|
| B1 | **scrypt CPU** | [Measured] 413 ms median for one hash (N=2^17, r=8, p=1) on a 4-thread laptop; throughput 2.4 hashes/s at 1 job, 4.1 at 2, 4.7 at 3, 5.1 at 4 (poor scaling: threads are not full cores). Railway vCPU speed [Unverified]. | The profile workloads need 20 to 26 hashes/s (88 literal). About 12 to 16 vCPUs optimistic, 23 to 29 conservative, for hashing alone (section 7). **This is the capacity limit.** |
| B2 | **Per-process hash cap** | [Code] `concurrency = min(vCPU, UV_THREADPOOL_SIZE - 1)`, queue 8 per slot; default threadpool 4 gives at most 3 | One process, however large, does at most about 7.3 hashes/s (3 / 0.41 s) at 100% and about 5 at 70% [Estimate]. Throughput scales by replicas or by raising the threadpool, not by vCPU alone. |
| B3 | **Hash inside the registration transaction** | [Code] step 6 above | Each admitted registration holds a pool connection for queue wait + 0.41 s. With `DB_POOL_MAX=10` and a gate that admits more than 10, the extra requests wait for a connection up to 5 s, then fail with a connection timeout (a 500). Today the gate admits 9 on one vCPU, so the gate protects the pool; **raising the gate to admit 100 requests (needed for R1 on a registration workload) breaks the pool unless change 1 is made first** [Estimate from code, not measured]. |
| B4 | **SMTP inside the request, no pooling** | [Code] `deliver()` awaited; `createTransport` has no `pool` | 13 to 19 OTP mails/s in the flow profiles means 13 to 19 requests held open per second of provider latency and 13 to 19 new SMTP connections/s [Estimate]. Provider connection and rate limits are unknown and may cap this long before the API does. |
| B5 | **Per-IP serialisation and limit in login** | [Code] advisory lock per `pwlogin:ip:<ip>`; per-IP cap 20 counting in-flight attempts | If every parent appears to come from one address (`TRUST_PROXY_HOPS=0` behind Railway, or one school NAT), logins serialise on one lock and more than 20 simultaneous logins get 429. Makes R1 impossible for login from one address. Value of `TRUST_PROXY_HOPS` is undecided. |
| B6 | **Write amplification and table churn** | [Code] login inserts and deletes a `password_login_attempts` row and creates 3 session rows; registration about 9 rows; sessions kept a day past expiry, purged hourly | At 25 logins/s sustained, about 90,000 session rows per hour and the same in refresh tokens [Estimate]; autovacuum pressure on `password_login_attempts` and `auth_sessions` [Unverified]. |
| B7 | **Hash exhaustion by an attacker** | [Code] the ticket is reserved before the throttle, wrong-password and unknown-email attempts hash identically; limits are per IP and per email only | An attacker using many addresses and emails can fill the gate and make real users see 503. The limits do not stop this. Edge rate limiting or a cheaper pre-check may be needed. Not tested. |
| B8 | **Memory** | scrypt 128 MiB per concurrent hash | 3 slots per replica is about 0.4 GiB of hash memory plus the Node baseline [Estimate]; the container memory limit must cover it or the process is killed. |
| B9 | DB statement rate | [Estimate] about 30 statements per registration flow, about 15 per login flow, so about 640/s and 430/s at 100 RPS | Small for PostgreSQL if indexed [Unverified on Railway]. Not expected to be the first limit. |

Decisions this analysis forces (section 8): what "mostly submissions" means, whether OTP login (no hash) can be encouraged, the SMTP provider and its limits, and whether the hash cost may ever change (not recommended without a security sign-off).

## 4. Proposed changes (ordered; none implemented)

Each needs approval before code is written.

1. **Hash outside the transaction.** Reserve the gate ticket, run a cheap non-consuming check that the verification token is valid
   (SELECT), hash the password, **then** open the transaction, consume the token, insert. Keeps "invalid token costs no hashing" and frees
   the connection during the 0.4 s hash. Biggest single win for registration, and **a prerequisite for raising the hash gate to admit about 100 requests** (otherwise the pool, not the CPU, fails first: 3.9 B3).
2. **Size scrypt capacity deliberately.** Decide expected registrations per second at peak. Measured on the authoring laptop: 0.41 s per hash, 2.4/s for one job, 5.1/s at 4 threads (not Railway). Sizing estimates are in section 7.
   Options: more vCPU or replicas per service (a Railway resource change, **requires lead approval**, not done here), larger `PASSWORD_HASH_QUEUE`
   (longer waits, more memory), or a lower cost factor (a security trade-off: **not recommended without sign-off**). Return 503 with `Retry-After` (already done) and make the portal retry once.
3. **Move OTP email off the request path** with a PostgreSQL outbox (`email_outbox`, worker claims with `FOR UPDATE SKIP LOCKED`, retry with back-off).
   Keeps the "void the code if delivery fails" guarantee via the worker. Interim, smaller step: pooled SMTP transport (`pool: true`, `maxConnections` about 5) and keep `await`.
4. **DB-back the in-memory limiters** (option A in 3.6), or accept and document per-replica limits.
5. **Separate health pool** (max 1) and map pool/statement timeouts to 503 + `Retry-After`.
6. **HTTP server timeouts:** `keepAliveTimeout`, `headersTimeout`, request deadline.
7. **Run housekeeping and PDF sweep under an advisory lock** (`pg_try_advisory_lock`) so only one replica does it per tick.
8. Move the OTP retention `DELETE` from `issueNew` to housekeeping.
9. Stage `EXPLAIN ANALYZE` on the hot queries (3.5) and add indexes only where a plan shows a need.
10. Give PDF rendering its own gate (or a worker thread) so it cannot starve sign-in.
11. Protect against hash exhaustion (3.9 B7): edge rate limiting and, if needed, a cheap pre-check before the ticket is reserved. Needs a design and a decision.
12. Raise `UV_THREADPOOL_SIZE` and `PASSWORD_HASH_CONCURRENCY` deliberately per replica size (3.9 B2); record the values with every run.

## 5. Load-test plan (prepared, not run)

The kit is in `scripts/loadtest/`; its `README.md` is the procedure (environment, commands, safety rules, identities, cleanup). The workflows below were read from the code and the web client; no endpoint or payload is invented.

**Real flows.** Registration: `GET /api/join/...`, `POST /api/email-otp/send`, `POST /api/email-otp/verify`, `POST /api/registrations`, `GET /api/onboarding`. Password login: `GET /api/auth/session` (401), `POST /api/auth/login/password`, `GET /api/onboarding`, sometimes `POST /api/auth/refresh` and `/logout`.
OTP login: `GET /api/auth/session`, `POST /api/email-otp/send` (purpose `login`), `POST /api/email-otp/verify`, `POST /api/auth/login`, `GET /api/onboarding`.

**Workload profiles (PROPOSED assumptions requiring approval).** Percent of the 100 requests each second:

| Endpoint | 1. `registration` (R90 L5 J5) | 2. `login` (L85 O10 R5) | 3. `combined` (R40 L45 O15) | literal `submit` |
|---|---|---|---|---|
| `POST /api/registrations` | 19.1 | 1.4 | 9.5 | 44.4 |
| `POST /api/auth/login/password` | 1.1 | 24.5 | 10.7 | 44.4 |
| `POST /api/auth/login` (OTP) | 0 | 2.9 | 3.6 | 0 |
| `POST /api/email-otp/send` | 19.1 | 4.3 | 13.1 | 3.3 |
| `POST /api/email-otp/verify` | 19.1 | 4.3 | 13.1 | 3.3 |
| `GET /api/onboarding` | 20.2 | 28.8 | 23.9 | 0 |
| `GET /api/auth/session` | 1.1 | 27.4 | 14.3 | 4.4 |
| `GET /api/join/...` | 20.2 | 1.4 | 9.5 | 0 |
| `POST /api/auth/refresh`, `/logout` | 0.2 | 4.8 | 2.2 | 0 |
| Registration + login submissions | 20.2 | 28.8 | 23.9 | 88.9 |
| Flows per second at 100 RPS | 21.2 | 28.8 | 23.9 | 96.7 |
| **scrypt hashes per second** | **20.2** | **25.9** | **20.3** | **88.9** |

Flow weights: R = registration flow (5 requests, 1 hash), L = password login flow (3 + 2 x 0.1 requests, 1 hash), O = OTP login flow (5 requests, no hash), J = visitor (1 request). `submit` is single requests: registration with a seeded token 40, password login 40,
OTP pair 3, session probe 4. `SESSION_TAIL` = 0.1. All are assumptions, not measured traffic.

**Scenarios.** 1 registration-heavy, 2 login-heavy, 3 combined (100 RPS for the whole run plus 100 extra closed-loop clients in the middle, so R1 and R2 hold together), 4 concurrency (closed loop, server-measured in-flight), 5 burst (100, then 300 RPS for 30 s, then 3 min recovery),
plus a **capacity search** (literal profile stepped 10 to 100 RPS), **integrity** (separate), and **controls-still-on**. Normal throughput tests use a **unique identity per flow**. Duplicate-registration and same-account races run separately and never mix into throughput runs.

**Classification of responses.** Every response is counted by endpoint and status, and grouped: expected (the status that endpoint returns in a valid flow), validation 400/422, authentication failure 401/403, conflict 409, rate-limited 429, deliberate 503 busy, unexpected 5xx / timeout.
Any 429 in a performance run makes the run **INVALID** (it measured a limit, not the system). No control is disabled: tests use one client address per flow (`TRUST_PROXY_HOPS=1` on the **test** API), enough accounts, and OTP-login accounts reused at most 3 times; the controls-still-on scenario proves per-email, per-IP and cooldown limits still answer 429.

**Verifying real concurrency.** `inflight-preload.mjs` (`node --import`, no application change) counts in-flight requests on the server and also records pool size, waits and timeouts, every SQL statement's duration, and scrypt count, throughput, duration and concurrency.

**Metrics.** Achieved API RPS and dropped iterations; max and average in flight and seconds at or above 100; p50 / p95 / p99 per endpoint; status by endpoint; scrypt throughput; API CPU and RSS; PostgreSQL connections, lock waits, pool wait and query latency; OTP generation, verification and SMTP delivery separately; SMTP success and concurrent connections;
registration integrity (`verify.sql` and race counters). **There is no SMTP queue today** (mail is sent inside the request); queue delay is measured as 0 by design and must be added once an outbox exists.

**Environment and cleanup.** Disposable database, fake SMTP sink, identities `lt-<run>-...@loadtest.example.org`, `cleanup.mjs` (dry run, then `--yes`) or drop the database. Refuses non-local databases. The acceptance run needs staging sized like production (**needs lead approval; not requested**); a laptop run proves only that the kit works.

## 6. Acceptance criteria

**Confirmed by the lead**

| ID | Criterion |
|---|---|
| R1 | Server-side probe shows **>= 100 requests in flight** |
| R2 | Achieved throughput **>= 100 API requests per second** |
| R2a | The workload is mostly registration and login submissions (profile to be approved, section 8) |

**Proposed for approval** (my suggestions; `evaluate.mjs` labels them `[PROPOSED]` and keeps them in one `CRITERIA` object). Steady tests are 1, 2 and 3 at 100 RPS on infrastructure sized per section 7:

| ID | Proposed criterion | Applies to |
|---|---|---|
| P1 | Time at >= 100 in flight accumulates to >= 120 s | 3, 4 |
| P2 | Achieved RPS >= 99% of 100 and `dropped_iterations` = 0 | 1, 2, 3 |
| P3 | 5xx other than deliberate 503, and timeouts or resets = 0 | all performance tests |
| P4 | Valid flows failing for any reason other than a deliberate 503: <= 0.5%. `503 SERVER_BUSY`: <= 1% of requests. Each 503 carries `Retry-After` | 1, 2, 3 |
| P5 | Reads (`join`, `session`, `onboarding`): p95 <= 300 ms, p99 <= 1 s. `refresh`, `logout`: p95 <= 500 ms | 1, 2, 3 |
| P6 | `otp_send`: p95 <= 1.5 s, p99 <= 3 s (with a 500 ms SMTP sink). `otp_verify`, OTP `login`: p95 <= 500 ms | 1, 2, 3 |
| P7 | `register`: p95 <= 2 s, p99 <= 4 s. Password `login`: p95 <= 1.5 s, p99 <= 3 s | 1, 2, 3 |
| P8 | scrypt p95 duration (including waiting for a worker thread) <= 1.5 s | 1, 2, 3 |
| P9 | Pool connect wait p95 <= 100 ms; pool connection timeouts = 0 | all |
| P10 | PostgreSQL connections <= 80% of `max_connections` (all replicas, all services) | all |
| P11 | API CPU average <= 70% of the allocated vCPUs; RSS growth <= 10% across the steady phase | 1, 2, 3 |
| P12 | OTP mails delivered to the sink == OTP sends answered 200; code readable within 100 ms of the API answer (no queue today) | 1, 2, 3 |
| P13 | Concurrency test (R1): no unexpected 5xx, no pool timeouts, `503` <= 5%, p99 <= 10 s for every endpoint (queueing allowed, latency P5 to P7 not applied), recovery after the run | 4 |
| P14 | Burst: no crash or restart; no 500 or reset; only 503 / 429 with `Retry-After`; p95 back within 20% of pre-burst within 60 s | 5 |
| P15 | Integrity: `verify.sql` all zero after every test; duplicate-email 201s <= 1 per group; token-reuse 201 = 1 per group; OTP verify 200 = 1 per group; same-session refresh: one 200, rest 409; same-account logins: no 5xx | integrity, and `verify.sql` after all |
| P16 | Controls still on: per-email limit answers 429 on the 6th wrong password, per-IP on the 21st, resend inside the cooldown answers 429 | controls scenario, before any performance run counts |
| P17 | Same criteria hold at 2 or more API replicas | 1 to 5 |
| P18 | Option C only: `exposure-check.sh` and the DB-role checks pass first | before Option C runs |

**Which pass individually, which together**

| Gate | Tests | Rule |
|---|---|---|
| Individually | 1, 2, 4, 5, integrity, controls-still-on | Each passes on its own run. A pass of 1, 2 or 3 is never used to claim R1, and a pass of 4 is never used to claim R2. |
| Together | 3 | R1 and R2 at the same moment, P1 to P12 (P13 does not apply while the overlay runs; P3 and P4 do), then P15. |
| After every run | `verify.sql` | Zero violations. |
| Replicas | 1 to 5 at 2 or more replicas | Nothing depends on one process's memory. |

The capacity search has no pass or fail: it reports where the hash gate, pool or CPU gives out and feeds the sizing.

## 7. Sizing estimates (assumptions stated; none measured on Railway)

**Assumptions.** (a) One hash costs T of one vCPU: **0.41 s optimistic** (the measured single-hash time, vCPU = a full core) or **0.78 s conservative** (derived from the measured 5.1 hashes/s with 4 threads on the authoring laptop; vCPU = a hyperthread). Railway's actual figure is **[Unverified]**; the staging run must measure it.
(b) Target 70% utilisation of hashing capacity. (c) Replica = 4 vCPU with 3 hash slots (the default `min(vCPU, threadpool - 1)`) and `DB_POOL_MAX=10`. (d) One extra vCPU of non-hash work (parsing, SQL driver, cookies, 100 RPS of Express) [Unverified].
(e) Replica memory = 3 x 128 MiB hash + about 400 MiB Node and caches (about 0.8 GiB; [Unverified]); the container limit must exceed it with margin. (f) PostgreSQL `max_connections` = 100 [Unverified]; budget about 72 after reserved connections and a 20% margin (section 3.2).

| Profile (hashes/s) | vCPU for hashing + 1 | Replicas of 4 vCPU (optimistic - conservative) | Hash memory in total | Pool connections (10 each) | Within the 72 budget? |
|---|---|---|---|---|---|
| 1 registration (20.2) | 13 - 24 | 4 - 8 | 1.5 - 3.0 GiB | 40 - 80 | yes - **no (set `DB_POOL_MAX` 8 or add PgBouncer)** |
| 2 login (25.9) | 16 - 30 | 6 - 10 | 2.2 - 3.8 GiB | 60 - 100 | yes - **no** |
| 3 combined (20.3) | 13 - 24 | 4 - 8 | 1.5 - 3.0 GiB | 40 - 80 | yes - **no** |
| literal `submit` (88.9) | 53 - 100 | 18 - 34 | 6.8 - 12.8 GiB | 180 - 340 | **no in either case** |

Reading the table: the 20 to 26 hashes/s flow profiles need roughly **4 to 10 replicas of 4 vCPU (16 to 40 vCPU) for the public API** [Estimate]. The literal 89 hashes/s reading needs 18 to 34 such replicas and PgBouncer: a different scale, not recommended as an acceptance target.
The staff API is negligible next to this (a handful of users). **Levers that change the numbers, in order of effect:** the number of password versus OTP sign-ins (OTP login costs no hash); the scrypt cost parameter (the biggest lever, and a **security decision**: not recommended without sign-off); more replicas; T on the real hardware.

**Connection pool (per replica).** Today, registration holds a connection through the hash (B3). With 3 hash slots per replica and the queue admitting up to 27, up to 27 registrations would want a connection while the pool has 10: waiters hit the 5 s connect timeout [Estimate]. After change 1 (hash outside the transaction),
a registration holds a connection about 10 to 25 ms [Estimate]; at about 5 registrations/s per replica that is under 0.5 connection on average, so `DB_POOL_MAX` of 4 to 6 would do and the connection budget stops being the constraint. **Change 1 is required before the gate is raised to admit 100.**

**R1 sizing (in flight).** With the combined profile and assumed latencies (reads 20 ms, mail 0.55 s, hash steps 0.6 s) about **20 requests are in flight at 100 RPS** [Estimate]. Holding **100 in flight** therefore needs about 5 times the concurrent clients than R2 alone, which a hash-bound system serves only by queueing:
in-flight hash requests = hashes/s x wait. To hold 100 in flight with half of them waiting on a hash at 20 hashes/s takes about 2.5 s of queueing, and requires the gate to admit that many (`PASSWORD_HASH_QUEUE` of 50+ per fleet, now 8 per slot per replica). This is why P13 relaxes latency for the concurrency test, and why the lead should confirm that "100 concurrent" means 100 requests simultaneously open, not 100 requests being served at full speed.

**SMTP.** 13 to 19 mails/s is 47,000 to 68,000 mails/hour. **The provider, its connection limit and its sending limits are unknown**; most SMTP services cap concurrent connections far below 19 and many cap volume. Each mail opens a new connection today. This may be the first real ceiling; confirm before any staging run.

## 8. Status and open decisions

| Item | Status |
|---|---|
| Stateless sessions / OTP / throttles in PostgreSQL | Implemented, not load-tested |
| Pool limits configurable; connection budget formula | Implemented / calculated; `max_connections` unverified |
| In-memory limiters | Implemented, **not** replica-safe |
| Hash inside the registration transaction; SMTP awaited in the request; hash cap 3 per process by default | Implemented, flagged (3.9) |
| Items 1 to 10 in section 4 | Proposed only |
| scrypt cost on this laptop | **Measured** (413 ms, 5.1 hashes/s at 4 threads); not on Railway |
| Load-test kit: probe (in flight, pool, scrypt, SQL), fake SMTP, evaluator | Written; smoke-tested in isolation (SQL timing never saw a real database) |
| Load-test kit: `k6.js` | Written; run under a shim for every scenario and profile; **never run by k6 against an API** |
| Load-test kit: `seed.mjs`, `cleanup.mjs`, `sample.sh`, `verify.sql` | Syntax-checked only |
| Onboarding lost-update test; payment; PDF / Drive; NAT scenario; staff API traffic against a split API | **Not written** |
| R1 (100 in flight) | **Unverified** |
| R2 (100 RPS, write-heavy) | **Unverified** |
| Sizing in section 7 | **Estimates only** |

Decisions for the lead:
1. **What "mostly registration and login submissions" means.** Flow reading (about 20 to 26 hashes/s, 20 to 29% of requests are the submission POSTs) or literal reading (about 89 hashes/s, 89% of requests). I recommend the flow reading as the acceptance workload and the literal one as a stress and capacity profile.
2. Approve or change the profile weights, `SESSION_TAIL`, and the password versus OTP login split. Encouraging OTP login is a product lever that removes hashes.
3. Approve, change or reject P1 to P18 (R1, R2 and R2a are fixed).
4. Approve a staging environment sized like production and the vCPU it needs (about 16 to 40 vCPU for the public API by section 7). Not requested; no Railway change made.
5. The **SMTP provider** and its connection and volume limits, and whether the OTP outbox is in scope for the first release.
6. `TRUST_PROXY_HOPS` and the per-IP limits behind shared addresses (school Wi-Fi, carrier NAT) (B5).
7. Rate-limit store (PostgreSQL counters or Redis) and edge protection against hash exhaustion (B7).
8. Whether the scrypt cost parameter may ever change. Not recommended without a security sign-off.
