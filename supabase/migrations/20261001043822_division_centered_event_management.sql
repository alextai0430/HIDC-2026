-- Version aligned with the production migration ledger entry.
BEGIN;

-- Bring pre-existing sequences into the independent per-division order used
-- by the Server Access Control panels.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY division ORDER BY position, id)::integer AS position
  FROM public.competitors
)
UPDATE public.competitors AS c
SET position = ordered.position
FROM ordered
WHERE ordered.id = c.id AND c.position IS DISTINCT FROM ordered.position;

-- Create a division and its numbered public judge roster atomically. The
-- account IDs and real names remain private to Server Access Control; the
-- roster_order is the stable Judge N label used by score records and exports.
CREATE OR REPLACE FUNCTION public.create_division_with_roster(
  p_actor uuid,
  p_division text,
  p_assignments jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  roster_size integer;
  assignment jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active AND role = 'organizer'
  ) THEN
    RAISE EXCEPTION 'Organizer access required';
  END IF;
  IF p_division IS NULL OR length(btrim(p_division)) = 0 OR length(btrim(p_division)) > 80 THEN
    RAISE EXCEPTION 'Enter a division name up to 80 characters';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.divisions WHERE lower(name) = lower(btrim(p_division))
  ) THEN
    RAISE EXCEPTION 'That division already exists';
  END IF;
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'Assign division judges before saving';
  END IF;

  roster_size := jsonb_array_length(p_assignments);
  IF roster_size NOT BETWEEN 2 AND 10 THEN
    RAISE EXCEPTION 'Assign between two and ten judges';
  END IF;
  IF (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_assignments)) <> roster_size
     OR (SELECT count(DISTINCT (value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> roster_size
     OR (SELECT min((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> 1
     OR (SELECT max((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments)) <> roster_size THEN
    RAISE EXCEPTION 'Choose a different judge and judge number for every roster position, numbered from 1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type' = 'technical')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type' = 'performance') THEN
    RAISE EXCEPTION 'Assign at least one Technical Judge and one Performance Judge';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_assignments) a
    LEFT JOIN public.profiles p ON p.id = (a.value->>'user_id')::uuid
    WHERE p.id IS NULL OR NOT p.active OR p.archived
      OR a.value->>'scoring_type' NOT IN ('technical', 'performance')
      OR (p.role = 'technical_judge' AND a.value->>'scoring_type' <> 'technical')
      OR (p.role = 'performance_judge' AND a.value->>'scoring_type' <> 'performance')
      OR p.role NOT IN ('technical_judge', 'performance_judge', 'organizer')
  ) THEN
    RAISE EXCEPTION 'Select active accounts whose role matches the scoring group';
  END IF;

  INSERT INTO public.divisions(name) VALUES (btrim(p_division));
  FOR assignment IN
    SELECT value FROM jsonb_array_elements(p_assignments)
    ORDER BY (value->>'slot')::integer
  LOOP
    INSERT INTO public.division_judges(division, slot, user_id, scoring_type)
    VALUES (
      btrim(p_division),
      (assignment->>'slot')::integer,
      (assignment->>'user_id')::uuid,
      assignment->>'scoring_type'
    );
  END LOOP;
  INSERT INTO public.audit(user_id, action, next)
  VALUES (
    p_actor,
    'division_create',
    jsonb_build_object('name', btrim(p_division), 'judge_count', roster_size)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.create_division_with_roster(uuid, text, jsonb)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_division_with_roster(uuid, text, jsonb)
  TO service_role;

-- Competition ordering and the manual first activation are scoped to a
-- division. There is still one live floor competitor at a time, but selecting
-- a division no longer depends on another division's independent order.
CREATE OR REPLACE FUNCTION public.manage_competitor(
  p_actor uuid,
  p_action text,
  p_data jsonb,
  p_development boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_data jsonb;
  target uuid;
  old_position integer;
  new_position integer;
  old_division text;
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
      SELECT id INTO next_target
      FROM public.competitors
      WHERE status = 'upcoming' AND NOT archived AND division = target_division
      ORDER BY position, id
      LIMIT 1;
      IF target <> next_target THEN
        RAISE EXCEPTION 'Competitors must be activated in their division order';
      END IF;
    ELSIF target_status = 'locked' AND NOT EXISTS (
      SELECT 1 FROM public.scoring_windows WHERE competitor_id = target
    ) THEN
      RAISE EXCEPTION 'Only a competitor with an existing scoring window can be reopened';
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
      RAISE EXCEPTION 'Use the division activation control to activate a competitor';
    END IF;
    target_division := p_data->>'division';
    IF target IS NULL AND (
      (SELECT count(*) FROM public.division_judges
        WHERE division = coalesce(target_division, '')) NOT BETWEEN 2 AND 10
      OR NOT EXISTS (SELECT 1 FROM public.division_judges
        WHERE division = coalesce(target_division, '') AND scoring_type = 'technical')
      OR NOT EXISTS (SELECT 1 FROM public.division_judges
        WHERE division = coalesce(target_division, '') AND scoring_type = 'performance')
    ) THEN
      RAISE EXCEPTION 'Finalize a valid 2–10 judge division roster, including Technical and Performance, before adding a competitor';
    END IF;
    IF old_data->>'division' IS DISTINCT FROM target_division
      AND EXISTS (SELECT 1 FROM public.competitor_judges WHERE competitor_id = target) THEN
      RAISE EXCEPTION 'A division cannot be changed after its official judge roster is snapshotted';
    END IF;

    old_position := (old_data->>'position')::integer;
    old_division := old_data->>'division';
    new_position := (p_data->>'position')::integer;
    IF old_position IS NULL THEN
      UPDATE public.competitors SET position = position + 1
      WHERE division = target_division AND position >= new_position;
    ELSIF old_division IS DISTINCT FROM target_division THEN
      UPDATE public.competitors SET position = position - 1
      WHERE division = old_division AND position > old_position;
      UPDATE public.competitors SET position = position + 1
      WHERE division = target_division AND position >= new_position;
    ELSIF new_position < old_position THEN
      UPDATE public.competitors SET position = position + 1
      WHERE division = target_division AND position >= new_position AND position < old_position;
    ELSIF new_position > old_position THEN
      UPDATE public.competitors SET position = position - 1
      WHERE division = target_division AND position > old_position AND position <= new_position;
    END IF;

    INSERT INTO public.competitors(id, name, division, position, status, dq, archived)
    VALUES (
      coalesce(target, gen_random_uuid()), p_data->>'name', target_division,
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

CREATE OR REPLACE FUNCTION public.delete_competitor(p_actor uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  old_data jsonb;
  old_position integer;
  old_division text;
  deleted_submission_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active AND (role = 'server_admin' OR is_admin)
  ) THEN
    RAISE EXCEPTION 'Organizer required';
  END IF;

  PERFORM pg_advisory_xact_lock(2026);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  SELECT to_jsonb(c), c.position, c.division
    INTO old_data, old_position, old_division
  FROM public.competitors c WHERE c.id = p_id FOR UPDATE;
  IF old_data IS NULL THEN RAISE EXCEPTION 'Competitor not found'; END IF;

  SELECT count(*)::integer INTO deleted_submission_count
  FROM public.submissions WHERE competitor_id = p_id;
  INSERT INTO public.audit(user_id, competitor_id, action, prior, next)
  VALUES (
    p_actor, p_id, 'competitor_delete',
    old_data || jsonb_build_object(
      'deleted_submission_count', deleted_submission_count,
      'deleted_at', transaction_timestamp()
    ),
    NULL
  );
  DELETE FROM public.submissions WHERE competitor_id = p_id;
  DELETE FROM public.competitors WHERE id = p_id;
  UPDATE public.competitors SET position = position - 1
  WHERE division = old_division AND position > old_position;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_competitor(uuid, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_competitor(uuid, uuid)
  TO service_role;

COMMIT;
