# Storing registration PDFs in Google Drive: setup

When a parent submits their registration, the portal makes a PDF and keeps a **private copy in a Google Drive**. This guide
sets that up for **you@example.com** (a temporary choice: moving to another account later is a two-minute change,
see the end).

Until you finish this, **the portal still works**: parents can submit and download their PDF (made on request), and
the backend's start-up message says `PDF storage: off`. Nothing is claimed as stored until it really is.

## What you will end up with

```
Google Drive of you@example.com
└── Young Edsplorer
    └── Parent Registrations
        └── <School> · <Branch>
            └── <Trip>
                └── YE-1A2B3C4D.pdf      (the file name is the registration reference only, no names)
```

- Files are **private**. The portal never shares a file or a folder and never makes a public link.
- The portal can only see files **it created itself** (it asks Google for the narrow `drive.file` permission). It cannot open
  anything else in that Drive.
- PostgreSQL stores only the Drive file id, which account it is in, its size and a checksum, **never the PDF**.
- Parents download their PDF through the portal (after it checks they own that registration), never from Drive directly.

## Why not a "service account"?

A service account is a robot Google account. It has **no Drive storage of its own**, and it cannot store files in a personal
Gmail Drive (uploads fail with `storageQuotaExceeded`), even if you share a folder with it. So the portal instead acts **on
behalf of your Google account**, with your one-time permission (OAuth). The permission is kept as a *refresh token* in
`apps/api/.env`, a file that Git ignores.

---

## Step 1: Google Cloud Console (about 10 minutes, once)

Use the browser profile where you are signed in as **you@example.com**.

1. Go to <https://console.cloud.google.com/> and accept the terms if asked.
2. At the top, click the project picker, then **New project**. Name it `Young Edsplorer Portal` and click **Create**. Make
   sure that project is selected afterwards.
3. **Turn on the Drive API.** Menu (☰) → **APIs & Services** → **Library** → search **Google Drive API** → **Enable**.
4. **Set up the sign-in screen.** Menu → **APIs & Services** → **OAuth consent screen** (Google may call this
   **Google Auth Platform**) → **Get started**.
   - App name: `Young Edsplorer Portal`. User support email: your address. Click **Next**.
   - Audience: choose **External** (a personal Gmail account can only use External). **Next**.
   - Contact email: your address. **Next**, tick the agreement, **Create**.
5. **Allow only the narrow permission.** In the left menu choose **Data Access** → **Add or remove scopes**, tick
   `.../auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app"),
   **Update**, **Save**. Do not add any other scope.
6. **Publish the app.** In the left menu choose **Audience** → **Publish app** → **Confirm**.
   > Important: while the app is in **Testing**, Google **expires the saved permission after 7 days** and the portal would stop
   > storing PDFs a week later. Publishing to **Production** avoids that. `drive.file` is one of Google's lowest-risk
   > permissions; the **Data Access** page shows how Google classifies it, and a review is normally only needed for
   > sensitive scopes. If you do see a "needs verification" note, you can still use the app yourself (step 3 below mentions the
   > warning screen).
7. **Create the key pair.** Left menu → **Clients** (or **Credentials** → **Create credentials** → **OAuth client ID**) →
   **Create client**.
   - Application type: **Desktop app**. Name: `Young Edsplorer Portal (local)`. **Create**.
   - A box shows a **Client ID** and a **Client secret**. Copy both. (You do not need to download the JSON file. If you do,
     keep it out of the project folder; Git is set to ignore `client_secret*.json` as a safety net.)

## Step 2: Tell the portal (edit `apps/api/.env`)

Open `apps/api/.env` in your editor and add these lines (this file is private; **never commit it, paste it into a chat or send
it to anyone**):

```
PDF_STORAGE=google-drive
GOOGLE_DRIVE_ACCOUNT=you@example.com
GOOGLE_OAUTH_CLIENT_ID=<paste the Client ID>
GOOGLE_OAUTH_CLIENT_SECRET=<paste the Client secret>
```

## Step 3: Sign in once and allow it

In a terminal:

```bash
cd apps/api
npm run drive:authorize
```

1. Your browser opens Google's sign-in page (the address is also printed in the terminal if it does not).
2. Choose **you@example.com**.
3. If you see **"Google hasn't verified this app"**, click **Advanced** → **Go to Young Edsplorer Portal (unsafe)**. That
   warning is normal for your own app; you made it.
4. Tick the Drive permission and click **Continue / Allow**.
5. The page says "Authorised". Back in the terminal the tool checks it really was the right account, then prints one line:

   ```
   GOOGLE_DRIVE_REFRESH_TOKEN=1//0abc...
   ```

6. Paste that line into `apps/api/.env`. Keep it secret. (It is like a password for the portal's Drive folder.)

If it says you signed in as a different account, nothing was saved: run the command again and pick the right account.

## Step 4: Prove it works

```bash
npm run drive:check
```

It signs in, confirms the account, creates `Young Edsplorer / Connection checks`, uploads a harmless one-page test PDF, reads it
back and compares it. You should see four `OK` lines. Open Google Drive as you@example.com and look for the folder
and the test file (delete it whenever you like).

## Step 5: Restart the backend

Stop the running backend and start it again (`npm start` or `npm run dev`). The start-up messages should include:

```
PDF storage: Google Drive, destination account you@example.com. A copy of each submitted registration PDF is kept there, privately.
```

Registrations that were submitted **before** this was set up are stored automatically within a few minutes, with no one asking.

---

## How it behaves day to day

| Situation | What happens |
|---|---|
| A parent submits | The registration is saved first. The parent goes straight to their dashboard. The PDF copy is made and uploaded in the background (a few seconds). |
| Drive is slow, full, or the permission was revoked | The registration is **never lost or changed**. The PDF shows "failed" with a short code, the server retries automatically (after 30 s, 1 min, 2 min... up to an hour apart), and the parent can press **Try again**. |
| Same PDF pressed many times | Only one file is ever uploaded for a registration. |
| Parent presses **Download PDF** | They get the stored copy (checked against its checksum). Nothing ever downloads by itself. |
| `PDF_STORAGE` is not set | PDFs are made on request, nothing is stored in Drive, and the dashboard works normally. |

### The short codes you may see (in `registration_pdfs.last_error_code` and the server log)

| Code | Meaning | What to do |
|---|---|---|
| `AUTH_REVOKED` | Google no longer accepts the saved permission | Run `npm run drive:authorize` again and replace `GOOGLE_DRIVE_REFRESH_TOKEN` |
| `AUTH_CONFIG` | The client id or secret is wrong | Re-copy them from the OAuth client in Cloud Console |
| `ACCOUNT_MISMATCH` | The saved permission belongs to a different Google account than `GOOGLE_DRIVE_ACCOUNT` | Authorise again as the right account. **Nothing is uploaded to the wrong account.** |
| `QUOTA_FULL` | The Drive has no storage left | Free up space or upgrade storage |
| `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `DRIVE_ERROR` | Temporary trouble reaching Google | Nothing; the server retries by itself |
| `PERMISSION` | Google refused an action | Check the Drive API is enabled and the scope is `drive.file` |
| `NOT_FOUND` | A file or folder was deleted in Drive | Nothing; it is stored again |
| `PDF_INVALID` | The registration's declaration record could not be verified, so no PDF is made for it | Needs a developer to look at that record |

### Checking the status (read-only SQL, shows no personal data)

```sql
SELECT status, last_error_code, attempts, stored_at FROM registration_pdfs ORDER BY created_at DESC LIMIT 20;
```

---

## Moving to a different Google account later

1. In `apps/api/.env` change `GOOGLE_DRIVE_ACCOUNT` to the new address.
2. Run `npm run drive:authorize` and sign in as the **new** account; replace `GOOGLE_DRIVE_REFRESH_TOKEN`
   (the OAuth client can stay the same).
3. Run `npm run drive:check`, then restart the backend.

The portal notices that the stored copies are in the *old* account and stores each one again in the new account, in its own
`Young Edsplorer / ...` folders. The old copies are left where they are (delete them yourself if you want).

## Development and production

Keep them separate: give each its own OAuth client, its own `GOOGLE_DRIVE_ACCOUNT` (or at least its own
`GOOGLE_DRIVE_ROOT_FOLDER_NAME`, such as `Young Edsplorer (dev)`) and its own `.env`. Tests never touch Google: they run against
a small imitation of Google's API that lives in the test folder.

## Keeping it safe

- `apps/api/.env` is ignored by Git. The example file `apps/api/.env.example` holds placeholders only.
- The refresh token and client secret are never sent to the browser, never written to logs, and never appear in any API reply.
  The server's log lines contain only a short code and the registration reference.
- To switch the portal's access off at any time: <https://myaccount.google.com/permissions> → Young Edsplorer Portal → **Remove
  access**. Stored files stay in Drive. The portal then reports `AUTH_REVOKED` until you authorise again.
