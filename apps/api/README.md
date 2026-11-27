# Parents Portal backend

Email OTP verification, registration, login sessions and the tour onboarding forms. Node 22+, Express 5, PostgreSQL (`pg`).

## Local setup

1. Copy `.env.example` to `.env` and fill in the `CHANGE_ME` values (`.env` is git-ignored).
   Both database URLs must point at `localhost` and at `parents_portal_dev` / `parents_portal_test`.
2. `npm install`
3. `npm run migrate` and `npm run migrate -- --test`
4. `npm run dev` (listens on `127.0.0.1:4000` only; `npm run start:local` is the same without file watching)
5. `npm test` (uses `parents_portal_test` only; refuses any other database)

## Production start and migrations

`npm start` is `node src/server.js`: it reads the real environment and never a `.env` file (a hosting platform sets the
variables). It listens on `PORT` and, in production, on every interface; `HOST` overrides that.

In production the database rules are strict:
- another host is accepted only with `NODE_ENV=production` and `ALLOW_PRODUCTION_DATABASE=true`;
- never a test database or the development database (`parents_portal_dev`), and never while `TEST_DATABASE_URL` is set;
- a URL may carry only `sslmode=disable` or `sslmode=verify-full` (see `DEPLOYMENT.md`, "Database TLS"), and `PGSSLMODE` and
  `NODE_TLS_REJECT_UNAUTHORIZED=0` must not be set.

`npm run migrate:production` needs the same, plus `MIGRATE_CONFIRM_DATABASE` set to the database's name. Local runs of
`npm run migrate` / `npm test` are unchanged and still refuse any non-local database.

## Delivering the code

`OTP_DELIVERY` has no default and no fallback. Pick one in `.env`:

**`smtp`: real email (Nodemailer).** Set every `SMTP_*` variable (see `.env.example`). On startup the
server connects and authenticates once and refuses to start if anything is wrong; it never falls
back to console mode. With `SMTP_SECURE=false` TLS (STARTTLS) is required for remote servers.
The code is only ever placed in the email: it is not logged, not returned by the API, and not
stored in plaintext. Delivery failures log only the SMTP error code, and the API answers
`502 DELIVERY_FAILED` and voids that code.

**`dev-console`: local development only, no email.** The code is printed in the terminal running
`npm run dev`:

    [DEV OTP] you@example.com -> 482913 (expires in 300s). No email is sent.

It is refused unless `NODE_ENV=development`, and refused if any `SMTP_*` value is also set.

**Which mode is this backend in?** On startup it prints the database name and the delivery mode, and the OTP
screen shows "Development mode: no email is sent" only when the backend answering is in `dev-console` mode. If you
see that note but expect real email, **a different backend is answering on port 4000** (a stale or test one): the new
backend now says "Port 4000 is already in use by another process" instead of failing quietly. Check with
`lsof -nP -iTCP:4000 -sTCP:LISTEN`, stop the stray process, restart this one.

**Check the email settings without sending anything:** `npm run mail:check` loads the same configuration, connects to
the mail server, negotiates TLS and logs in, then prints OK or FAILED. It sends no email and prints no credentials.
OK means the settings and login are accepted; only a real code arriving in a mailbox you control proves delivery to
that mailbox. For Gmail the password must be an **app password**.

**Code lifetimes:** parents' codes last `OTP_TTL_SECONDS` (default 300, 5 minutes); staff first-time-setup and
forgot-password codes last `STAFF_OTP_TTL_SECONDS` (default 900, 15 minutes). Both are stored as an expiry time when the
code is created and checked on the server.

## API (`/api/email-otp`)

| Endpoint | Body | Notes |
|---|---|---|
| `POST /send` | `{email, purpose: "registration" or "login"}` | Creates a code only if none is pending (see below). |
| `POST /resend` | same | Explicit resend. Invalidates the previous code. 30s cooldown. |
| `POST /verify` | `{email, purpose, code}` | Returns a single-use `verificationToken` (15 min). |

Rules (all server-side): 6-digit CSPRNG code, **300s (5 minute) expiry**, 30s resend cooldown,
5 attempts per code, 5 sends per email and 20 per IP per hour. Errors are
`{error: {code, message, ...}}`.

Expiry and cooldown are stored as `timestamptz` and decided inside PostgreSQL, against
PostgreSQL's own clock, not the Node process's.

**Expired codes and `send`.** Only an explicit resend creates a new code. If a code is already
pending for an email, even an expired one, `send` returns `alreadySent: true` with
`expiresInSeconds: 0` and delivers nothing new; the client must then offer **Resend OTP**
(`/resend`, available once the 30s cooldown has passed). Verifying that expired code returns
`OTP_EXPIRED`.

## Registration (`POST /api/registrations`)

Creates a parent registration. It needs the single-use `verificationToken` returned by `/verify`.

    {firstName, lastName, role, phone, email, password, verificationToken}  ->  201 {registered, registrationId, email}

In **one PostgreSQL transaction** the server (1) spends the token, which is bound to the submitted
email and the registration purpose, then (2) inserts the row. If either step fails, both roll back,
so a failed insert never burns the token. The password is hashed after the token check (so a
request without a valid token costs no hashing) and stored in the same transaction. Concurrent requests cannot reuse a token or create a
duplicate (`UNIQUE` on the normalised email and on the token). The raw token is never stored.

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Field problems, listed in `error.fields`. Nothing is spent. |
| 403 | `VERIFICATION_REQUIRED` | Token missing from the DB, wrong, expired, used, or for another email. One answer for all of these. |
| 409 | `EMAIL_ALREADY_REGISTERED` | Email taken. Checked after the token, so only someone who just verified the email learns this. The token stays unspent. |
| 500 | `INTERNAL_ERROR` | Nothing was saved and the token is still usable. |

Role is checked against an allow-list in `src/modules/registrations/validation.js` (keep it in sync
with the frontend form). **There is no school field:** a `school` in the body is rejected, and the
school comes from the trip when the parent registers from its public page (`publicTrip`). Otherwise new rows store the
fixed placeholder `Unassigned` in the existing, unchanged `school` column.

Passwords: 10 to 128 characters, not whitespace-only, not on a short common-password list, not equal
to the email, and there is no password confirmation field. They are hashed
with **scrypt** from `node:crypto` (N=2^17, r=8, p=1, 16-byte random salt, NFKC-normalised); the
`scrypt$N$r$p$salt$hash` string is stored in `password_credentials`. The password is never stored or
logged, and is never in a response.

A successful registration also starts the new account's login session (same transaction, see
below), so the person continues straight into the onboarding form.

Migrations: `001_email_otp.sql`, `002_parent_registrations.sql`, `003_auth_sessions.sql`,
`004_onboarding_forms.sql`, `005_password_credentials.sql`, `006_password_reset_purpose.sql`.

## Authentication (`/api/auth`)

Before this, "login" in the UI was a mock and nothing identified a user, so saved forms could not
have been tied to anyone safely. Identity is now a server-side session.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /login` | `{email, verificationToken}` | Token from `/api/email-otp/verify` with `purpose: "login"`. Spends it and creates the session in one transaction. 404 `ACCOUNT_NOT_FOUND` (token not spent) if the verified email has no registration. |
| `POST /login/password` | `{email, password}` | Reuses the same session. Any failure (unknown email, account with no password yet, wrong password) is the same 401 `INVALID_CREDENTIALS`, with the same hashing work. 429 `RATE_LIMITED` (+ `Retry-After`) after 5 attempts per email or 20 per IP in 15 minutes (`PASSWORD_LOGIN_*` settings). Attempts are counted *before* the password is checked, under a per-email lock, so parallel guesses can't slip past; a successful sign-in clears that email's count. Accounts created before passwords existed have none: they sign in with an email code. |
| `GET /session` | | `{authenticated: true, user}` or 401 `UNAUTHENTICATED` (with `renewable: false` when there is no refresh cookie). |
| `POST /refresh` | `{}` (JSON only) | Spends the refresh cookie for a new access + refresh pair. 409 `REFRESH_RACE`: another request just renewed it, repeat yours. 401: sign in again. See `AUTH_SESSIONS.md`. |
| `POST /logout` | | Revokes the sign-in server-side (even with an expired access token) and clears all its cookies. |

### Forgot password (`/api/auth/password-reset`)

| Endpoint | Body | Notes |
|---|---|---|
| `POST /request` | `{email}` | Always the same answer (the usual OTP challenge: `expiresInSeconds`, `resendAvailableInSeconds`, `delivery`, `alreadySent`). |
| `POST /resend` | `{email}` | Explicit resend; same cooldown rules. |
| `POST /verify` | `{email, code}` | Same errors and attempt limits as any OTP. Returns a single-use `verificationToken` for purpose `password_reset`. |
| `POST /confirm` | `{email, verificationToken, password, confirmPassword}` → `{passwordChanged: true}` | The only step that changes anything. No cookie, no session. |

- **No account enumeration.** For an email with no account a real code row is still created (so cooldown,
  expiry, attempts and the hourly caps behave identically) but nothing is sent and nobody knows the code, so
  it can never verify. Sending never waits for the mail server and a failed send is never reported, so
  neither the response time nor an error reveals anything. The generic `/api/email-otp` routes do not
  accept the `password_reset` purpose, so they cannot be used to bypass this.
- `/confirm` runs in **one transaction** under a per-email lock: it spends the token (bound to the email and
  purpose), writes the new scrypt hash (also for accounts that had no password), revokes every session of
  the account, kills any other unused reset authorisation for that email and clears its password sign-in
  lock-out. Parallel confirms, even with different tokens, produce exactly one success. The password rules
  are the registration rules; a failed validation does not spend the token.
- After COMMIT a "password changed" notice is sent best-effort (`sender.sendPasswordChanged`; dev-console
  just prints a line). If it fails, only a generic line is logged and the reset stands.
- Known trade-off: if the mail server is down, a real user sees the code step but no email arrives (the
  failure is deliberately not reported); they can use Resend or email-code login.

- A sign-in is a 15-minute **access token** (`pp_access`, `Path=/api`) and a one-time **refresh token** (`pp_refresh`,
  `Path=/api/auth`), each 256 random bits in an `HttpOnly; SameSite=Strict` cookie (`Secure` when
  `NODE_ENV=production`). The database stores only keyed hashes; JavaScript cannot read either. Refreshing rotates
  both; a replayed refresh token ends the sign-in. Inactivity limit 3 days, absolute limit `SESSION_TTL_SECONDS`
  (7 days, never extended). Full policy and design: `AUTH_SESSIONS.md` at the project root.
- The user's identity is the `parent_registrations` row. Protected routes call `requireSession`,
  which sets `req.auth`; **nothing in a body, query string or header is ever used as a user id.**
- CSRF: the cookie is `SameSite=Strict`, and every state-changing route needs a JSON body or a
  non-simple method (PUT/DELETE), which browsers will not send cross-site without a CORS
  preflight (no CORS is enabled).
- Whether an email has an account is revealed only to someone who has just proved control of it.
  Sending a login code to an unregistered address is possible (as for registration) and is
  limited by the OTP rate limits.

## Staff, schools, trips and parent links (Phase 3)

Migrations `007_staff_auth.sql`, `008_schools_trips_links.sql`, `009_audit_log.sql` (tables only; parent
registrations and onboarding forms are untouched).

### Staff accounts (no public sign-up)
Staff are completely separate from parents: own table, own session tables, own cookies `pp_staff_access`
(`Path=/api/admin`) and `pp_staff_refresh` (`Path=/api/admin/auth`), both `HttpOnly; SameSite=Strict`, `Secure` in
production, own token-hash domain and own rate-limit table. A parent session never works on `/api/admin/*`, and a staff
session never works on a parent route (tests prove both directions). Access tokens last 15 minutes, renewal stops after
2 hours of inactivity, and sign-ins end after `STAFF_SESSION_TTL_SECONDS` (default 8 h, absolute). See `AUTH_SESSIONS.md`.
Sign-in is email + password (scrypt), with the same generic error for unknown email / disabled account /
wrong password, and the same lock-out rules as parent password sign-in.

**Create the first admin** (one-time, on a machine that can reach the database; nothing is typed on the
command line, so nothing lands in shell history or `ps`):

    cd apps/api
    npm run staff -- create admin        # prompts for email, name, and the password twice (hidden)
    npm run staff -- create sales        # a sales account
    npm run staff -- create admin --additional-admin   # another admin: you must type a confirmation
    npm run staff -- disable <email>     # also ends its sessions; the last active admin can't be disabled
    npm run staff -- enable <email>
    npm run staff -- set-password <email>

The password may also be piped on stdin (e.g. from a secret manager). Safeguards: the first account must be an
admin; an existing email is never overwritten; a further admin needs `--additional-admin` plus a typed
confirmation; all runs take one database lock, so two runs can't race; non-local databases are refused.

### Who can do what (conservative default, **needs the lead's approval**)
| | sales | admin |
|---|---|---|
| list schools / trips | yes | yes |
| create a school, create a trip (always a draft), edit trip fields | yes | yes |
| activate a draft, close an active trip | yes | yes |
| reopen a closed trip, archive a trip, rename/archive a school | no | yes |
| turn a trip's public registration page on/off (not on an archived trip) | yes | yes |
| view the audit log | no | yes |
Tour type and payment mode can change only while a trip is a draft. Every rule is enforced in the API (and the
UI just hides what you can't do). There is no way to view or export submitted answers in this phase.

### Staff accounts, first-time password setup and the Manage staff screen
Migration `012_staff_password.sql` lets a staff row exist **without a password** ("pending setup"). Status is derived:
no password = **pending**, password and no `disabled_at` = **active**, `disabled_at` set = **deactivated**. A pending or
deactivated account cannot sign in.

**Adding staff** (an authorised admin or IT person; there is no public sign-up):
- Admin panel, `/admin/staff` (admins only): name and email; the role is Sales. No password is entered anywhere.
- Command line: `npm run staff -- create sales --pending` / `create admin --pending [--additional-admin]` (an extra admin
  still needs the typed confirmation). `create <role>` without `--pending` still asks for a password at a hidden prompt.
- SQL, in the Portal database only (never the ERP): `INSERT INTO staff_users (email_normalized, display_name, role)
  VALUES ('person@company.com', 'Full Name', 'sales');` (lower-case email; `role` is `admin` or `sales`). Direct SQL writes
  no audit entry and does not end sessions when you deactivate; the screen and the command line do both.

**First-time setup and forgot-password** are one flow (`/admin/login` -> "First time or forgot your password?"), built on the
email code module with its own purpose `staff_password` (a parent's code can never work here, and the generic
`/api/email-otp` routes refuse it): email -> 6-digit code (5 minutes, 5 attempts, 30 s resend, hourly caps) -> new password
twice. Only the mailbox owner can finish it. The public answers are identical for every email (staff, pending, deactivated,
parent or unknown), and only an existing, non-deactivated account is ever emailed. Finishing ends all that account's sessions and
does **not** sign anyone in; a "password was set/changed" notice is emailed. The code email says whether the person is
setting or resetting a password.

**Change password** (signed in, `/admin/password`): needs the current password (wrong guesses count toward the same lock-out
as sign-in), keeps this session and ends the others.

- Staff sign in with **email and password** only. No Microsoft sign-in and no second factor in this phase.
- Roles come from PostgreSQL on every request (`sales`: schools, trips and their public pages; `admin`: everything, plus staff
  management and the audit log). The server enforces this on every route; a test lists every admin route and fails if one is not
  classified.
- Staff emails need `OTP_DELIVERY=smtp` with working `SMTP_*` settings. The sender must be able to reach company mailboxes;
  check with a real address before relying on it.

### Routes (all under `/api/admin`, staff session required except login)
`POST /auth/login`, `GET /auth/session`, `POST /auth/logout` · `GET|POST /schools`, `PATCH /schools/:id` ·
`GET /trips[?schoolId=]`, `GET|PATCH /trips/:id`, `POST /schools/:id/trips`, `POST /trips/:id/status` ·
`POST /trips/:id/public-registration` (`{"enabled": true|false}`) · `GET /audit`.
State-changing requests that carry an `Origin` header from another host are refused (on top of SameSite=Strict).

### Trips and the form template
A trip has a title, tour type (`domestic`/`international`), optional destination, payment mode (`none`/`payment`),
status (`draft` → `active` → `closed`, or `archived`) and optional opening/closing times. The template
(`domestic_none`, `domestic_payment`, `international_none`, `international_payment`) is a **generated database
column**: it cannot be supplied by a client. Payment mode is configuration only: nothing collects payments.

### Public registration pages (migration `014_public_trip_pages.sql`)
Each trip has one **public** page: `/join/<school>/<branch>/<trip>` (and `.../continue` for the register/log-in/form
screens), e.g. `/join/greenfield-public-school/kolkata-branch/winter-trip`. A school with no branch uses `main`.
- **No token.** Nothing random is generated, put in the address or stored. The words are not a secret and grant nothing:
  they only name a trip. Parents still register or log in (password / email code) before seeing any personal data.
- **Stable words.** `schools.slug`, `schools.branch_slug` and `trips.slug` are set once when the row is created (from the
  name, `src/modules/catalog/slug.js`) and never change on a rename or branch edit. Duplicates get `-2`, `-3`, …;
  `(slug, branch_slug)` is unique per school and `(school_id, slug)` per trip, enforced by the database. Rows are never
  deleted, so an address can never move to another trip.
- **Off by default.** `trips.public_registration` is switched by any admin or sales user on the trip page (audited as
  `trip.public_on` / `trip.public_off`); it is separate from status and payment mode. A page is shown only when the school
  is active, the trip is `active` or `closed`, and the switch is on; it takes registrations only when the trip is `active`
  and inside its opening/closing times. Everything else is the same 404 `TRIP_NOT_FOUND`.
- `GET /api/join/:school/:branch/:trip` is public, rate limited per IP (`JOIN_LOOKUPS_PER_MINUTE`, default 30, only IP and
  time recorded), `no-store`, and returns only `{school: {name, branch?}, trip: {title, destination, tourType},
  registrationOpen}`: no ids.
- `POST /api/registrations` takes optional `publicTrip: {school, branch, trip}`; `POST /api/enrolments` takes
  `{trip: {school, branch, trip}}`. Both re-check the trip inside the transaction (row locked `FOR SHARE`): not public ->
  404 `TRIP_NOT_FOUND`, public but closed -> 409 `TRIP_NOT_OPEN`. A rejected trip never burns the email verification.
- The staff API returns `slug`, `publicRegistration`, `publicPath` and `publicUrl` (`PUBLIC_BASE_URL` + path, or null).

**Retired secret links.** The old `/join/<token>` links (and `/join/<school>/<trip>/<token>`) no longer resolve; the
frontend shows "This older link no longer works" with a button to My registrations, and never sends the token anywhere.
The link-management API (`/trips/:id/links`, `/links/:id/...`) is gone. The `trip_links` table and every row are **kept**
(audit history; `trip_enrolments.trip_link_id` / `parent_registrations.trip_link_id` still point at them), marked
`retired_at`. `token_hash` is now nullable; the old hashes stay until someone approves
`scripts/erase-retired-link-hashes.sql` (sets them to NULL; nothing else changes). Registrations and drafts made through
old links stay reachable from `/registrations`.

### Parents: saved progress, My registrations, trip details
- Form answers are saved to PostgreSQL as the parent types (`onboarding_forms`, debounced, and flushed when the tab is
  hidden), one form per trip registration (`trip_enrolments`). Nothing is kept in browser storage.
- `GET/PUT/DELETE /api/onboarding` and `POST /api/onboarding/submit` take an optional registration id (`?enrolment=<id>`
  or `enrolmentId` in the body; `legacy` = a form from before trips). The server checks it belongs to the signed-in
  parent; anyone else's id gives `404 REGISTRATION_NOT_FOUND`. Without it the newest registration is used (older clients).
- `GET /api/enrolments` lists the parent's own registrations (id, school, trip, year, form status, payment status) and a
  trip-less legacy form if any. `POST /api/enrolments` returns the registration id (and is a no-op if already enrolled).
- **After login, which registration opens** (never simply "the newest"):
  - from a trip's public page (`/join/<school>/<branch>/<trip>/continue`): that trip. `POST /api/enrolments` is a no-op
    if the parent already has it, so a draft resumes at its saved section and a submitted one opens read-only, with no
    duplicate. The trip stays in the address through register, email code and log in;
  - on the parent portal (`/parent`, `/parent/login`; never `/`, which is the Sales portal): the server decides with `GET /api/enrolments/resume` -> `none` (a notice asks the parent to open
    their school's trip link; no trip is invented), `one` (opened directly), or `several` (a short notice that points
    at the school's link and lets the parent open each existing registration; nothing is chosen or deleted).
  - `/registrations/<id>` still opens one of the parent's own registrations (server-checked); it is what the `several`
    notice links to. There is no "My registrations" page any more: `/registrations` redirects to `/parent`.
  - The active form has no "Start over" control (`DELETE /api/onboarding` still exists for drafts, but the parent UI
    no longer calls it). `GET /api/enrolments` (the full list) is kept for the API.
- A parent can still hold more than one registration (one per trip, by design: the same student on next year's trip).
  There is deliberately no one-registration-per-account constraint.
- **After submission** the parent sees a confirmation page: school, branch, trip, destination, trip type, status, who
  signed and when, the itinerary placeholder and (collapsed) the submitted answers. Read-only.
- **Itinerary:** no itinerary data exists yet; the page says "Itinerary will be available soon."
- **Payment:** not shown to parents at all (decided for now). No gateway and no payment/order records exist;
  `paymentView()` (`src/modules/enrolments/payment.js`) still reports "not configured / not required" in the API and can
  never report success. The trip's payment mode is unchanged for staff. A future gateway should record its order
  against the `trip_enrolments` row.

### Declaration and typed signature (migration 015)
Final submission (`POST /api/onboarding/submit`) needs `declarationAccepted: true`, `declarationVersion` (the current
wording, `src/modules/onboarding/declaration.js`) and `signatureName` (trimmed, NFC, 2–150 characters, any script, no
control or text-direction characters). The server writes `declaration_version`, `signature_name` and
`declaration_accepted_at` (its own clock, the same instant as `submitted_at`) in the single UPDATE that submits the
form; a client-sent date is refused. Drafts never carry them, and the database refuses them on a draft. The wording is
also stored by version in `declaration_texts`, which can't be changed or deleted; to change it, add a new version.
This is a typed electronic acknowledgement, **not** a cryptographic or certified digital signature. Forms submitted
before 015 have no acknowledgement (NULL).

### School logos (migration 015)
`PUT /api/admin/schools/:id/logo` (admin only; body = the raw PNG, JPEG or WebP image, at most 512 KB; the type is
decided from the file's bytes, never SVG) and `DELETE /api/admin/schools/:id/logo`. Stored in `school_logos` (school
lists never load the bytes); audited. Served publicly at `GET /api/school-logos/<school>/<branch>?v=<version>` (the
school's address words, never an id) with `nosniff` and a `default-src 'none'; sandbox` CSP. Parents see it next to
the Young Edsplorer logo on the public trip page, the form and the confirmation; without a logo only ours is shown.

### Removing test schools and trips (`npm run catalog:cleanup`)
Local development database only (refuses anything but `parents_portal_dev` on localhost; never the test database).
`npm run catalog:cleanup` prints every school and trip with what depends on it (read only). `remove-trip <id>` /
`remove-school <id>` with `--by <admin email>` show what would be removed; add `--confirm` to do it. A record with
any registration, form, submission, signature or retired-link history is refused, never cascaded; the check is
repeated inside the transaction with the rows locked. audit_log keeps the history and records the removal. Take and
verify a backup first. Archiving a school / closing a trip (in the admin panel) is the non-destructive alternative.

### Audit log
`audit_log` is append-only (a trigger refuses updates and deletes). Entries are written in the same transaction as
the change. Only small plain values are kept and any key that looks secret (token, password, hash, cookie, ...) is
dropped, so passwords and session tokens can't be recorded.

### Known limitations / decisions still open
- Staff have **no second factor** (not confirmed as a requirement). A staff email-code step would reuse the OTP
  machinery; it has deliberately not been invented.
- Per-IP limits use the connection address; behind a proxy set `TRUST_PROXY_HOPS` (Railway: 1; see `DEPLOYMENT.md`).
- Housekeeping runs hourly inside the server: expired parent and staff sessions and old sign-in attempt rows are deleted.

## Onboarding forms (`/api/onboarding`, login required)

The forms are the two coresheet workbooks, column for column. `src/modules/onboarding/definitions.js`
is the single source of truth (the server validates with it; the browser renders from it).

| Endpoint | Notes |
|---|---|
| `GET /` | `{role, definitions: {domestic, international}, form}`; `form` is `null` until the tour is chosen. |
| `PUT /` | `{tourType, data, currentSection, version}`. Creates the draft (`version: null`) or updates it (`version` = last seen). Autosave. |
| `POST /submit` | `{version}`. Validates the **saved** draft completely and marks it submitted, in one transaction. |
| `DELETE /` | "Start over": deletes a **draft** only. |

- **Which form.** The tour (Domestic / International) is chosen by the user on first visit. The
  variant (student / teacher / team leader) comes from the role chosen at registration, on the
  server, never from the client. The tour type is locked once a draft exists (start over to change).
- **Draft vs submitted.** A draft accepts incomplete and badly formatted answers (only shape, length
  and select options are checked, so autosave works mid-typing). Submission enforces required fields
  and formats. A submitted form has `status = 'submitted'`, `submitted_at`, and progress 100.
- **Concurrency.** Each write carries the `version` it started from; a stale write gets 409
  `VERSION_CONFLICT` instead of overwriting (second tab/device). Submit locks the row, so concurrent
  submits produce exactly one success; later ones get 409 `ALREADY_SUBMITTED`.
- **Policy: a submitted form is read-only.** Edits and "start over" get 409 `FORM_SUBMITTED`, and a
  database trigger refuses `UPDATE`s of submitted rows even if the application had a bug. There is
  deliberately no "reopen" endpoint: a change after submission needs an administrator.
- **Storage.** One JSONB document per registration (`onboarding_forms.data`) rather than a column per
  spreadsheet column: there are six variants with different columns, drafts are half-empty, and nothing
  queries single answers. Ownership, lifecycle, version and immutability are enforced by the table.

### Decisions to confirm with the business

1. **Required vs optional.** A column is required unless its header says otherwise ("(IF ANY)",
   "(IF DIFFERENT BRANCHES...)"). Domestic `ALLERGY` and `REMARK` have no such wording; they are optional here.
2. **Gender** offers Male / Female (the sheets show `MALE` and `F`). **Meals** offer Veg / Non-veg (the
   values seen in the sheets). Other options (e.g. Jain, Other) need confirming.
3. **Who fills the form.** The registration role decides the variant. If a parent fills it in for a
   child, they would need to register as Student; confirm that is intended.
4. **PAN details** are required for every variant, as the sheet lists them; for students the sheet adds
   "Relation with student" (the PAN holder's relation). Confirm PAN is mandatory for teachers/TLs.
5. **Age** and **Passport validity** are read-only and calculated in the browser from the dates; they
   are not stored. Passport validity is relative to today, not to the tour date.
6. **Passport number** is checked as 6 to 9 letters/digits and **PAN** as `AAAAA9999A`; other rules
   (e.g. minimum passport validity at the travel date) are not applied because the sheets don't state them.
7. **One form per account**, as the sheets hold one row per person.
8. **Edits after submission** are blocked (above). Confirm that is the wanted policy.

## Using it from another app (e.g. the Internal ERP)

`createEmailOtpModule({ db, sender, config })` from `src/modules/email-otp` returns an Express
router and a service. Apply `001_email_otp.sql` to the host database, pass a real `sender`, and
mount `createRegistrationsModule({ db, emailOtp: emailOtp.service })` for registration, or call
`emailOtp.service.consumeVerificationTokenIn(client, { email, token })` inside your own transaction.
