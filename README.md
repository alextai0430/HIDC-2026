# HIDC 2026 Judge Console

Next.js, TypeScript, Tailwind CSS, Supabase Auth/Postgres/Realtime, and IndexedDB. The interface defaults to dark; the NDL emblem and HIDC wordmark toggle a locally persisted light theme. The supplied NDL emblem is stored in `public/ndl-emblem.jpg`.

## Run the local demo

Use Node.js 22+.

```powershell
npm ci
$env:NEXT_PUBLIC_BYPASS_AUTH='true'
npm run dev
```

Open http://127.0.0.1:3000. The demo account selector previews all five judge slots and the organizer. Demo scoring and roster changes are local to each demo account on this browser. They do not sync to other laptops. The demo does not create real Auth users or connect to event data. In open-admin mode, local sample submissions have calculated values and provisional rankings; these are not official event results. A connected Supabase installation enables those workflows.

## Connect the real event

1. Create a Supabase project. In its SQL editor run `supabase/migrations/001_hidc.sql`, then `002_live_and_admin.sql`, then `003_usernames_and_development_access.sql`. Existing installations need to apply migration 003. With the Supabase CLI, link the project and run `supabase db push` instead. These migrations require the standard Supabase `auth` schema and Realtime publication.
2. Optionally run `supabase/seed.sql` to add seven sample competitors across all five divisions. Remove or archive these before the event.
3. Copy `.env.example` to `.env.local`. Change every placeholder:
   - `NEXT_PUBLIC_SUPABASE_URL`: the project's HTTPS URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: its publishable/anon key. This is browser-safe with the supplied RLS policies.
   - `SUPABASE_SERVICE_ROLE_KEY`: its secret service-role key. Server only; never share with judges or prefix with `NEXT_PUBLIC`.
   - `NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED=false`: default for development/testing. All signed-in accounts can open Admin, Server Access Control, score details, technical values, global rankings, and management tools without an additional password. Set `true` and rebuild to restore original permission boundaries. This is independent of judge sign-in and demo bypass.
   - `SCORING_ADMIN_PASSWORD` (disabled while protection is false): a long, unique password shared only with designated scoring administrators.
   - `ADMIN_COOKIE_SECRET` (disabled while protection is false): at least 32 cryptographically random characters, server only. Changing it invalidates admin unlock cookies.
   - `NEXT_PUBLIC_BYPASS_AUTH=false`: required for a real event. This is a build-time setting: rebuild after changing it.
4. In Supabase Authentication → Users, create the organizer's email/password account. Copy its UUID, then run:

```sql
insert into public.profiles(id,name,username,role,slot,active)
values ('ORGANIZER_AUTH_UUID','organizer','organizer','server_admin',null,true);
```

5. Disable public account sign-up in Supabase Auth. Set your deployment's site URL and authorized redirect URLs in Supabase Auth. No registration page exists in this application.
6. Sign in as the organizer, open Server Access Control, and create or assign all five judges. Each active slot has one holder; deactivate the old holder before assigning a replacement. Activate a competitor to open scoring on every laptop.

All public account interfaces use **username and password only**. Usernames contain 3�32 lowercase letters, digits, underscores or hyphens (first character alphanumeric), normalized case-insensitively. Judges never choose their slot and never supply or see an email address.

## Manage accounts without redeploying

Server Access Control creates and edits accounts using username, password, assigned slot, and active/inactive state. The server creates a unique synthetic Auth address under `hidc.internal` and resolves usernames privately at login. Synthetic addresses are not included in profile responses, account forms, exports, or audit entries. Auth tokens remain opaque implementation details; they are not rendered as account data. Renaming a username preserves its Auth UUID, historical attribution, and private Auth identifier.

Existing installations: migration 003 assigns each legacy profile a unique `user-...` username. Rename it in Server Access Control or update `profiles.username` in the Supabase dashboard. Existing Auth passwords and identifiers keep working through the server-side username lookup. Direct password resets in Supabase Auth still require no redeploy. Profiles need a unique normalized username, `role='judge'`, `slot=1..5`, and active state. Slots 1�3 are technical; 4�5 are performance. Deactivate the old slot holder before assigning a replacement. Make slot replacements between routines; historical entries retain their author.

For five test accounts, run `node --env-file=.env.local scripts/seed-users.mjs`. It generates random passwords and prints only usernames/passwords. Never commit its output.

## Scoring and privacy decisions

- Technical base values and compounded level/features live exclusively in `lib/scoring.ts`, imported only by server routes and tests. There is no Execution multiplier or control.
- With admin protection enabled, technical judges see event labels and their own ranking positions, never technical values. The brief conflicts on personal technical totals; this implementation follows its stronger prohibition on revealing technical scores, including in personal exports.
- Performance judges see their own six values and total out of 30.
- With protection enabled, scoring admin unlock is bound to the authenticated user with a signed, HttpOnly, SameSite cookie, expiring after four hours. Production cookies require HTTPS. Database-backed limits allow five unlock attempts per 15 minutes. The browser never receives the admin password.
- Scoring admins can inspect all submissions, export records, reopen/finish submissions, change submission DQ state, and inspect audit history. With protection enabled, global combined rankings are returned only for the server organizer; in the default development mode every signed-in active account can access them.
- Numeric tables have RLS enabled with no browser read/write policies. Browser database grants are revoked for submissions, operations, and audit. Only authenticated server routes use the service role, and, with protection enabled, ordinary responses contain only the current judge's submissions with no computed technical values.
- Sensitive admin responses are not written to IndexedDB. The offline cache retains only the current user's own label-based entries; admin unlock is not restored from browser storage.
- Realtime broadcasts the roster and a content-free change signal, never score payloads. An authenticated refresh obtains authorized data; a five-second fallback handles missed notifications.

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

Set the variables above in the hosting provider's environment settings before building. For a real competition set bypass false and `NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED=true`, configure the retained admin secrets, and rebuild. Use HTTPS. Point every judge laptop at the same URL and Supabase project. `npm start` binds to loopback for local testing; on a self-hosted server use `npx next start --hostname 0.0.0.0` behind an HTTPS reverse proxy. No cloud deployment or live Supabase credentials are bundled with this repository.

## Verification

`npm test` exercises scoring, feature compounding, deductions, missing entries, division scaling, zero/negative totals, local edit immutability, and actual PostgreSQL functions/RLS through PGlite. The SQL test creates mock Supabase roles/auth schema, runs the migrations, and checks lifecycle guards, duplicate retries, stale revisions, slot authorization, and denied browser table/RPC access. Realtime transport and Supabase Auth require an actual project and are not simulated by PGlite.

Before event use, conduct a connected rehearsal with five judge logins plus the organizer: start/lock/advance, disconnect and reconnect one laptop, retry an operation, finish all five submissions, inspect normalized results, export, reset a password, deactivate a judge, and attempt unauthorized API/table access. The local demo and a successful build do not substitute for this live rehearsal.

## Technical category colors

Each trick row has a shared section color: # gold, T green, O blue, F orange, S pink/red, W purple, and R teal. Deductions are red, levels blue, features violet, and hotkey configuration slate. Light and dark palettes use separate high-contrast foreground colors. Recorded events carry the matching bordered index badge. Selection uses a checkmark and thicker inset border in addition to color; hover, disabled, and keyboard-focus states remain distinct.
