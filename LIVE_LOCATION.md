# Live Location

During a trip, the team lead's phone shares its position about every 5 minutes, and that trip's parents see it on a map
in their dashboard (**Live Tracking**). It works like WhatsApp Live Location, built from free, open-source parts:
the existing server and database, Leaflet for the map, and OpenStreetMap map tiles.

## Who does what

| Person | What they do | Where |
|---|---|---|
| Sales (the trip's owner) or Admin | Choose the trip's team lead | Staff panel → the trip → **Live location** card |
| Team lead | Press **Start Live Location**, keep the page open, press **Stop** at the end | Their Parent Dashboard → **Live Tracking** |
| Parents of that trip | Open their dashboard and look at the map | Parent Dashboard → **Live Tracking** |

### Choosing the team lead (staff)

1. The team lead registers for the trip through the trip's normal link and picks the role **Team Leader**.
2. On the trip's page in the Sales or Admin panel, the **Live location** card lists everyone registered for that trip as a
   Team Leader. Choose one and press **Save team lead**.

Registering as "Team Leader" on its own grants nothing, because anyone can pick that role on a public form. Sharing is only
possible for the person staff have chosen, for that trip, while the trip is **active**. Changing or clearing the team lead
ends any sharing in progress.

### Sharing (team lead)

1. Open the portal on your phone through its **https://** address and go to **Live Tracking**.
2. Press **Start Live Location**. The browser asks for location permission once; allow it.
3. The phone sends its position straight away, then about every 5 minutes. The page shows when it last sent and when the
   next update is due.
4. **Keep the page open with the screen on.** Where the browser supports it, the page asks the phone to keep the screen on
   while sharing.
5. Press **Stop Live Location** at the end. Sharing also stops when you log out, when your sign-in ends, when the trip is
   closed, or when staff choose a different team lead.

### Viewing (parents)

Parents reach it the way they reach everything else: from their trip's link, signed in, through their dashboard's
**Live Tracking** section. There is no new parent login, and parents are never asked for their own location. The page:

- shows the trip and school, a status and the map, with "Last updated" set to the real time the phone measured the
  position, and how long ago that was
- checks for a new position every 5 minutes while it is open; stops checking while the tab is hidden; checks again
  as soon as the tab comes back
- shows one of six states:
  - **Live**
  - **Out of date**: the last known position, greyed out, with a warning that it is not live
  - **Starting**: waiting for the first position
  - **Not sharing**
  - **Sharing ended**
  - **Trip ended**

  A map appears only for **Live** and **Out of date**. A position is never invented, and an old one is never shown as
  current.

**Why not show the map on the public trip page itself?** That link is public: it is shared in school WhatsApp groups and
can be forwarded to anyone. Putting children's real-time location on it would show it to everyone the link ever reached.
So the map is shown only to people registered for that trip and signed in. The trip's link still takes them there.

## What works on phones, honestly

A website can only read the location while its page is open and in front.

| Situation | What happens |
|---|---|
| Page open, screen on (foreground) | Works: a position about every 5 minutes. |
| Screen locks, or the team lead switches to another app | **Updates stop.** Phones freeze background web pages to save battery: iPhone almost immediately, Android within a few minutes. |
| Team lead comes back to the page | If an update is overdue, one is sent at once, then every 5 minutes again. |
| Parents, while updates have stopped | After 12 minutes the map says **Out of date** and shows the last known position greyed out. It never pretends to be live. |
| Phone offline (no signal) | Nothing is sent while offline. When the connection returns, the page sends a fresh position at once. Old positions are not queued up. |
| Location permission refused | Sharing stops, and the page explains how to allow location in the browser's settings. |
| No GPS fix, or it takes too long | A warning is shown and the page tries again a minute later. |
| Low accuracy (more than 500 m) | Still sent. The team lead sees a note, and parents see "Approximate (within about 1.8 km)". |

**Sharing with the screen off: use the Team Leader mobile app** (`apps/mobile/`, see `MOBILE_APP.md`). It uses the
phone's native background location (an Android foreground service, the iOS location background mode) and the same
server rules as the web page. The browser version on this page remains for team leads without the app; it only works
while the page is open.

**Practical advice for the team lead:** keep the phone on a charger or power bank during travel. Leave the portal open on
Live Tracking. Set the screen to stay on (the page asks for this automatically where supported). Check in with the page
now and then.

## Privacy and data kept

- **Only the latest position is stored.** There is one row per trip in `trip_live_locations`, overwritten on every
  update. There is **no route history**.
- The position is deleted:
  - when the team lead presses Stop
  - when the trip is closed or archived, by a database trigger, so this holds whichever screen or SQL changed it
  - when staff change the team lead
  - by hourly housekeeping, once there has been no update for 24 hours or the team lead's sign-in has ended
- What is stored: latitude, longitude, accuracy, the time the phone measured it, the time the server received it, and
  the sharing status.
- The server checks every position before storing it:
  - the coordinates must be real (0,0 is refused)
  - accuracy must be between 0 and 10 km
  - the measurement time can't be in the future (2 minutes' leeway allowed), more than 15 minutes old, or older than the
    last stored one
  - updates must be at least 45 seconds apart
- Identity comes only from the sign-in cookie. The browser only names one of its **own** trip registrations, and the
  server works out the trip and the permission from that. A trip ID, school or person typed into a request is refused.
  Other people's registrations are answered "not found".

## Cost and traffic

**No new paid services. No billing to enable.** Everything used is free:
- Leaflet (open source)
- OpenStreetMap's public map tiles
- the browser's built-in location
- the existing Node server and PostgreSQL database

There is no Google Maps, no paid geocoding, and no WebSocket service.

**Estimated requests for one active trip over an 8-hour day:**

| What | Count |
|---|---|
| Team lead's position uploads (8 h × 12 per hour) | about 96, plus 1 start and 1 stop |
| Team lead's own page refreshes (one after each upload, plus the 5-minute check) | about 190 |
| Parents' page refreshes | 12 per hour per open page: **40 parents × 1 hour each ≈ 480**; worst case, 40 parents with it open all day ≈ 3,840 |
| Database writes | about 96 small updates of one row (no new rows) |
| Map tiles (from OpenStreetMap, not your server) | about 12–25 per map opening, cached by the browser: 40 parents opening it 3 times ≈ 1,500–3,000 a day |

Each upload is about 200 bytes and each answer under 1 KB, so this is negligible for the existing server.

**What is not free at every scale:**
- **The team lead's phone:** mobile data is tiny, but GPS with the screen on uses noticeable **battery**.
- **Hosting:** the requests above are light, but whatever hosts the portal still has its own cost.
- **Map tiles:** OpenStreetMap's tile servers are run by volunteers for **light use only**
  ([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)). A prototype or a handful of trips is fine.
  For many trips with hundreds of parents, switch to a tile provider's plan (several have free tiers) or host tiles
  yourself. The provider is a setting, so switching needs no code changes:

  ```
  # frontend, at build time (e.g. packages/web-core/.env.production)
  VITE_MAP_TILE_URL=https://tiles.example.com/{z}/{x}/{y}.png
  VITE_MAP_TILE_ATTRIBUTION=&copy; Example Maps &copy; OpenStreetMap contributors
  ```

## Technical summary

- Migration `018_trip_live_location.sql` adds the `trip_live_locations` table and the trip-end trigger. Rollback:
  `apps/api/src/db/rollbacks/018_trip_live_location.down.sql`.
- Parent and team-lead API, using the parent sign-in (`apps/api/src/modules/live-location/routes.js`):
  - `GET /api/live-location?enrolment=…`
  - `POST /api/live-location/start`
  - `POST /api/live-location/location` with `{enrolmentId, latitude, longitude, accuracy, capturedAt}`
  - `POST /api/live-location/stop`
- Staff API, for staff who manage the trip (`staff-routes.js`):
  - `GET /api/admin/trips/:id/live-location`
  - `PUT /api/admin/trips/:id/live-location/team-lead` with `{enrolmentId | null}`
- Settings (`DEFAULT_LIVE_LOCATION_POLICY` in `apps/api/src/modules/live-location/service.js`):

  | Setting | Value |
  |---|---|
  | Update interval | 300 s |
  | Shown as out of date after | 720 s |
  | Minimum gap between updates | 45 s |
  | Allowed future time | 120 s |
  | Oldest accepted reading | 900 s |
  | Retention | 24 h |

  Per-person rate limits: 120 reads and 60 writes per 10 minutes.
- The phone side is `packages/web-core/src/liveLocation/`:
  - `sharer.js`: the 5-minute loop, using one timer and never `setInterval`
  - `liveSharing.js`: one loop per page, the screen wake lock, and catching up when the page is visible or online again
  - `LiveMap.jsx`: the Leaflet map, downloaded only when a map is shown
  - `mapConfig.js`: the tile settings

## Setup checklist

1. **HTTPS is required** for the team lead's phone. Browsers only give the location to secure pages. `http://localhost`
   counts as secure, but only on the computer itself. A phone using the computer's network address (`http://192.168…`)
   is not secure and will see "needs a secure (https://) address". Use the real deployment's HTTPS address, or for a
   quick test a free HTTPS tunnel to your computer. Neither is set up yet.
2. Apply migration 018 where the portal runs (`npm run migrate`, after a backup). It is already applied to
   `parents_portal_dev` and `parents_portal_test`.
3. For each trip: the team lead registers through the trip link as **Team Leader**, submits the form (the dashboard
   appears after submission), and Sales chooses them on the trip page.
4. Before many trips run at once, decide on the map tile provider (see Cost).
