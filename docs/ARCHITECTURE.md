# Parents Portal: monorepo architecture (working decision, Phase 1)

This is the current working architecture. It is provisional: the single shared API is pending confirmation from the
team lead, and the structure is kept modular so the API can be split later.

## Layout

```
apps/
  api/                      Express API (was backend/). Owns the database, auth, OTP, PDFs, Google Drive. Only service with secrets.
  web-server/               Tiny zero-dependency server every portal runs on Railway: serves built files, forwards /api to the API.
  portal-domestic-paid/     \
  portal-domestic-free/      |  four public registration portals: thin apps (index.html, main.jsx, vite.config.js)
  portal-international-paid/ |  that call @pp/web-core with their own target.
  portal-international-free/ /
  portal-staff/             Sales + Admin portal (separate deployment, never part of a public portal's build).
  mobile/                   Expo team-leader app (unchanged; not an npm workspace, keeps its own lockfile).
packages/
  web-core/                 The React source (was frontend/). Still builds as the combined app, so the old single service works.
  contracts/                @pp/contracts: the four variants + the stable registration record (zod, plain JSON, ERP-ready).
railway/                    One config-as-code file per Railway service (not applied automatically).
```

Each portal is selected by a `target`: `domestic-paid`, `domestic-free`, `international-paid`, `international-free`
or `staff`. Public targets serve only `/parent*` and `/join/*`; the staff target serves only `/admin*` and `/sales*`.
A public portal's build contains no staff code: `AppRoutes.jsx` loads each side with `React.lazy` behind build-time flags (`__HAS_STAFF__`, `__HAS_PARENT__`), and `npm run check:bundles` fails the build if staff markers, source maps or credential-looking text appear in a public bundle. The API remains the real security boundary.

## Why a proxy server in front of each portal

Railway's generated domains (`*.up.railway.app`) are on the public-suffix list, so two of them are different sites.
Sign-in cookies are `SameSite=Strict` and the API rejects writes whose `Origin` differs from its `Host`. A portal on
one railway.app host therefore cannot talk to an API on another. `apps/web-server` serves the portal and forwards
`/api/*` to the API's private address, keeping the browser on one origin: no CORS, host-only cookies, the existing
same-origin check keeps working. The proxy keeps the browser's `Host`, appends the caller's address to
`X-Forwarded-For`, and passes `Set-Cookie` through untouched.

## Railway services (nothing is created or changed by these files)

| Service | Config | Needs |
|---|---|---|
| `postgres` | existing | managed by Railway |
| `api` | `railway/api.json` | existing API variables; `SERVE_FRONTEND=false`; `TRUST_PROXY_HOPS`: NOT decided; see `docs/CLIENT-IP-STAGING-VERIFICATION.md` (the earlier suggestion of 2 is withdrawn until the header chain is measured); `PUBLIC_BASE_URL_DOMESTIC_PAYMENT`, `PUBLIC_BASE_URL_DOMESTIC_NONE`, `PUBLIC_BASE_URL_INTERNATIONAL_PAYMENT`, `PUBLIC_BASE_URL_INTERNATIONAL_NONE` = the four portal hosts used in links (`PUBLIC_BASE_URL` stays as the fallback; see `DEPLOYMENT.md`). Migrations are NOT run automatically: the existing manual, confirmed `migrate:production` step (DEPLOYMENT.md) stays the single owner; `migrate.js` also takes a database advisory lock, so two runs can never overlap. |
| `portal-<variant>` x4 | `railway/portal-*.json` | `API_URL` = the API's private address (e.g. `http://api.railway.internal:<port>`). Public values only. |
| `portal-staff` | `railway/portal-staff.json` | same |
| existing combined service | root `railway.json` | unchanged behaviour: builds `@pp/web-core`, API serves it |

## Data model

Already in place: `trips.tour_type`, `trips.payment_mode`, generated `trips.template_key` (the four variants);
`trip_enrolments`; answers in `onboarding_forms.data` (JSONB). Migration `019_registration_variant_columns.sql`
(NOT applied anywhere yet) adds `school_id`, `trip_id`, `variant` to `onboarding_forms`, filled by a database trigger from the
enrolment's trip (never from the browser), with composite foreign keys so school, trip, variant and enrolment must agree.
`packages/contracts` defines the registration record built from those columns plus the JSONB `answers`.

## Not done in Phase 1

Variant enforcement on `/join` (a link opened on the wrong portal), validation
and save fixes, responsive layout, credential investigation, ERP-facing code. See the Phase 2 and 3 lists.

## Dependencies and lockfile

- The root `package-lock.json` is the only lockfile for the npm workspaces (`apps/api`, `apps/web-server`, `apps/portal-*`,
  `packages/*`). The old per-app lockfiles were removed after every entry was compared: the root lock reproduces the exact
  versions they pinned, with two exceptions: `zod` 4.6.7 instead of 4.6.6 for the lint tooling only (root `overrides`), and
  `cookie` 1.1.1 now sits under `react-router` (same version, different folder). `apps/mobile` is not a workspace and keeps its own lockfile.
- Known advisories in the pinned versions (see the lockfile report): `body-parser` 2.3.0 (GHSA-27r3-jxmh-p828, fixed in 2.4.0;
  every JSON parser in the API already sets `inflate: false`, the documented workaround), `nodemailer` 10.0.15 (moderate,
  fixed in 10.6.0, pinned exactly in `apps/api/package.json`), `eslint` and `minimatch` (dev tooling only). Upgrading any of
  them is a separate, approved change.
