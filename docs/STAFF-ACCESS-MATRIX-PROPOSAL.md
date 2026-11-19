# Staff access: existing baseline (preserved) and deferred proposals (decision D7)

Status: **re-scoped.** Under `docs/SCOPE-CHARTER-AND-DECISIONS.md` the project **preserves existing Sales/Admin permissions and staff workflows exactly** and adds **no** new field-level restriction, masking, step-up authentication, capability function, reason code, approval rule or read auditing (SA-30 and the staff-access ideas are out of scope). Section 1 (the existing baseline) is the only part that applies to this project. Sections 2 to 7 are a **deferred proposal** kept for the company if it later requests new staff features; **nothing in them is planned or built.** Final access decisions belong to the company. The default is **deny**: staff may do only what is listed as allowed, and every new read of children's personal information is a new, reviewed, audited capability.
Related: `DB-PRIVILEGE-MANIFEST.md` (the database side), `SECURITY-REQUIREMENTS-M1-M15.md` (M5 staff MFA, M10 route matrix, M13 audit), `SECURITY-ARCHITECTURE.md` (SA-10, SA-14, SA-30).

## 1. What exists today (baseline, from the code)

- Two staff roles: **admin** and **sales** (`staff/provision.js`).
- **Scoping:** an admin manages every school; a salesperson manages **only the schools they created** (`schools.created_by`) and those schools' trips; another's school is "not found" (`catalog/service.js`, covered by `sales-ownership` tests). Sales can open a draft and close an active trip; only admin can reopen or archive.
- Staff routes: school and trip management, trip public-page on/off, school logo, team-lead assignment and trip live-location view (any staff who may manage the trip), staff management and audit viewing (admin only).
- **No staff route reads a registration, a form, a PDF or any participant data today.** Staff see names and emails of team-lead **candidates** only (to assign one). The database role therefore needs no access to forms at all (`DB-PRIVILEGE-MANIFEST.md` 3). **Any future dashboard that shows participant data is a new capability and needs this matrix approved first.**
- Staff sign in with email and password only (no MFA). **Unchanged by this project** (MFA is outside the separation project).
- **Default-deny at the database level (in scope if the role split is approved):** `pp_staff` receives only the privileges the existing staff code uses (`DB-PRIVILEGE-MANIFEST.md` 3), which preserves every existing staff workflow and grants nothing more.

## 2. [DEFERRED, OUT OF SCOPE] Principles proposed

1. **Default deny** in the application and in the database (`pp_staff` has no privilege on forms, PDFs or registrations until a capability is approved and granted).
2. **Least data for the purpose:** each capability returns only the field tiers it needs.
3. **Scope first:** admin = all schools; sales = schools they created (as today); any further role states its scope.
4. **Every read of Tier 1 or higher is audited in the same transaction** as the read, through `audit_append` (a read that cannot be audited does not happen).
5. **Step-up authentication** (recent MFA) for Tier 2 and higher; **reason** required for Tier 2 and higher on individual records.
6. **No raw export** of Tier 3 or 4. Bulk output is capped, logged and approved.
7. **Separation of duties** for the most sensitive actions (Tier 4 reveal, erasure, bulk export): a second approver.
8. **Corrections are not edits:** submitted forms are immutable in the database; a correction is a controlled "reopen" action (admin, reason, audited), not a silent change.
9. Periodic access review by someone other than the person reviewed.

## 3. [DEFERRED, OUT OF SCOPE] Data tiers (from the onboarding definitions; SA-30 is out of scope)

| Tier | Contents | Examples (field keys in the code) |
|---|---|---|
| **T0 Operational** | No personal detail | school, trip, tour type, status, progress percent, submitted time, counts |
| **T1 Contact** | Who and how to reach | parent and participant names, phone, email, role |
| **T2 Personal** | Identity details | date of birth, age, gender, nationality, address, place of birth, class and section, meal preference, nominee name and relation, free-text remarks |
| **T3 Health** | Medical | allergies |
| **T4 Government and financial identifiers** | Highest harm if leaked | passport number, issue and expiry dates, place of issue; **PAN number**, PAN holder name, date of birth and relation |
| **T5 Location and attestations** | | live location of a trip group; signature name and declaration acceptance; the **PDF**, which contains all tiers |

## 4. [DEFERRED, OUT OF SCOPE] Proposed matrix

Legend: **Yes** allowed; **Reason** allowed with a recorded reason; **Approve** needs a second approver; **No** denied. "Own" = schools the person created; "All" = every school. Audit column states what must be written. **All entries are proposals.**

| Capability | Admin | Sales | Scope | Field tiers | Audit requirement |
|---|---|---|---|---|---|
| Manage schools and trips; public page on/off; logos | Yes (all) | Yes (own; limits on reopen and archive as today) | All / Own | T0 | Existing audit rows |
| View counts and progress per trip (registered, submitted, pending) | Yes | Yes | All / Own | T0 | None (aggregate); count reads in monitoring |
| View the participant list of a trip (names, contact) | Yes | Yes | All / Own | T1 | One audit row per list view: actor, session, trip, page, row count |
| Open one participant's form | Reason | No | All | T1 to T2 (T3 and T4 masked) | Audit row per record: actor, entity, tiers shown, reason code |
| See allergies (health) | Approve | No | All | T3 | Audit row with reason; consider a dedicated trip-operations role instead of admin |
| See passport or PAN values | Approve | No | All | T4 | Audit row with reason and approver; value **masked by default** (for example last three characters); reveal is a separate action; never exported; never logged |
| Download a participant's PDF | Reason | No | All | T5 (all tiers) | Audit row per download |
| Export a list (CSV) | Approve (T0 and T1 only) | No | All | T0 to T1 | Audit row with row count and approver; file not retained by the server |
| Export any T3 or T4 data in bulk | No | No | | | Not offered |
| View a trip's live location | Yes | Yes (own trips, active trip only) | All / Own | T5 | Audit row per view session (not per refresh) |
| Assign a team lead (existing) | Yes | Yes (own) | All / Own | T1 (candidates' names and email) | Existing `trip.team_lead_assign`; **add** an identity-confirmation step (SA-13) |
| Reopen a submitted form for correction | Reason | No | All | T0 | Audit row with reason; the parent is notified |
| Erase a registration (retention and erasure, M6) | Approve | No | All | all | Audit row without personal data; run through the single erasure function |
| Staff management (create, activate, deactivate) | Yes | No | | | Existing audit rows; add CLI audit (M13) |
| View the audit log | Yes | No | | | Reading the audit log is itself audited |
| Change a staff member's role | Approve | No | | | Audit row with approver |

**Open choices for the company:** whether Sales should see T1 at all (the proposal says yes for follow-up on their own schools); whether a **trip-operations role** (health and contact for the trip leader and field staff, scoped to a trip and dates) should exist instead of giving admin T3; whether finance needs a role before payments; the numeric limits (list page size, bulk caps, alert thresholds); whether several salespeople may share one school; who the second approver is for each "Approve" row.

## 5. [DEFERRED, OUT OF SCOPE] Technical enforcement proposed

1. **Capability functions in the database** instead of table grants. Each approved read is a narrow `SECURITY DEFINER` function (same rules as `DB-PRIVILEGE-MANIFEST.md` 5.4) that (a) applies the scope (`created_by = actor` unless admin), (b) returns only the permitted tiers with masking, and (c) calls `audit_append` **in the same transaction**. Examples: `staff_trip_progress(trip)`, `staff_participants(trip, page)`, `staff_form_view(enrolment, reason)`, `staff_sensitive_reveal(enrolment, field, reason, approver)`. `pp_staff` receives `EXECUTE` only; it keeps no `SELECT` on forms. **Implication:** these functions are high-value code (they read children's data with owner rights); each needs a review, concurrency and scope tests, and a pinned `search_path`. The benefit: a compromised staff API cannot read forms except through audited, scoped, masked paths, and cannot read at all outside them.
2. **Step-up authentication** (M5): T2 and higher require authentication within a short recent window; T4 reveal and erasure require it every time.
3. **Rate and volume limits** per actor, enforced server-side: records opened per hour, list size, export count; breaches raise an alert (M8).
4. **No staff UI path to T3 or T4 in bulk.** The staff portal build contains no screen for it, and the API has no route for it.
5. **Reason codes** are an enumerated list, not free text, plus an optional note that is never searched in logs.
6. **Review:** monthly review of read audit rows (who opened whose data and why) by a person who is not the reader; quarterly access recertification.

## 6. [DEFERRED, OUT OF SCOPE] Tests required before any capability ships

| # | Test | Expected |
|---|---|---|
| S1 | Default deny: as `pp_staff`, `SELECT` on `onboarding_forms`, `registration_pdfs`, `parent_registrations` beyond the candidate columns | `42501` |
| S2 | Scoping: sales A calls each capability for sales B's school and trip, for a guessed id, and for an archived school | `404` and no data, no audit row for a successful read |
| S3 | Tier masking: T3 and T4 never appear in list or form-view responses; reveal requires reason, recent MFA and approver | refused otherwise |
| S4 | Atomic audit: if `audit_append` fails, the read returns nothing | no data without a row |
| S5 | Every capability writes exactly the specified audit row (actor, session, entity, tiers, reason, count) | row present, no field values inside |
| S6 | Bulk and rate limits | 429 and an alert |
| S7 | Wrong role: admin-only capabilities called by sales | `403` |
| S8 | A compromised staff API (raw SQL as `pp_staff`) cannot read any form or PDF row except through the functions | `42501` |
| S9 | Logs contain no T1 to T4 values | scan finds none |
| S10 | Offboarding: a deactivated staff member loses every capability immediately (sessions revoked) | `401` |

## 7. Approval record (for the deferred proposal only)

| Item | Decision | By | Date |
|---|---|---|---|
| Matrix in section 4 (each row) | pending | company | |
| Roles beyond admin and sales | pending | company | |
| Numeric limits and approvers | pending | company | |
| Which fields are collected and which encrypted (SA-30) | pending | company and counsel | |
