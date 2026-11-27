# Load-test kit

**Status: written, partly verified, never run against the real API.** What was exercised on the authoring machine (no PostgreSQL, no k6):

| Piece | Verified how |
|---|---|
| `inflight-preload.mjs` (in-flight, pool, scrypt, SQL timing) | Run against stub servers: in-flight counting, pool-error path and the scrypt wrapper (through `import { scrypt } from "node:crypto"`) work. **SQL timing never saw a real database.** |
| `fake-smtp.mjs` | Real nodemailer 10.0.15 (the API's version): delivery, concurrent connections, code extraction. |
| `evaluate.mjs` | Fabricated numbers only. |
| `k6.js` | Run under a k6-API shim for every scenario and profile: no init-time or flow-code exceptions. **Never run by k6 against an API**, so request shapes (phone and email rules, cookie handling, `http.batch`) are untested. |
| `seed.mjs`, `cleanup.mjs`, `sample.sh`, `verify.sql` | Syntax-checked only. |

Expect to fix details on the first `smoke` run. Nothing in this directory is a result.

## Requirements and what they mean

Two **separate** confirmed requirements, and the workload must be **mostly parent registration and login submissions**:

1. **>= 100 concurrent in-flight requests**, measured on the server.
2. **>= 100 requests per second** (API requests; fake-SMTP polls are not counted).

`in-flight = RPS x mean latency` (Little's law), so one does not prove the other: 100 RPS at 50 ms is about 5 in flight.

## Real flows the tests use (read from the code; nothing invented)

| Flow | Requests, in order | Hashes |
|---|---|---|
| **R** registration | `GET /api/join/:school/:branch/:trip` -> `POST /api/email-otp/send {email,purpose:"registration"}` -> (read code from the sink) -> `POST /api/email-otp/verify {email,purpose,code}` -> `POST /api/registrations {firstName,lastName,role,phone,email,password,verificationToken,publicTrip}` (201, sets session cookies) -> `GET /api/onboarding` | 1 (scrypt **hash**, inside the DB transaction) |
| **L** password login | `GET /api/auth/session` (401 before sign-in) -> `POST /api/auth/login/password {email,password}` -> `GET /api/onboarding`; with probability `SESSION_TAIL` (0.1) then `POST /api/auth/refresh` and `POST /api/auth/logout` | 1 (scrypt **verify**, outside any transaction) |
| **O** OTP login | `GET /api/auth/session` -> `POST /api/email-otp/send {purpose:"login"}` -> `POST /api/email-otp/verify` -> `POST /api/auth/login {email,verificationToken}` -> `GET /api/onboarding` | 0 |
| **J** visitor | `GET /api/join/...` only | 0 |

Behaviours that shape the test design (all [Code]):

- Login records its attempt **before** checking the password, under per-email and per-IP advisory locks, and deletes that email's attempt rows on success. So **in-flight** logins count toward the limits: more than 5 simultaneous logins for one email, or more than 20 from one IP, get `429`.
- OTP sends are capped per email (default 5 per hour, 30 s cooldown) and per IP (default 20 per hour). Wrong codes are capped at 5 per code.
- `POST /api/registrations` has no rate limit of its own; the hash gate (503 `SERVER_BUSY`) and the one-time token are its controls.
- Registration holds a pool connection for the whole hash; login does not.

## Workload profiles (PROPOSED assumptions, need lead approval)

All numbers below are **my assumptions**, not measured traffic. Flow weights (percent of started flows) and the resulting HTTP request shares at 100 RPS:

| Profile | Flow weights | Flows/s at 100 RPS | Requests/flow | Hashes/s |
|---|---|---|---|---|
| `registration` (1) | R 90, L 5, J 5 | 21.2 | 4.71 | 20.2 |
| `login` (2) | L 85, O 10, R 5 | 28.8 | 3.47 | 25.9 |
| `combined` (3) | R 40, L 45, O 15 | 23.9 | 4.19 | 20.3 |
| `submit` (literal) | single requests: sreg 40, slogin 40, sotp (send+verify pair) 3, sprobe 4 | 96.7 | 1.03 | 88.9 |

Share of the **100 requests each second**, by endpoint:

| Endpoint | `registration` | `login` | `combined` | `submit` |
|---|---|---|---|---|
| `POST /api/registrations` | 19.1 | 1.4 | 9.5 | 44.4 |
| `POST /api/auth/login/password` | 1.1 | 24.5 | 10.7 | 44.4 |
| `POST /api/auth/login` (OTP) | 0 | 2.9 | 3.6 | 0 |
| `POST /api/email-otp/send` | 19.1 | 4.3 | 13.1 | 3.3 |
| `POST /api/email-otp/verify` | 19.1 | 4.3 | 13.1 | 3.3 |
| `GET /api/onboarding` | 20.2 | 28.8 | 23.9 | 0 |
| `GET /api/auth/session` | 1.1 | 27.4 | 14.3 | 4.4 |
| `GET /api/join/...` | 20.2 | 1.4 | 9.5 | 0 |
| `POST /api/auth/refresh` + `logout` | 0.2 | 4.8 | 2.2 | 0 |
| **Registration + login submissions** | **20.2** | **28.8** | **23.9** | **88.9** |

**Decision needed.** "Mostly registration and login submissions" can mean two different things:

- **Flow reading (`registration`, `login`, `combined`):** most *flows* are registrations / logins. Because every submission needs supporting calls (OTP send and verify, session probe, the first page load), only about 20 to 29% of the *HTTP requests* are the submission POSTs, but about 20 to 26 hashes per second are still needed. Recommended as the **acceptance** workload.
- **Literal reading (`submit`):** about 89% of requests are submission POSTs, so about **89 hashes per second**. Registration uses pre-seeded verified tokens (no OTP round trip), so this isolates the hash and write path. That is roughly **37 vCPU-seconds of hashing per second** at 0.41 s per hash: a capacity-ceiling and stress profile, not a realistic parent flow. Used by `SCENARIO=capacity`.

`SESSION_TAIL`, the weights, and `TAIL` are proposals. Change them only by agreement and record the values with every run.

## Safety and isolation

- **Never production.** `k6.js` refuses a `BASE_URL` containing `railway`, `up.app`, `prod`, `young`. `seed.mjs` and `cleanup.mjs` refuse a non-local database unless `LOADTEST_ALLOW_REMOTE_DB=yes-this-is-not-production`, and refuse a URL containing `railway`, `rlwy` or `proxy`. Use a disposable database (local, or a throwaway staging database that is not production).
- **Email never leaves the machine.** The API is pointed at `fake-smtp.mjs`.
- **Identities are isolated.** Every test identity is `lt-<run>-...@loadtest.example.org` (8-hex-digit `<run>` printed by `seed.mjs`). Registrations created by flows use `lt-<run>-f-<scenario>-<n>`. Nothing else uses that domain.
- **Cleanup.** `node scripts/loadtest/cleanup.mjs [--run <id>]` is a dry run that prints counts; add `--yes` to delete (one transaction: forms, enrolments, registrations with their sessions / refresh tokens / credentials, OTPs with their tokens, login-attempt rows). Dropping the whole test database is simpler and safer.
- `inflight-preload.mjs` is a measurement aid. Never preload it in production.

## Avoiding self-inflicted limits (without disabling any control)

No limit is raised or switched off. Instead the test avoids tripping them with identities and addresses that a real crowd would have:

| Limit (default) | How the test stays under it |
|---|---|
| 20 OTP sends / hour / IP; 20 password attempts / 15 min / IP (counts in-flight logins); 30 join lookups / min / IP | **One client address per flow** via `X-Forwarded-For`, which needs `TRUST_PROXY_HOPS=1` on the **test** API. This models many parents on many networks. It is a test-environment setting; the production value is a separate, undecided matter (`docs/CLIENT-IP-STAGING-VERIFICATION.md`). |
| 5 password attempts / email (counts in-flight) | Accounts are handed out sequentially with a prime stride from a pool of thousands, so simultaneous flows never share an account. |
| 5 OTP sends / hour / email, 30 s cooldown | Registration flows use a new email each time; OTP-login accounts are reused at most 3 times (`test_identity_pool_exhausted` marks the run INVALID if the pool runs out). |
| 300 refreshes / 10 min / IP (in memory) | Spread addresses. |

Any `429` in a performance test makes `evaluate.mjs` report the run **INVALID** (not pass, not fail): the run measured a limit, not the system. The separate `ratelimit` scenario proves the limits still answer 429 (per-email after 5, per-IP after 20, resend inside the cooldown) with spreading off for those calls.

A **shared-address (NAT) scenario** is deliberately *not* hidden: with `SPREAD_IPS=false` the per-IP limits will fire and a school-Wi-Fi crowd is affected. Run it once as a measurement of that product risk (see `docs/CONCURRENCY.md`).

## Components

| File | Purpose |
|---|---|
| `seed.mjs` | Verified single-use tokens (`--singles`, for `submit` mode and the duplicate / token-reuse races), password-login accounts (`--accounts`) and OTP-login accounts (`--otp-accounts`), made in bulk with one real-cost scrypt hash. Writes `tokens.json` (git-ignored). |
| `fake-smtp.mjs` | SMTP sink: `DELAY_MS`, `FAIL_RATE`; admin port gives the code per address (`consume=1`), delivery latency, **max concurrent SMTP connections**, failures. |
| `inflight-preload.mjs` | Server-side probe (see Metrics). |
| `k6.js` | Scenarios `smoke`, `registration`, `login`, `combined`, `concurrency`, `burst`, `capacity`, `integrity`, `ratelimit`. |
| `sample.sh` | 1 s samples of API CPU % and RSS and of PostgreSQL connections by state, lock waits, `max_connections`, oldest active query. |
| `verify.sql` | Data-integrity queries (every `violations` must be 0). |
| `evaluate.mjs` | PASS / FAIL / INVALID table. Confirmed and proposed criteria are labelled. |
| `cleanup.mjs` | Removes exactly the rows a run created. |
| `exposure-check.sh` | Proves a public API answers 404 for staff routes (fails today: Option C baseline). |

## Environment for a run

```bash
# 1. disposable database, migrated with the normal tool (TEST database only)
export DATABASE_URL=postgresql://localhost/parents_portal_loadtest
export OTP_HMAC_SECRET=$(openssl rand -hex 32)

# 2. fake mail sink (terminal 1). 500 ms models a real provider's delay (assumption).
DELAY_MS=500 node scripts/loadtest/fake-smtp.mjs

# 3. API under test (terminal 2).
# NODE_ENV=development for a local run: production sets Secure cookies, which k6 will not send over plain http.
# A staging run behind https can use production settings. Neither changes pool, CPU or SQL behaviour.
# Size knobs to record and vary: DB_POOL_MAX, UV_THREADPOOL_SIZE, PASSWORD_HASH_CONCURRENCY, PASSWORD_HASH_QUEUE.
NODE_ENV=development TRUST_PROXY_HOPS=1 \
OTP_DELIVERY=smtp SMTP_HOST=localhost SMTP_PORT=2525 SMTP_SECURE=false SMTP_USER=x SMTP_PASSWORD=y SMTP_FROM=no-reply@loadtest.example.org \
PROBE_FILE=run1-probe.jsonl \
node --import ./scripts/loadtest/inflight-preload.mjs apps/api/src/server.js

# 4. create ONE open public trip through the staff portal on the test database, then seed
node scripts/loadtest/seed.mjs --singles 60000 --accounts 4000 --otp-accounts 2500

# 5. sampler (terminal 3), then k6
API_PID=<pid> PGURL=$DATABASE_URL scripts/loadtest/sample.sh > run1-sample.csv
k6 run -e SCENARIO=combined -e SCHOOL=<slug> -e TRIP=<slug> --summary-export=run1.summary.json scripts/loadtest/k6.js

# 6. results
kill -TERM <api pid>        # writes run1-probe.jsonl.summary.json
curl -s localhost:2526/stats > run1-sink.json
node scripts/loadtest/evaluate.mjs combined --k6 run1.summary.json --probe run1-probe.jsonl.summary.json --sink run1-sink.json --sample run1-sample.csv
psql "$DATABASE_URL" -f scripts/loadtest/verify.sql
node scripts/loadtest/cleanup.mjs        # dry run; or drop the test database
```

Record with every run: commit hash, container / machine size (vCPU, RAM), Node and PostgreSQL versions, `max_connections`, replica count and every size knob above, the profile and its weights, `SESSION_TAIL`, `DELAY_MS`, the exact `k6 run` command.
A run without these is not a result. A laptop run proves the kit works; it says nothing about Railway. The acceptance run needs staging with the same vCPU and memory as production (needs lead approval).
With several API replicas, start each under the probe with its own `PROBE_FILE`, run one `sample.sh` per PID, and sum the in-flight and scrypt figures.

## Tests

| # | Scenario | Command core | What it proves |
|---|---|---|---|
| 1 | Registration-heavy | `SCENARIO=registration RPS=100 DURATION=10m` | R2 on profile `registration` |
| 2 | Login-heavy | `SCENARIO=login RPS=100 DURATION=10m` | R2 on profile `login` |
| 3 | Combined | `SCENARIO=combined RPS=100 DURATION=15m OVERLAY_VUS=100 OVERLAY_START=5m OVERLAY_DURATION=5m` | R2 and R1 at once: 100 RPS all run, plus 100 more closed-loop clients in minutes 5 to 10 |
| 4 | Concurrency | `SCENARIO=concurrency VUS=200 DURATION=5m` | R1. **Pass or fail comes from the server probe**, not from `VUS`. If the probe stays under 100, raise `VUS`; if it still does, see the note below. A run that never held 100 in flight is invalid, not failed. |
| 5 | Burst | `SCENARIO=burst RPS=100 BURST_RPS=300` | 100 RPS, 5 s ramp to 300 RPS, 30 s hold, back, 3 min recovery |
| - | Capacity search | `SCENARIO=capacity` (profile `submit`) | Steps 10, 20, 40, 60, 80, 100 RPS of submissions: where does the hash gate, pool or CPU give out |
| - | Integrity | `SCENARIO=integrity`, then `verify.sql` | See below |
| - | Controls still on | `SCENARIO=ratelimit` | The limits answer 429 |

`PROFILE=<name>` overrides the default profile of a scenario (for example `PROFILE=submit` with `combined`).

Note on concurrency (4): requests rejected instantly with 503 do not stay in flight. With the default hash gate (about 9 admitted per 1-vCPU process) a hash-heavy closed loop is mostly rejected and never reaches 100 in flight. Holding 100 in flight on a hash-bound workload requires admitting that many (a larger `PASSWORD_HASH_QUEUE`, with the latency that queueing costs) or running more processes. This is a sizing decision, not a test flaw: see `docs/CONCURRENCY.md` section 7.

### Integrity (run separately from performance)

- `dup`: 20 simultaneous registrations for **one email** with 20 different valid tokens, 50 groups: at most one 201 per group.
- `reuse`: 20 simultaneous registrations with the **same email and token**, 50 groups: exactly one 201 per group.
- `otp`: one email, 20 simultaneous sends then 20 simultaneous verifies of the mailed code, 25 groups: one live code, exactly one verify 200, one mail per email (sink `/stats`).
- `sameAccountLogin`: 10 simultaneous correct-password logins for **one account**, 25 groups: some 200, the rest may be 429 (per-email limit), never 5xx.
- `sameSessionRefresh`: login, then 5 simultaneous refreshes with **one refresh cookie**, 25 groups: exactly one 200 and the others 409 `REFRESH_RACE`.
- `verify.sql` after **every** test (also after performance runs): duplicate emails, tokens used twice, registrations without credential / session / enrolment, consumed tokens without registration, `idle in transaction`.
- **Not covered:** lost updates in onboarding save (needs the save contract confirmed; the `version` column suggests optimistic concurrency but enforcement has not been checked), payment (no payment code exists), PDF generation and Drive.

## Metrics and where each comes from

| Metric | Source |
|---|---|
| Achieved API RPS, dropped iterations | k6 `api_requests` rate (sink polls excluded), `dropped_iterations` |
| Max / average in flight, seconds at >= 100 | **probe** `maxInflight`, `avgInflight`, `secondsAtOrAboveThreshold` |
| p50 / p95 / p99 per endpoint | k6 `latency_<endpoint>`; whole flows: `flow_duration_<flow>` |
| HTTP status by endpoint | k6 `resp_<endpoint>_<status>`; grouped: expected, validation 400/422, auth 401/403, conflict 409, rate-limited 429, busy 503, unexpected 5xx |
| Scrypt throughput, duration, concurrency | probe `scrypt.total / avgPerSec / peakPerSec / maxRunning / durationMs` |
| CPU, memory | `sample.sh` (`ps`: CPU % is per core), probe `rssMb` |
| PostgreSQL connections, lock waits, longest active query | `sample.sh` |
| Pool wait, pool timeouts, waiting callers | probe `pool.*` |
| Query latency | probe `queries.ms` (every statement, measured at the driver) and `topByTotalTime`; `pg_stat_statements` if enabled |
| OTP generation / verification / SMTP delivery, separately | `latency_otp_send` (API incl. its own mail delivery), sink `deliveryMs` (mail delivery alone; the difference is OTP generation), `latency_otp_verify`, `smtp_code_wait` |
| SMTP delivery success, concurrent connections | sink `/stats` (`messages`, `failed`, `connectionsMax`) vs `resp_otp_send_200` |
| SMTP queue | **None exists today** (mail is sent inside the request). `smtp_code_wait` would grow once an outbox is added; add outbox depth and oldest-pending age then. |
| Registration integrity | `verify.sql`, `dup_email_201`, `token_reuse_201`, `otp_verify_200` |

## Which tests must pass

| Test | Individually | At 2 replicas | Together |
|---|---|---|---|
| 1 Registration-heavy | Yes | Yes | feeds 3 |
| 2 Login-heavy | Yes | Yes | feeds 3 |
| 3 Combined | Yes: the "together" gate (R1 and R2 at once) | Yes | n/a |
| 4 Concurrency | Yes (server-measured) | Yes | in 3 |
| 5 Burst | Yes (deliberate rejections only, recovery) | Yes | once with staff traffic running (Option C) |
| Integrity + `verify.sql` | Yes, and after every other run | Yes | after 3 and 5 |
| Controls still on | Yes | n/a | before any performance run counts |
| `exposure-check.sh`, DB-role checks (Option C) | Yes | n/a | before any Option C run counts |

## Results

None. Add one dated section per run: configuration (above), the `evaluate.mjs` table, `verify.sql` output, anything surprising.
