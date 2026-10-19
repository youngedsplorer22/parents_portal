# Young Edsplorer Parent Portal — Frontend

Standalone React + Vite + Tailwind CSS authentication frontend for the Young Edsplorer Parent Portal.

## Current scope

- Full-screen landscape authentication UI
- Glass-style authentication card without blurring the background image
- Register / Login tabs, with Register selected by default
- Registration form: name, school, role, phone, email
- Frontend validation only
- Passwordless login by email → mock OTP verification UI
- OTP focus, backspace, arrow navigation and paste support
- Google and Microsoft authentication UI placeholders
- Responsive desktop, tablet and mobile layouts
- No backend, database, email OTP or OAuth credentials included

## Run locally

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

The backend/authentication integrations can be added later without redesigning the UI.
