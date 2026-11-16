# Deployment notes (Parents Portal)

Nothing here has been run against a real host; it lists what production still needs.

## Railway foundation (stage 1)
What the backend now supports, so one Node service can run on Railway (the service that also serves the frontend, and the
migration step, come in later stages):
- **Node version:** `.node-version` is `24` and both `package.json` files declare `"node": "^22.22.2 || ^24.15.0"`, the range
  every tool agrees on (Vite 8, Vitest 5, jsdom 30, ESLint 10, `pg`, Express 5). The test suites were run on Node 24.22.1 only.
- **Start:** `npm start` (= `node src/server.js`) reads the platform's environment, not a `.env` file. Locally use `npm run dev`
  or `npm run start:local`, which still load `backend/.env`.
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
The frontend is a single-page app. `/admin/...` and `/join/<token>` are routes inside it, so the web server must
answer **any non-file, non-`/api` path with `index.html`**, or deep links return 404 on reload. (`vite` dev and
`vite preview` already do this.)

Example (nginx), serving `frontend/dist` and proxying the API on the same origin:

    server {
      listen 443 ssl http2;
      server_name parents.example.com;
      root /var/www/parents-portal;           # contents of frontend/dist
      add_header Referrer-Policy "no-referrer" always;   # /join/<token> URLs contain the link token

      location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
      }
      location / {
        try_files $uri $uri/ /index.html;
      }
    }

Static hosts: Netlify `_redirects` `/*  /index.html  200`; Vercel `rewrites` to `/index.html`.

## Same origin, and keep the Host header
The browser app and the API must share one origin (as the dev proxy does). Cookies are `SameSite=Strict` and no CORS is enabled.

The staff API refuses state-changing requests whose `Origin` host differs from the `Host` header the backend receives.
So any proxy in front of the backend must pass the browser's Host through unchanged:
- nginx: `proxy_set_header Host $host;` (nginx's default is the upstream address, which would block every staff action);
- Vite dev server: `changeOrigin: false` (already set in `frontend/vite.config.js`; the `"/api": "http://..."` shorthand
  would turn it on and cause "This request was blocked" on staff login).

## HTTPS and proxy
- Serve everything over HTTPS; set `NODE_ENV=production` so cookies are `Secure`.
- Per-IP limits (OTP sends, password sign-in, public link lookups) use the connection address. Behind a proxy the backend
  sees the proxy's address until Express `trust proxy` is configured for it. **This is not configured yet** and must be set for
  the deployment (only trust your own proxy).
- Set `PUBLIC_BASE_URL` (origin only) so staff are given complete parent links.

## Sign-in sessions (migration 017)
Access + refresh tokens are described in `AUTH_SESSIONS.md`. When deploying this change:
- Apply `017_access_refresh_tokens.sql` (adds columns and two tables; no existing row is changed or deleted). Back up first.
  Rollback: `backend/src/db/rollbacks/017_access_refresh_tokens.down.sql` (this signs out anyone who signed in after 017).
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
- Password hashing runs through one gate (`backend/src/modules/auth/work-gate.js`) shared by parent and staff sign-in,
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

## Still required
Production domain and TLS, mail sender domain (SPF/DKIM) for OTP emails, a scheduled call to the `purgeExpired` housekeeping,
database backups, and the first admin created with `npm run staff -- create admin`.
