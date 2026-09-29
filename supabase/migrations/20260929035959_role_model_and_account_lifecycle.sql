BEGIN;

-- Account roles describe capability only. Division membership owns scoring group.
DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND contype = 'c'
      AND (pg_get_constraintdef(oid) ILIKE '%role%' OR pg_get_constraintdef(oid) ILIKE '%slot%')
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

DROP INDEX IF EXISTS public.active_judge_slot;
UPDATE public.profiles
SET role = CASE
  WHEN role = 'server_admin' THEN 'organizer'
  WHEN role = 'judge' AND slot <= 3 THEN 'technical_judge'
  WHEN role = 'judge' THEN 'performance_judge'
  ELSE role
END;
-- Normalize any older admin-flagged judge into the single Organizer role.
UPDATE public.profiles SET role = 'organizer' WHERE is_admin;
UPDATE public.profiles SET is_admin = true WHERE role = 'organizer';
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'technical_judge';
ALTER TABLE public.profiles DROP COLUMN slot;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('technical_judge','performance_judge','organizer'));
ALTER TABLE public.profiles ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN archived_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN archived_by uuid;

-- An auth-admin deletion removes the profile row; historical accounts are archived instead.
ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

UPDATE public.profiles
SET role = 'organizer', is_admin = true
WHERE lower(username) = 'alexandertai';

CREATE OR REPLACE FUNCTION public.manage_judge_assignments(p_actor uuid, p_division text, p_assignments jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
  target uuid;
  target_order integer;
  target_type text;
  assignment_count integer;
  previous_assignments jsonb;
  saved_submission_count integer;
  affected_competitor_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active AND (role = 'organizer' OR is_admin)
  ) THEN
    RAISE EXCEPTION 'Organizer required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.divisions WHERE name = p_division) THEN
    RAISE EXCEPTION 'Division unavailable';
  END IF;
  IF jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'Assignments must be a list';
  END IF;

  assignment_count := jsonb_array_length(p_assignments);
  IF assignment_count < 2 OR assignment_count > 10 THEN
    RAISE EXCEPTION 'Assign between two and ten judges';
  END IF;
  IF (SELECT count(DISTINCT (value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> assignment_count
     OR (SELECT min((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> 1
     OR (SELECT max((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> assignment_count
     OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_assignments)) <> assignment_count THEN
    RAISE EXCEPTION 'Choose a different judge for each assignment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type' = 'technical')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type' = 'performance') THEN
    RAISE EXCEPTION 'Assign at least one Technical Judge and one Performance Judge';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments)
    WHERE value->>'scoring_type' NOT IN ('technical','performance')
  ) THEN
    RAISE EXCEPTION 'Invalid scoring group';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_assignments) AS assignment
    LEFT JOIN public.profiles AS p ON p.id = (assignment.value->>'user_id')::uuid
    WHERE p.id IS NULL OR NOT p.active OR p.archived
      OR (p.role = 'technical_judge' AND assignment.value->>'scoring_type' <> 'technical')
      OR (p.role = 'performance_judge' AND assignment.value->>'scoring_type' <> 'performance')
      OR p.role NOT IN ('technical_judge','performance_judge','organizer')
  ) THEN
    RAISE EXCEPTION 'Select active accounts whose role matches the scoring group; Organizers must be assigned explicitly';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(dj) ORDER BY dj.slot), '[]'::jsonb)
  INTO previous_assignments
  FROM public.division_judges AS dj WHERE dj.division = p_division;
  SELECT count(DISTINCT s.id)::integer, count(DISTINCT c.id)::integer
  INTO saved_submission_count, affected_competitor_count
  FROM public.competitors AS c
  JOIN public.submissions AS s ON s.competitor_id = c.id
  WHERE c.division = p_division
    AND (s.version > 0 OR s.finished OR s.dq OR s.events <> '[]'::jsonb OR s.performance <> '[0,0,0,0,0,0]'::jsonb);

  -- Preserve all scored submissions; only remove untouched pre-created placeholders for judges leaving.
  DELETE FROM public.division_judges WHERE division = p_division;
  FOR item IN SELECT value FROM jsonb_array_elements(p_assignments) ORDER BY (value->>'slot')::integer LOOP
    target := (item->>'user_id')::uuid;
    target_order := (item->>'slot')::integer;
    target_type := item->>'scoring_type';
    INSERT INTO public.division_judges(division, slot, user_id, scoring_type)
    VALUES (p_division, target_order, target, target_type);
  END LOOP;

  DELETE FROM public.submissions AS s
  USING public.competitors AS c
  WHERE s.competitor_id = c.id AND c.division = p_division
    AND s.version = 0 AND s.events = '[]'::jsonb
    AND s.performance = '[0,0,0,0,0,0]'::jsonb AND NOT s.finished AND NOT s.dq
    AND NOT EXISTS (
      SELECT 1 FROM public.division_judges AS dj
      WHERE dj.division = p_division AND dj.user_id = s.user_id
    );

  INSERT INTO public.submissions(competitor_id, user_id, slot, scoring_type)
  SELECT c.id, dj.user_id, dj.slot, dj.scoring_type
  FROM public.competitors AS c
  JOIN public.division_judges AS dj ON dj.division = c.division
  JOIN public.profiles AS p ON p.id = dj.user_id AND p.active AND NOT p.archived
  WHERE c.division = p_division AND c.status = 'active' AND NOT c.archived
  ON CONFLICT (competitor_id, user_id) DO NOTHING;

  INSERT INTO public.audit(user_id, action, prior, next)
  VALUES (
    p_actor,
    'judge_assignments',
    jsonb_build_object('division', p_division, 'assignments', previous_assignments),
    jsonb_build_object(
      'division', p_division,
      'assignments', p_assignments,
      'saved_submissions_affected', saved_submission_count,
      'competitors_affected', affected_competitor_count,
      'at', transaction_timestamp()
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_score(p_user uuid,p_slot integer,p_id uuid,p_competitor uuid,p_version integer,p_kind text,p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved public.submissions;
  competitor public.competitors;
  account public.profiles;
  before_data jsonb;
  assigned_type text;
  assignment_order integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_competitor::text, 0));
  IF EXISTS (SELECT 1 FROM public.operations WHERE id = p_id AND user_id = p_user) THEN
    RETURN jsonb_build_object('duplicate', true);
  END IF;
  SELECT * INTO account FROM public.profiles WHERE id = p_user AND active AND NOT archived;
  IF account.id IS NULL THEN RAISE EXCEPTION 'Account is inactive'; END IF;
  SELECT * INTO competitor FROM public.competitors WHERE id = p_competitor FOR UPDATE;
  IF competitor.id IS NULL OR competitor.archived THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;

  SELECT scoring_type, slot INTO assigned_type, assignment_order
  FROM public.division_judges
  WHERE division = competitor.division AND user_id = p_user;
  IF assigned_type IS NULL THEN RAISE EXCEPTION 'You are not assigned to this competitor division'; END IF;
  IF (account.role = 'technical_judge' AND assigned_type <> 'technical')
     OR (account.role = 'performance_judge' AND assigned_type <> 'performance')
     OR account.role NOT IN ('technical_judge','performance_judge','organizer') THEN
    RAISE EXCEPTION 'Your account role does not match this division assignment';
  END IF;
  IF p_kind IN ('put_event','delete_event') AND assigned_type <> 'technical' THEN
    RAISE EXCEPTION 'Technical Judge assignment required';
  END IF;
  IF p_kind = 'performance' AND assigned_type <> 'performance' THEN
    RAISE EXCEPTION 'Performance Judge assignment required';
  END IF;
  IF competitor.status <> 'active' AND NOT EXISTS (
    SELECT 1 FROM public.submissions WHERE competitor_id = p_competitor AND user_id = p_user
  ) THEN
    RAISE EXCEPTION 'Only the active competitor can be started; ask Organizer to advance the floor';
  END IF;
  SELECT * INTO saved FROM public.submissions WHERE competitor_id = p_competitor AND user_id = p_user FOR UPDATE;
  IF saved.id IS NULL THEN
    IF competitor.status <> 'active' THEN RAISE EXCEPTION 'Routine is not active; ask Organizer to reopen it'; END IF;
    INSERT INTO public.submissions(competitor_id,user_id,slot,scoring_type)
    VALUES (p_competitor,p_user,assignment_order,assigned_type) RETURNING * INTO saved;
  END IF;
  IF saved.scoring_type <> assigned_type THEN
    RAISE EXCEPTION 'This saved submission belongs to its original scoring group; contact the Organizer';
  END IF;
  IF saved.version <> p_version THEN RAISE EXCEPTION 'Version conflict: reload server copy before retrying'; END IF;
  before_data := to_jsonb(saved);
  IF p_kind = 'put_event' THEN
    saved.events := (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
      FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS a(value,ord)
      WHERE value->>'id' <> p_payload->>'id') || jsonb_build_array(p_payload);
  ELSIF p_kind = 'delete_event' THEN
    saved.events := (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
      FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS a(value,ord)
      WHERE value->>'id' <> p_payload->>'id');
  ELSIF p_kind = 'performance' THEN saved.performance := p_payload->'values';
  ELSIF p_kind = 'finish' THEN saved.finished := (p_payload->>'finished')::boolean;
  ELSIF p_kind = 'dq' THEN saved.dq := (p_payload->>'dq')::boolean;
  ELSE RAISE EXCEPTION 'Invalid operation'; END IF;
  saved.events := (SELECT coalesce(jsonb_agg(value ORDER BY value->>'at'),'[]'::jsonb) FROM jsonb_array_elements(saved.events));
  UPDATE public.submissions
  SET events=saved.events, performance=saved.performance, finished=saved.finished, dq=saved.dq,
      version=version+1,
      submitted_at=CASE WHEN saved.finished THEN coalesce(submitted_at,now()) ELSE submitted_at END,
      updated_at=now()
  WHERE id=saved.id;
  INSERT INTO public.operations(id,user_id) VALUES(p_id,p_user);
  INSERT INTO public.audit(user_id,competitor_id,action,prior,next)
  VALUES(p_user,p_competitor,p_kind,before_data,(SELECT to_jsonb(x) FROM public.submissions AS x WHERE x.id=saved.id));
  RETURN jsonb_build_object('ok',true);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_score(uuid,integer,uuid,uuid,integer,text,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score(uuid,integer,uuid,uuid,integer,text,jsonb) TO service_role;

-- Starting a routine now reserves a submission for each explicitly assigned account.
CREATE OR REPLACE FUNCTION public.manage_competitor(p_actor uuid,p_action text,p_data jsonb,p_development boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_data jsonb;
  target uuid;
  old_position integer;
  new_position integer;
  target_division text;
  target_status text;
  next_target uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2026);
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id=p_actor AND active AND (role='organizer' OR is_admin OR p_development)
  ) THEN RAISE EXCEPTION 'Organizer required'; END IF;
  target := (p_data->>'id')::uuid;
  SELECT to_jsonb(c) INTO old_data FROM public.competitors AS c WHERE id=target;
  IF p_action='activate' THEN
    SELECT status INTO target_status FROM public.competitors WHERE id=target AND NOT archived;
    IF target_status IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    IF target_status='upcoming' THEN
      SELECT id INTO next_target FROM public.competitors WHERE status='upcoming' AND NOT archived ORDER BY position LIMIT 1;
      IF target<>next_target THEN RAISE EXCEPTION 'Competitors must be activated in performance order'; END IF;
    ELSIF target_status='locked' AND NOT EXISTS(SELECT 1 FROM public.submissions WHERE competitor_id=target) THEN
      RAISE EXCEPTION 'Only the next upcoming competitor or a previously started competitor can be activated';
    END IF;
    UPDATE public.competitors SET status='locked' WHERE status='active';
    UPDATE public.competitors SET status='active' WHERE id=target AND NOT archived RETURNING division INTO target_division;
    IF target_division IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    INSERT INTO public.submissions(competitor_id,user_id,slot,scoring_type)
      SELECT target,dj.user_id,dj.slot,dj.scoring_type
      FROM public.division_judges AS dj
      JOIN public.profiles AS p ON p.id=dj.user_id AND p.active AND NOT p.archived
      WHERE dj.division=target_division
      ON CONFLICT(competitor_id,user_id) DO NOTHING;
  ELSIF p_action='save' THEN
    IF p_data->>'status'='active' AND coalesce(old_data->>'status','')<>'active' THEN
      RAISE EXCEPTION 'Use the floor advance control to activate a competitor';
    END IF;
    IF old_data->>'division' IS DISTINCT FROM p_data->>'division'
       AND EXISTS(SELECT 1 FROM public.submissions WHERE competitor_id=target AND version>0) THEN
      RAISE EXCEPTION 'A division cannot be changed after scoring has started';
    END IF;
    old_position := (old_data->>'position')::integer;
    new_position := (p_data->>'position')::integer;
    IF old_position IS NULL THEN UPDATE public.competitors SET position=position+1 WHERE position>=new_position;
    ELSIF new_position<old_position THEN UPDATE public.competitors SET position=position+1 WHERE position>=new_position AND position<old_position;
    ELSIF new_position>old_position THEN UPDATE public.competitors SET position=position-1 WHERE position>old_position AND position<=new_position; END IF;
    INSERT INTO public.competitors(id,name,division,position,status,dq,archived)
      VALUES(coalesce(target,gen_random_uuid()),p_data->>'name',p_data->>'division',new_position,
        coalesce(p_data->>'status','upcoming'),coalesce((p_data->>'dq')::boolean,false),coalesce((p_data->>'archived')::boolean,false))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,division=excluded.division,position=excluded.position,
        status=excluded.status,dq=excluded.dq,archived=excluded.archived RETURNING id INTO target;
  ELSIF p_action='lock' THEN
    UPDATE public.competitors SET status='locked' WHERE id=target;
  ELSE RAISE EXCEPTION 'Unknown roster action'; END IF;
  INSERT INTO public.audit(user_id,competitor_id,action,prior,next)
  VALUES(p_actor,target,p_action,old_data,(SELECT to_jsonb(c) FROM public.competitors AS c WHERE id=target));
END;
$$;
REVOKE ALL ON FUNCTION public.manage_competitor(uuid,text,jsonb,boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_competitor(uuid,text,jsonb,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.change_judge_account_role(p_actor uuid, p_target uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_profile public.profiles;
  new_profile public.profiles;
  active_organizers integer;
  removed_assignments jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND (role='organizer' OR is_admin)) THEN
    RAISE EXCEPTION 'Organizer access required';
  END IF;
  IF p_role NOT IN ('technical_judge','performance_judge','organizer') THEN RAISE EXCEPTION 'Invalid account role'; END IF;
  SELECT * INTO old_profile FROM public.profiles WHERE id=p_target FOR UPDATE;
  IF old_profile.id IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF lower(old_profile.username)='alexandertai' AND p_role<>'organizer' THEN
    RAISE EXCEPTION 'alexandertai must remain an Organizer';
  END IF;
  IF old_profile.role='organizer' AND old_profile.active AND p_role<>'organizer' THEN
    SELECT count(*)::integer INTO active_organizers FROM public.profiles WHERE role='organizer' AND active;
    IF active_organizers<=1 THEN RAISE EXCEPTION 'At least one active Organizer account must remain'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(dj) ORDER BY dj.division,dj.slot),'[]'::jsonb)
  INTO removed_assignments FROM public.division_judges AS dj
  WHERE dj.user_id=p_target AND (
    (p_role='technical_judge' AND dj.scoring_type<>'technical') OR
    (p_role='performance_judge' AND dj.scoring_type<>'performance')
  );
  UPDATE public.profiles SET role=p_role, is_admin=(p_role='organizer') WHERE id=p_target RETURNING * INTO new_profile;
  DELETE FROM public.division_judges AS dj WHERE dj.user_id=p_target AND (
    (p_role='technical_judge' AND dj.scoring_type<>'technical') OR
    (p_role='performance_judge' AND dj.scoring_type<>'performance')
  );
  DELETE FROM public.submissions AS s USING public.competitors AS c
  WHERE s.competitor_id=c.id AND s.user_id=p_target AND s.version=0 AND s.events='[]'::jsonb
    AND s.performance='[0,0,0,0,0,0]'::jsonb AND NOT s.finished AND NOT s.dq
    AND NOT EXISTS (SELECT 1 FROM public.division_judges AS dj WHERE dj.division=c.division AND dj.user_id=p_target);
  INSERT INTO public.audit(user_id,action,prior,next)
  VALUES (
    p_actor,'account_role_change',
    jsonb_build_object('id',old_profile.id,'username',old_profile.username,'role',old_profile.role,'removed_assignments',removed_assignments),
    jsonb_build_object('id',new_profile.id,'username',new_profile.username,'role',new_profile.role,'removed_assignments',removed_assignments)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.change_judge_account_role(uuid,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_judge_account_role(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.remove_judge_account(p_actor uuid, p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_profile public.profiles;
  score_history boolean;
  active_organizers integer;
  assignment_history jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND (role='organizer' OR is_admin)) THEN
    RAISE EXCEPTION 'Organizer access required';
  END IF;
  SELECT * INTO target_profile FROM public.profiles WHERE id=p_target FOR UPDATE;
  IF target_profile.id IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF lower(target_profile.username)='alexandertai' THEN RAISE EXCEPTION 'alexandertai is the protected full-access Organizer account'; END IF;
  IF target_profile.role='organizer' AND target_profile.active THEN
    SELECT count(*)::integer INTO active_organizers FROM public.profiles WHERE role='organizer' AND active;
    IF active_organizers<=1 THEN RAISE EXCEPTION 'The final active Organizer cannot be removed'; END IF;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.submissions AS s
    WHERE s.user_id=p_target AND (
      s.version>0 OR s.finished OR s.dq OR s.events<>'[]'::jsonb OR s.performance<>'[0,0,0,0,0,0]'::jsonb
    )
    UNION ALL
    SELECT 1 FROM public.operations WHERE user_id=p_target
    UNION ALL
    SELECT 1 FROM public.audit WHERE user_id=p_target AND action IN ('put_event','delete_event','performance','finish','dq')
  ) INTO score_history;
  SELECT coalesce(jsonb_agg(to_jsonb(dj) ORDER BY dj.division,dj.slot),'[]'::jsonb)
  INTO assignment_history FROM public.division_judges AS dj WHERE dj.user_id=p_target;

  IF score_history THEN
    UPDATE public.profiles SET active=false, archived=true, archived_at=now(), archived_by=p_actor WHERE id=p_target;
    DELETE FROM public.division_judges WHERE user_id=p_target;
    INSERT INTO public.audit(user_id,action,prior,next)
    VALUES (
      p_actor,'account_archive',
      jsonb_build_object('id',target_profile.id,'name',target_profile.name,'username',target_profile.username,'role',target_profile.role,'active',target_profile.active,'assignments',assignment_history),
      jsonb_build_object('id',p_target,'archived',true,'active',false,'score_history_preserved',true,'at',transaction_timestamp())
    );
    RETURN jsonb_build_object('hard_delete',false,'archived',true,'score_history',true);
  END IF;

  -- Temporarily disable first; the server then removes the Auth identity, which cascades the profile.
  UPDATE public.profiles SET active=false, archived=true, archived_at=now(), archived_by=p_actor WHERE id=p_target;
  DELETE FROM public.division_judges WHERE user_id=p_target;
  DELETE FROM public.submissions WHERE user_id=p_target;
  INSERT INTO public.audit(user_id,action,prior,next)
  VALUES (
    p_actor,'account_delete',
    jsonb_build_object('id',target_profile.id,'name',target_profile.name,'username',target_profile.username,'role',target_profile.role,'active',target_profile.active,'assignments',assignment_history),
    jsonb_build_object('permanent',true,'score_history',false,'at',transaction_timestamp())
  );
  RETURN jsonb_build_object('hard_delete',true,'archived',false,'score_history',false);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_judge_account(uuid,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_judge_account(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reactivate_judge_account(p_actor uuid, p_target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE target_profile public.profiles;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND (role='organizer' OR is_admin)) THEN
    RAISE EXCEPTION 'Organizer access required';
  END IF;
  SELECT * INTO target_profile FROM public.profiles WHERE id=p_target FOR UPDATE;
  IF target_profile.id IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF lower(target_profile.username)='alexandertai' THEN RAISE EXCEPTION 'alexandertai is already protected and active'; END IF;
  UPDATE public.profiles SET active=true, archived=false, archived_at=NULL, archived_by=NULL WHERE id=p_target;
  INSERT INTO public.audit(user_id,action,prior,next)
  VALUES (
    p_actor,'account_reactivate',
    jsonb_build_object('id',target_profile.id,'username',target_profile.username,'role',target_profile.role,'active',target_profile.active,'archived',target_profile.archived),
    jsonb_build_object('id',target_profile.id,'username',target_profile.username,'role',target_profile.role,'active',true,'archived',false)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.reactivate_judge_account(uuid,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_judge_account(uuid,uuid) TO service_role;

COMMIT;
