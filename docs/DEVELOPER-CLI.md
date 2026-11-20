# Developer commands (how to set up a school, a trip and a Sales person)

There is no admin website. Everything that sets things up is a command you type on your own computer. The commands are the only way to create a school or a trip, decide which trip each public portal serves, add a Sales person, or give a Sales person a trip.

Parents, students, teachers and team leads use the four public portals. Sales people use the Sales portal, and there they can only add and edit the itinerary of the trips you give them.

## Before you start

1. Open a terminal in the repository folder.
2. Make sure the local database is running and `apps/api/.env` has your **local** `DATABASE_URL`.
3. To see the list of commands at any time:

```
npm run ops -- help
```

Every command starts with `npm run ops --`. Then the command name, then its details.

## Which database am I about to change? (read this once)

The tool picks the database for you and **refuses anything that is not your own computer** unless you take deliberate extra steps:

| You type | It uses | Safe? |
|---|---|---|
| `npm run ops -- trip:list` | your local development database (`parents_portal_dev`) | yes. If `DATABASE_URL` points anywhere else, it stops. |
| `npm run ops -- trip:list --test` | the local test database (`parents_portal_test`) | yes |
| `... --production` | the live company database | refused unless **all four** of the safeguards below are in place |

**Safeguards for the live database.** The command is refused unless:
1. you typed `--production`,
2. `NODE_ENV=production` is set,
3. `ALLOW_PRODUCTION_DATABASE=true` is set, and
4. `OPS_CONFIRM_DATABASE` is set to the exact name of that database.

Even then, the first line it prints is the database it will use. **Read it.** If it is not the one you meant, press Ctrl-C before anything happens.

Do not put those three settings in your `.env` file. Type them on the command line, only on the day you really mean to change the live database.

### Running a command against the live database

`npm run ops -- <command>` is `node --env-file=.env scripts/ops.js <command>`: it loads `apps/api/.env`, which is for local work only. Keep production settings out of that file.

For the live database, run the script directly, from the `apps/api` directory:

```
NODE_ENV=production ALLOW_PRODUCTION_DATABASE=true OPS_CONFIRM_DATABASE=<exact database name> node scripts/ops.js portal:status --production
```

(`portal:status` only reads; replace it with any command in this guide.) Points to know:

- This direct invocation does **not** load any `.env` file. Everything the process needs must already be in its environment, including the production `DATABASE_URL`. The three settings above are the safeguards; `DATABASE_URL` must be the live database's address, and the database name in it must be exactly the `OPS_CONFIRM_DATABASE` value.
- The script passes `OPS_CONFIRM_DATABASE` to the same check the migration runner uses (`MIGRATE_CONFIRM_DATABASE`). You set only `OPS_CONFIRM_DATABASE` for these commands, and messages name that variable.
- The database address rules in `DEPLOYMENT.md` (Railway foundation, Database TLS) apply here too: for example the live address may not be a test or development database, and `TEST_DATABASE_URL` must not be set.
- Never print, echo or paste `DATABASE_URL` or any other secret: not in a terminal, a log, a ticket or a chat. The script prints only the database name, host and which variable it came from.
- **Not verified:** that a Railway shell makes these variables available to this process, and how you open such a shell. This repository does not say. Check it in a staging environment first, with a read-only command such as `portal:status`.

Commands that only read (`trip:list`, `portal:status`, `sales:list`, `sales:assignments`, `audit:list`) never change anything.

## A new school and trip: step by step

Example: ABC School, Jaipur trip, Domestic, Without Payment.

**Step 1. Create the trip.**

```
npm run ops -- trip:create --school "ABC School" --branch "Jaipur" --title "Jaipur 2027" --type domestic --payment none --year 2027-28 --destination "Jaipur" --new-school
```

- `--type` is `domestic` or `international`.
- `--payment` is `none` (Without Payment) or `payment` (With Payment). This only chooses which registration form and portal are used. It does not take any payment.
- `--new-school` creates the school. Leave it out when the school already exists; then a misspelt school name is refused instead of creating a second school.
- The trip is created as a **draft**. Nothing is public yet.

It prints the trip's **address**, for example `abc-school/jaipur/jaipur-2027`, and which portal folder it belongs to.

**Step 2. Get the lines for the portal's configuration.**

```
npm run ops -- trip:config abc-school/jaipur/jaipur-2027
```

Open the portal folder it names (for example `apps/portal-domestic-free`), open `src/deployment.config.js`, and paste in the values it printed (school, branch, trip, school name, trip title, destination).

**Step 3. Add the school's logo (optional, and keep every earlier school's logo).**

1. Copy the logo (PNG, JPEG or WebP) into that portal's `src/school-logos/` folder (create it if it is not there). Name it after the school and branch, for example `abc-school-jaipur.png`.
2. At the top of `deployment.config.js`, un-comment (or add) an import line for it: `import abcJaipurLogo from "./school-logos/abc-school-jaipur.png";`
3. Add it to the `schoolLogos` list, keyed by the school and branch words: `"abc-school/jaipur": abcJaipurLogo,`

**Never delete the older entries or files.** `schoolLogos` holds the logo of every school this portal has served. When the portal is customised for the next school, the parents of the earlier school still open this same portal, and the list is how they keep seeing their own school's logo. A new school's logo is only ever shown for that school's own registrations. A school with no entry shows a neutral "School logo" box, never another school's logo.

The logos are built into the portal. There is no logo upload and no logo in the database. (A logo an older school already has in the database keeps working as a fallback.)

**Step 4. Build and check the one portal you changed.**

```
npm run build -w @pp/portal-domestic-free
```

Every public portal checks its own `deployment.config.js` when it builds. If the school, branch, trip, school name or trip title is empty or wrong, or a logo file is missing, **that portal's build stops** with a message naming the file and the value to fix. Nothing is written, so a portal that is not ready can never be deployed by mistake. The portals are independent: one that is ready still builds when another is not.

To look at all five portals on your own computer before every school is set up, you may run `ALLOW_UNCONFIGURED_PORTAL_BUILD=true npm run build:all-portals`. That switch is refused on Railway and in CI. Never deploy a build made that way.

**Step 5. Deploy that one portal** on Railway (the Domestic Without Payment portal, for example). Wait until it is healthy. If it fails, nothing in the database has changed. Do not touch the other three portals or the API.

**Step 6. Make this the trip the portal accepts.**

```
npm run ops -- portal:bind abc-school/jaipur/jaipur-2027
```

This tells the **server** that this portal registers people for this trip and no other. If the portal served another school before, that school's trip is **closed and its public page switched off** in the same step. Nothing is deleted: its registrations, forms and PDFs stay, and those parents can still log in. This does **not** open the new trip.

**Step 7. Open the trip.**

```
npm run ops -- trip:open abc-school/jaipur/jaipur-2027
```

This makes the trip active and switches its public page on. Registrations start now, and only now.

Check with `npm run ops -- portal:status`. This is not zero downtime: between Step 5 and Step 7 the new link says registration is closed, and the old school's link says "closed" from Step 5. The full explanation and the way back are in `DEPLOYMENT.md` ("Switching a portal from school A to school B").

## Closing a trip

```
npm run ops -- trip:close abc-school/jaipur/jaipur-2027
```

New registrations stop and its public page is switched off. Everyone who already registered keeps access to their registration, and keeps reading the itinerary.

## Sales people

**Add a Sales person (the allowlist).** Use their exact company email address:

```
npm run ops -- sales:allow --email priya@company.com --name "Priya Sharma"
```

Only an address added this way can set a password or log in. The person then opens the Sales portal, chooses "First time or forgot your password?", and sets a password with a code sent to that email. You never see or type their password.

**Give them a trip.** A Sales person sees no trip until you do this. One person can have many trips, and one trip can have many people:

```
npm run ops -- sales:assign --email priya@company.com abc-school/jaipur/jaipur-2027
```

**Take a trip away** (it works at once):

```
npm run ops -- sales:revoke --email priya@company.com abc-school/jaipur/jaipur-2027
```

**Look at who has what:**

```
npm run ops -- sales:list
npm run ops -- sales:assignments
npm run ops -- sales:assignments abc-school/jaipur/jaipur-2027
```

**Stop or restart someone:** `npm run ops -- sales:disable priya@company.com` and `sales:enable`.

## Removing the old admin accounts (one time)

The product no longer has admin accounts. To delete the old ones, first look (this changes nothing):

```
npm run ops -- admin:remove
```

It lists the admin accounts and exactly what deleting them would touch. With `--apply` it deletes:

- the admin accounts;
- their sign-in sessions, their unused "set a password" codes and their sign-in attempt counters;
- the audit-log rows the admins wrote (the log refuses edits, so this one command switches that protection off for this one step, inside one all-or-nothing transaction, and switches it back on straight after; if anything fails, nothing at all changes).

It keeps every school, trip, registration, participant record, PDF record, Google Drive record, itinerary item, logo, Sales account, assignment, and every audit row written by a Sales person or by a developer command. The `created_by` / `assigned_by` / `updated_by` / `bound_by` fields that named an admin are set to empty; the rows stay. One new audit row records only how many accounts were removed, with no email address. Because the audit protection is switched off briefly, run it with the database owner's connection, and at a quiet time (it waits for a moment's lock on the audit log).

When you are sure, run it with both flags (the second one is the database name it printed):

```
npm run ops -- admin:remove --apply --confirm parents_portal_dev
```

On the live database, use the production invocation from *Running a command against the live database* and add `--production`: `node scripts/ops.js admin:remove --production --apply --confirm <database name>`. This has not been run on any live database.

## The live checks in production (one time per portal)

`PORTAL_BINDING_REQUIRED=true` on the API is **mandatory for production API startup**: the API refuses to start in production without it, and refuses `false`. Local development and tests do not need it. With it on, the API accepts a registration only from a public portal it can identify, and only for the trip that is bound to that portal and open. Each public portal needs its own secret:

1. Make a long random value (at least 32 characters) for each portal you use. Use a different one for each.
2. On the **API** service, set `PORTAL_PROXY_SECRET_DOMESTIC_NONE` (and the matching variable for each other portal you use): `..._DOMESTIC_PAYMENT`, `..._INTERNATIONAL_PAYMENT`, `..._INTERNATIONAL_NONE`.
3. On each **portal** service, set `PORTAL_PROXY_SECRET` to the same value as that portal's variable on the API.
4. Keep the values out of Git and out of the portal's source files. They are never sent to a browser.

**Order.** Set the flag and the portal secrets on the API **before the first production deployment of the API**: it will not start without them. Binding comes later and separately. A portal's trip can be bound after its website is deployed, and until its trip is bound **and** open that portal accepts no registrations (that is expected, not a fault). The safe sequence for putting a school on a portal, or switching it to another school, is:

configure (`deployment.config.js`) → build → deploy the portal → `portal:bind` → `trip:open`

That is Steps 2 to 7 above. The full explanation, the check and the way back are in `DEPLOYMENT.md` ("Switching a portal from school A to school B"). Whether these steps work as written on Railway has not been verified; the server rules behind them are covered by automated tests on a local test database.

## If a command says "Stopped:"

It explains what is wrong, in words. Nothing was changed when it stops. The most common causes: a misspelt school name (add `--new-school` only when you really want a new school), an email that is not on the Sales list, or the wrong database.
