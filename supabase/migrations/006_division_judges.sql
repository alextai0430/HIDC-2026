-- Division-specific judging groups. Existing assignments are copied to every
-- division so the current five-judge setup remains unchanged on upgrade.
BEGIN;

DROP INDEX IF EXISTS public.active_judge_slot;

CREATE TABLE public.division_judges (
  division text NOT NULL REFERENCES public.divisions(name) ON UPDATE CASCADE ON DELETE CASCADE,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 5),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  PRIMARY KEY (division, slot),
  UNIQUE (division, user_id)
);
ALTER TABLE public.division_judges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.division_judges FROM anon, authenticated;
GRANT ALL ON public.division_judges TO service_role;

INSERT INTO public.division_judges(division, slot, user_id)
SELECT d.name, p.slot, p.id
FROM public.divisions d
CROSS JOIN public.profiles p
WHERE p.role='judge' AND p.active
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.manage_judge_assignments(p_actor uuid, p_division text, p_assignments jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE item jsonb; target uuid; target_slot int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND active AND (role='server_admin' OR is_admin)) THEN
    RAISE EXCEPTION 'Organizer required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM divisions WHERE name=p_division) THEN RAISE EXCEPTION 'Division unavailable'; END IF;
  IF jsonb_typeof(p_assignments) <> 'array' OR jsonb_array_length(p_assignments) <> 5 THEN
    RAISE EXCEPTION 'Select exactly five judges';
  END IF;
  IF EXISTS(
    SELECT 1 FROM competitors c JOIN submissions s ON s.competitor_id=c.id
    WHERE c.division=p_division
  ) THEN RAISE EXCEPTION 'Judges cannot be changed after scoring has started in this division'; END IF;
  IF (SELECT count(DISTINCT (value->>'slot')::int) FROM jsonb_array_elements(p_assignments)) <> 5
     OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_assignments)) <> 5 THEN
    RAISE EXCEPTION 'Assignments must contain one distinct judge for each slot';
  END IF;
  DELETE FROM division_judges WHERE division=p_division;
  FOR item IN SELECT value FROM jsonb_array_elements(p_assignments) LOOP
    target=(item->>'user_id')::uuid;
    target_slot=(item->>'slot')::int;
    IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=target AND active AND role='judge' AND slot=target_slot) THEN
      RAISE EXCEPTION 'Each selected judge must be active and match the assigned scoring slot';
    END IF;
    INSERT INTO division_judges(division,slot,user_id) VALUES(p_division,target_slot,target);
  END LOOP;
  INSERT INTO audit(user_id,action,next) VALUES(p_actor,'judge_assignments',jsonb_build_object('division',p_division,'assignments',p_assignments));
END $$;
REVOKE ALL ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_score(p_user uuid,p_slot int,p_id uuid,p_competitor uuid,p_version int,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s submissions; c competitors; before_data jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_competitor::text,0));
  IF EXISTS(SELECT 1 FROM operations WHERE id=p_id AND user_id=p_user) THEN RETURN jsonb_build_object('duplicate',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_user AND active AND role='judge' AND slot=p_slot) THEN
    RAISE EXCEPTION 'Account or slot is no longer active';
  END IF;
  SELECT * INTO c FROM competitors WHERE id=p_competitor FOR UPDATE;
  IF c.id IS NULL OR c.archived THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM division_judges WHERE division=c.division AND user_id=p_user AND slot=p_slot) THEN RAISE EXCEPTION 'You are not assigned to this competitor division'; END IF;
  IF c.status <> 'active' AND NOT EXISTS(SELECT 1 FROM submissions WHERE competitor_id=p_competitor AND user_id=p_user) THEN
    RAISE EXCEPTION 'Only the active competitor can be started; ask organizer to advance the floor';
  END IF;
  SELECT * INTO s FROM submissions WHERE competitor_id=p_competitor AND user_id=p_user FOR UPDATE;
  IF s.id IS NULL THEN
    IF c.status <> 'active' THEN RAISE EXCEPTION 'Routine is not active; ask organizer to reopen it'; END IF;
    INSERT INTO submissions(competitor_id,user_id,slot) VALUES(p_competitor,p_user,p_slot) RETURNING * INTO s;
  END IF;
  IF s.slot<>p_slot THEN RAISE EXCEPTION 'Submission slot does not match division assignment'; END IF;
  IF s.version<>p_version THEN RAISE EXCEPTION 'Version conflict: reload server copy before retrying'; END IF;
  before_data=to_jsonb(s);
  IF p_kind='put_event' THEN
    s.events=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(s.events) WITH ORDINALITY a(value,ord) WHERE value->>'id'<>p_payload->>'id')||jsonb_build_array(p_payload);
  ELSIF p_kind='delete_event' THEN
    s.events=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(s.events) WITH ORDINALITY a(value,ord) WHERE value->>'id'<>p_payload->>'id');
  ELSIF p_kind='performance' THEN s.performance=p_payload->'values';
  ELSIF p_kind='finish' THEN s.finished=(p_payload->>'finished')::boolean;
  ELSIF p_kind='dq' THEN s.dq=(p_payload->>'dq')::boolean;
  ELSE RAISE EXCEPTION 'Invalid operation'; END IF;
  s.events=(SELECT coalesce(jsonb_agg(value ORDER BY value->>'at'),'[]') FROM jsonb_array_elements(s.events));
  UPDATE submissions SET events=s.events,performance=s.performance,finished=s.finished,dq=s.dq,version=version+1,submitted_at=CASE WHEN s.finished THEN coalesce(submitted_at,now()) ELSE submitted_at END,updated_at=now() WHERE id=s.id;
  INSERT INTO operations(id,user_id) VALUES(p_id,p_user);
  INSERT INTO audit(user_id,competitor_id,action,prior,next) VALUES(p_user,p_competitor,p_kind,before_data,(SELECT to_jsonb(x) FROM submissions x WHERE x.id=s.id));
  RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION public.manage_competitor(p_actor uuid,p_action text,p_data jsonb,p_development boolean default false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE old_data jsonb; target uuid; old_position int; new_position int; target_division text; target_status text; next_target uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2026);
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND active AND (role='server_admin' OR is_admin OR p_development)) THEN RAISE EXCEPTION 'Organizer required'; END IF;
  target=(p_data->>'id')::uuid;
  SELECT to_jsonb(c) INTO old_data FROM competitors c WHERE id=target;
  IF p_action='activate' THEN
    SELECT status INTO target_status FROM competitors WHERE id=target AND NOT archived;
    IF target_status IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    IF target_status='upcoming' THEN
      SELECT id INTO next_target FROM competitors WHERE status='upcoming' AND NOT archived ORDER BY position LIMIT 1;
      IF target<>next_target THEN RAISE EXCEPTION 'Competitors must be activated in performance order'; END IF;
    ELSIF target_status='locked' AND NOT EXISTS(SELECT 1 FROM submissions WHERE competitor_id=target) THEN
      RAISE EXCEPTION 'Only the next upcoming competitor or a previously started competitor can be activated';
    END IF;
    UPDATE competitors SET status='locked' WHERE status='active';
    UPDATE competitors SET status='active' WHERE id=target AND NOT archived RETURNING division INTO target_division;
    IF target_division IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    INSERT INTO submissions(competitor_id,user_id,slot)
      SELECT target,user_id,slot FROM division_judges WHERE division=target_division
      ON CONFLICT(competitor_id,slot) DO NOTHING;
  ELSIF p_action='save' THEN
    IF p_data->>'status'='active' AND coalesce(old_data->>'status','')<>'active' THEN
      RAISE EXCEPTION 'Use the floor advance control to activate a competitor';
    END IF;
    IF old_data->>'division' IS DISTINCT FROM p_data->>'division'
       AND EXISTS(SELECT 1 FROM submissions WHERE competitor_id=target) THEN
      RAISE EXCEPTION 'A division cannot be changed after scoring has started';
    END IF;
    old_position=(old_data->>'position')::int;
    new_position=(p_data->>'position')::int;
    IF old_position IS NULL THEN UPDATE competitors SET position=position+1 WHERE position>=new_position;
    ELSIF new_position<old_position THEN UPDATE competitors SET position=position+1 WHERE position>=new_position AND position<old_position;
    ELSIF new_position>old_position THEN UPDATE competitors SET position=position-1 WHERE position>old_position AND position<=new_position; END IF;
    INSERT INTO competitors(id,name,division,position,status,dq,archived) VALUES(coalesce(target,gen_random_uuid()),p_data->>'name',p_data->>'division',(p_data->>'position')::int,coalesce(p_data->>'status','upcoming'),coalesce((p_data->>'dq')::boolean,false),coalesce((p_data->>'archived')::boolean,false))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,division=excluded.division,position=excluded.position,status=excluded.status,dq=excluded.dq,archived=excluded.archived RETURNING id INTO target;
  ELSIF p_action='lock' THEN UPDATE competitors SET status='locked' WHERE id=target;
  ELSE RAISE EXCEPTION 'Unknown roster action'; END IF;
  INSERT INTO audit(user_id,competitor_id,action,prior,next) VALUES(p_actor,target,p_action,old_data,(SELECT to_jsonb(c) FROM competitors c WHERE id=target));
END $$;

COMMIT;
