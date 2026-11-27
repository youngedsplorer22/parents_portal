# Deployment notes (Parents Portal)

Nothing here has been run against a real host; it lists what production still needs. Stage 2 (below) was verified locally only; every point marked **STAGING** needs a check on a real Railway environment before production.

## Railway foundation (stage 1)
What the backend now supports, so one Node service can run on Railway (the service that also serves the frontend, and the
migration step, come in later stages):
- **Node version:** `.node-version` is `24` and both `package.json` files declare `"node": "^22.22.2 || ^24.15.0"`, the range
  every tool agrees on (Vite 8, Vitest 5, jsdom 30, ESLint 10, `pg`, Express 5). The test suites were run on Node 24.22.1 only.
- **Start:** `npm start` (= `node src/server.js`) reads the platform's environment, not a `.env` file. Locally use `npm run dev`
  or `npm run start:local`, which still load `apps/api/.env`.
- **Listening:** the server listens on `PORT` and, with `NODE_ENV=production`, on every interface. Development and test still
  listen on `127.0.0.1`. `HOST` (an IP address) overrides either.
- **Production database:** another host is accepted only with `NODE_ENV=production` **and** `ALLOW_PRODUCTION_DATABASE=true`.
  A database named like a test database (`parents_portal_test`, anything ending `_test`) or the development database
  `parents_portal_dev`, or `TEST_DATABASE_URL` being set, makes production refuse to start. Connection URLs may carry only
  `sslmode` (`disable` or `verify-full`), `application_name` and `connect_timeout`, each at most once: the driver lets other
  options such as `?host=` redirect it, and uses the last of a repeated option.
- **Migrations:** `npm run migrate:production` (= `node src/db/migrate.js --production`) needs `NODE_ENV=production`,
  `ALLOW_PRODUCTION_DATABASE=true` and `MIGRATE_CONFIRM_DATABASE` set to the database's name. It keeps one transaction per
  file, the advisory lock and the checksum check. Take a backup first.
- **Variables for this stage:** `NODE_ENV`, `PORT` (injected by Railway), `HOST` (optional), `DATABASE_URL`, `ALLOW_PRODUCTION_DATABASE`,
  `MIGRATE_CONFIRM_DATABASE` (migration step only). Never set `TEST_DATABASE_URL` in production.

### Database TLS (PostgreSQL)
What was checked, and what has not been:
- **Railway documents** that traffic between services of one environment, including the database, travels over a private
  WireGuard-encrypted network (`<service>.railway.internal`), and that the Postgres image has SSL enabled. Its pages do not say
  which `sslmode` the private connection string needs, and they do not describe the certificate. A third-party Railway template
  uses `sslmode=disable` on the private host; that is not Railway documentation.
- **The driver (`pg` 8.23)** uses no TLS when the URL has no `sslmode`. For `allow`, `prefer`, `require`, `verify-ca` and
  `verify-full`, and even for an unknown value, it uses TLS with certificate and host-name checks, but it warns that its next major
  version gives `require`, `prefer` and `verify-ca` the weaker libpq meaning. `sslmode=no-verify` and `uselibpqcompat=true` turn
  verification off, and the `PGSSLMODE` environment variable is read when the URL says nothing. That is the source of the
  "SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca'..." message.
- **So this project accepts only two settings,** the two that mean the same in every version: no `sslmode` / `sslmode=disable`
  (no TLS) and `sslmode=verify-full` (TLS that verifies the certificate and host name). Every other `sslmode`, `ssl=`,
  `uselibpqcompat`, `sslrootcert` and similar options are refused at start-up, so the warning cannot appear and verification can never
  be switched off by a typo. In production `PGSSLMODE` and `NODE_TLS_REJECT_UNAUTHORIZED=0` must not be set (the server and
  `migrate:production` refuse to run).
- **Supported production configuration:** Railway's private `DATABASE_URL` as Railway provides it
  (`postgresql://…@<service>.railway.internal:5432/<db>`), with no `sslmode` (or an explicit `sslmode=disable`). Any other host that
  is not on this machine must use `sslmode=verify-full`, because nothing then encrypts the connection but TLS.
- **Do not use the public proxy URL** (`DATABASE_PUBLIC_URL`) for the app or `migrate:production`. Outside the private network
  `sslmode=verify-full` is required, and Railway's Postgres certificate is, as far as I know, self-signed (not confirmed in its
  docs), so verification would fail unless its CA could be trusted. Loading a CA is not supported yet. Use `psql` and `pg_dump`
  with their own SSL settings for ad-hoc access from a laptop.
- **Not yet verified, check on the staging environment first:** that the Railway Postgres service accepts the app's non-TLS
  connection on the private network. If it does not, Postgres answers `no pg_hba.conf entry … no encryption`. Do **not** then
  switch to `no-verify` or `require`; ask for a change that supports `sslrootcert` with tests instead.

## Single-page app routing
Express serves the built frontend itself (`apps/api/src/frontend.js`), so no separate web server is needed on Railway.
- Turned on by `SERVE_FRONTEND` (default: **on in production, off in development**). The separately deployed API service must run with it OFF: `railway/api.json` sets `SERVE_FRONTEND=false` in its start command (it builds no frontend, and with it on the API would refuse to start with "frontend build was not found"). That inline value also wins over a stray `SERVE_FRONTEND=true` service variable. Only the legacy single-service app (root `railway.json`) serves the frontend from the API; `FRONTEND_DIST` overrides the folder
  (default `packages/web-core/dist`). In production the server refuses to start if `index.html` is missing.
- `/api/*` is always the API: an unknown API path is the JSON 404, never HTML (also `/API/...`).
- Real files are sent as files. `/assets/*` (content-hashed by Vite) is `immutable` for a year; `index.html` is `no-cache`;
  other public files cache for an hour. A missing asset is a 404, never the app shell.
- A GET/HEAD *navigation* (the browser asks for `text/html`) to any other path gets `index.html`, so `/sales/...` and
  `/join/<token>` deep links reload. Dotfiles and path traversal are refused.
- Development is unchanged: `npm run dev` in `packages/web-core/` (Vite proxy `/api` -> `127.0.0.1:4000`, `changeOrigin: false`).

If you ever put a different web server in front instead (nginx etc.), it must answer any non-file, non-`/api` path with
`index.html` and pass the browser's `Host` through unchanged.

## Same origin, and keep the Host header
The browser app and the API must share one origin (as the dev proxy does). Cookies are `SameSite=Strict` and no CORS is enabled.

The staff API refuses state-changing requests whose `Origin` host differs from the `Host` header the backend receives.
So any proxy in front of the backend must pass the browser's Host through unchanged:
- nginx: `proxy_set_header Host $host;` (nginx's default is the upstream address, which would block every staff action);
- Vite dev server: `changeOrigin: false` (already set in `packages/web-core/vite.config.js`; the `"/api": "http://..."` shorthand
  would turn it on and cause "This request was blocked" on staff login).

## HTTPS and proxy
- Serve everything over HTTPS; `NODE_ENV=production` makes cookies `Secure`. Railway terminates TLS.
- **`TRUST_PROXY_HOPS`** is the number of proxies in front of the server whose `X-Forwarded-For` entries the API trusts (local: `0`,
  the default). Express then reads the client address from `X-Forwarded-For`, counting that many entries **from the right** (the
  ones the trusted proxy added); anything a caller wrote further left is ignored. `X-Real-IP`, `Forwarded` and `X-Forwarded-Host`
  are never used (the same-site check compares `Origin` with the real `Host` header). If the forwarded value is not an IP address,
  the connection address is used instead. All per-IP limits (OTP sends, password sign-in, refresh, public link lookups, mobile)
  read this one address. Production logs a warning when it is `0`. A value too high lets callers choose their own address; a value
  too low makes everyone share the proxy's address.
  **Initial launch: the API is private, and its trust is fixed by design.** The API has no public domain. Only the four public portals
  and the Sales portal reach it, over Railway's private network, and each of them sends the API exactly one validated address in
  `X-Forwarded-For` (see the next bullet). So the API trusts exactly one hop, its own web server: **`TRUST_PROXY_HOPS=1` is
  required in production** (the API refuses to start in production without it, and refuses `0`). Setting it is part of the private
  design: it is only right while every request reaches the API through a portal web server. If the API ever gets a public domain
  (for example for the mobile app), the value must be decided again, and that needs its own staging verification.
- **`CLIENT_IP_SOURCE`** (each portal's web server, public and Sales; **required in production, no default**). It says how the web
  server reads the visitor's address from what Railway's edge reported, and it is **not decided yet**: Railway's documentation does
  not say how the edge fills `X-Forwarded-For` and `X-Real-IP`, and its staff's answers disagree. The three accepted values are
  `xff:<n>` (the n-th entry from the right of `X-Forwarded-For`, n from 1 to 8), `x-real-ip`, and `peer` (the connecting address:
  safe, but every visitor then shares one address for the per-IP limits). **Do not assume one.** Choose it only from the staging
  verification in `docs/CLIENT-IP-STAGING-VERIFICATION.md`; that verification has not been done. The web server refuses to start in
  production without a valid value. An address that is not exactly one valid IP falls back to the connecting address, never to
  another entry. Do not test any of this by sending forged headers to a real endpoint such as a sign-in route.
- **What a portal forwards.** A portal's web server forwards only the calls its own website makes, by exact method and path. The Sales
  UI ships in every public portal build (`__HAS_STAFF__=true`), so public portals forward the parent calls **and** the 13 Sales routes
  (Sales sign-in, password, session, refresh, logout, itinerary). The staff-only build (`PORTAL_ROLE=staff`) forwards only the same
  13 Sales routes. Everything else — `/api/mobile/*`, `/api/health*`, the enrolment list (`GET /api/enrolments`), discarding a draft
  (`DELETE /api/onboarding`) and any other method or address — is answered with a JSON 404 by the web server and never reaches the
  API. The mobile routes stay in the API for later. The full lists are in `apps/web-server/src/api-policy.js`.
- **Host header and request bodies (portal web servers).** A request must carry exactly one well-formed `Host` header (a host name,
  IPv4 address or bracketed IPv6 address, with an optional port); a missing, empty, repeated, comma-containing or malformed one gets a
  JSON 400 before anything is served or forwarded (`/healthz` alone answers whatever the `Host`). A request body larger than the
  limit the API itself sets for that route (2 KB for emailed codes and enrolment, 4 KB for registration and sign-in, 1 KB for live
  location, 8 KB for Sales, 64 KB for the registration form) is refused with a JSON 413 while it streams, so the API never receives
  more than it would accept; a GET carries no body. The portal does not buffer bodies in memory. Refusals close the connection. The
  web server also sets Node's header and request timeouts explicitly (60 s and 300 s), so a client that stalls mid-upload is cut off.
  Not covered here: how many connections the Railway edge allows, which only the platform can limit.
- **Registration links.** `npm run ops -- trip:create` prints a trip's link; the API builds it from the trip's tour template, so each
  link opens the portal that serves that template. Set one variable per portal, each to that portal's real public origin
  (`https://host`, nothing else: no path, no spaces; a trailing slash is dropped):

  | Environment variable | Portal |
  |---|---|
  | `PUBLIC_BASE_URL_DOMESTIC_PAYMENT` | Domestic — With Payment |
  | `PUBLIC_BASE_URL_DOMESTIC_NONE` | Domestic — Without Payment |
  | `PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT` | International — With Payment |
  | `PUBLIC_BASE_URL_INTERNATIONAL_NONE` | International — Without Payment |

  - **Set all four before go-live.** The values are the four deployed portal origins; none is guessed or defaulted in the code.
  - `PUBLIC_BASE_URL` (origin only) remains a **backward-compatible fallback**: a template with no variable of its own uses it,
    and a deployment that sets only `PUBLIC_BASE_URL` keeps working exactly as before (every link uses that one host).
  - **Partial setup is refused at start.** If at least one of the four is set, `PUBLIC_BASE_URL` is not, and any of the four is
    missing, the API will not start and names the missing variables (never their values), because the staff portal would
    otherwise show a link to itself, which does not work.
  - **If none of the five is set** the API gives no full address and the staff panel shows its own origin plus the registration
    path. That is only correct for a single combined site; with separately deployed portals it is a broken link, so set them.

## Core business model: one deployment = one school + one trip

Each customised deployment represents exactly one school and one trip. This is a deliberate architectural constraint, not a
limitation. It is worth stating explicitly because it rules out several patterns that might otherwise seem natural:

**What is true:**
- Developers customise the application for a specific school and trip before each deployment: `src/deployment.config.js` names
  the school, trip, destination, logo and other trip-specific values.
- Parents and students access that deployment to register for the trip it was built for.
- The Sales interface ships in the same deployment (every public portal build includes the Sales UI). Sales logs in at `/sales`
  and immediately manages the itinerary for that deployment's configured trip — no selection step, no assignment workflow.
- Parent registrations and Sales itinerary management both resolve the trip from `portal_deployments`, which the developer binds
  with `npm run ops -- portal:bind`. They operate on the same canonical trip record and trip ID.
- Different independent deployments remain isolated: a Sales user of one deployment cannot see or edit another deployment's trip
  or itinerary. The API enforces this at every request.

**What is not part of this product:**
- A multi-trip Sales management system where Sales selects from multiple schools or trips.
- A mandatory many-to-many Sales-to-trip assignment workflow. The `staff_trip_assignments` table exists in the schema but is not
  checked by the Sales itinerary access control; `portal_deployments` is the sole authority.
- A separate Sales portal or additional Railway service (Sales can use the public portal's URL and the `/sales` path).
- Duplicate trip records for the same school and trip across deployments.

**Deployment isolation is enforced by the server, not by the website.** Each portal sends its `PORTAL_PROXY_SECRET`; the API
matches it to a template key, looks up `portal_deployments`, and returns only that one trip. A Sales user authenticated against
one deployment cannot name a trip from another deployment and get access; the same 403 is returned whether the trip exists or not.

## Preparing a portal for a school (the developer's workflow)

There is **no admin portal and no admin login**. The four public portals (`apps/portal-domestic-paid`, `portal-domestic-free`,
`portal-international-paid`, `portal-international-free`; the screens say With Payment and Without Payment) are reusable templates, each
with its own Railway service, and there is **no new service per school or trip**. One template serves **one school and one trip at a
time**. Everything that sets a school or trip up is a developer command, run by a developer (on your own computer for local work; against the live
database with the production invocation, whose Railway route is not yet verified): see **`docs/DEVELOPER-CLI.md`** for the step-by-step
guide, including how the commands protect the live database from a mistake.

**What protects the old school.** Three independent things, so redeploying a template for the next school can never show one school's
branding to another school's parents:

1. *The server decides who can register.* `portal_deployments` (migration 020) records which one trip each template accepts new
   registrations for. `npm run ops -- portal:bind` makes the next trip the bound one and, in the same step, closes the trip it replaces
   and switches its public page off. From then on the API refuses new registrations for the old trip (`409 TRIP_NOT_OPEN`) and answers
   `registrationOpen: false` for it, whatever any website shows.
2. *The server knows which portal is calling.* Each public portal's own web server adds a secret key (`PORTAL_PROXY_SECRET`) to every
   `/api` call it forwards, and removes any such header a browser sent. With `PORTAL_BINDING_REQUIRED=true` the API accepts a
   registration or enrolment only from a portal whose key it recognises, and only for the trip bound to **that** portal's template. A
   direct call to the API, or a call from another portal, is refused. Nothing a browser sends can claim to be a portal.
3. *The portal only shows its own trip.* `src/deployment.config.js` names the one school and trip it was built for. Any other
   registration address on that site, an old school's link included, shows "This registration link is closed or no longer available"
   and nothing of either school. A portal that was never configured says "This registration portal isn't set up yet" and takes no
   registrations.

*Nothing is deleted.* Schools, trips, people, enrolments, forms and PDFs (and their Google Drive copies) stay exactly as they are.
Parents who already registered keep logging in at `/parent/login` on any portal; their dashboard shows the school and trip from
**their own registration**, never from the portal's configuration, and they keep reading their trip's itinerary after it is closed.

### Switching a portal from school A to school B (the one procedure)

**What the server enforces.** A trip accepts a new registration only when ALL of these hold at that moment, on the server: it is the trip
bound to the portal's template (`portal_deployments`, one row per template, so one trip per portal), it is `active`, its public page is ON,
it is inside its dates, and the request carries that template's portal key. Deploying a website changes none of this; only the commands do:

| Command | What it changes | When it takes effect |
|---|---|---|
| `portal:bind B` | Moves the template's binding to B. In the same transaction the previous trip (A) is set `closed` and its public page OFF. It does **not** open B. | The instant it commits: A stops accepting. B accepts only once it is also open. |
| `trip:open B` | B becomes `active` and its public page ON. It does **not** bind. | B accepts only if it is also the bound trip. |
| `trip:close A` | A becomes `closed`, page OFF. The binding stays on A, so nobody registers on that portal until the next `portal:bind`. | At once. |

Because there is one binding row per template, **A and B can never both accept**. There is a gap in which neither does, and that is
deliberate. This is **not zero downtime**: from the moment the new website is live until `trip:open B` has run, B's link says registration is
closed, and A's link says it is closed from the moment the new website is live (the new website only knows B). Do it in a quiet period.

The commands below are written as `npm run ops -- <command>`, which is the local form. Against the live database use the production
invocation in `docs/DEVELOPER-CLI.md` (*Running a command against the live database*), which has not been verified on Railway.

**Before you start (nothing live changes):**
1. `npm run ops -- trip:create ... B` (a draft). `npm run ops -- trip:config <B>` prints its values.
2. Edit that portal's `src/deployment.config.js`: B's values, and B's logo under `src/school-logos/` with a `schoolLogos` entry. **Keep A's entry
   and file.** Build it locally: `npm run build -w @pp/portal-<name>`. The build stops if the file is empty or invalid.
3. Make sure A's registration is finished. Check `npm run ops -- portal:status`.

**The switch, in this order** (configure and build are in *Before you start*; school A stays bound until step 2):
1. **Deploy that one portal's website** (new `deployment.config.js`). Wait until it is healthy. If the build or deploy fails, Railway keeps the
   old website and nothing in the database has changed: stop and fix it. (Deploying first is deliberate: a failure here costs nothing. Binding
   first and then failing to deploy would leave B open on the server with no page for it.)
2. `npm run ops -- portal:bind <B>`: A is closed and its page switched off. The portal now belongs to B.
3. `npm run ops -- trip:open <B>`: B is open. Registrations start.

**Check:** `npm run ops -- portal:status` shows B `[active]`. B's link shows the registration button. A's link says "closed or no longer
available". A parent from school A can still log in at `/parent/login` on the same address and sees their own registration, school name,
logo (from `schoolLogos`), PDF, tickets and itinerary: nothing about them is deleted or hidden by any of these commands.

**Going back (rollback to school A).** Reverse it in the same safe order: the website first, then the server rules.
1. **Redeploy the previous website build of that one portal** (the one with school A's `deployment.config.js`) and wait until it is healthy.
2. `npm run ops -- portal:bind <old-trip>`: the binding returns to A. The new trip (B) is **closed and its public page switched off** in the
   same step, exactly as A was when B was bound. Nothing is deleted.
3. `npm run ops -- trip:open <old-trip>`: A was closed by the first switch, so it must be opened again. Registrations for A resume only now.
4. **Verify** with `npm run ops -- portal:status`: it shows A `[active]`. A's link shows the registration button and B's link says it is
   closed.

Like the switch, this is not zero downtime: A's registration page is unavailable from the moment B was bound until step 3. Never touch the
other three portals or the API.

**Not verified:** the database steps (`portal:bind` back to A, then `trip:open` A) are covered by an automated test on a local test
database. Neither the switch nor this rollback has been run on Railway or on the live database, and how you redeploy the previous
website build in Railway (redeploy the earlier deployment, or rebuild the earlier configuration) has not been checked.

### Portal service settings (each public portal, and the Sales portal)
Each portal's web server refuses to start in production (NODE_ENV=production, or on Railway) unless it knows what it is. `PORTAL_ROLE` is set
in the start command of each `railway/<name>.json` (`public` for the four registration portals, `staff` for the Sales portal), so it follows the
folder being served and a Sales build can never run as a registration portal or the other way round. A `public` portal also refuses to start
without `PORTAL_PROXY_SECRET` (32 or more characters, equal to its `PORTAL_PROXY_SECRET_<TEMPLATE>` on the API); the `staff` portal refuses to
start if it has one. No message ever prints a secret. Locally, none of this is needed. If a Railway service overrides the start command in its own
settings, that override must keep `PORTAL_ROLE`.

### Production settings for the server (a Railway variable change: yours to make, never made by code here)
- `PORTAL_BINDING_REQUIRED=true` on the API. **Required in production: the API refuses to start in production without it, and refuses `false`.**
  With it on, a portal whose template has no bound trip accepts nobody, a sign-up with no trip link is refused (`TRIP_REQUIRED`), and a
  registration must come from a recognised portal. **An unbound portal never accepts registrations.**
- One secret per portal you use (32 or more characters, a different one each, kept out of Git):
  `PORTAL_PROXY_SECRET_DOMESTIC_NONE`, `PORTAL_PROXY_SECRET_DOMESTIC_PAYMENT`, `PORTAL_PROXY_SECRET_INTERNATIONAL_NONE`,
  `PORTAL_PROXY_SECRET_INTERNATIONAL_PAYMENT` on the **API** service; and on each **portal** service, `PORTAL_PROXY_SECRET` set to the
  same value as that portal's variable on the API. The API refuses to start with `PORTAL_BINDING_REQUIRED=true` and no secret, or with
  two equal secrets. Set the secrets before the first production deploy of the API. A portal accepts a registration only when its
  trip is both bound (`portal:bind`) and open (`trip:open`); see *First production deployment, in order*.

### Sales and itineraries
A Sales person is an exact email address a developer added (`npm run ops -- sales:allow`); only that address can set a password (by an
emailed code) and sign in. When Sales logs in, they see the **one trip the deployment is configured for** — the same trip parents
register for on that portal — and can add and edit itinerary items for it. No manual trip assignment is required. Everything else
under `/api/admin` does not exist (404). Participants read their own trip's itinerary, read-only, from the Itinerary section of their
dashboard.

**How the deployment trip is resolved.** The API looks up `portal_deployments` to find the trip. It resolves the template key by two
mechanisms, in priority order:
1. **Portal key** (`x-portal-key` header, set by the public portal web server on every request it forwards). The API matches it
   against the configured `PORTAL_PROXY_SECRET_<TEMPLATE>` variables to find the template key, then looks up `portal_deployments`.
   This is the mechanism used by combined public+staff deployments: no extra env var is needed on the API.
2. **`STAFF_DEPLOYMENT_TEMPLATE_KEY`** env var (optional). Set to one of the four template keys for a staff-only deployment
   (`PORTAL_ROLE=staff`) where no portal web server sends a portal key. If neither mechanism yields a template key, the trip list
   is empty and Sales sees "No trip is configured for this portal yet."

**Parent registrations and Sales itinerary management use the same canonical trip identity.** The parent portal resolves the trip
through the portal key → `portal_deployments` path; Sales resolves the same trip through the same table, via the same portal key
(for public portals) or the env var (for staff-only portals). They are always the same row.

### Removing the old admin accounts (once, per database)
`npm run ops -- admin:remove` lists the old admin accounts and what points at them (a dry run). `--apply --confirm <database name>` deletes
the admin accounts, their sessions and codes, and the audit rows the admins wrote. Schools, trips, Sales accounts, registrations, PDFs,
Drive records, itineraries and every other audit row stay; the fields that named an admin are emptied. Do it on the live database only with
the safeguards in `docs/DEVELOPER-CLI.md`.

### Migration 020
`apps/api/src/db/migrations/020_itinerary_assignments_portal_binding.sql` adds three tables (`staff_trip_assignments`,
`trip_itinerary_items`, `portal_deployments`) and changes nothing that exists. Its rollback is
`apps/api/src/db/rollbacks/020_itinerary_assignments_portal_binding.down.sql`. It does not depend on migration 019. The runner applies
pending migrations in file-name order, so running it on a database where 019 has not been applied also applies 019: decide about 019
first. Production: back up, then `npm run migrate:production` with the usual confirmations.

## Database pool, health checks and shutdown (stage 2)
- Pool: `DB_POOL_MAX` 10, `DB_CONNECTION_TIMEOUT_MS` 5000 (waiting for a connection fails fast), `DB_IDLE_TIMEOUT_MS` 30000,
  `DB_STATEMENT_TIMEOUT_MS` 15000 (PostgreSQL cancels a longer statement, error 57014), `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`
  30000. Mind the total: replicas x `DB_POOL_MAX` must stay below the database's `max_connections`.
- `GET /api/health` and `/api/health/live`: liveness, the process answers; never touches the database. `GET /api/health/ready`:
  readiness, `SELECT 1` within 2 s and not shutting down; otherwise `503`. Bodies are only `{"status":"ok"}` or
  `{"status":"unavailable"}`. Readiness shares one query between concurrent callers and caches for 1 s.
  `railway.json` (legacy) and `railway/api.json` (the API service) use **readiness** as the deploy health check.
- Shutdown (`SIGTERM`/`SIGINT`): readiness turns 503, new connections stop, in-flight requests get `SHUTDOWN_GRACE_MS` (10 s),
  stragglers are dropped, the pool closes, exit code 0 (1 if anything was forced). **STAGING:** check Railway's own stop
  timeout (default is longer than 10 s) and that a redeploy under load drops no requests.

## Root build and start (stage 2): the legacy single service
**This is the legacy layout. It is not the configuration to select for the new split deployment.** The root `railway.json` and
root `package.json` describe the earlier single Railway service, in which one API process also serves the built website. The
split deployment (one API service, four public portal services and one Sales portal service) uses the files in `railway/`, listed
in *Railway service checklist* below. A split service left on the default root `railway.json` would build the website and start the
API, which no split service should do.
- `railway.json` + root `package.json` (the legacy single service): build = `npm run build` (`npm ci --include=dev` for the npm
  workspaces, then builds `packages/web-core/dist`); start = `npm start` (= `npm start -w @pp/api`, the platform's environment, no
  `.env` file). The API serves that build, as before.
- That layout has no portal identity, so once production enforces `PORTAL_BINDING_REQUIRED=true` it cannot take new
  registrations. It is kept as the record of the previous layout.
- The split layout (four public portals + Sales portal + one API) is described in `docs/ARCHITECTURE.md`; its Railway configs are in `railway/`.
- Locally: `npm run dev:backend` / `npm run dev:frontend` from the root (or `npm run dev` inside `apps/api` and `packages/web-core`).
- **Migrations are not run by start or build.** Run `npm run migrate:production` (see stage 1) yourself, once per release, with a backup.

## Staff accounts (there is no admin)
There is no admin account and no first-admin step. Sales accounts are added by the developer command `sales:allow` (see
`docs/DEVELOPER-CLI.md`); the owner sets their password by an emailed code. The old admin accounts are removed with `admin:remove`.

## Sign-in sessions (migration 017)
Access + refresh tokens are described in `AUTH_SESSIONS.md`. When deploying this change:
- Apply `017_access_refresh_tokens.sql` (adds columns and two tables; no existing row is changed or deleted). Back up first.
  Rollback: `apps/api/src/db/rollbacks/017_access_refresh_tokens.down.sql` (this signs out anyone who signed in after 017).
- Restart every backend process after the migration. People already signed in stay signed in: their old cookie is
  exchanged once for the new pair on their next request.
- The refresh endpoints are rate limited **per IP, in memory, per process**. Until `trust proxy` is set (below), everyone
  behind a proxy shares one limit (300 renewals per 10 minutes). Configure `trust proxy` before going live behind one.
- Schedule `purgeExpired` (below); without it, ended sign-ins and their refresh tokens stay in the tables.

## Live location (migration 018)
See `LIVE_LOCATION.md`. In short:
- Apply `018_trip_live_location.sql`, with a backup first. It adds one table and a trigger and changes no existing row.
- The team lead's phone must reach the portal over **HTTPS**, because browsers only give the location to secure pages.
- Map tiles come from OpenStreetMap's public servers by default, which are meant for light use only. For larger use, set
  `VITE_MAP_TILE_URL` and `VITE_MAP_TILE_ATTRIBUTION` at build time to another provider.
- If a Content-Security-Policy is ever added to the pages, allow the tile host in `img-src`.
- The hourly housekeeping in `server.js` also ends abandoned sharing and wipes its position.

## Capacity: sign-ins, and what happens under a burst
Password checks (scrypt, N=2^17, about 128 MiB and 0.4 s of CPU each) are the most expensive thing the server does.
Measured on the development laptop (2 physical cores, running at 41% CPU speed): about 1.6 to 1.9 sign-ins per second.
- Password hashing runs through one gate (`apps/api/src/modules/auth/work-gate.js`) shared by parent and staff sign-in,
  registration, password reset and staff password change. At most `PASSWORD_HASH_CONCURRENCY` hashes run at once
  (default: CPU count, but one libuv worker thread is always left free) and `PASSWORD_HASH_QUEUE` more may wait
  (default 8 per worker). Beyond that the server answers **503 SERVER_BUSY with `Retry-After`** straight away; nothing is
  counted against the user's sign-in limit, no email verification is used up, and the screens say "try again in a few seconds".
- Without the gate, 1,000 simultaneous sign-ins left 768 of them waiting past two minutes and made even DNS lookups of
  `localhost` take 3 to 31 seconds. With it, a busy answer takes about 5 ms and everything else stays responsive.
- **1,000 users signing in in the same second cannot be served on this machine** (636 to 734 got in within 6 minutes;
  with the same 1,000 arriving over 5 minutes, 930 did). Add CPU (hashing throughput scales with cores), or serve parent
  sign-in from more than one server process. Do not lower the hashing cost to chase this number.
- Registration PDFs are rendered one at a time with a short queue and a small in-memory cache (a submitted registration
  never changes); extra requests get the same 503.
- The registration PDF uses Noto Sans for Latin, Greek, Cyrillic, Vietnamese, Devanagari (Hindi) and Bengali. Names in
  other scripts (Chinese, Japanese, Korean, Arabic) would show as empty boxes until a font for them is added.

## OTP email (existing SMTP) on Railway
Production sends real email only: `OTP_DELIVERY=dev-console` is refused outside development, and `OTP_DELIVERY=smtp` with an
incomplete `SMTP_*` set stops the server at start (it never falls back to the console). The server also verifies the SMTP
connection at start, so a wrong host, port or login fails the deploy instead of the first registration.
- Outbound SMTP is blocked on Railway's Free, Trial and Hobby plans; the **Pro** plan allows it. Use the provider's submission
  port: `587` with `SMTP_SECURE=false` (STARTTLS) or `465` with `SMTP_SECURE=true`.
- Set these in the service's **Variables** tab (never in a file, the repository or `railway.json`): `OTP_DELIVERY=smtp`,
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` (an app password where the provider offers one),
  `SMTP_FROM`. Codes and credentials are never logged; the start-up log names only the SMTP host.
- Before the first real registration, check SPF and DKIM for the `SMTP_FROM` domain so codes do not land in spam.
- `npm run mail:check` connects and logs in to the mail server and sends nothing, but it reads `apps/api/.env`, which does not
  exist on Railway. The start-up verification above is the production check; read the deploy log for
  "SMTP connection to ... verified."

## Railway service checklist
The split deployment is one Postgres service plus **six** application services. Each application service must have its config-as-code
path set, in that service's Railway settings (by you; nothing in the repository sets it), to **its own** file below. Do not leave any
of them on the default root `railway.json`: that file is the legacy single service (see *Root build and start*).

| Service | Config file to select | What it runs |
|---|---|---|
| API | `railway/api.json` | The API only (`SERVE_FRONTEND=false npm start -w @pp/api`). Builds no website. Health check `/api/health/ready`. |
| Public portal: Domestic, with payment | `railway/portal-domestic-paid.json` | That portal's website through the web server (`PORTAL_ROLE=public`). Health check `/healthz`. |
| Public portal: Domestic, without payment | `railway/portal-domestic-free.json` | The same, for its own portal. |
| Public portal: International, with payment | `railway/portal-international-paid.json` | The same, for its own portal. |
| Public portal: International, without payment | `railway/portal-international-free.json` | The same, for its own portal. |
| Sales portal | `railway/portal-staff.json` | The Sales website through the web server (`PORTAL_ROLE=staff`). Health check `/healthz`. |

Variables, by service (names only; set them in the service's **Variables** tab, never in a file or the repository):
- **API:** `NODE_ENV=production`, `DATABASE_URL` (reference the Postgres service's private URL), `ALLOW_PRODUCTION_DATABASE=true`,
  `OTP_HMAC_SECRET`, the `OTP_DELIVERY`/`SMTP_*` set above, `PORTAL_BINDING_REQUIRED=true`, one `PORTAL_PROXY_SECRET_<TEMPLATE>` for
  each public portal in use, the four `PUBLIC_BASE_URL_<TEMPLATE>`, plus the auth, staff and Google Drive variables already listed in
  `apps/api/.env.example` and `GOOGLE_DRIVE_SETUP.md`. `PORT` is injected by Railway; set it explicitly so the portals can name the API's
  private address. `TRUST_PROXY_HOPS=1`: **required in production** for the private API (it refuses to start without it, and refuses 0).
  Remove or do not generate the API's public domain: the initial launch has none.
- **Each of the four public portals:** `PORTAL_PROXY_SECRET` (the same value as that portal's `PORTAL_PROXY_SECRET_<TEMPLATE>` on the
  API, and different for every portal), `API_URL` (the API's private address) and `CLIENT_IP_SOURCE` (required in production; its value comes from the staging verification and is not decided here). `PORT` is injected by Railway.
- **Sales portal:** `API_URL` and `CLIENT_IP_SOURCE` (same rules). It must not have a `PORTAL_PROXY_SECRET`, and it will refuse to start if it does.

### First production deployment, in order
Nothing accepts a registration before step 9. Keep `PORTAL_BINDING_REQUIRED=true` throughout: the API will not start in production
without it, and an unbound portal, or a portal whose bound trip is not open, never accepts a registration.
1. **Set the API service's variables** (names above; the values are yours and never go in the repository): every mandatory
   production variable, one `PORTAL_PROXY_SECRET_<TEMPLATE>` for each public portal in use (32 or more characters, all different), and
   `PORTAL_BINDING_REQUIRED=true` and `TRUST_PROXY_HOPS=1` (the private API; no public domain). Each portal's `CLIENT_IP_SOURCE` is decided
   only by the staging verification in `docs/CLIENT-IP-STAGING-VERIFICATION.md` (step 6), and that must be done before step 9.
2. **Deploy the API** with `railway/api.json`. The readiness check passes on an empty database (it only runs `SELECT 1`).
3. **Back up the database and verify the backup** (it exists, is complete and can be restored) before anything changes the schema.
4. **Apply the migrations**, only after step 3, once, from `railway ssh`: `npm run migrate:production -w @pp/api` with `MIGRATE_CONFIRM_DATABASE` set to the
   database name and the other safeguards from *Railway foundation* (`NODE_ENV=production`, `ALLOW_PRODUCTION_DATABASE=true`). The
   runner applies every pending migration in file-name order, so decide about migration 019 first (see *Migration 020*). Then remove
   `MIGRATE_CONFIRM_DATABASE` (there is no admin to bootstrap; see *Staff accounts*).
5. **Create each real trip as a draft and bind it to its portal template** with the developer commands in `docs/DEVELOPER-CLI.md`:
   `trip:create`, then `portal:bind <school>/<branch>/<trip>`. A trip can be bound only to the portal of its own template. Do **not**
   run `trip:open` yet: a bound draft trip accepts no registration. Check with `portal:status`. Against the live database these commands
   need the four safeguards described in that document. `npm run ops` reads `apps/api/.env`, which does not exist on Railway; in a shell
   that already has the production variables, run `node scripts/ops.js <command> --production` from `apps/api` instead. This repository
   does not say how you reach such a shell, so check that route in staging first. **In the staging project** use `--staging` instead of
   `--production` (and `npm run migrate:staging` instead of `migrate:production`): it has its own variables (`STAGING_DATABASE_URL`,
   `ALLOW_STAGING_DATABASE=true`, `STAGING_CONFIRM_DATABASE=railway`, `STAGING_RAILWAY_PROJECT_ID`) and never uses the production ones (`docs/DEVELOPER-CLI.md`). At this step also add the Sales people
   (`sales:allow`) and, if the database has any old admin accounts, remove them once (*Removing the old admin accounts*:
   dry run first, and only after step 3).
6. **Prepare and deploy each portal service**, each with its own file in `railway/`: its `src/deployment.config.js` must name the trip you
   bound in step 5 (*Preparing a portal for a school*), and its build must pass. Set `PORTAL_PROXY_SECRET` (the same value as that
   portal's variable on the API), `API_URL` and `CLIENT_IP_SOURCE` (from the staging verification; a portal will not start without it);
   the Sales portal gets `API_URL` and `CLIENT_IP_SOURCE` only.
   **Bind and deploy order.** In this first deployment no school is yet on any portal, so binding a draft trip (step 5) before its website is
   deployed (step 6) is safe: it accepts nothing until step 9. Binding after the website is deployed is equally valid. When a portal
   already serves a school and you are switching it, the order is different and matters: deploy the new website first, then
   `portal:bind`, then `trip:open` (see *Switching a portal from school A to school B*).
7. **Verify, with registrations still closed:** the API readiness check and every portal's `/healthz`; each portal's trip page says
   registration is closed; `portal:status` shows the right trip for each portal; a Sales person can set a password with the emailed
   code, sign in, see the deployment's configured trip and edit an itinerary item; and, if participants already exist, one can still sign in
   and see their dashboard.
8. **Verify the registration workflow end to end** before any public use: emailed code, save and resume, submit, PDF generated and
   stored in Google Drive, payment status (paid portals), and the dashboard sections (Personal Details, Payment Status, Insurance,
   Train / Flight Tickets, Live Tracking, Itinerary). This needs an open trip, so do it in a separate staging environment with its own
   database and secrets where you can. If it has to be done in production, open only that trip (step 9), do not share its link, register
   with an address you control, and treat that record as a real one.
9. **Open each trip** (`trip:open`) only when steps 1 to 8 have passed and every portal's `CLIENT_IP_SOURCE` has been decided from the staging verification and applied. A trip's portal
   accepts registrations only from this moment, and only because the trip is bound to it and open. Then share the registration link.

Password hashing uses about 128 MiB per concurrent hash; check the API service's memory limit against `PASSWORD_HASH_CONCURRENCY`.

## Still required
Production domain and TLS, mail sender domain (SPF/DKIM) for OTP emails, a scheduled call to the `purgeExpired` housekeeping,
database backups, and the first Sales accounts (see *Staff accounts*).
