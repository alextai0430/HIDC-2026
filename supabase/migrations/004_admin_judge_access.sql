-- Apply only after 001-003. No Auth accounts, roles, slots, scores or operation IDs change.
BEGIN;
ALTER TABLE public.profiles ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
UPDATE public.profiles SET is_admin = true
WHERE username IN ('alexandertai', 'organizer');

create or replace function public.manage_competitor(p_actor uuid,p_action text,p_data jsonb,p_development boolean default false) returns void language plpgsql security definer set search_path=public as $$
declare old_data jsonb; target uuid; old_position int; new_position int;
begin
 perform pg_advisory_xact_lock(2026);
 if not exists(select 1 from profiles where id=p_actor and active and (role='server_admin' or is_admin or p_development)) then raise exception 'Organizer required'; end if;
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
revoke all on function public.manage_competitor(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.manage_competitor(uuid,text,jsonb,boolean) to service_role;

COMMIT;
