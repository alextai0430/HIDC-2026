# HIDC 2026 Judge Console

Next.js, TypeScript, Tailwind CSS, Supabase Auth/Postgres/Realtime, and IndexedDB. The interface defaults to light; the NDL emblem and HIDC wordmark in the judge console toggle a locally persisted dark theme. The supplied NDL emblem is stored in `public/ndl-emblem.jpg`.

## Run the local demo

Use Node.js 22+.

```powershell
npm ci
$env:NEXT_PUBLIC_BYPASS_AUTH='true'
npm run dev
```

Open http://127.0.0.1:3000. The demo account selector previews Technical Judge, Performance Judge, and Organizer access. Demo scoring and roster changes stay in this browser and never connect to event data. Local demo results are provisional, not official event results.

## Fileless local development

This project currently uses one Supabase database for both the deployed app and local development. Local scoring, account changes, and competitor changes affect the live event database. Use existing accounts and avoid test submissions or destructive changes while connected. The launcher warns when connected to the live project. Do not rerun migrations 001–004 on the existing project.

In the existing Vercel project settings, add these variables for the **Development** environment only, using the existing Supabase project's credentials:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (mark sensitive; server-side only)
- `NEXT_PUBLIC_BYPASS_AUTH=false`

Keep production variables configured separately in Vercel; `NEXT_PUBLIC_BYPASS_AUTH` must be false for a real event. Current administrator authorization comes from the server-loaded profile (`is_admin` or `server_admin`), not `NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED`; the latter and the old admin-password variables are unused legacy settings. Do not create or edit production variables as part of local setup.

On each computer, install Node.js 22+, then:

```powershell
git clone https://github.com/alextai0430/HIDC-2026.git
cd HIDC-2026
npm ci
npx --yes vercel@54.17.3 login
npx --yes vercel@54.17.3 link
npm run dev:vercel:check
npm run dev:vercel
npm run build:vercel
```

During `vercel link`, select the account/team and **existing Vercel project** that serves `hidc-2026.vercel.app`. If it is not listed, cancel and ask the project owner to grant access; do not create a duplicate project. The Vercel login token is saved in that computer's user configuration, and the project link is saved under ignored `.vercel/`; never copy either between computers or commit them. `build:vercel` builds with the same Development variables after `dev:vercel:check` passes.

Vercel's `env run` passes configured values directly to the process without writing an env file. Do not use `vercel env pull` or `vercel pull` for this workflow because those commands can create local environment files/cache. The launcher also filters inherited Vercel settings, masks keys found in existing `.env*` files from Next.js, checks auth bypass is off, and checks service-key/project consistency without printing values. Leave `.env.local` untouched until you have verified this workflow on your computer; once verified, you may remove that file if it is no longer needed.

For daily use, update the branch you are working on, then run `npm ci` if package files changed and `npm run dev:vercel`. Work on a feature branch and review changes before pushing: pushes to the connected production branch may trigger a production deployment. The local launcher does not push, deploy, or modify any Vercel or Supabase settings automatically.

## Connect the real event

Apply the complete migration history using the project’s reviewed Supabase migration workflow. New installations start with `001_hidc.sql` through `006_division_judges.sql`, then apply the timestamped migrations in order. Existing installations must first compare remote migration history with the repository and apply only reviewed pending migrations; do not rerun schema SQL manually or blindly push migrations. The migration set requires Supabase Auth and the Realtime publication. This repository change has **not** been applied to a live Supabase project.

Create the initial Organizer through the supported account bootstrap procedure, then create judge accounts and set each division’s complete roster before adding competitors. Every division needs 2–10 distinct assigned judges with at least one Technical Judge and one Performance Judge. An Organizer counts only when explicitly assigned. Competitor creation is blocked until its division has a valid roster, and the official roster is snapshotted for that competitor. `supabase/seed.sql` inserts competitors, so it can run only after valid judge rosters are already configured for every seeded division.

For manual/local hosting only, configure these variables in the host's secure environment settings (or use an ignored local env file):
   - `NEXT_PUBLIC_SUPABASE_URL`: the project's HTTPS URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: its publishable/anon key. This is browser-safe with the supplied RLS policies.
   - `SUPABASE_SERVICE_ROLE_KEY`: its secret service-role key. Server only; never share with judges or prefix with `NEXT_PUBLIC`.
   - `NEXT_PUBLIC_BYPASS_AUTH=false`: required for a real event. This is a build-time setting: rebuild after changing it.
Disable public account sign-up in Supabase Auth and set the deployment’s site URL and authorized redirect URLs. No public registration page exists. Use the application’s Organizer account-management flow to create judge accounts; do not expose service-role credentials or synthetic login identifiers.

All public account interfaces use **username and password only**. Usernames contain 3�32 lowercase letters, digits, underscores or hyphens (first character alphanumeric), normalized case-insensitively. Judges never choose their slot and never supply or see an email address.

## Manage accounts without redeploying

Server Access Control creates accounts with a username, password, and one role: Technical Judge, Performance Judge, or Organizer. Division assignments determine which scoring groups a judge may submit to. A judge may be assigned to multiple divisions. The server resolves usernames through a private synthetic Auth mapping; synthetic email addresses are not exposed through profile responses, account forms, or exports. Renaming a username preserves the immutable Auth/profile ID and score attribution.

Deleting an account permanently removes its login and profile. Submitted scoring records and the minimal historical attribution snapshot are preserved for authorized organizers; unfinished departed work is removed from that competitor’s expected completion count. Direct Auth user management should be reserved for recovery, not routine judge setup or deletion.

For five test accounts, run `node --env-file=.env.local scripts/seed-users.mjs`. It generates random passwords and prints only usernames/passwords. Never commit its output.

## Scoring and privacy decisions

- `Score Details` always opens without another password. Ordinary judges see only their own competitor records, trick names, levels, features, deductions, timestamps and status. Technical point values and totals do not appear in this view or its exports.
- Performance judges may see their own performance ratings without Admin unlock. Technical numeric values and cross-judge/global results remain protected by Admin unlock and Show Points rules. Ordinary judges are limited to their own allowed data.
- Active Organizer accounts, including `alexandertai`, can manage event state and view protected event results. Only judges assigned to a competitor’s immutable roster can submit scoring for it; an account’s role must match that division assignment.
- The old `/api/unlock` password route is disabled. Environment flags and browser cookies cannot turn an ordinary judge into a server administrator. The server reloads the active profile on each request and scopes `state`, `manage`, `review` and `audit` accordingly.
- PostgreSQL RLS and grants deny browser access to submission, operation and audit tables. The service-role key is used only on the server. Realtime broadcasts content-free refresh signals, never score payloads.
- IndexedDB keeps only the current user's own label-based entries and pending operation queue. It removes global results, account lists, audit history and computed scores, even for administrator accounts. Local storage and UI state cannot authorize a server request.

## Official results

Results are separate per division and use each competitor’s snapshotted judge roster. Technical scores are averaged within the technical group and scaled to 70; performance scores are averaged within the performance group for 30. A result is complete only after every expected roster submission is submitted. Exhibition is excluded, and DQ competitors rank last. Equal final scores share a rank; performance order breaks display ties. If every combined technical score is zero or negative, scaled technical is zero (never NaN or negative).

Technical deductions are fixed amounts, unaffected by selected modifiers. Features compound. All calculations retain full precision; display/export values may be formatted. Export buttons offer ranked or first-submission-time order CSV and TXT; exports quote CSV and neutralize spreadsheet-formula prefixes.

## Offline, sync, and recovery

Each scoring operation and its resulting local snapshot are saved atomically in one IndexedDB record before the saved notification appears. A serial outbox retries unique UUID operations in order. PostgreSQL atomically checks revision, changes the submission, records the operation UUID, and appends before/after audit data. Retrying an acknowledged operation does not repeat it. Different laptop edits to the same submission produce a visible version conflict instead of silently overwriting work.

Activate or reopen a competitor through Floor Control. Server-issued scoring-window credentials bind each queued action to the assigned judge and currently open competitor. Offline edits remain saved on the judge's device and can sync while that server-side window remains open. A locally saved action is not proof that the server received it; inspect the pending count and sync status. A judge offline cannot learn a newly active competitor until reconnecting.

The server does not trust browser timestamps to authorize offline work. If the organizer closes or advances the scoring window before a judge reconnects, the queued actions remain on that device and are rejected for official scoring. The judge must download a backup and contact the organizer; if the same competitor is deliberately reopened, the judge can explicitly reconcile the saved actions into the new open window. Official event timestamps use server receipt time. Keep every assigned judge connected and synced before advancing the floor; do not treat queued offline work as an official submission.

Production builds register a service worker for the public shell and hashed assets only, allowing a previously opened console to reload offline. API responses are never service-worker cached. First use and new sign-in require internet. The browser must allow IndexedDB. Do not clear site data, use private browsing, or sign out with queued work. Use one laptop/tab per judge account. For a conflict, download the local backup before choosing to reload the server copy; the backup preserves the pending event history for reconciliation.

Audit records preserve every technical edit/delete and administrator action; archived competitors retain scores. Archiving is preferred over destructive deletion. Keep database backups and verify all laptop pending counts are zero before publishing results.

## Deploy

This project uses genuine Next.js Node server routes (not a static export). Deploy to Vercel or another Node.js 22+ Next.js host, with the repository root as the project root:

```sh
npm ci
npm test
npm run build
npm start
```

Set the variables above in the hosting provider's environment settings before building. For a real competition set bypass false. Administrator access comes from account flags. Use HTTPS. Point every judge laptop at the same URL and production Supabase project. `npm start` binds to loopback for local testing; on a self-hosted server use `npx next start --hostname 0.0.0.0` behind an HTTPS reverse proxy. The project is deployed through the public GitHub repository and Vercel project. No live Supabase credentials are bundled with this repository.

## Verification

`npm test` exercises scoring, variable division rosters, migration capabilities/RLS through an isolated PGlite database, account deletion with preserved results, scoring-window validation, profile preferences, and offline queue boundaries. It does not emulate Supabase Auth or actual cross-laptop Realtime delivery.

Before an event, perform an authorized connected rehearsal using separate Organizer, Technical Judge, and Performance Judge sessions with a non-production event dataset. Test active-window start/reopen/lock/advance, network interruption and recovery, submission locking, rankings/exports, and direct unauthorized API and table access. Do not use live event data as a test fixture.

## Technical category colors

Each trick row has a shared section color: # gold, T green, O blue, F orange, S pink/red, W purple, and R teal. Deductions are red, levels blue, features violet, and hotkey configuration slate. Themes maintain category separation, readable foregrounds, and distinct hover, selected, disabled, and keyboard-focus states.

Organizer privileges are account capabilities, separate from scoring assignment. `alexandertai` remains a full-access Organizer, while Organizer accounts score only if explicitly assigned to a division. Judges never receive global access merely from their technical/performance scoring role. Cached data or local UI state does not authorize server requests.
