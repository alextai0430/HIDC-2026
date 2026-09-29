-- Revalidate the immutable competitor snapshot at the last safe boundary.
-- This prevents activating legacy or corrupted snapshots that lack one of
-- the two scoring groups, regardless of how the competitor was created.
CREATE OR REPLACE FUNCTION public.manage_competitor(
  p_actor uuid,
  p_action text,
  p_data jsonb,
  p_development boolean DEFAULT false
)
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
  expected_judges integer;
  technical_judges integer;
  performance_judges integer;
BEGIN
  PERFORM pg_advisory_xact_lock(2026);
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active AND role = 'organizer'
  ) THEN
    RAISE EXCEPTION 'Organizer required';
  END IF;

  target := (p_data->>'id')::uuid;
  SELECT to_jsonb(c) INTO old_data FROM public.competitors c WHERE id = target;

  IF p_action = 'activate' THEN
    SELECT status, division INTO target_status, target_division
    FROM public.competitors WHERE id = target AND NOT archived;
    IF target_status IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    IF target_status = 'upcoming' THEN
      SELECT id INTO next_target FROM public.competitors
      WHERE status = 'upcoming' AND NOT archived ORDER BY position LIMIT 1;
      IF target <> next_target THEN
        RAISE EXCEPTION 'Competitors must be activated in performance order';
      END IF;
    ELSIF target_status = 'locked' AND NOT EXISTS (
      SELECT 1 FROM public.scoring_windows WHERE competitor_id = target
    ) THEN
      RAISE EXCEPTION 'Only the next competitor in performance order can be started';
    END IF;

    SELECT
      count(*) FILTER (WHERE expected),
      count(*) FILTER (WHERE expected AND scoring_type = 'technical'),
      count(*) FILTER (WHERE expected AND scoring_type = 'performance')
    INTO expected_judges, technical_judges, performance_judges
    FROM public.competitor_judges WHERE competitor_id = target;
    IF expected_judges NOT BETWEEN 2 AND 10
      OR technical_judges < 1
      OR performance_judges < 1 THEN
      RAISE EXCEPTION 'This competitor has an invalid finalized judge roster; it must contain 2–10 judges, including Technical and Performance';
    END IF;

    UPDATE public.scoring_windows SET closed_at = clock_timestamp() WHERE closed_at IS NULL;
    UPDATE public.competitors SET status = 'locked' WHERE status = 'active';
    UPDATE public.competitors SET status = 'active' WHERE id = target AND NOT archived;
    INSERT INTO public.scoring_windows(competitor_id) VALUES (target);
    INSERT INTO public.submissions(
      competitor_id, user_id, historical_user_id, judge_name_snapshot,
      judge_role_snapshot, slot, scoring_type
    )
    SELECT target, cj.user_id, cj.user_id, cj.display_name, cj.role_snapshot,
      cj.roster_order, cj.scoring_type
    FROM public.competitor_judges cj
    JOIN public.profiles p ON p.id = cj.user_id AND p.active AND NOT p.archived
    WHERE cj.competitor_id = target AND cj.expected
    ON CONFLICT (competitor_id, user_id) DO UPDATE SET
      finished = false,
      submitted_at = NULL,
      version = public.submissions.version + 1,
      updated_at = clock_timestamp();

  ELSIF p_action = 'save' THEN
    IF p_data->>'status' = 'active' AND coalesce(old_data->>'status', '') <> 'active' THEN
      RAISE EXCEPTION 'Use the floor advance control to activate a competitor';
    END IF;
    IF target IS NULL AND (
      (SELECT count(*) FROM public.division_judges
        WHERE division = coalesce(p_data->>'division', '')) NOT BETWEEN 2 AND 10
      OR NOT EXISTS (SELECT 1 FROM public.division_judges
        WHERE division = coalesce(p_data->>'division', '') AND scoring_type = 'technical')
      OR NOT EXISTS (SELECT 1 FROM public.division_judges
        WHERE division = coalesce(p_data->>'division', '') AND scoring_type = 'performance')
    ) THEN
      RAISE EXCEPTION 'Assign and save a valid 2–10 judge division roster, including Technical and Performance, before adding a competitor';
    END IF;
    IF old_data->>'division' IS DISTINCT FROM p_data->>'division'
      AND EXISTS (SELECT 1 FROM public.competitor_judges WHERE competitor_id = target) THEN
      RAISE EXCEPTION 'A division cannot be changed after its official judge roster is snapshotted';
    END IF;
    old_position := (old_data->>'position')::integer;
    new_position := (p_data->>'position')::integer;
    IF old_position IS NULL THEN
      UPDATE public.competitors SET position = position + 1 WHERE position >= new_position;
    ELSIF new_position < old_position THEN
      UPDATE public.competitors SET position = position + 1
      WHERE position >= new_position AND position < old_position;
    ELSIF new_position > old_position THEN
      UPDATE public.competitors SET position = position - 1
      WHERE position > old_position AND position <= new_position;
    END IF;
    INSERT INTO public.competitors(id, name, division, position, status, dq, archived)
    VALUES (
      coalesce(target, gen_random_uuid()), p_data->>'name', p_data->>'division',
      new_position, coalesce(p_data->>'status', 'upcoming'),
      coalesce((p_data->>'dq')::boolean, false),
      coalesce((p_data->>'archived')::boolean, false)
    )
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, division = excluded.division,
      position = excluded.position, status = excluded.status,
      dq = excluded.dq, archived = excluded.archived
    RETURNING id INTO target;

  ELSIF p_action = 'lock' THEN
    UPDATE public.competitors SET status = 'locked' WHERE id = target;
    UPDATE public.scoring_windows SET closed_at = clock_timestamp()
    WHERE competitor_id = target AND closed_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unknown roster action';
  END IF;

  INSERT INTO public.audit(user_id, competitor_id, action, prior, next)
  VALUES (p_actor, target, p_action, old_data,
    (SELECT to_jsonb(c) FROM public.competitors c WHERE id = target));
END;
$$;

REVOKE ALL ON FUNCTION public.manage_competitor(uuid, text, jsonb, boolean)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_competitor(uuid, text, jsonb, boolean)
  TO service_role;
