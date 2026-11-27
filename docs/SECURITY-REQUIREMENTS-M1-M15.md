# Mandatory security requirements M1 to M15: milestone, risk, dependency, acceptance test

Status: **all fifteen items are NOT STARTED and NOT COMPLETE.** The list is preserved from `docs/SECURITY-ARCHITECTURE.md` section 11 without removal or weakening.
**Rule (permanent): no item is marked complete on the strength of documentation.** An item is complete only when its **acceptance test has been executed**, its **evidence** (test output, drill record, signed review, screenshot of a setting with date and who captured it) is stored in the release record, and someone other than the implementer has checked it. A document, a plan, a merged pull request or a green build is not evidence.
Status values used below: `Not started` (all items today), `In progress`, `Verified` (evidence attached and independently checked), `Accepted exception` (owner, reason, expiry date, lead sign-off).

Milestones: **MS-A** before any real children's data is collected or staff use the system with real data; **MS-B** Option C go-live (split services); **MS-C** production release with multiple replicas; **MS-D** before online payments (not before the current phase).
**Lead decisions are applied below** (recorded in `DB-PRIVILEGE-MANIFEST.md` 13 and `SCOPE-CHARTER-AND-DECISIONS.md`). Acceptance tests were extended, never weakened; the project-scope classification below governs what is built now.
Findings referenced (SA-xx) are in `SECURITY-ARCHITECTURE.md` 10, `DB-PRIVILEGE-MANIFEST.md` 12 and `DEPENDENCY-UPDATE-PLAN.md` 9.

## Scope classification under `SCOPE-CHARTER-AND-DECISIONS.md`

The list M1 to M15 stays as the **company's mandatory security list**; nothing is deleted. Because the current project is the **separation of the portals with backend changes only where justified**, each item is classified. "Outside the project" means it is **neither built nor blocked** by the separation project and is scheduled separately by the company.

| # | Relationship to the separation project |
|---|---|
| M1 | **Conditional part of the project** (only if the backend and role split are approved) |
| M2 | **Conditional** (depends on the staff-OTP-tables and secret decisions, charter 6 items 2 and 3) |
| M3 | **Conditional** (only if the staff API is separated) |
| M4 | **In project** (dependency updates, decided); CI gate is the company's call |
| M5 MFA | **Outside the project** (new security system; existing staff login unchanged) |
| M6 retention and erasure | **Outside the project** (new function; existing collection and storage preserved) |
| M7 backups and restore drill | **Outside the project** as a programme; the role-aware restore point applies only if roles are split |
| M8 monitoring and incident runbook | **Outside the project** (no new logging platform; existing logging preserved) |
| M9 distributed rate limiting | **In project only if more than one replica runs** (limits multiply per replica); correct client address (`TRUST_PROXY_HOPS`) needed by the proxy layout |
| M10 route and ownership tests | **In project** as tests only (no behaviour change); independent review is the company's call |
| M11 secrets | **Conditional** (secret split only if the staff API is separated); rotation system **outside the project** |
| M12 Drive hardening | **Outside the project** (existing Drive flow unchanged, decision D9; the folder's authorised-only access is a company-managed control) |
| M13 audit hardening | **Reduced to existing permissions** (Q4): INSERT and SELECT for staff and operator roles, no UPDATE, DELETE or TRUNCATE; everything else **out of scope** |
| M14 reconciliation process | **Outside the project** (process, not architecture) |
| M15 payment prerequisites | **Outside the project** (payments remain future and plan-only) |

The acceptance tests below for **in-project or conditional** items are still required for those items. For items **outside the project** the text is retained for the company's later use; it must not be read as work this project will perform.

## Summary

| # | Requirement | Milestone | Status |
|---|---|---|---|
| M1 | Separate DB roles with privilege manifest tests | MS-B | Not started |
| M2 | Staff OTP tables and signing keys separate from parents' | MS-B | Not started |
| M3 | No staff routes or code in the public API | MS-B | Not started |
| M4 | Dependency updates and a CI audit gate | MS-A | Not started |
| M5 | MFA for staff (admin first) | MS-A | Not started |
| M6 | Retention schedule and erasure procedure | MS-A | Not started |
| M7 | Backups with a timed, tested restore | MS-A | Not started |
| M8 | Monitoring, alerting, incident runbook, named owner | MS-A | Not started |
| M9 | Distributed rate limiting; correct client address | MS-C | Not started |
| M10 | Route authorization and ownership matrix tests; independent review | MS-A (tests), final review before release | Not started |
| M11 | Secrets: store, owners, rotation with dual-key window | MS-A (store, owners), MS-B (split, rotation) | Not started |
| M12 | Google Drive account hardening or removal | MS-A | Not started |
| M13 | Audit hardening: INSERT-only roles, DDL alerting, privileged-read auditing | MS-A (CLI and DDL alerting), MS-B (roles) | Not started |
| M14 | Staff reconciliation of registrations; team-lead identity confirmation | MS-A | Not started |
| M15 | Payment prerequisites, payment threat model and independent review | MS-D only | Not started |

## Detail

### M1. Separate database roles, with privilege manifest tests
- **Milestone:** MS-B.
- **Risk addressed:** one DB role for every service, so any SQL injection or code execution in a public route reaches staff credentials, sessions, the audit log and all parent data (ranked risk 1; SA-01, SA-02, SA-03).
- **Implementation dependency:** decisions D1 to D8 (`DB-PRIVILEGE-MANIFEST.md` 13); the **capability probes P1 to P17 on a disposable staging database, with the report reviewed and any fallback chosen** (`DB-MIGRATION-AND-TEST-PLAN.md` 3; nothing assumed available); the definer function for the registration trip lock (D1, no removal of the lock, no broad UPDATE); the composite foreign key (D5); code changes in manifest section 9; connection limits and timeouts **computed from measured capacity** (D8, migration plan 5); a staging database.
- **Acceptance test (objective):**
  1. The manifest test (10.2) passes: the live catalog equals the manifest exactly, with no extra object or privilege.
  2. The runtime capture (10.1) shows **no application statement outside the manifest**.
  3. The role-scoped integration suites (10.3) pass under `pp_public`, `pp_staff`, `pp_ops`, and **no application connection is a superuser or the owner**.
  4. Forbidden operations F1 to F17 all fail with 42501 and permitted operations P1 to P6 all succeed; P3 shows the definer trigger wiping a live position when staff close a trip.
  4a. **D1 tests pass:** concurrency tests C1 to C8 and behaviour and security tests V1 to V8 (`DB-PRIVILEGE-MANIFEST.md` 5.3), including that `pp_public` cannot lock or update `trips` directly and that the function leaves `trips` unchanged.
  4b. **D5:** the composite-key tests (`DB-MIGRATION-AND-TEST-PLAN.md` 4.4) pass, including the SA-22 reproduction now failing with `23503`.
  4c. **D8:** the connection budget sheet is complete from measured values, and under the role-pooled burst test every role stays within its limit and exceeding it fails fast.
  5. The compromise simulation (10.5) finds no cross-domain read or write.
  6. A canary replica runs on each role for at least one agreed observation window with **zero unexplained 42501** errors.
- **Evidence:** capability report, CI run URLs and logs for items 1 to 5 and 4a to 4c; the connection budget sheet; canary window log.

### M2. Staff OTP tables and signing keys separate from parents'
- **Milestone:** MS-B.
- **Risk addressed:** a role or process that can write the shared OTP tables can read staff addresses, invalidate staff codes and, with a shared key, forge verification tokens (SA-04); a shared secret means one leak affects every identity (SA-17).
- **Implementation dependency:** M11 (secrets), manifest section 9 item 1 (table parameter; new tables), the secret-split sequence (current value kept as the parent secret; new staff secret).
- **Acceptance test:**
  1. As `pp_public`: any read or write of `staff_email_otps` / `staff_verification_tokens` fails (F8), and the parent tables contain no `staff_password` rows.
  2. The staff API **refuses to start** when given the parent secret as its signing secret, and the public API refuses to start when it can see the staff secret.
  3. Forgery test: insert a verification-token row for a staff email using the parent secret's hash, then call the staff password-confirm route: rejected.
  4. **Compatibility test:** a parent session and a mobile session created before the change still authenticate afterwards; staff must sign in again (documented, expected).
- **Evidence:** test output; the cutover record showing the session check.

### M3. No staff routes or code in the public API
- **Milestone:** MS-B.
- **Risk addressed:** the public process answering admin paths (checks are role-only), and a public image carrying staff code and secrets (ranked risk 1 and the attack surface).
- **Implementation dependency:** the `public-api` and `staff-api` entrypoints and package boundaries (manifest section 9 item 5).
- **Acceptance test:**
  1. `scripts/loadtest/exposure-check.sh` against the public API returns **404** for every staff path (it fails today, which is the baseline).
  2. A route-inventory test lists the public router table and asserts **no path under `/api/admin`**; the staff API's table contains no parent-only routes.
  3. An import-graph test (or build analysis) proves the public build contains no staff module and reads no staff environment variable.
  4. Cross-token tests: a parent cookie and a mobile bearer token against the staff API, and a staff cookie against the public API, all return 401.
- **Evidence:** test output; build analysis report.

### M4. Dependency updates and a CI audit gate
- **Milestone:** MS-A.
- **Risk addressed:** known vulnerabilities in production dependencies (SA-06, SA-07, SA-08, SA-28) and the absence of any automated check.
- **Implementation dependency:** approval of `DEPENDENCY-UPDATE-PLAN.md` (sets U1 `body-parser` 2.4.0, U2 `nodemailer` 10.6.0, U3 eslint toolchain, with the evidence in its 3a); the mobile set U4 from `MOBILE-DEPENDENCY-REVIEW-PLAN.md`; a CI system (none exists in the repository). Security patches do not wait for the seven-day rule.
- **Acceptance test:**
  1. After U1 and U2, `npm audit --omit=dev` reports **no high or critical** and no remaining advisory without a recorded exception; `npm audit signatures` verifies.
  2. The lockfile-diff review matches the change set exactly (no unexpected packages, only registry hosts, no new install scripts).
  3. The per-update tests in plan section 5 pass, including the compressed-body regression (identical before and after) and the address-parser regression.
  4. **The gate works:** on a scratch branch, pin `body-parser` back to 2.3.0 and confirm the CI job **fails**; revert and confirm it passes.
  5. The same job runs for `apps/mobile`, with the policy that runtime-bundle advisories block a release and build-tool advisories are tracked with an owner and expiry; the shipped-bundle analysis result is recorded.
  6. The `body-parser` advisory's own proof of concept (to be obtained) is part of the regression suite and fails on 2.3.0.
- **Evidence:** CI runs including the deliberate failing run.

### M5. Multi-factor authentication for staff (admin first)
- **Milestone:** MS-A (before staff handle real children's data).
- **Risk addressed:** staff sign in with email and password only while able to reach children's data; credential theft or phishing is enough (SA-10).
- **Implementation dependency:** decision on the factor (authenticator app or hardware key); staff API change; enrolment and recovery design (lost device); M8 for alerts; M13 for audit events; **outside the project**.
- **Acceptance test:**
  1. An admin who knows the password but has no second factor **cannot** obtain a session (test through the real login route).
  2. A used authenticator code **cannot be replayed**; codes outside the allowed window are refused; attempts are throttled and counted.
  3. Enrolment and recovery work and each writes an audit row; recovery needs a second administrator or an out-of-band step.
  4. Sensitive actions (staff creation, exports) require recent authentication.
  5. Disabling MFA is impossible for the account itself without another admin.
- **Evidence:** test output; recovery drill record.

### M6. Retention schedule and erasure procedure
- **Milestone:** MS-A (before real children's data is collected).
- **Risk addressed:** children's data kept indefinitely, no way to honour deletion, copies in backups, Google Drive and logs (SA-11).
- **Implementation dependency:** legal decision on retention periods and consent (counsel; decision 7 in `SECURITY-ARCHITECTURE.md` 9); **outside the project**; a future erasure function and Drive deletion would be new functionality; SA-30 (sensitive fields) is out of scope.
- **Acceptance test:** on staging with synthetic data: create a registration, a submitted form, a stored PDF (fake Drive) and a live-location record; run the erasure procedure; assert that **the rows are gone, the Drive file is deleted, no personal data remains in `audit_log` details or logs, and an erasure record exists without personal data**; a retention job removes synthetic data past the schedule; documentation states when backups containing the data expire. The procedure is run by someone other than its author.
- **Evidence:** test output; signed retention schedule.

### M7. Backups with a timed, tested restore
- **Milestone:** MS-A.
- **Risk addressed:** data loss, ransomware or a bad migration with no recovery; a restore that omits roles and privileges (SA-26).
- **Implementation dependency:** confirmation of Railway's backup capability and retention [Unverified]; agreed recovery time and recovery point objectives (decision for the lead); roles and ACL capture (`pg_dumpall --roles-only` or equivalent).
- **Acceptance test:** restore the latest backup into a **fresh instance**, measure the elapsed time against the agreed objective, then run the manifest test, a role smoke test (each flow once under each role), and row-count and checksum comparisons with the source. Backups are encrypted and access is limited and logged. The drill is repeated on a fixed schedule.
- **Evidence:** drill record with timings and results, signed.

### M8. Monitoring, alerting, incident runbook and a named owner
- **Milestone:** MS-A.
- **Risk addressed:** attacks and failures unseen or unanswered (ranked risk 6); secrets or personal data in logs.
- **Implementation dependency:** tool choice (log drain, metrics, alert routing, on-call); small code additions (counters, structured logs); a named incident owner (decision 8).
- **Acceptance test:**
  1. **Synthetic triggers fire alerts within the agreed time:** a refresh-token reuse, a login-failure spike, a burst of 503 busy, a 5xx rate rise, database connections at 80%, and (when present) an audit checkpoint gap.
  2. **Log redaction test:** run a load test with synthetic users and scan all produced logs for email addresses, OTP codes, tokens, passwords and phone numbers: zero matches.
  3. A **tabletop exercise** of the runbook (contain, preserve evidence, rotate secrets, notify, review) is completed with the named owner and produces dated actions.
- **Evidence:** alert screenshots with timestamps, scan output, exercise record.

### M9. Distributed rate limiting and correct client address
- **Milestone:** MS-C (before multi-replica production).
- **Risk addressed:** limits multiplied by the replica count and reset on deploy (in-memory limiters); per-IP defences that do nothing or punish whole schools if `TRUST_PROXY_HOPS` is wrong.
- **Implementation dependency:** shared-store decision (PostgreSQL counters or Redis); the staging measurement in `docs/CLIENT-IP-STAGING-VERIFICATION.md`; the edge protection decision.
- **Acceptance test:**
  1. With **two replicas**, a limit of N hits per window allows exactly N across both when requests alternate; a restart does not reset it.
  2. Through the real proxy chain on staging, `req.ip` equals the test client's address; a spoofed `X-Forwarded-For` is ignored.
  3. Every limiter in the code is backed by the shared store (a test lists the limiters and fails if one is in memory).
  4. The load tests in `CONCURRENCY.md` pass with the limits **on** and the `ratelimit` scenario confirms they still answer 429.
- **Evidence:** test output; staging header measurement.

### M10. Route authorization and ownership matrix tests; independent review
- **Milestone:** MS-A for the tests; the independent review before any production release.
- **Risk addressed:** a route without a guard, or one that trusts a client-supplied id (horizontal and vertical escalation); no independent assurance.
- **Implementation dependency:** a route inventory generated from the routers; a test harness with two parents and two staff roles; a reviewer who did not write the code; the existing Sales/Admin permissions are the baseline the tests assert (`STAFF-ACCESS-MATRIX-PROPOSAL.md` 1).
- **Acceptance test:**
  1. **CI fails if any route lacks an explicit guard** declaration.
  2. For every route taking an id: parent A requesting parent B's enrolment, form, PDF or location receives 404 (or 403) and no data; the wrong staff role receives 403; an unauthenticated call receives 401.
  3. Attack tests: replay of an OTP, verification token and refresh token; concurrent refresh; mass assignment attempts; oversized and malformed input.
  4. **Independent review:** a written scope, a report with each finding rated, and every finding closed or formally accepted before release.
- **Evidence:** CI logs; review report and closure record.

### M11. Secrets: store, owners, rotation with a dual-key window
- **Milestone:** MS-A for the store and owners; MS-B for the split and rotation.
- **Risk addressed:** one secret for every identity; secrets readable by too many people; no way to rotate without ending every session (SA-17).
- **Implementation dependency:** inventory of every secret; Railway (or other) secret-store permissions [Unverified]; dual-key verification code for session, OTP and token hashes.
- **Acceptance test:**
  1. A secrets inventory lists each secret, its service, owner and next rotation date, and the platform's access list for secrets is reviewed.
  2. **Rotation drill on staging:** rotate the parent secret with a dual-key window; existing sessions stay valid during the window and the old key is then removed with no sign-in loss beyond the planned one.
  3. A secret scan of the repository history and build output is clean.
  4. Each service refuses to start with a wrong-domain secret (see M2).
- **Evidence:** inventory; drill record.

### M12. Google Drive account hardening or removal
- **Milestone:** MS-A.
- **Risk addressed:** every PDF copy (children's data) behind one OAuth refresh token in an environment variable and one Google account (SA-12).
- **Implementation dependency:** decision whether Drive copies are needed at all; **outside the project**: the Drive flow and credentials stay in the API as today (D9); the company confirms the folder's access list.
- **Acceptance test:** the Drive account has hardware-key multi-factor sign-in (administrator export or dated screenshot), **no other members**, and an OAuth-grant list showing only this application; creating a new grant triggers an alert; ~~public API without Google variables~~ **[withdrawn: the Drive flow is unchanged, decision D9]**; the existing PDF tests pass unchanged; deletion of a stored file works (M6). If Drive is removed, the test is that no code path uploads and no stored copy remains.
- **Evidence:** dated administrator exports; test output.

### M13. Audit hardening
- **Milestone:** MS-A for command-line audit rows and DDL alerting; MS-B for INSERT-only roles.
- **Risk addressed:** audit rows that can be truncated or edited by the application role; privileged actions and reads of children's data that leave no record (SA-05).
- **Implementation dependency (reduced by decision Q4):** M1 (roles) so that staff and operator roles hold only the **existing** `audit_log` permissions. No `audit_append`, no event triggers, no `pgaudit`, no external infrastructure.
- **Acceptance test:**
  1. As `pp_staff` and every runtime role: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` on `audit_log`, `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER` all fail (F14); the existing code paths keep writing through plain INSERT under `pp_staff` and `pp_ops` and the existing audit tests pass unchanged.
  2. ~~DDL alert, command-line audit rows, privileged-read auditing~~ **[out of scope: no new mechanism]**.
- **Evidence:** test output; alert record. **Wording rule:** the log is described as an *append-only table protected by a trigger*; the words *tamper-evident*, *tamper-proof* or *immutable* are not used, because external anchoring is out of scope (decision Q4) and a database owner or administrator can still alter it.

### M14. Staff reconciliation of registrations; team-lead identity confirmation
- **Milestone:** MS-A (process).
- **Risk addressed:** registrations created with an email only, with no proof of guardianship (SA-14); a self-declared "Team Leader" being assigned to share a trip group's location (SA-13).
- **Implementation dependency:** a written procedure approved by the product owner; a report or screen that compares registrations with school lists; a confirmation step before team-lead assignment.
- **Acceptance test:** the procedure is approved and dated; a dry run on a synthetic dataset with N seeded mismatches produces a report listing **exactly those N**; team-lead assignment cannot complete without the confirmation step (test) and writes its existing audit row.
- **Evidence:** approved procedure; dry-run output.

### M15. Payment prerequisites, payment threat model and independent review
- **Milestone:** MS-D only. **Not required for the current phase.** No payment code is written before approval.
- **Risk addressed:** insecure or inconsistent payment handling (forged webhooks, replays, amount tampering, double payment, refund abuse), and building payment on an unready base.
- **Implementation dependency:** M1, M2, M5, M7, M8, M9, M11, M13 complete; the readiness checklist in `SECURITY-ARCHITECTURE.md` 6.6 (worker and outbox, idempotency mechanism, trusted `trip_prices`, booking status, payment types in contracts); provider chosen (decision 6).
- **Acceptance test (before go-live):** a **payment-specific threat model approved**; in a provider sandbox: a forged webhook signature is rejected, a replayed event is stored once and ignored, an amount or currency mismatch is refused, a duplicate order request with the same idempotency key creates one order, the browser return page never changes order state, a refund above the captured amount is refused, a reconciliation run reports seeded discrepancies, and every state change has an audit row; **no card number or CVV appears in any table or log** (scan); an **independent payment review** is closed.
- **Evidence:** sandbox test output; review report.

## Dependency order between items

`M11 (store and owners)` and `M7`, `M8`, `M4`, `M5`, `M6`, `M12`, `M14` can start independently for MS-A. `M1` needs the platform answer (D4) and the manifest decisions. `M2` and `M3` need the service split and `M11`. `M13` layer 1 needs `M1`. `M9` needs the staging header measurement. `M10` tests can start immediately; the independent review comes last. `M15` needs the rest.
