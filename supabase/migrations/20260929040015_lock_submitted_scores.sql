-- A submitted score is immutable to its judge until an Organizer reopens it
-- through the manager-only review_submission RPC.
CREATE OR REPLACE FUNCTION public.apply_score(
  p_user uuid,
  p_slot integer,
  p_id uuid,
  p_competitor uuid,
  p_version integer,
  p_kind text,
  p_payload jsonb
)
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
  IF saved.finished THEN
    RAISE EXCEPTION 'Submission is already submitted; ask the Organizer to reopen it';
  END IF;
  IF p_kind = 'finish' AND (p_payload->>'finished')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only an Organizer can reopen a submitted score';
  END IF;

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
