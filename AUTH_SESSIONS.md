# Sign-in sessions: access and refresh tokens

How parents (`/api/auth`) and staff (`/api/admin/auth`, Admin and Sales) stay signed in, and every way a sign-in ends.
Code: `backend/src/modules/sessions/` (shared engine and cookies), `auth/` (parents), `staff/` (staff),
`frontend/src/api/http.js` (automatic renewal). Migration `017_access_refresh_tokens.sql`.

## Policy

| | Parents | Staff (Admin and Sales) | Setting |
|---|---|---|---|
| Access token | 15 min | 15 min | `PARENT_ACCESS_TOKEN_TTL_SECONDS`, `STAFF_ACCESS_TOKEN_TTL_SECONDS` (60 to 3600) |
| Inactivity limit (refresh token lifetime) | 3 days | 2 hours | `PARENT_SESSION_IDLE_TIMEOUT_SECONDS`, `STAFF_SESSION_IDLE_TIMEOUT_SECONDS` |
| Absolute limit (never extended) | 7 days | 8 hours | `SESSION_TTL_SECONDS`, `STAFF_SESSION_TTL_SECONDS` (unchanged names) |
| Replay grace for simultaneous refreshes | 20 s | 20 s | `REFRESH_REUSE_GRACE_SECONDS` (0 to 120) |

Every lifetime must satisfy access ≤ inactivity ≤ absolute. When an absolute limit is set lower than a default, unset
values shrink to fit. Values you set explicitly that don't nest stop the server at startup with a message naming them.

"Inactivity" here means time without a renewal, and the page renews only while it is making requests. A parent who
leaves the tab open and idle for more than 3 days must sign in again, and so must a staff member idle for more than 2 hours.
No sign-in outlives its absolute limit, however active the person is.

## Design

- **Both tokens are opaque.** Each is 32 random bytes (base64url) with no JWT and no signing key. PostgreSQL stores only
  `HMAC-SHA256(SESSION_SECRET, "<domain>:access:<token>")` or `"…:refresh:…"`. Parents and staff use different domains, so
  a token of one kind can never be used as another.
- **The access token is checked against the database on every protected request**, so logout, password reset,
  deactivation and replay detection take effect at once. The cost is one indexed query per request. A JWT would remove
  that query but keep revoked users signed in until their token expired.
- **The browser never sees a token.** Both are `HttpOnly; SameSite=Strict` cookies, `Secure` when `NODE_ENV=production`:

  | Cookie | Path | Max-Age |
  |---|---|---|
  | `pp_access` | `/api` | access lifetime |
  | `pp_refresh` | `/api/auth` | until the inactivity limit (capped at the absolute end) |
  | `pp_staff_access` | `/api/admin` | access lifetime |
  | `pp_staff_refresh` | `/api/admin/auth` | as for parents |

  The refresh cookie's narrow path keeps it off every other request. Tokens never appear in a response body, a URL,
  localStorage/sessionStorage or a log line. Responses carry `Cache-Control: no-store`.
- **A sign-in is one row** in `auth_sessions` or `staff_sessions`, called the "session family". Refresh tokens are rows
  in `auth_refresh_tokens` or `staff_refresh_tokens`. Revoking the row ends both tokens at once.
- **Identity comes only from the access cookie** (`requireSession` sets `req.auth`, `requireStaff` sets `req.staff`).
  No registration ID, document ID or other value from the browser is accepted as proof. Every route still checks that the
  requested record belongs to `req.auth` (parent) or that `req.staff.role` is allowed (staff).

## Refresh: `POST /api/auth/refresh`, `POST /api/admin/auth/refresh`

- **Rotation.** Each refresh token works once. A refresh spends it and issues a new access and refresh pair. It moves the
  inactivity deadline forward, but never past the absolute end.
- **Replay detection.** Presenting a spent refresh token more than 20 s after it was spent revokes the whole sign-in
  (`revoke_reason = 'refresh_reuse'`), so the attacker and the real user are both signed out. Parents get a log line
  with no identifiers or tokens. Staff get an audit entry, `staff.session_reuse`.
- **Races.** Two tabs refreshing at once lock the same row (`FOR UPDATE`). One gets 200 and new cookies. The other gets
  **409 `REFRESH_RACE`**, with nothing issued and nothing revoked. The browser already holds the new cookies, so the page
  simply repeats its request. In the browser, renewals are also single-flight per page and per tab
  (`navigator.locks` where supported).
- **401** means the sign-in is over (expired, revoked, replayed, or not a real token). The refresh cookies are cleared.
- **Abuse and CSRF.** The endpoint accepts only a JSON POST, so a cross-site HTML form gets 415 before anything happens.
  It also requires a matching `Origin` host, and the cookies are `SameSite=Strict`. There is a per-IP limit of 300 per
  10 minutes (a code default, `DEFAULT_REFRESH_LIMIT` in `auth/routes.js`; not an environment setting) and a disabled
  staff account can't refresh.

## The page: automatic renewal (`frontend/src/api/http.js`, `apiFetch`)

- A protected request answered **401 `UNAUTHENTICATED`** triggers one renewal followed by one repeat of the request.
  A second 401 is passed to the screen, so there is never a loop.
- **The repeat can't submit twice.** That 401 comes from the sign-in check, which runs before any route handler, so the
  first request did nothing.
- Requests that are never renewed: sign-in, sign-out, the refresh endpoint itself, email codes, password reset,
  registration and public trip pages. Other 401 codes (for example a wrong current password) and aborted requests are
  also passed straight through.
- The session check (`GET …/auth/session`) can see the refresh cookie. Its 401 says `renewable: false` when there is
  nothing to renew with, so a visitor who was never signed in doesn't make the page call the refresh endpoint.
- Once a renewal has been refused, the page doesn't try again until a request succeeds (the person signs in again).
- **Unsaved answers.** An autosave refused because the token expired is renewed and saved with the same answers.
  If the sign-in itself is over, the parent sees "Your session has ended. Please log in again." Answers typed after the
  last successful save are then lost. They are deliberately not kept in the browser's storage, because it would hold
  personal data on shared computers. The autosave runs within a second of typing, so that window is small, and the page
  warns before closing with unsaved changes.

## Every way a sign-in ends

| Event | Effect | `revoke_reason` |
|---|---|---|
| Logout | That sign-in, even with an expired access token; all cookies cleared | `logout` |
| Parent password reset | Every sign-in of that parent | `password_reset` |
| Staff password change | Every other sign-in of that staff member (the current one stays) | `password_change` |
| Staff password reset | Every sign-in of that staff member | `password_reset` |
| Staff deactivated (screen or CLI) | Every sign-in at once; any later request or refresh is refused | `deactivated` |
| Refresh token replayed | That sign-in (session family) | `refresh_reuse` |
| Inactivity / absolute limit | The refresh is refused with 401 | — |

## Sign-ins from before this change

The old single cookie (`pp_session` / `pp_staff_session`, a 7-day or 8-hour token) is no longer accepted on any request.
The first protected request after deploying gets 401. The page then calls the refresh endpoint, which exchanges the old
cookie exactly once for a new pair (keeping the original absolute end) and clears the old cookie. Nobody is signed out by
the upgrade, and the old token can't be used a second time.

## Known limits (not solved by this change)

- The refresh rate limit is held **in memory, per server process**. With several processes, each counts separately.
- The limit is **per IP address**, and Express `trust proxy` is not configured yet (see DEPLOYMENT.md). Behind a proxy,
  every user would appear as one address and share one limit. Set `trust proxy` before deploying behind one.
- Inside the 20 s grace window a replayed refresh token is answered 409 and not treated as theft. It issues nothing,
  so a thief gains no token, but the theft is not detected either.
- Anyone holding a stolen, still-valid access token can use it for up to 15 minutes, or until logout or another
  revocation, the same as any bearer cookie. HttpOnly + SameSite=Strict + HTTPS are the protections against stealing it.
- `purgeExpired()` (which deletes sign-ins a day past their absolute end) still needs a scheduled call in production.
