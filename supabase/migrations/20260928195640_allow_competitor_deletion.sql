CREATE OR REPLACE FUNCTION public.delete_competitor(p_actor uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_data jsonb;
  old_position integer;
  deleted_submission_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = p_actor
      AND active
      AND (role = 'server_admin' OR is_admin)
  ) THEN
    RAISE EXCEPTION 'Organizer required';
  END IF;

  PERFORM pg_advisory_xact_lock(2026);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text, 0));

  SELECT to_jsonb(c), c.position
    INTO old_data, old_position
  FROM public.competitors AS c
  WHERE c.id = p_id
  FOR UPDATE;

  IF old_data IS NULL THEN
    RAISE EXCEPTION 'Competitor not found';
  END IF;

  SELECT count(*)::integer
    INTO deleted_submission_count
  FROM public.submissions
  WHERE competitor_id = p_id;

  -- Keep prior audit snapshots for traceability, but remove all live score data.
  INSERT INTO public.audit(user_id, competitor_id, action, prior, next)
  VALUES (
    p_actor,
    p_id,
    'competitor_delete',
    old_data || jsonb_build_object(
      'deleted_submission_count', deleted_submission_count,
      'deleted_at', transaction_timestamp()
    ),
    NULL
  );

  DELETE FROM public.submissions WHERE competitor_id = p_id;
  DELETE FROM public.competitors WHERE id = p_id;
  UPDATE public.competitors SET position = position - 1 WHERE position > old_position;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_competitor(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_competitor(uuid, uuid) TO service_role;
