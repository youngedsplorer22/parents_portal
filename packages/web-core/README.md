# Young Edsplorer Parents Portal: frontend

React 19 + Vite. One app serves three portals:

| Address | Who | What |
|---|---|---|
| `/sales` (and `/`) | Sales team | Schools, trips, public registration links, choosing a trip's team lead |
| `/admin` | Administrators | Everything Sales has, plus all schools and trips, managing staff, school logos |
| `/join/<school>/<branch>/<trip>` | Parents | A trip's public registration page; register or log in there |
| `/parent` | Parents | Their registration form, then the dashboard (personal details, PDF, Live Tracking) |

Everything talks to the backend in `../backend` through `/api`. The Vite dev server proxies that path to
`http://127.0.0.1:4000` (`vite.config.js`, which keeps the browser's Host header so the same-origin checks work).
Sign-in is HttpOnly cookies only, with automatic renewal (`src/api/http.js`, see `../AUTH_SESSIONS.md`). No token or
personal data is ever written to browser storage.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (start the backend first)
npm test           # Vitest + Testing Library (jsdom)
npm run lint
npm run build      # production build in dist/
```

Map tiles for Live Tracking can be changed at build time with `VITE_MAP_TILE_URL` and `VITE_MAP_TILE_ATTRIBUTION`
(see `../LIVE_LOCATION.md`).

## Layout

- `src/AppRoutes.jsx`: the three portals' routes.
- `src/App.jsx`: parent sign-in and registration.
- `src/admin/`: Sales and Admin.
- `src/join/`: public trip pages.
- `src/components/onboarding/` and `src/components/dashboard/`: the parent's form and dashboard.
- `src/liveLocation/`: the map, and the browser version of the team lead's sharing. The Team Leader **mobile app** in
  `../mobile` is the way to share with the screen locked.
- `src/api/`: one small client per backend module.
- `src/test/`: fake backends used by the screen tests.
