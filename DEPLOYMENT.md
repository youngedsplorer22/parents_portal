# Deployment notes (Parents Portal)

Nothing here has been run against a real host; it lists what production still needs.

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
