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

1. Create a Supabase project. In its SQL editor run `supabase/migrations/001_hidc.sql`, then `002_live_and_admin.sql`, then `003_usernames_and_development_access.sql`. For an existing installation with 001–003 applied manually, do not rerun them or use `supabase db push`; follow the migration 004 deployment procedure below. New installations should also apply `004_admin_judge_access.sql` after 003. These migrations require the standard Supabase `auth` schema and Realtime publication.
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

- Technical base values and compounded level/features live exclusively in `lib/scoring.ts`, imported only by server routes and tests. There is no Execution multiplier or control.
- With admin protection enabled, ordinary technical judges see event labels and their own ranking positions, never technical values. Administrator judges can also access protected technical values. The brief conflicts on personal technical totals; this implementation follows its stronger prohibition on revealing technical scores, including in personal exports.
- Performance judges see their own six values and total out of 30.
- With protection enabled, scoring admin unlock is bound to the authenticated user with a signed, HttpOnly, SameSite cookie, expiring after four hours. Production cookies require HTTPS. Database-backed limits allow five unlock attempts per 15 minutes. The browser never receives the admin password.
- Scoring admins can inspect all submissions, export records, reopen/finish submissions, change submission DQ state, and inspect audit history. With protection enabled, global combined rankings are returned only for permanent administrators (`is_admin=true` or the backup `server_admin` role); in the default development mode every signed-in active account can access them.
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

## Judge 1 with administrator access (migration 004)

Scoring assignment and administration are independent. `alexandertai` remains `role='judge', slot=1, active=true` and gains `is_admin=true`. The `organizer` account keeps `role='server_admin', slot=NULL` with `is_admin=true` as a backup. Other judges default to `is_admin=false`. No Auth account, UUID, password, slot, submission, or operation is recreated or reassigned.

With production protection enabled, permanent administrators have immediate access to management, protected scores, audit history, and global rankings. Judge 1 still opens on Technical and keeps scoring and synchronizing as Judge 1. Ordinary judges retain their own scoring access. The existing explicit scoring-password unlock still delegates temporary score-review access; it never grants account/roster management or global rankings. Do not share that password with ordinary judges. Development open-admin mode remains available and intentionally gives every active signed-in account administrative access while the flag is false.

Normal judge management cannot edit either administrator account, including passwords, usernames, slots, active status, or privileges. Administrator grants are controlled in the database, never by a browser-supplied account payload. Deliberate administrator changes require a separate database maintenance operation. Keep Judge 1 assigned to alexandertai.

Offline writes are sanitized at the IndexedDB boundary for every account: only the current user's submissions, without computed totals/event values, are retained. Global rankings, account lists, audit history, and the protected-access flag are removed. Pending operations and their IDs/versions remain intact. Cached privileges cannot authorize a server request; each request reloads the active profile from the database. Protected data returns only after an authorized online refresh.

### Safe rollout for the existing live installation

Local implementation does not apply SQL, modify production, commit, push, or deploy automatically. Use this order during a pause in scoring:

1. Back up Supabase project `msmdzuprjankfsgdozed` before any migration. Ensure all laptops have synchronized their pending queues, then take a current restorable database backup, including Auth data, profiles, submissions, operations, audit, schema and functions. Store exports securely outside the repository. Follow [Supabase database backup guidance](https://supabase.com/docs/guides/platform/backups) or its [CLI backup/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). A CSV roster alone is not a database backup. Enter any database credentials privately, never in chat or committed files.
2. In Supabase SQL Editor, record existing profile UUIDs, roles, slots and active states, plus submission/operation counts. Apply **only** `supabase/migrations/004_admin_judge_access.sql`. It runs in a transaction and replaces only the roster function's authorization condition; reservation, locking, audit and scoring behavior remain intact. Do not rerun 001–003 or blindly run `supabase db push` against the manually migrated database.
3. Run the verification query below. Confirm alexandertai has the same UUID and judge slot 1 with admin true; organizer has its same UUID, server_admin role, null slot and admin true; judges 2–5 have admin false. Compare the scoring counts and historical records with the backup before proceeding.
4. Review `git diff` and `git status`. Confirm `git check-ignore .env.local` succeeds. Stage only the reviewed source, tests, README and migration 004, commit and push to the existing private HIDC-2026 repository. Do not stage source ZIP archives, database exports, credentials or environment files. Pushing the connected production branch can immediately start the Vercel deployment, so migration verification must happen first.
5. Wait for the existing Vercel project to deploy that commit. Keep production `NEXT_PUBLIC_BYPASS_AUTH=false` and `NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED=true`; retain existing server-only secrets. No new environment variables or password changes are needed. Confirm the deployed commit matches the tested source and the build passes.
6. At https://hidc-2026.vercel.app, sign in as alexandertai. Confirm Technical Judge 1 and Administrator are both displayed; test roster/division management, activation/locking, account creation/edit/deactivation of a disposable non-admin test account, protected scores, audit history, and global rankings. Confirm both administrator accounts are protected from normal account edits.
7. In separate browser sessions, sign in as judges 2–5. Without a scoring-admin unlock, confirm no protected values, audit data, other judges' submissions, or global rankings are returned, and management/review/audit requests are rejected. Confirm the backup organizer still has administrator access.
8. Rehearse scoring with all five judges: activate a test routine, add technical and performance scores, disconnect/reconnect Judge 1, finish and sync all entries, and verify shared rankings. Confirm zero pending operations and no global/admin payload in IndexedDB. Use reliable venue Wi-Fi and complete this five-judge rehearsal before contest use.

```sql
select id, username, role, slot, active, is_admin
from public.profiles
order by slot nulls last, username;

select 'submissions' as kind, count(*) from public.submissions
union all
select 'operations', count(*) from public.operations;
```

If the application deployment fails after 004, the additive schema is compatible with the previous app: the backup organizer retains access. Roll back the Vercel app deployment if needed; leave scoring data and migration history intact. Do not drop the new column or restore an old backup over new scoring without a separate recovery plan.

Tests cover actual API handlers with mocked external services, plus PostgreSQL migration/RLS tests with preexisting scores and operations. They verify administrator Judge 1 scoring, backup access, denial for judges 2–5, protected account edits, six-character passwords, and offline redaction. They do not replace live Supabase Auth/realtime verification after deployment.
