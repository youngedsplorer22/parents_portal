# Mobile app dependency security review (PLAN, separate from the API and web updates)

Status: **plan and first evidence. `apps/mobile/package.json` and `apps/mobile/package-lock.json` are unchanged** (checksum verified after every step). Experiments ran on a **scratch copy outside the repository** with `--package-lock-only --ignore-scripts`.
Decision (lead): prepare a separate review; **do not apply npm's suggested Expo downgrade without compatibility evidence.** This plan follows that.
Scope: `apps/mobile` (Expo app for team leaders; not an npm workspace; own lockfile). Date of data: 2026-11-19. Related: `DEPENDENCY-UPDATE-PLAN.md` section 7 (finding SA-28).

## 1. Current state (reproduced)

`npm audit` on the mobile lockfile: **17 vulnerabilities (2 high, 15 moderate)**. With `--omit=dev` still 12 (2 high), because Expo lists its CLI and build tools as dependencies of `expo`.

| Package (locked version) | Severity | Advisory | Where it comes from |
|---|---|---|---|
| `zod` 3.25.76 | **High** | GHSA-mrhx-c7xc-m3w5: memory exhaustion validating oversized constrained collections (`<4.6.6`) | under `@expo/cli` (build tooling) |
| `@expo/cli` | **High** | via `glob` and `zod` | dependency of `expo` (command-line tool) |
| `node-forge` 1.4.2 | Moderate | GHSA-6889-vf6x-f3g5 (Ed25519 small-order keys) and a TLS client crash on an unsupported ServerHello | Expo tooling |
| `uuid` 7.0.3, `xcode` 3.0.1 | Moderate | missing buffer bounds check in v3/v5/v6 | `@expo/config-plugins` (prebuild tooling) |
| `glob` 13.0.6 and older copies, `minimatch` 10.2.6 and older, `@expo/fingerprint`, `@expo/*`, `@typescript-eslint/*` | Moderate | glob AbortSignal bypass, minimatch DoS | tooling and lint |
| `expo` 57.0.28 | Moderate | via `@expo/fingerprint` | direct |

**npm's own fix suggestion is to move `expo` to 52.0.49.** That is a **downgrade across five SDK majors** (the registry tag `sdk-52`), which would break the app (React Native 0.86, SDK 57 modules). **Rejected.** It is an artefact of how npm resolves the advisory ranges, not a remediation.

## 2. Does any of this ship in the app?

Expected but **not yet verified**: the vulnerable packages are **developer and CI tooling** (the Expo CLI, config plugins used at prebuild time, certificate and Xcode project tools, lint and test libraries). A React Native app bundle contains only code imported from `App.tsx` through Metro, plus native modules; it does not contain `@expo/cli`, `xcode`, `node-forge` (signing tooling) or ESLint.
Runtime dependencies declared by the app: `@react-native-community/netinfo`, `expo`, `expo-build-properties`, `expo-dev-client`, `expo-location`, `expo-secure-store`, `expo-status-bar`, `expo-task-manager`, `react`, `react-native`, `react-native-safe-area-context`. **None of these appears in the audit's vulnerable list.**
**Verification method:** (1) produce the production JavaScript bundle (`expo export`, or an EAS build artifact) and list every package path that contributed code (Metro bundle analysis or source map in a scratch environment); (2) assert that none of the advisory packages appears; (3) inspect the native binary's included libraries for the signing and CLI tools (none expected). Until this is done, severity stays **Medium** (SA-28). Build-time exposure still matters: a poisoned tool runs on the developer's machine or in the build service with access to signing material, so these are supply-chain findings even if not shipped.

## 3. First evidence: a patch within the same SDK (no downgrade)

In a scratch copy of `package.json` and the lockfile, `npm install expo@57.0.33 --package-lock-only --ignore-scripts` (a **patch-level** update inside SDK 57; `expo` 57.0.33 requires `@expo/cli ^57.0.34`, `@expo/fingerprint ^0.20.16`, `@expo/config-plugins ~57.0.13`) gives:

| | Before (repo lockfile) | After (scratch, expo 57.0.33) |
|---|---|---|
| Total | 17 | **9** |
| High | 2 (`zod`, `@expo/cli`) | **1 (`zod`)** |
| Moderate | 15 | 8 |
| `node-forge` | 1.4.2 | **1.4.3** (fixed) |
| `uuid` / `xcode` | 7.0.3 / 3.0.1 | **gone / 4.0.0** (fixed) |
| `glob` | 13.0.6 | 14.0.6 |
| `@expo/cli` | flagged | **no longer flagged** |

**Remaining after the patch:** `zod` 3.25.76 (**high**, fixed only in `>=4.6.6`, a different major: the tool still resolves the 3.x line), the `@typescript-eslint/*` and `minimatch` chain (moderate, lint tooling), and `@expo/fingerprint` / `expo` reported through those.
**Conclusion:** a patch inside SDK 57 resolves most findings without a downgrade or an SDK change. It does **not** fix the `zod` high finding; that needs a separate decision (see 5).
Not yet evidence: that the app still builds and runs on 57.0.33 (section 4).

## 4. Compatibility evidence required before any change

| # | Check | Pass condition |
|---|---|---|
| 1 | Expo's own compatibility check for the target SDK (`expo install --check`, `expo-doctor`) in a scratch branch | No incompatible package versions |
| 2 | Changelog review of `expo` 57.0.28 to 57.0.33 and the pinned `expo-*` modules (`expo-location`, `expo-secure-store`, `expo-task-manager`, `expo-dev-client`, `expo-build-properties`) | No breaking change for background location, secure storage or build properties |
| 3 | `npm test` (jest, `--runInBand`), `npm run typecheck`, `npm run lint` | green |
| 4 | Development build (EAS `preview` profile) for Android and the iOS simulator or device | builds, starts |
| 5 | Manual device test of the team-leader flow against a staging API: sign in, list assigned trips, start sharing, send positions (foreground and background), stop, refresh token, sign out; token stored in Secure Store survives restart | identical behaviour to the current build |
| 6 | API contract unchanged: the app talks only to `/api/mobile/*` (see `MOBILE_APP.md`); no server change is needed | contract tests pass |
| 7 | Permissions and store metadata unchanged (location, background modes) | no new permission prompt |
| 8 | Bundle analysis (section 2): advisory packages absent from the shipped bundle | none present |
| 9 | Binary size and startup time compared | within agreed tolerance |

## 5. Decisions and options for the remaining high finding (`zod`)

| Option | Effect | Risk |
|---|---|---|
| A. Accept for now with a recorded exception | `zod` runs inside `@expo/cli` on developer machines and CI; the advisory needs oversized attacker-controlled input to a validator; exploitability low in a build tool | Residual until Expo ships a tool that resolves `zod >= 4.6.6` |
| B. `overrides` forcing `zod` 4.x for the tool | Removes the advisory | The CLI is written for 3.x; a major bump can break prebuild; needs the checks in section 4 and Expo's support statement |
| C. Move to SDK 58 (`expo` 58.0.26) | May carry newer tooling | A **major SDK migration** (React Native and module upgrades); a project, not a patch |

**Proposed:** apply the SDK 57 patch update (section 3) as its own change after section 4 passes; record A as a time-boxed exception for `zod` (owner, reason, expiry date); evaluate B in the scratch environment; plan C as a separate project when SDK 58 is the target.

## 6. Isolated change plan (when approved)

1. Branch from the same base as the other update sets (`DEPENDENCY-UPDATE-PLAN.md` U1 to U3); **mobile is set U4**.
2. In `apps/mobile`: update `expo` and the aligned `expo-*` packages to the 57.x patch versions Expo's compatibility tool selects; refresh **only** `apps/mobile/package-lock.json`. The root workspace lockfile is untouched (mobile is not a workspace).
3. Lockfile-diff review: list added, removed and changed packages; registry hosts only; no new install scripts beyond the known tooling; record every change.
4. Run section 4 checks. `npm audit` (with and without `--omit=dev`) and `npm audit signatures`.
5. New binary: a patch of the native modules means a **new store build**; plan release with the team (installed apps do not pick up native changes over the air; JavaScript-only updates are not enough).
6. Add `apps/mobile` to the CI audit job (`DEPENDENCY-UPDATE-PLAN.md` 8) with a policy: build-tooling advisories are reviewed and tracked; runtime-bundle advisories block a release.

**Rollback:** revert the lockfile and `package.json` commit and rebuild; the previous store build remains available until the new one is accepted. Keep the previous binary distributable.

## 7. Acceptance

The review is complete when: the shipped-bundle analysis result is recorded; the patch update has passed section 4 with evidence; each remaining advisory is either fixed or listed as an exception with owner, reason and expiry; the CI job covers `apps/mobile`. **Nothing here is marked complete today.**

## 8. Decisions needed

1. Approve preparing set U4 (the SDK 57 patch update) after the section 4 checks.
2. Approve the time-boxed exception approach for `zod` (option A) while B is evaluated.
3. Decide when SDK 58 is scheduled.
4. Confirm who performs the device tests and the store release.
