# Project scope charter and confirmed decisions (governing document)

Status: **planning only. Nothing is implemented, migrated, deployed, installed or committed.** Where another planning document disagrees with this one, **this one governs** and the other document carries a banner pointing here.
Date of this revision: 2026-11-19.

## 1. Purpose and rule

**Purpose:** separate the four public frontend portals and the staff portal, and restructure backend services **only where there is a demonstrated technical or security reason**. This is **not** a product redesign and **not** a rewrite of existing functionality.

**Rule for every proposed change:** it must (1) **preserve existing functionality** exactly, and (2) be **justified by a concrete requirement or a piece of evidence** (a code reading, a measurement, or a confirmed lead requirement). A change that cannot be justified is out of scope. A change that cannot preserve existing behaviour is **not made silently**: it is listed in section 6 and **waits for approval**.
No unnecessary services, workers, databases, security systems or architectural complexity are added.

## 2. Existing behaviour that must be preserved

Registration and onboarding workflows. Parent login and sessions. OTP verification. Staff login and the Sales/Admin workflows. Registration data and database behaviour. PDF generation, Google Drive storage and parent downloads. Email notifications. Existing business rules and permissions. Mobile app behaviour and API compatibility. Existing logging and audit functionality.

## 3. Confirmed product and scope decisions

| # | Decision | Effect on the plans |
|---|---|---|
| **SA-30** | Additional encryption, **new field-level restrictions**, and **changes to the existing collection** of PAN, passport, address, allergy and meal information are **OUT OF SCOPE**. Existing collection, storage, PDF generation and access behaviour are preserved. No extra protection mechanism for these fields is added by this project | SA-30 is closed as out of scope. The access-matrix proposal's masking, tiers and step-up ideas are **not** part of this project (section 5) |
| **D9** | The registration PDF workflow stays **exactly as it is**: on successful registration the PDF is stored automatically in the company's designated Google Drive folder; the folder is accessible only to authorised company personnel; parents keep the existing option to download their PDF to their own device and **never** receive access to the Drive folder. Any future separation of Drive credentials or background processing is an internal detail that must not change the parent experience or company workflow. **No existing PDF functionality is removed, redesigned or replaced** | The **worker** (S4), the asynchronous PDF-retry redesign (earlier D6) and a worker read service are **withdrawn from this project**. The public API keeps the Drive flow as it is today |
| **Q4** | **No** external audit checkpoint infrastructure, separate cloud logging storage or new logging platform. Existing logging and audit functionality is preserved. Only genuinely necessary **existing** audit-log permissions are documented. External tamper-evidence infrastructure is **OUT OF SCOPE** unless the company separately requests it | `audit_append`, the keyed hash chain, `audit_head`, checkpoints, a verifier and administrator-action logging are **withdrawn** (earlier D3). Section 4.2 lists the existing audit permissions |
| **Scope** | Separation of the portals; backend restructuring only with demonstrated reason; no unnecessary services, workers, databases or security systems | Section 4 (justification register) and section 5 (what is out of scope) |

**Earlier decisions that stand (unchanged):** D1 as a **conditional** internal change (only if the database-role split is approved, section 4); D4 verify platform capabilities on disposable staging before any migration; D5 composite foreign key (retained, see section 6 item 6); D8 connection limits derived from measured capacity, never invented; dependency decisions (`body-parser` 2.4.0, `nodemailer` 10.6.0, `minimatch` 11 reviewed, security patches not subject to the seven-day rule, separate mobile review, no Expo downgrade).

## 4. Justification register: what remains and why

Each row names the **concrete requirement or evidence**. "Conditional" means it happens only if the stated gate is approved. Nothing marked Out of scope is built by this project.

### 4.1 In scope

| Item | Concrete justification | Preserves behaviour? | Gate |
|---|---|---|---|
| Four public portals and the staff portal as separate frontend deployments (`apps/portal-*`, `apps/web-server`) | The project's purpose; already built in Phase 1 | Yes (same-origin proxy keeps cookies and Origin checks) | None |
| Per-variant link host in the staff panel | Required **by** the portal separation: the staff panel builds links from one `PUBLIC_BASE_URL`, but there are now four hosts (`catalog/service.js` about lines 89 to 92) | **Not today** (section 6 item 1) | **Approval** |
| Dependency security updates (`body-parser` 2.4.0, `nodemailer` 10.6.0, eslint toolchain; mobile separately) | Known advisories (`npm audit`); decided | Yes (identical output verified for the OTP messages) | Approval to implement |
| Capacity work needed to meet the confirmed **100 concurrent / 100 RPS** requirement: only items the staging load test shows are necessary (for example hash outside the registration transaction, pooled SMTP, database-backed counters for in-memory limiters when more than one replica runs) | Confirmed lead requirement (`CONCURRENCY.md`) | Yes (internal) | Each item gated on a measured failure; none before the staging test |
| Distributed rate limiting for the in-memory limiters **if more than one replica runs** | Limits multiply per replica and reset on deploy [Code] | Yes (limits intended values unchanged) | Replica count decision |
| Route authorization and ownership **tests** (no behaviour change) | Demonstrates existing rules hold across the split | Yes | None |

### 4.2 Conditional on approving the backend split (Option C) and the database-role split

Option A (one API, today's structure, hardened where measured) remains the baseline. Option C is **proposed**, not decided: its justification is a **demonstrated** exposure, not a preference. Evidence: the single API process serves public and staff routes with **one database role that can read and write staff credentials, sessions and the audit log**; a flaw in any public route reaches them (`apps/api/src/app.js`, one `DATABASE_URL`, no roles).
If approved, **only** these are added, each preserving behaviour:

| Item | Justification | Notes |
|---|---|---|
| Staff API as a separate deployment of the **same codebase**; no new product code | Remove staff routes from the public process | Config-driven; shared code stays shared |
| DB roles `pp_public`, `pp_staff`, `pp_ops` (operator CLIs) and the owner `pp_migrator` | Limit blast radius | **No** `pp_worker`, **no** extra definer roles beyond the two below |
| `resolve_public_trip_for_registration` definer function (D1) | The public role cannot take the row lock registration uses unless it has UPDATE; the function keeps the exact lock semantics without broad UPDATE | Equivalence test V8; needed **only** if roles are split |
| `trip_live_location_stop_on_trip_end` re-created as `SECURITY DEFINER` (SA-02) | Trigger runs with the caller's rights; staff closing a trip must still wipe the live location without staff gaining write on positions | **Only** if roles are split; equivalence test P3 |
| Staff OTP kept working across the split | Staff and parents share the OTP tables; after the split a public-role compromise could read staff addresses (SA-04) | **Options for approval:** (a) separate staff OTP tables (small schema change); (b) accept the residual exposure and document it. Not decided |
| Existing audit-log permissions | Staff code already writes and reads `audit_log` | Below |
| Composite foreign key on forms (D5) | SA-22: the database does not enforce that a form's enrolment belongs to its registration | Retained; **independent of the split** and can ship separately |
| Connection limits and timeouts (D8) | Several services and replicas share one database | From measurement |

**Existing audit-log permissions (Q4), nothing new:**
The code already uses `audit_log` as follows [Code]: `staff` modules, `catalog`, live-location team-lead assignment and the bootstrap and cleanup tools **insert**; the staff panel **reads** the latest entries (admin only). The append-only trigger (`audit_log_no_update`, refusing UPDATE and DELETE) **stays unchanged**. Under a role split the necessary permissions are therefore:
`pp_staff`: `INSERT` and `SELECT` on `audit_log`, `USAGE` on `audit_log_id_seq`. `pp_ops`: `INSERT` and `SELECT` (cleanup and provisioning tools). `pp_public`: **none** (no public code path writes the audit log). No role has `UPDATE`, `DELETE` or `TRUNCATE`. This is what the existing functionality needs; **it adds no mechanism**. A side effect, not a new feature: runtime roles no longer own the table, so they cannot drop the trigger.
What this does **not** provide (and the project does not claim): protection against a database owner or administrator, or detection of tail deletion. That is the external infrastructure that is out of scope.

## 5. Out of scope for this project (withdrawn or deferred)

| Item | Where it appeared | Status |
|---|---|---|
| Encryption, masking, new field-level restrictions, minimised collection for PAN, passport, address, allergy, meal data (SA-30) | `DB-PRIVILEGE-MANIFEST.md` 12, `STAFF-ACCESS-MATRIX-PROPOSAL.md` | **Out of scope** (decision) |
| Worker service (S4), asynchronous PDF-retry redesign, worker read service for downloads (D6, D9 options) | manifest 3b, 9b | **Withdrawn** (decision D9) |
| `audit_append`, `audit_head`, keyed hash chain, external checkpoints, independent log storage, verifier, DDL event-trigger alerting, `pgaudit` shipping, `TRUNCATE` trigger addition | manifest 5.5, `SECURITY-ARCHITECTURE.md` 4.3 | **Withdrawn / out of scope** (decision Q4); a `TRUNCATE` trigger is also dropped as new mechanism |
| Staff access matrix beyond the **existing** Sales/Admin permissions (tiers, masking, step-up authentication, capability functions, reason codes, second approvers, bulk caps, read auditing) | `STAFF-ACCESS-MATRIX-PROPOSAL.md` | **Deferred**: documentation of the baseline only; no change to who can do what today. New staff features would need a separate request |
| Staff MFA (M5), retention and erasure design (M6), secrets rotation system (M11), monitoring platform and runbooks (M8), restore-drill programme (M7), Drive account tooling (M12), reconciliation process (M14), payment prerequisites (M15) | `SECURITY-REQUIREMENTS-M1-M15.md` | **Outside the separation project.** They remain items on the company's security list and are tracked separately; this project neither builds nor blocks on them (section 8) |
| Email outbox and background mail worker; edge protection against hash exhaustion; separate payments service; any new database | `CONCURRENCY.md` 4 items 3 and 11, `SECURITY-ARCHITECTURE.md` 6.4 | **Out of scope** (payments remain future and plan-only) |
| Moving OTP retention purge, Drive upload and housekeeping purges out of the API processes | manifest 3a, 9 items 3 and 4 | **Withdrawn**: they stay where they are |

## 6. Existing functionality that cannot be preserved unchanged, or is at risk: STOP for approval

Nothing below has been changed. Each is a place where the proposed structure **cannot** keep today's behaviour without an explicit decision.

| # | Functionality | Why it cannot stay unchanged | Smallest proposed handling | Needs |
|---|---|---|---|---|
| 1 | **Staff "copy the trip's public link"** (**implemented** with four per-variant host variables and a fallback; see `DEPLOYMENT.md`) (and the links staff share) | One `PUBLIC_BASE_URL` cannot name four portal hosts; the link would point to the wrong portal for three of four variants (`catalog/service.js` about 89 to 92, `config.js` `PUBLIC_BASE_URL`) | A small configuration map from trip variant to portal host (internal, no UI redesign) | **Approval**; a staging check for all four variants |
| 2 | **Staff sessions** if the signing secret is split between the public and staff services | Staff session and token hashes use the current shared secret; a new staff secret signs out every staff member once | Either keep the **same secret value** in both services (sessions preserved, key separation not achieved) or split and accept one staff re-login. Parent and mobile sessions are preserved either way if the current value stays the parents' | **Decision** |
| 3 | **Shared OTP tables (staff and parents)** after a role split | A compromised public API could read staff addresses and invalidate staff codes (SA-04) | (a) separate staff OTP tables (a schema change), or (b) accept the exposure | **Decision**; (a) changes the database |
| 4 | **Operator command-line tools** (`npm run staff`, `bootstrap:admin`, `catalog:cleanup`) | They use one `DATABASE_URL`; after a role split they need the operator role's credential, a change to how administrators run them | Documented operator procedure; no tool behaviour change | **Approval** if roles are split |
| 5 | **The legacy combined service** (`railway.json`: API serving the frontend, all routes) | Cannot coexist with a restricted-role design: it needs the all-powerful role. Rolling back to it re-opens the single-role path | Keep it **only until cutover**, then retire it and revoke its credential | **Approval** of cutover and rollback plan |
| 6 | **Database behaviour for forms (D5 composite key)** | New constraint rejects a form whose enrolment belongs to another registration. The application never creates such rows, but it **is** a change to database behaviour | Retain as decided (independent of the split, shippable separately); data checks and rollback are in the plan | **Reconfirm** under this charter |
| 7 | **Public API holding Google Drive credentials** | Not a loss of function: it is the existing design and, with the worker withdrawn, it **stays**. The risk (a compromise of the public API reaching Drive) is accepted and unchanged | None (company-managed Drive account settings; the folder's authorised-only access is an existing operational control that this project cannot verify) | **Company confirms** the Drive folder access list |
| 8 | **Platform capabilities** (custom roles, definer-function ownership, per-role limits) | Unverified on Railway; if unavailable the role split cannot be done as designed | Probes on disposable staging; fallback options in `DB-MIGRATION-AND-TEST-PLAN.md` 3.2 | Probe results; **stop and report** on failure |

**Items I checked and found preservable** (no decision needed): mobile app API and origin (public API keeps `/api/mobile/*` at the existing origin; tokens keep their own hash domain), parent registration and onboarding, parent PDF download from the stored copy, OTP delivery by email, staff Sales/Admin permissions (as listed in `STAFF-ACCESS-MATRIX-PROPOSAL.md` section 1), live-location behaviour, housekeeping (stays in the API processes), existing logging.

## 7. Plan changes applied to the other documents

| Document | Change |
|---|---|
| `DB-PRIVILEGE-MANIFEST.md` | Banner; `pp_worker`, `pp_def_audit` and the worker sections removed from scope; "interim" PDF permissions become the **permanent** public-API permissions; `audit_append` replaced by the existing audit permissions; D6 redesign withdrawn; SA-30 out of scope; decision record rewritten |
| `DB-MIGRATION-AND-TEST-PLAN.md` | Banner; migration steps for `audit_append`, `TRUNCATE` trigger, worker and PDF-request column removed; staff OTP tables marked decision-dependent; probes and fallbacks for event triggers and `pgaudit` marked informational |
| `STAFF-ACCESS-MATRIX-PROPOSAL.md` | Banner; documents the **existing** Sales/Admin baseline only; proposed restrictions deferred |
| `SECURITY-ARCHITECTURE.md` | Banner and a scope note; audit design v2, payment-service placement and non-separation items marked out of scope; SA-30 closed |
| `SECURITY-REQUIREMENTS-M1-M15.md` | Scope classification table; M1 to M3, M9, M10 (tests) tied to the separation; the rest tracked separately |
| `CONCURRENCY.md`, `ARCHITECTURE-OPTIONS.md` | Scope notes: each proposed code change gated on measurement; Option A baseline, Option C an approval gate; no outbox, no worker |
| `DEPENDENCY-UPDATE-PLAN.md`, `MOBILE-DEPENDENCY-REVIEW-PLAN.md` | Unchanged (decided) |

## 8. Remaining genuine blockers and decisions

1. **Is the backend split (Option C) and the database-role split approved**, or does the project stay on Option A (portal separation only) for now? Everything in 4.2 depends on this. If the answer is "not now", the role work, definer functions and OTP-table decision all wait.
2. Section 6 items 1 to 5 and 8: each needs the approval or decision named there.
3. **D5 reconfirmation** (item 6).
4. **`019`** (unapplied migration): apply before any role work, or not at all in this project?
5. **Company confirmation** that the Drive folder's access list is limited to authorised personnel (item 7). Not something the code can prove.
6. Approval to run the staging capability probes (gate G0) and, later, to implement the dependency updates.
7. Items outside the separation project (M5, M6, M7, M8, M11, M12, M14, M15) are **not blockers for it**, but they stay on the company's security list; decide when they are scheduled.
