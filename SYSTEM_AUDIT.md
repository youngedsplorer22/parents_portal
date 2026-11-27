# System audit (2026-10-28)

The whole repository was audited when the Team Leader mobile app was added. "Unused" below always means traced:
- an import graph from every entry point (frontend `src/main.jsx`; backend `src/server.js`, `src/db/migrate.js` and
  every script in `package.json`)
- plus a full-text search of code, tests, CSS, HTML, docs and scripts, excluding only `node_modules` and build output.

## 1. Inventory

| Area | State | Notes |
|---|---|---|
| `packages/web-core/` (React 19 + Vite) | **Active** | Sales, Admin and Parent portals in one app. After cleanup, every source file is reachable from the entry point. |
| `apps/api/` (Node 22, Express 5, PostgreSQL) | **Active** | All 11 modules are mounted and every file is reachable. Migrations 001–018 are all required by existing installations; rollbacks for 016–018. |
| `apps/mobile/` (Expo SDK 57, RN 0.86.3, TypeScript) | **New** | Team Leader app; see `MOBILE_APP.md`. |
| Browser live-location sharing (`packages/web-core/src/liveLocation/sharer.js`, `liveSharing.js`) | **Kept, intentionally** | It overlaps with the mobile app's sharing, but per instructions it stays until the app is verified on real devices. Both use the **same** server rules (one backend implementation). |
| `trip_links` table + `RetiredLink.jsx` | **Kept** | The old single-use parent links, retired by migration 014. Kept as audit history and for old link addresses (shows "this link was replaced"). |
| `GET /api/admin/audit` | **Kept** | Server-side audit log, deliberately with no screen (earlier decision). Admin-only. |
| `apps/api/scripts/erase-retired-link-hashes.sql` | **Kept** | A documented, optional, manually-approved data step (README, migration 014). |
| `body.admin-page` class | **Removed** (see 2) | Only existed to re-enable scrolling, which is now the default everywhere. |
| Dependencies | All used | Packages without a source import are used by config: `@tailwindcss/vite` and `tailwindcss` (Vite config + CSS `@import`), the ESLint plugins (eslint config), `jsdom` (Vitest), `@fontsource/*` (loaded by path in the PDF module), `pdfjs-dist` (PDF tests). |
| `apps/api/.env.example` vs `config.js` | Consistent | Every documented variable is read by the code, and every variable the code reads is documented. |

## 2. Removed (with evidence)

| Removed | Evidence | Check after removal |
|---|---|---|
| `packages/web-core/src/components/auth/AuthLayout.jsx` | Zero imports anywhere; the only match for "AuthLayout" is the unrelated `StaffAuthLayout`. Unreachable from `src/main.jsx`. Original template file (first commit). | Frontend tests 659/659, lint, build |
| `packages/web-core/src/components/auth/OtpInput.jsx` | Zero imports. The OTP step uses its own boxes in `EmailOtpStep.jsx`. Template file. | same |
| `packages/web-core/src/components/auth/SocialLoginButton.jsx` | Zero imports. The social buttons are inline in `App.jsx`. Template file. | same |
| `packages/web-core/public/background_image.jpg`, `fuji.jpg`, `japan.jpg`, `mountain.jpg`, `trying.png` (1.8 MB) | Zero references in source, CSS, HTML, backend, docs or tests. The page background is `try.png` (kept). | same |
| `packages/web-core/public/favicon.svg` | Zero references. The tab icon is `only_logo.png` (kept). Its `<link>` declared the wrong type (`image/svg+xml`); fixed to `image/png`. | same |
| `document.body.classList` "admin-page" effect in `StaffApp.jsx`, and the `body.admin-page` CSS | Only re-enabled scrolling, which `<body>` no longer blocks anywhere (the registration-clipping fix). The three tests that asserted the class now assert that nothing locks the page. | same |

All removed files are in git's first commit (`git checkout -- <path>` restores them). Nothing is staged or committed.

**Not removed:**
- migrations and rollbacks
- the browser live-location sharing
- `trip_links`
- the audit API
- the font packages
- anything whose use couldn't be proven absent

## 3. Routes, API and permissions

### Web pages (frontend)

| Path | Who | Access |
|---|---|---|
| `/`, `/sales/*` | Sales | Staff sign-in (role sales); only their own schools and trips |
| `/admin/*` | Admin | Staff sign-in (role admin); everything, plus Manage staff |
| `/join/:school/:branch/:trip` (+ `/continue`) | Anyone with the link | Public trip page; registration needs an email code |
| `/parent`, `/parent/login`, `/parent/registrations/:id` | Parents | Parent sign-in; only their own registrations |

### API

| Mount | Identity | Routes | Rules |
|---|---|---|---|
| `/api/email-otp` | none | `POST send, resend, verify` | Rate limits per email and IP; purposes: registration and login only |
| `/api/registrations` | email code | `POST /` | Verification token single-use; trip resolved from the public page |
| `/api/auth` | parent cookies | `POST login, login/password, refresh, logout`, `password-reset/{request,resend,verify,confirm}`, `GET session` | Lock-out, busy gate, refresh rotation and replay detection; JSON only; same-origin |
| `/api/onboarding` | parent cookie | `GET /`, `PUT /`, `POST submit`, `DELETE /`, `GET pdf`, `GET pdf/status`, `POST pdf/retry` | Only the caller's own enrolment; per-person PDF limits |
| `/api/enrolments` | parent cookie | `GET /`, `GET resume`, `POST /` | Own enrolments only |
| `/api/live-location` | parent cookie | `GET /?enrolment=`, `POST start, location, stop` | Viewer: an enrolment of that trip. Sharer: the staff-chosen team lead, trip active. Validated fixes; per-person limits; JSON only |
| `/api/mobile` (new) | **Bearer token (app)** | `POST auth/login, auth/refresh, auth/logout`; `GET me, trips, trips/:enrolmentId`; `POST trips/:enrolmentId/{start,location,stop}` | App tokens only (separate hash domain; cookies ignored). Trips = staff-assigned only. The same live-location service as the web. Per-person and per-IP limits |
| `/api/admin/auth` | staff cookies | `POST login, refresh, logout, password, password/{request,resend,verify,confirm}`, `GET session` | Separate staff sessions and cookies |
| `/api/admin` | staff cookie | schools, trips, status, public registration, logo (admin), `GET audit` (admin), `/staff` (admin), `GET/PUT trips/:id/live-location[/team-lead]` (new) | Sales: own schools and trips only (others answer "not found"); same-origin for writes |
| `/api/join` | none | `GET /:school/:branch[/:trip]` | Per-IP lookup limit; only public, open trips |
| `/api/school-logos` | none | `GET` logo images | Public by design |

## 4. Security findings

| Finding | Severity | Status |
|---|---|---|
| **`body-parser` 2.3.0** (GHSA-27r3-jxmh-p828): DoS via trailing bytes after a *compressed* body | High in general, **not reachable here** | Every parser uses `inflate: false`, so compressed bodies are refused before decompression (new test proves it: 415, or 401 before any body is read). The fixed version (2.4.0) was published 2026-10-22; **upgrade after 2026-11-05** (two-week rule). |
| **`nodemailer` 10.0.15** (address parser: quotes, comments, `;`, `>`) | Moderate, **not reachable here** | Email validation only accepts plain addresses, with no quotes, comments, groups or brackets, before anything reaches the mailer. The fix (10.2.1) was published 2026-10-22; **upgrade after 2026-11-05**. |
| `apps/mobile/` audit: `node-forge`, `zod` 3, `uuid`, `xcode` (7 issues) | High/moderate in **build tooling only** | All inside `@expo/cli` / `@expo/config-plugins`, which run on the developer's computer and are not in the app (the shipped JS bundle contains none of them). Fixes require a newer Expo CLI. Revisit with the next Expo SDK update. |
| Frontend audit | none | 0 vulnerabilities |
| Secrets | OK | `.env` is ignored in all three projects; no keys or tokens in tracked or untracked source; the app contains no secrets (the API address is public). |
| Mobile token storage | OK | Keychain / Keystore via `expo-secure-store` (after first unlock, this device only); Android backups off. |
| Exposed endpoints | OK | No new public endpoint except mobile sign-in, which uses the same throttle as web sign-in. CSRF tests cover the new write routes. |

## 5. Unresolved / not verified

- **The mobile app has not run on a real phone.** This Mac (macOS 12.7.6) can't build iOS (Xcode 16 needs macOS 14+)
  and has no Java or Android SDK. Background tracking is configured, and its decisions are unit-tested, but **not
  verified on Android or iPhone**. See the device checklist in `MOBILE_APP.md`.
- Dependency upgrades held back by the two-week rule: `body-parser`, `nodemailer` (after 2026-11-05).
- Express `trust proxy` is still unset (`DEPLOYMENT.md`): per-IP limits need it behind a proxy.
