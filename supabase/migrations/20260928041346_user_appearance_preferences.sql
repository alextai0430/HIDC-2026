begin;

alter table public.profiles
  add column appearance_preferences jsonb not null
    default '{"template":"control-room","scheme":"hidc-navy","font":"system-ui","mode":"light"}'::jsonb,
  add column appearance_updated_at timestamptz not null default now();

alter table public.profiles
  add constraint profiles_appearance_preferences_object
  check (jsonb_typeof(appearance_preferences) = 'object');

comment on column public.profiles.appearance_preferences is
  'Per-user presentation preferences only; scoring, permission and event behavior are not stored here.';

commit;
