# Team Leader mobile app (`apps/mobile/`)

A React Native app (Expo SDK 57, React Native 0.86.3, TypeScript) for Android and iOS. A Team Leader shares their
phone's location with the parents of a trip they lead, **including while the phone is locked**. It uses the existing
backend and database; there is no second backend.

## How it fits

| Who | Uses | Does |
|---|---|---|
| Sales / Admin | Web portal | Create trips, share the trip's public link, **choose the trip's team lead** (trip page → Live location) |
| Team Leader | **Mobile app** | Signs in with their Parents Portal email and password, sees only the trips they were chosen for, Start / Stop |
| Parents | Web portal | Dashboard → Live Tracking shows only their own trip's latest position (`LIVE_LOCATION.md`) |

Registering as "Team Leader" on the public form grants nothing. Only being chosen by staff makes a trip appear in the
app, and every request is checked again by the server.

## What the app does

1. **Sign in** with the same email and password as the website.
   - Same password check, lock-out and busy-server rules.
   - Forgotten passwords are reset on the website.
2. **My trips:** only trips where staff chose this person as team lead, with each trip's status.
3. **Sharing screen** for one trip:
   - **Start** asks for location permission in the order the phone requires: while using the app, then "Always" /
     "Allow all the time".
   - The server must agree before anything starts: the person must be the chosen team lead and the trip active.
   - A first position is sent at once, then the phone's own background location service takes over.
   - **Stop** stops the phone's location service; the server wipes the stored position.
   - The screen shows:
     - the status: Sharing / Starting / Out of date / No internet / Not sharing
     - when parents last received a location
     - GPS accuracy
     - the connection
     - permission state, with an **Open Settings** button
     - the reason, if sharing stopped on its own
4. **Recovery.** Each time the app opens or comes back to the front, it checks with the server and corrects itself:
   - after a restart or reboot, it restarts the phone's location service if sharing is still on
   - if staff chose someone else, the trip ended, sharing was stopped elsewhere, or the sign-in ended, it stops and
     says why
   - if location permission was removed, it stops and tells the server
   - when the connection returns, it sends a fresh position at once

## Background location: what each phone really does

This is native background location, not a timer that only runs while the app is open. It uses `expo-location`'s
background updates with `expo-task-manager`:

| | Android | iPhone |
|---|---|---|
| How it keeps running | A **foreground service** of type `location`, with a permanent notification ("Sharing your location with parents"). This is the only way Android allows background location. | The **"location" background mode** with "Always" permission. iOS shows the blue location indicator while sharing. |
| How often it reads | The app asks for about every 5 minutes. Doze and battery savers can delay readings. | iOS delivers readings when the phone moves, often more than every 5 minutes, and seldom when it is still. |
| How often it sends | At most every 4.5 minutes, always the newest reading with its **real** capture time. | Same. |
| Phone locked, app in background | Keeps working. | Keeps working. |
| App swiped away / force-closed | The foreground service normally keeps running. Some manufacturers (Xiaomi, Oppo, Vivo, Samsung with strict battery settings) kill it; see setup below. | **iOS stops location updates.** The team lead must open the app again. |
| Phone still for a long time (hotel, bus parked) | Readings continue every ~5 min. | iOS may deliver no new reading. Parents then see "Out of date". The app never re-sends an old reading as if it were new. |
| No signal | Readings are taken; one too old for the server (over 14 min) is not sent. The newest is sent when back online. | Same. |
| Phone switched off / battery dead | Nothing can be sent. Parents see "Out of date", and the position is wiped after 24 hours. | Same. |

Sign-in lifetime: the app signs in with the same rules as the website. The access token lasts 15 minutes and renews
automatically, including in the background. Renewal stops after 3 days of no use, and a sign-in always ends after 7
days. On a trip longer than 7 days the team lead must sign in again: sharing stops and the app says so.

## Security

- **Tokens:** an access + refresh token pair stored only in the phone's secure storage, i.e. the iOS Keychain or
  Android Keystore-backed storage, with "after first unlock, this device only" so the background task can read them
  while locked. Never in plain storage, logs or URLs. Android device backups are off.
- **Separation:** app tokens work only on `/api/mobile/*`. They're hashed in their own domain, so an app token is
  useless as a website cookie and vice versa.
- **Same session rules as the website:**
  - refresh tokens rotate, and replaying an old one ends the sign-in
  - logout ends it
  - a website password reset ends app sign-ins too
- **HTTPS only.** Plain http is possible only in a development build pointed at a computer on the local network
  (`ALLOW_LOCAL_HTTP=1`), and the native settings (iOS ATS, Android cleartext) enforce it too.
- **Minimal permissions:**
  - Android: location (coarse, fine, background), foreground service (location), internet, notifications. Camera,
    microphone, contacts, storage, overlay and vibration are explicitly removed.
  - iOS: location only, one background mode.

## Running it

### What you need

| For | Needs |
|---|---|
| Unit tests, type check, lint, JS bundles | Node 22+ (works on this Mac) |
| **Android** build on a real phone | JDK 17 + Android Studio (Android SDK 35+, platform tools) and a phone with USB debugging, or Expo's cloud build service (needs an Expo account) |
| **iOS** build on a real iPhone | A Mac with **macOS 14 or newer and Xcode 16 or newer**, plus an Apple ID (a free one installs on your own iPhone for 7 days; the Apple Developer Program, $99/year, is needed for TestFlight / App Store), or Expo's cloud build service |

**This Mac (macOS 12.7.6) cannot build the iOS app:** its newest Xcode is 14.2, and current React Native and the
App Store need Xcode 16. It has no Java or Android SDK installed either.

### Steps (Android, local)

```bash
cd apps/mobile
npm install
cp .env.example .env            # set EXPO_PUBLIC_API_BASE_URL to the portal's https:// address
npx expo run:android            # builds a development build and installs it on the connected phone
```

To test against your computer's backend on the same Wi-Fi (development only):

```bash
ALLOW_LOCAL_HTTP=1 EXPO_PUBLIC_API_BASE_URL=http://<computer-ip>:4000 npx expo run:android
```

### Steps (iOS, on a Mac with Xcode 16+)

```bash
cd apps/mobile && npm install
EXPO_PUBLIC_API_BASE_URL=https://<portal> npx expo run:ios --device
```

### Android phone settings for reliable sharing

- Location permission: **Allow all the time**.
- Battery: set the app to **Unrestricted** / not optimised.
- On Xiaomi, Oppo, Vivo or Realme, also allow **Autostart**.

## Checks

```bash
cd apps/mobile
npm test            # Jest (jest-expo): 31 tests
npm run typecheck   # TypeScript, strict
npm run lint        # eslint-config-expo
```

## Implemented vs tested vs verified on a device

| Feature | Implemented | Automated test | Real device |
|---|---|---|---|
| Sign in / out, token storage, renewal (single-flight, race, one retry) | yes | yes (Jest + backend API tests) | **not yet** |
| Only assigned trips; refusal for unassigned, other trips, parents | yes | yes (backend API tests) | **not yet** |
| Start / Stop, first position, background task decisions (spacing, offline, stop reasons) | yes | yes (Jest, with fakes for the phone APIs) | **not yet** |
| Native background location (Android foreground service, iOS background mode) | yes, configured | native projects generated and inspected (manifest, Info.plist); JS bundles built for both platforms | **not yet: needs real Android and iPhone** |
| Recovery after restart, reboot, reassignment, trip closure, sign-out | yes | server side yes; app side via unit tests of the rules | **not yet** |
| Battery use, OEM battery killers, iOS stationary behaviour | documented | no | **not yet** |

**Background tracking has not been verified on any real phone.** The checklist for the first device test:

1. Start sharing, lock the phone and wait 15 minutes. The parent's map should show updates about every 5 minutes.
2. Move around (walk or drive). Positions should follow.
3. Turn on airplane mode for 10 minutes, then turn it off. A fresh position should arrive within a minute.
4. Swipe the app away, wait 10 minutes. Android: updates should continue (note the manufacturer). iOS: they stop.
5. Reboot, then open the app. It should resume (or say why not).
6. On the web, choose another team lead or close the trip. The app should stop within one update and say why.
7. Remove "Always" location permission in Settings. The app should stop and tell the server.
