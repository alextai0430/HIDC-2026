create table public.profiles (id uuid primary key references auth.users(id), name text not null, role text not null default 'judge' check(role in ('judge','server_admin')), slot int check(slot between 1 and 5), active boolean not null default true, check(role='server_admin' or slot is not null));
create unique index active_judge_slot on public.profiles(slot) where active and role='judge';
create table public.divisions (name text primary key);
insert into public.divisions values ('Team Division'),('Individual Juniors'),('Individual Newcomer'),('Individual Open'),('Exhibition');
create table public.competitors (id uuid primary key default gen_random_uuid(), name text not null, division text not null references public.divisions(name), position int not null, status text not null default 'upcoming' check(status in ('upcoming','active','locked')), dq boolean not null default false, archived boolean not null default false);
create unique index one_active on public.competitors((status)) where status='active';
create table public.submissions (id uuid primary key default gen_random_uuid(), competitor_id uuid not null references public.competitors(id), user_id uuid not null references public.profiles(id), slot int not null check(slot between 1 and 5), events jsonb not null default '[]', performance jsonb not null default '[0,0,0,0,0,0]', finished boolean not null default false, dq boolean not null default false, version int not null default 0, submitted_at timestamptz, updated_at timestamptz not null default now(), unique(competitor_id,slot));
create table public.operations (id uuid primary key, user_id uuid not null references public.profiles(id), created_at timestamptz not null default now());
create table public.audit (id bigint generated always as identity primary key, user_id uuid, competitor_id uuid, action text not null, prior jsonb, next jsonb, created_at timestamptz not null default now());
alter table public.profiles enable row level security;
alter table public.divisions enable row level security;
alter table public.competitors enable row level security;
alter table public.submissions enable row level security;
alter table public.operations enable row level security;
alter table public.audit enable row level security;
create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
create policy roster on public.competitors for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and active));
create policy division_read on public.divisions for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and active));
-- No browser SELECT or mutation policies on submissions, operations, audit.
-- Sensitive records are returned only by authenticated, redacting server routes.
revoke all on public.submissions,public.operations,public.audit from anon,authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
alter publication supabase_realtime add table public.competitors;

create function public.apply_score(p_user uuid,p_slot int,p_id uuid,p_competitor uuid,p_version int,p_kind text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare s submissions; c competitors; before_data jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_competitor::text,0));
 if exists(select 1 from operations where id=p_id and user_id=p_user) then return jsonb_build_object('duplicate',true); end if;
 if not exists(select 1 from profiles where id=p_user and active and slot=p_slot and role='judge') then raise exception 'Account or slot is no longer active'; end if;
 select * into c from competitors where id=p_competitor for update;
 if c.id is null or c.archived then raise exception 'Competitor unavailable'; end if;
 select * into s from submissions where competitor_id=p_competitor and slot=p_slot for update;
 if s.id is null then
   if c.status <> 'active' then raise exception 'Routine is not active; ask organizer to reopen it'; end if;
   insert into submissions(competitor_id,user_id,slot) values(p_competitor,p_user,p_slot) returning * into s;
 end if;
 if s.user_id<>p_user then raise exception 'This submission belongs to a different account'; end if;
 if s.version<>p_version then raise exception 'Version conflict: reload server copy before retrying'; end if;
 before_data=to_jsonb(s);
 if p_kind='put_event' then
   s.events=(select coalesce(jsonb_agg(value order by ord),'[]') from jsonb_array_elements(s.events) with ordinality a(value,ord) where value->>'id'<>p_payload->>'id')||jsonb_build_array(p_payload);
 elsif p_kind='delete_event' then
   s.events=(select coalesce(jsonb_agg(value order by ord),'[]') from jsonb_array_elements(s.events) with ordinality a(value,ord) where value->>'id'<>p_payload->>'id');
 elsif p_kind='performance' then s.performance=p_payload->'values';
 elsif p_kind='finish' then s.finished=(p_payload->>'finished')::boolean;
 elsif p_kind='dq' then s.dq=(p_payload->>'dq')::boolean;
 else raise exception 'Invalid operation'; end if;
 s.events=(select coalesce(jsonb_agg(value order by value->>'at'),'[]') from jsonb_array_elements(s.events));
 update submissions set events=s.events,performance=s.performance,finished=s.finished,dq=s.dq,version=version+1,submitted_at=case when s.finished then coalesce(submitted_at,now()) else submitted_at end,updated_at=now() where id=s.id;
 insert into operations(id,user_id) values(p_id,p_user);
 insert into audit(user_id,competitor_id,action,prior,next) values(p_user,p_competitor,p_kind,before_data,(select to_jsonb(x) from submissions x where x.id=s.id));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.apply_score(uuid,int,uuid,uuid,int,text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_score(uuid,int,uuid,uuid,int,text,jsonb) to service_role;

create function public.manage_competitor(p_actor uuid,p_action text,p_data jsonb) returns void language plpgsql security definer set search_path=public as $$
declare old_data jsonb; target uuid; old_position int; new_position int;
begin
 perform pg_advisory_xact_lock(2026);
 if not exists(select 1 from profiles where id=p_actor and role='server_admin' and active) then raise exception 'Organizer required'; end if;
 target=(p_data->>'id')::uuid;
 select to_jsonb(c) into old_data from competitors c where id=target;
 if p_action='activate' then
   update competitors set status='locked' where status='active';
   update competitors set status='active' where id=target and not archived;
   -- Reserve each slot when the routine starts. Offline judges can sync after lock.
   insert into submissions(competitor_id,user_id,slot) select target,id,slot from profiles where active and role='judge' and exists(select 1 from competitors where id=target and status='active') on conflict(competitor_id,slot) do nothing;
 elsif p_action='save' then
   old_position=(old_data->>'position')::int;
   new_position=(p_data->>'position')::int;
   if old_position is null then
     update competitors set position=position+1 where position>=new_position;
   elsif new_position<old_position then
     update competitors set position=position+1 where position>=new_position and position<old_position;
   elsif new_position>old_position then
     update competitors set position=position-1 where position>old_position and position<=new_position;
   end if;
   insert into competitors(id,name,division,position,status,dq,archived) values(coalesce(target,gen_random_uuid()),p_data->>'name',p_data->>'division',(p_data->>'position')::int,coalesce(p_data->>'status','upcoming'),coalesce((p_data->>'dq')::boolean,false),coalesce((p_data->>'archived')::boolean,false)) on conflict(id) do update set name=excluded.name,division=excluded.division,position=excluded.position,status=excluded.status,dq=excluded.dq,archived=excluded.archived returning id into target;
 elsif p_action='lock' then update competitors set status='locked' where id=target;
 else raise exception 'Unknown roster action'; end if;
 insert into audit(user_id,competitor_id,action,prior,next) values(p_actor,target,p_action,old_data,(select to_jsonb(c) from competitors c where id=target));
end $$;
revoke all on function public.manage_competitor(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manage_competitor(uuid,text,jsonb) to service_role;
