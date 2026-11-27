# Dependency update plan (PLAN ONLY, isolated change set)

Status: **plan with the lead's decisions applied (section 10); awaiting approval to implement.** `package.json` and every lockfile are **unchanged** (checksums of `package-lock.json`, `apps/api/package.json`, `package.json` and `apps/mobile/package-lock.json` were taken before and after the dry runs used here and are identical). Dry runs (`--dry-run`) were used; nothing was installed.
Policy decided in `SECURITY-ARCHITECTURE.md` 14 and confirmed by the lead: **a known vulnerable version is not kept to limit lockfile drift, and security patches do not wait for any general age rule.** This plan makes the drift small, reviewable and tested instead.
Data sources: `npm audit` and `npm audit --omit=dev` (read the lockfiles and sent package names and versions to the npm registry), `npm view` (registry metadata), `npm audit signatures`, `npm update --dry-run`, `npm install --dry-run`. Date of the data: 2026-11-19.

## 1. Verified advisories and patched versions

| Package | In repo | Advisory | Severity | Affected | Patched | Runtime (production) path? |
|---|---|---|---|---|---|---|
| `body-parser` | 2.3.0 (via `express` 5.3.0) | GHSA-27r3-jxmh-p828: denial of service via trailing bytes after a compressed request body | **High** | `>=2.0.0 <2.4.0` | **2.4.0** (released 2026-10-22) | **Yes**, `@pp/api` |
| `nodemailer` | 10.0.15 (exact pin in `apps/api/package.json`) | GHSA-8c8m-p3m8-cjg8 (nested comment ends early in `addressparser`), GHSA-m943-m63m-w62w (`;` inside a quoted string or comment ends a group early), GHSA-85x2-q946-cp5h (`>` inside a quoted local part ends the angle address early). All three let header text become an extra or different recipient | Moderate | `>=3.0.0 <10.1.4` | **>= 10.1.4** (2026-10-18). Latest 10.x: **10.6.0** (2026-11-15) | **Yes**, `@pp/api` |
| `minimatch` | 10.2.6 (via `eslint` and `@eslint/config-array`) | GHSA-g3hv-75wg-m249: denial of service via globparts amplification | Moderate | `>=7.0.0 <11.0.1` | **>= 11.0.1**; latest 11.0.9 (2026-11-16) | No (lint tooling only, `@pp/web-core`) |
| `eslint`, `@eslint/config-array` | 10.12.0, 0.23.5 | the `minimatch` advisory above, by dependency | Moderate | `eslint` `<10.15.0` pulls `minimatch ^10`; `@eslint/config-array` `<0.23.6` | `eslint` **10.15.0**, `@eslint/config-array` **0.23.6** (both require `minimatch ^11.0.5`) | No |

Totals: **5 vulnerabilities in the root lockfile (1 high, 4 moderate)**. With `--omit=dev`: **2** (`body-parser`, `nodemailer`). All were reproduced in this review.

**Exploitability in this application (informs priority, not whether to fix):**
- `body-parser`: every parser in `apps/api/src` and `apps/web-server/src` sets `inflate: false`, so a compressed body is refused with 415 before parsing. Low today. The setting is a workaround; the fix removes the dependency on that discipline.
- `nodemailer`: recipient addresses are checked by a strict regex that rejects quotes, comments, `<`, `>` and `;` before reaching the parser (`email-otp/validation.js`). `SMTP_FROM` is operator-set configuration. Low today.
- `minimatch`/`eslint`: development only.

## 2. Target versions and a note on release age

| Package | Target | Age on 2026-11-19 | Comment |
|---|---|---|---|
| `body-parser` | 2.4.0 | 28 days | Within Express 5.3.0's declared range `^2.3.0`; **lockfile-only** |
| `nodemailer` | **10.6.0** (preferred, decided) | 4 days | **Confirmed patched and compatible (section 3a).** Non-major; zero dependencies; Node `>=20`; floor for the advisories is 10.1.4. Staying on 10.0.15 is not acceptable |
| `eslint` | 10.15.0 | 6 days | Within `@pp/web-core`'s declared `^10.10.0`; **lockfile-only** |
| `minimatch` | 11.0.9 | 3 days | **Major** bump (10 to 11) but only reached through eslint's own declared range |
| `@eslint/config-array` | 0.23.6 | 6 days | follows eslint |

**Rule (lead's decision): security patches are taken as soon as they are verified, after the package-diff review in section 5 and the evidence in section 3a. The general seven-day age rule applies only to non-security updates.** `nodemailer` 10.6.0 (4 days old) is therefore acceptable once its checks pass.

## 3. Complete dependency change set (not only the direct packages)

From `npm audit fix --dry-run` (non-force) plus the pin change for `nodemailer`:

| Change | Kind | Production? | Reviewed |
|---|---|---|---|
| `body-parser` 2.3.0 to 2.4.0 | update | **Yes** | Its dependencies `qs ^6.16.1`, `iconv-lite ^0.7.3`, `content-type ^2.1.0` are **already satisfied** by the lockfile (6.16.1, 0.7.3, 2.1.0), so **no other package changes** for this update |
| `nodemailer` 10.0.15 to 10.6.0 | update (needs the exact pin edited in `apps/api/package.json`, because `npm audit fix` will not change a pin) | **Yes** | No dependencies before or after. Requires Node `>=20` (repo engines: `^22.22.2 \|\| ^24.15.0`) |
| `eslint` 10.12.0 to 10.15.0 | update (lockfile only) | No | |
| `@eslint/config-array` 0.23.5 to 0.23.6 | update (lockfile only) | No | |
| `minimatch` 10.2.6 to 11.0.9 | **major** | No | Used by eslint internals only; Node `20 \|\| >=22` |
| `brace-expansion` 5.0.12 to 5.0.13 | patch | No | Dependency of `minimatch` |
| **`@isaacs/nonrecursive-glob-match` 1.1.0 (new package)** | **added** | No | **New to the tree.** Created 2026-10-26, this version published 2026-11-05, maintainer `isaacs` (also the `minimatch` maintainer), license BlueOak-1.0.0, 36 files, no dependencies, **no install scripts found in metadata**. Dev-only (arrives with `minimatch` 11). Review its source before accepting |

Counts: **1 package added, 5 changed** by the audit path; plus 1 change for `nodemailer`. Everything except `body-parser` and `nodemailer` is development tooling and is not shipped (portal bundles are built from source; the bundle check forbids staff markers and source maps).
Registry origin: all `resolved` URLs must remain `https://registry.npmjs.org/...`; integrity hashes are recorded in the lockfile and checked by `npm ci`. `npm audit signatures` reported **339 packages with verified registry signatures and 105 with verified provenance attestations** for the current tree.

## 3a. Verification evidence (scratch experiments, 2026-11-19)

All experiments ran in disposable directories **outside the repository** (`npm install --ignore-scripts`), with the repository's `package.json` and lockfile checksums unchanged afterwards. They are repeatable and are intended to become CI regression tests.

**`nodemailer` 10.0.15 versus 10.6.0 (preferred target): patched and compatible.**
- **Patched:** the address parser handled hostile inputs differently. On 10.0.15, `x (a (b) c) <victim@x.org>` produced the display name `x c)`; `Group: "a;b" <g1@x.org>, g2@x.org;` produced a wrong group and an address `"b <g1@x.org>, g2"@x.org;`; and `<"a>"@x.org>` produced the address `"a` and a bad envelope. On 10.6.0 these parse correctly (`g1@x.org` and `g2@x.org` as recipients; `"a>"@x.org` intact). Inputs that were already handled (plain, quoted names, `a"b@x.org`) are identical.
- **Compatible with this application:** the application's three real message types (OTP for registration, OTP for login, the staff password-changed notice), built by its own `buildMessage` functions and sent through each version's JSON transport, produced **identical envelopes and message bodies** (message id and date excluded). The ESM default import used by the application (`import nodemailer from "nodemailer"`) works on both.
- **Changelog 10.0.15 to 10.6.0** (read from the package): additive features (SMTP pool `pendingCount`, `socketCloseTimeout`, `AbortSignal` per send, `info.serverMessageId`, error `permanent` flag, an OTP header option), header and MIME encoding fixes, and further address-parser fixes (10.4.1). No change to TLS defaults, `requireTLS`, timeouts or `disableFileAccess`/`disableUrlAccess` is listed. The application sets none of the new options.
- Still required in the real tests: `smtp-sender`, `smtp-check`, OTP suites, and the options-preserved checks (section 5, U2).

**`body-parser` 2.3.0 versus 2.4.0.**
- **Application behaviour unchanged:** with `inflate: false` (what the API uses everywhere) a gzip body, a gzip body with trailing bytes, and a gzip body with an unsupported charset all return **415** on both versions in 16 to 22 ms; valid and plain JSON bodies behave identically.
- **Advisory not reproduced:** two simple attempts (valid gzip with 1 KB of trailing bytes; the same with an unsupported charset) did **not** hang, crash or burn CPU on 2.3.0 with `inflate: true`. I could not reproduce the exact exploit from the advisory text with these payloads, so **this review does not claim to have demonstrated the denial of service**. It rests on the advisory data in `npm audit`.
- **The fix is visible in the source diff:** `lib/read.js` in 2.4.0 asserts the charset is supported **before** creating the decompression stream (comment: so an unsupported charset cannot leave a decoder piped with no error listener) and checks `inflate === false` against `Content-Encoding` earlier; documentation notes were updated. This matches the class of flaw the advisory describes (compressed-body handling).
- Action: obtain the advisory's own proof of concept (GHSA-27r3-jxmh-p828) as the regression test; until then the regression test is the before-and-after equality test in section 5.

**`minimatch` 11.0.9 and `@isaacs/nonrecursive-glob-match` 1.1.0 (the new transitive package): reviewed, nothing adverse found.**
- `minimatch` 11.0.9 depends on `@isaacs/nonrecursive-glob-match ^1.1.0` and `brace-expansion ^5.0.12`; Node `20 || >=22`; ES modules; license BlueOak-1.0.0; maintainer `isaacs` (the long-time `minimatch` maintainer).
- `@isaacs/nonrecursive-glob-match` 1.1.0: **36 files**, **no runtime dependencies**, **no `preinstall`, `install` or `postinstall` scripts** (its `prepare`, `postversion` and `prepublishOnly` scripts are publish-time only and do not run on install from the registry), no use of `child_process`, `net`, `http(s)`, `fs`, `os`, `vm`, `eval`, `new Function`, `fetch` or `process.env` in its source; about 1,000 lines of pure pattern code in `dist/esm`. `minimatch` itself reads one environment variable (`__MINIMATCH_TESTING_PLATFORM__`, a test hook) and nothing else of concern; `brace-expansion` is clean.
- The package is **new** (created 2026-10-26; this version 2026-11-05). It is reached **only through eslint tooling** (not production). Recommendation: accept in U3 after the lint and build checks, pin by the lockfile integrity, and re-review on any later version change. The decision to accept remains the lead's.

**Registry trust:** `npm audit signatures` verified 339 registry signatures and 105 provenance attestations for the current tree; repeat for the updated tree after each set.

## 4. Root workspace lockfile strategy (preserved)

- One lockfile only: the root `package-lock.json` (workspaces `apps/api`, `apps/web-server`, `apps/portal-*`, `packages/*`). No per-app lockfile is created.
- Every change is made **from the repository root** (for example `npm update body-parser`, `npm install nodemailer@10.6.0 -w @pp/api`, `npm update eslint @eslint/config-array minimatch brace-expansion`), then the lockfile diff is reviewed.
- `apps/mobile` is **not** a workspace and keeps its own lockfile (see section 7: it needs its own plan).
- The root `overrides` entry (`zod` 4.6.7) is unchanged. No new `overrides` are added: none are needed for these updates (Express 5.3.0 already accepts `body-parser ^2.3.0`, so the fix resolves without one).
- Railway builds run `npm ci` (see `railway/*.json`), so the committed lockfile is what deploys. Node stays within `engines`.

## 5. Isolated change sets, order and required tests

Three separate branches and reviews (not one combined change), each started from the same base:

| Set | Content | Why separate |
|---|---|---|
| **U1** | `body-parser` 2.4.0, lockfile only | The only production update with no `package.json` change; smallest possible diff |
| **U2** | `nodemailer` 10.6.0 (pin edit plus lockfile) | Email delivery is a critical path (OTP); isolated so a delivery regression is attributable |
| **U3** | `eslint` 10.15.0, `@eslint/config-array` 0.23.6, `minimatch` 11.0.9, `brace-expansion` 5.0.13, new `@isaacs/nonrecursive-glob-match` (dev tooling) | Different risk (tooling, a new package, a major); new lint findings, if any, are fixed in a separate commit, never mixed with the security update |

**Checks common to every set (objective acceptance):**
1. Start: record `npm ls --all --json`, the lockfile package list (name, version, resolved, integrity), and the built portal `dist` file hashes.
2. After the change: `npm ci` on a clean checkout succeeds; `npm ls` reports no `invalid`, `extraneous` or `missing`.
3. **Lockfile diff review:** a script lists added, removed and changed packages and compares with section 3 exactly. Any unexpected package fails the review. All `resolved` hosts are `registry.npmjs.org`; no `git+`, `file:` or tarball URL; no new `hasInstallScript` entries beyond the existing dev-only `fsevents`.
4. `npm audit` and `npm audit --omit=dev`: the targeted advisories are gone; any remaining item is listed with an owner and an expiry date.
5. `npm audit signatures`: all signatures and attestations verify.
6. `npm test` for the affected workspace(s), plus `npm test` at the root before merge.

**U1 `body-parser` 2.4.0, additional tests:**
- API suites: `hardening`, `csrf`, `token-attacks`, `security-probe`, `frontend-serving`, `onboarding-api`, `form-validation-api`, `registrations-api`, `auth-api` (they cover JSON errors `entity.parse.failed`, `entity.too.large`, `encoding.unsupported`).
- **New regression test for the advisory (written with the change):** against every JSON route, send (a) a gzip body, (b) a gzip body with trailing bytes, (c) an oversized body, (d) a body with a wrong `Content-Type`. Expect 415 `UNSUPPORTED_ENCODING`, 413, 415 respectively, quickly, with no CPU spike and no hang. Run the **same test before and after**; results must be identical.
- A unit assertion that the resolved `body-parser` version is `>= 2.4.0` (`npm ls --json`), so a later lockfile change cannot silently reintroduce it.
- A one-minute `smoke` load run from `scripts/loadtest/` to confirm no behavioural change.

**U2 `nodemailer` 10.6.0, additional tests:**
- API suites: `smtp-sender`, `smtp-check`, `staff-sales-otp-delivery`, `otp-api`, `otp-service`, `password-reset`, `staff-password`, `env-example`.
- `npm run mail:check` and the OTP flow against the fake SMTP sink (`scripts/loadtest/fake-smtp.mjs`); compare headers, MIME structure and the extracted code with a recording made on 10.0.15 (**snapshot equality** for From, To, Subject, content type; Message-ID and Date excluded).
- **Address-parser regression (defence in depth):** with `jsonTransport`, send to `a"b@x.org`, `a(b)@x.org`, `a;b@x.org`, `"a>"@x.org` and a nested-comment address; assert the recipient list is exactly one expected address or the send is refused. The application's own validation must still reject these earlier (existing tests).
- **Security options preserved:** `disableFileAccess` and `disableUrlAccess` still reject an attachment `path` and a remote URL; `requireTLS` for a non-local host; `tls.minVersion` unchanged; the timeouts (10 s, 10 s, 20 s) unchanged.
- Review the upstream changelog from 10.0.15 to 10.6.0 for default changes (TLS, pooling, DKIM, envelope handling) and record the result.

**U3 eslint toolchain, additional tests:**
- `npm run lint -w @pp/web-core` (new findings fixed in a separate commit), `npm test -w @pp/web-core`, `npm run build`, `npm run build:all-portals` and `npm run check:bundles`.
- **Built output unchanged:** the hashes of every `apps/portal-*/dist` file equal the pre-change hashes (proves no runtime effect).
- Read the source of `@isaacs/nonrecursive-glob-match` 1.1.0 (36 files) and confirm: no network access, no `child_process`, no file writes, no install scripts.

**After all three:** root `npm test`, both supported Node majors (22.22.2 and 24.15.0) in CI (only 24.22.1 was available locally), full audit report attached to the change.

## 6. Rollback

Each set is one commit (or one small PR). Rollback is reverting that commit and redeploying; `npm ci` restores the previous tree exactly. Because Railway builds from the committed lockfile, no manual step exists. If U2 breaks mail delivery, only U2 is reverted; the OTP delivery failure mode is the existing 502 `DELIVERY_FAILED` with the code voided, so no code is left usable. A reverted set re-opens the advisory: record the exception (owner, reason, expiry date) in the change log.

## 7. The mobile app's separate lockfile (now its own plan: `MOBILE-DEPENDENCY-REVIEW-PLAN.md`)

`apps/mobile` is not a workspace and was **not** covered by the earlier review. `npm audit` on its lockfile reports **17 vulnerabilities (2 high, 15 moderate)**; with `--omit=dev` still **12 (2 high)** because the Expo CLI and build tooling are listed as dependencies of `expo`:

| Package | Severity | Note |
|---|---|---|
| `zod` | **High** | GHSA-mrhx-c7xc-m3w5: memory exhaustion validating oversized constrained collections; arrives through `@expo/cli` (build tooling) |
| `@expo/cli` | **High** | via `glob` and `zod` |
| `glob`, `minimatch`, `uuid`, `xcode`, `node-forge`, `@expo/*`, `@typescript-eslint/*` | Moderate | build, lint and signing tooling (`node-forge`: GHSA-6889-vf6x-f3g5 and a TLS client crash advisory) |

`npm audit`'s own suggested fix is a **downgrade of `expo` to 52.0.49**, which is not a valid remediation. Most of this list is **build-time tooling that is not shipped in the app binary**, but that has **not been verified** (a bundle and dependency-graph check of what the production build actually includes is needed). **Recommendation:** a separate plan: confirm which packages reach the shipped bundle (`expo export`/EAS output inspection), upgrade the Expo SDK on its own track, and add `npm audit` for `apps/mobile` to CI. Severity of this finding: **Medium** until the shipped-bundle check is done.

## 8. CI and ongoing control (requirement M4)

- CI job on every change and weekly: `npm ci`, `npm audit --omit=dev` **fails the build on high or critical** production advisories; moderate advisories are tracked; a documented exception needs an owner, a reason and an expiry.
- Same job for `apps/mobile`.
- `npm audit signatures` in CI.
- Lockfile-diff script (section 5, item 3) as a required check.
- Pin policy: exact pins for security-sensitive libraries stay, but each pin has a recorded review date; Dependabot-style notifications or a scheduled `npm outdated` report.

## 9. Findings

| ID | Severity | Finding | Evidence | Verification | Remediation |
|---|---|---|---|---|---|
| SA-06 | High (advisory); exploitability Low | `body-parser` 2.3.0 vulnerable (GHSA-27r3-jxmh-p828) | `npm audit`, `npm ls` | `npm ls body-parser` | U1 |
| SA-07 | Moderate; exploitability Low | `nodemailer` 10.0.15 vulnerable (3 advisories) | `npm audit` | `npm ls nodemailer` | U2 |
| SA-08 | Low | eslint toolchain `minimatch` DoS (dev only) | `npm audit` | `npm ls minimatch` | U3 |
| SA-28 | Medium | `apps/mobile` lockfile never audited: 17 vulnerabilities (2 high), mostly build tooling; shipped-bundle exposure unverified | `npm audit` in `apps/mobile` | Inspect the production bundle's dependency graph | Separate plan (section 7), CI audit |
| SA-29 | Info | New transitive package `@isaacs/nonrecursive-glob-match` (24 days old) enters through U3 | `npm audit fix --dry-run`, `npm view` | Source review (section 5, U3) | Accept after review or hold U3 until `eslint` resolves it differently |

## 10. Decisions record (lead) and what remains

| Decision | Applied |
|---|---|
| Prepare `body-parser` 2.4.0 as an isolated security update, subject to advisory and regression verification | Set U1; evidence in 3a; the advisory's proof of concept still to be added as the regression test |
| Prefer `nodemailer` 10.6.0 if confirmed patched and compatible | **Confirmed** (3a); set U2 targets 10.6.0 |
| Review `minimatch` 11 and its new transitive dependency before accepting | **Reviewed** (3a); acceptance in U3 after lint, build and bundle-hash checks |
| Security patches do not wait for the seven-day rule | Rule updated (section 2) |
| Separate mobile dependency review; no Expo downgrade without compatibility evidence | `MOBILE-DEPENDENCY-REVIEW-PLAN.md` (set U4); downgrade rejected |

Remaining: obtain the `body-parser` advisory proof of concept; approve implementation of U1 to U3 (and U4 after the mobile checks); add the CI gate (section 8); confirm the Node versions to test (22.22.2 and 24.15.0).
