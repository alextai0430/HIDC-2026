# HIDC 2026 Judge Console

Next.js, TypeScript, Tailwind CSS, Supabase Auth/Postgres/Realtime, and IndexedDB. The interface defaults to dark; the NDL emblem and HIDC wordmark toggle a locally persisted light theme. The supplied NDL emblem is stored in `public/ndl-emblem.jpg`.

## Run the local demo

Use Node.js 22+.

```powershell
npm ci
$env:NEXT_PUBLIC_BYPASS_AUTH='true'
npm run dev
```

Open http://127.0.0.1:3000. The demo account selector previews all five judge slots and the organizer. Demo scoring and roster changes are local to each demo account on this browser. They do not sync to other laptops. The demo does not create real Auth users or connect to event data. Local demo results are provisional and are not official event results. A connected Supabase installation enables those workflows.

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

1. Create a Supabase project. In its SQL editor run `supabase/migrations/001_hidc.sql`, then `002_live_and_admin.sql`, then `003_usernames_and_development_access.sql`. For an existing installation with 001–003 applied manually, do not rerun them or use `supabase db push`; follow the migration 004 deployment procedure below. New installations should also apply `004_admin_judge_access.sql` after 003. These migrations require the standard Supabase `auth` schema and Realtime publication.
2. Optionally run `supabase/seed.sql` to add seven sample competitors across all five divisions. Remove or archive these before the event.
3. For manual/local hosting only, configure these variables in the host's secure environment settings (or use an ignored local env file):
   - `NEXT_PUBLIC_SUPABASE_URL`: the project's HTTPS URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: its publishable/anon key. This is browser-safe with the supplied RLS policies.
   - `SUPABASE_SERVICE_ROLE_KEY`: its secret service-role key. Server only; never share with judges or prefix with `NEXT_PUBLIC`.
   - `NEXT_PUBLIC_BYPASS_AUTH=false`: required for a real event. This is a build-time setting: rebuild after changing it.
4. In Supabase Authentication → Users, create the organizer's email/password account. Copy its UUID, then run:

```sql
insert into public.profiles(id,name,username,role,slot,active,is_admin)
values ('ORGANIZER_AUTH_UUID','organizer','organizer','server_admin',null,true,true);
```

5. Disable public account sign-up in Supabase Auth. Set your deployment's site URL and authorized redirect URLs in Supabase Auth. No registration page exists in this application.
6. Sign in as the organizer, open Server Access Control, and create or assign all five judges. Each active slot has one holder; deactivate the old holder before assigning a replacement. Activate a competitor to open scoring on every laptop.

All public account interfaces use **username and password only**. Usernames contain 3�32 lowercase letters, digits, underscores or hyphens (first character alphanumeric), normalized case-insensitively. Judges never choose their slot and never supply or see an email address.

## Manage accounts without redeploying

Server Access Control creates and edits accounts using username, password, assigned slot, and active/inactive state. The server creates a unique synthetic Auth address under `hidc.internal` and resolves usernames privately at login. Synthetic addresses are not included in profile responses, account forms, exports, or audit entries. Auth tokens remain opaque implementation details; they are not rendered as account data. Renaming a username preserves its Auth UUID, historical attribution, and private Auth identifier.

Existing installations: migration 003 assigns each legacy profile a unique `user-...` username. Rename it in Server Access Control or update `profiles.username` in the Supabase dashboard. Existing Auth passwords and identifiers keep working through the server-side username lookup. Direct password resets in Supabase Auth still require no redeploy. Profiles need a unique normalized username, `role='judge'`, `slot=1..5`, and active state. Slots 1�3 are technical; 4�5 are performance. Deactivate the old slot holder before assigning a replacement. Make slot replacements between routines; historical entries retain their author.

For five test accounts, run `node --env-file=.env.local scripts/seed-users.mjs`. It generates random passwords and prints only usernames/passwords. Never commit its output.

## Scoring and privacy decisions

- `Score Details` always opens without another password. Ordinary judges see only their own competitor records, trick names, levels, features, deductions, timestamps and status. Technical point values and totals do not appear in this view or its exports.
- `Admin` shows the signed-in judge's own event values and totals, or their own performance category values and total. It never lists another judge's entry or combined/final results. Own values can be calculated offline from the common scoring rules; computed values are not persisted to IndexedDB.
- Only active accounts with `is_admin=true` or `role='server_admin'` receive all submissions, audit history, account lists and global rankings. They see every tab, including read-only views of all technical and performance judge slots; only a judge assigned to a slot may submit its score. Server Access Control retains floor, account, division and global-results management.
- The old `/api/unlock` password route is disabled. Environment flags and browser cookies cannot turn an ordinary judge into a server administrator. The server reloads the active profile on each request and scopes `state`, `manage`, `review` and `audit` accordingly.
- PostgreSQL RLS and grants deny browser access to submission, operation and audit tables. The service-role key is used only on the server. Realtime broadcasts content-free refresh signals, never score payloads.
- IndexedDB keeps only the current user's own label-based entries and pending operation queue. It removes global results, account lists, audit history and computed scores, even for administrator accounts. Local storage and UI state cannot authorize a server request.

## Official results

Results are separate per division. Exhibition is excluded. Three finished technical totals are combined, and the highest eligible complete combined total in the division scales to 70. Two finished performance totals average to 30. Missing submissions remain pending, not zero. Results are provisional until all expected entries are finished. DQ competitors receive zero and sort after eligible competitors. Equal final scores share a rank; performance order breaks display ties. If every combined technical score is zero or negative, scaled technical is zero (never NaN or negative). Negative individual raw scores remain visible to administrators.

Technical deductions are fixed amounts, unaffected by selected modifiers. Features compound. All calculations retain full precision; display/export values may be formatted. Export buttons offer ranked or first-submission-time order CSV and TXT; exports quote CSV and neutralize spreadsheet-formula prefixes.

## Offline, sync, and recovery

Each scoring operation and its resulting local snapshot are saved atomically in one IndexedDB record before the saved notification appears. A serial outbox retries unique UUID operations in order. PostgreSQL atomically checks revision, changes the submission, records the operation UUID, and appends before/after audit data. Retrying an acknowledged operation does not repeat it. Different laptop edits to the same submission produce a visible version conflict instead of silently overwriting work.

Activate routines while judges are connected. Activation reserves submissions for all active slots so offline edits can sync after the routine ends. An offline laptop cannot learn a newly active competitor until it reconnects. Local saves are not proof that the central server has received the changes: inspect the pending count and sync status before closing a laptop.

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

`npm test` exercises scoring, feature compounding, deductions, missing entries, division scaling, zero/negative totals, local edit immutability, and actual PostgreSQL functions/RLS through PGlite. The SQL test creates mock Supabase roles/auth schema, runs the migrations, and checks lifecycle guards, duplicate retries, stale revisions, slot authorization, and denied browser table/RPC access. Realtime transport and Supabase Auth require an actual project and are not simulated by PGlite.

Before event use, conduct a connected rehearsal with five judge logins plus the organizer: start/lock/advance, disconnect and reconnect one laptop, retry an operation, finish all five submissions, inspect normalized results, export, reset a password, deactivate a judge, and attempt unauthorized API/table access. The local demo and a successful build do not substitute for this live rehearsal.

## Technical category colors

Each trick row has a shared section color: # gold, T green, O blue, F orange, S pink/red, W purple, and R teal. Deductions are red, levels blue, features violet, and hotkey configuration slate. Light and dark palettes use separate high-contrast foreground colors. Recorded events carry the matching bordered index badge. Selection uses a checkmark and thicker inset border in addition to color; hover, disabled, and keyboard-focus states remain distinct.

## Judge 1 with administrator access (migration 004)

Scoring assignment and administration are independent. `alexandertai` remains `role='judge', slot=1, active=true` and gains `is_admin=true`. The `organizer` account keeps `role='server_admin', slot=NULL` with `is_admin=true` as a backup. Other judges default to `is_admin=false`. No Auth account, UUID, password, slot, submission, or operation is recreated or reassigned.

Permanent administrators have immediate access to management, all judges' scores, audit history and global rankings. Judge 1 keeps scoring and synchronizing as Judge 1. Ordinary judges receive only their own submissions and personal score values; the extra administrator password and open-admin development mode are disabled.

Normal judge management cannot edit either administrator account, including passwords, usernames, slots, active status, or privileges. Administrator grants are controlled in the database, never by a browser-supplied account payload. Deliberate administrator changes require a separate database maintenance operation. Keep Judge 1 assigned to alexandertai.

Offline writes are sanitized at the IndexedDB boundary for every account: only the current user's submissions, without computed totals/event values, are retained. Global rankings, account lists, audit history, and the protected-access flag are removed. Pending operations and their IDs/versions remain intact. Cached privileges cannot authorize a server request; each request reloads the active profile from the database. Protected data returns only after an authorized online refresh.

### Existing live installation

Migration 004 has already been applied and verified in project `msmdzuprjankfsgdozed`: alexandertai is still Judge 1 with `is_admin=true`, organizer remains the backup administrator, judges 2–5 have `is_admin=false`, and existing profile UUIDs and slots are unchanged. Do not rerun migrations 001–004 or blindly run `supabase db push`. Commit only reviewed source, tests and documentation to the public repository; `.env.local`, ZIP archives and credentials must stay out of Git. A push to the connected production branch can start a Vercel deployment, so review and test first.

Before contest use, test separate sessions for an ordinary technical judge, ordinary performance judge, alexandertai and organizer. Check Score Details, Admin, Server Access Control, global rankings, technical/performance slot selectors, exports, direct API access, offline queue and synchronization. Keep venue Wi-Fi reliable and rehearse with all five judges.


Tests cover actual API handlers with mocked external services, plus PostgreSQL migration/RLS tests with preexisting scores and operations. They verify administrator Judge 1 scoring, backup access, denial for judges 2–5, protected account edits, six-character passwords, personal versus global API scope, exports and offline redaction. They do not replace live Supabase Auth/realtime verification after deployment.
