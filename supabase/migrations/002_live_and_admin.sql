-- A content-free change signal provides realtime refresh without broadcasting scores.
create table public.live_signal(id boolean primary key default true check(id), changed_at timestamptz not null default clock_timestamp());
insert into public.live_signal(id) values(true);
alter table public.live_signal enable row level security;
create policy live_read on public.live_signal for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and active));
grant select on public.live_signal to authenticated;
grant all on public.live_signal to service_role;
create function public.signal_change() returns trigger language plpgsql security definer set search_path=public as $$begin update live_signal set changed_at=clock_timestamp() where id;return null;end$$;
revoke all on function public.signal_change() from public,anon,authenticated;
create trigger score_signal after insert or update on public.submissions for each statement execute function public.signal_change();
create trigger profile_signal after insert or update on public.profiles for each statement execute function public.signal_change();
alter publication supabase_realtime add table public.live_signal;

create table public.unlock_attempts(user_id uuid primary key references public.profiles(id), attempts int not null, expires timestamptz not null);
alter table public.unlock_attempts enable row level security;
revoke all on public.unlock_attempts from anon,authenticated;
grant all on public.unlock_attempts to service_role;
create function public.consume_unlock_attempt(p_user uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare n int;
begin
 insert into unlock_attempts values(p_user,1,now()+interval '15 minutes') on conflict(user_id) do update set attempts=case when unlock_attempts.expires<now() then 1 else unlock_attempts.attempts+1 end,expires=case when unlock_attempts.expires<now() then now()+interval '15 minutes' else unlock_attempts.expires end returning attempts into n;
 return n<=5;
end$$;
revoke all on function public.consume_unlock_attempt(uuid) from public,anon,authenticated;
grant execute on function public.consume_unlock_attempt(uuid) to service_role;

create function public.review_submission(p_actor uuid,p_id uuid,p_version int,p_finished boolean,p_dq boolean) returns void language plpgsql security definer set search_path=public as $$
declare s submissions;
begin
 select * into s from submissions where id=p_id for update;
 if s.id is null or s.version<>p_version then raise exception 'Version conflict: refresh this submission';end if;
 update submissions set finished=p_finished,dq=p_dq,version=version+1,submitted_at=case when p_finished then coalesce(submitted_at,now()) else submitted_at end,updated_at=now() where id=p_id;
 insert into audit(user_id,competitor_id,action,prior,next) values(p_actor,s.competitor_id,'admin_review',to_jsonb(s),(select to_jsonb(x) from submissions x where id=p_id));
end$$;
revoke all on function public.review_submission(uuid,uuid,int,boolean,boolean) from public,anon,authenticated;
grant execute on function public.review_submission(uuid,uuid,int,boolean,boolean) to service_role;
