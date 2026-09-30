BEGIN;

-- Performance judges only receive visible values when both Admin unlock and
-- Show Points are active. Apply category patches server-side so a masked
-- response can never replace unknown values with placeholders.
CREATE OR REPLACE FUNCTION public.apply_score(
  p_user uuid, p_slot integer, p_id uuid, p_competitor uuid, p_version integer,
  p_kind text, p_payload jsonb, p_window_revision uuid, p_window_token uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved public.submissions;
  c public.competitors;
  account public.profiles;
  judge public.competitor_judges;
  w public.scoring_windows;
  before_data jsonb;
  patch jsonb;
  patch_index integer;
  patch_index_number numeric;
  patch_value numeric;
  patched_indexes integer[] := ARRAY[]::integer[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_competitor::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.operations
    WHERE id = p_id AND historical_user_id = p_user
  ) THEN
    SELECT * INTO saved FROM public.submissions
    WHERE competitor_id = p_competitor AND historical_user_id = p_user;
    RETURN jsonb_build_object('duplicate', true, 'version', coalesce(saved.version, 0));
  END IF;

  SELECT * INTO account FROM public.profiles
  WHERE id = p_user AND active AND NOT archived;
  IF account.id IS NULL THEN RAISE EXCEPTION 'Account is inactive or was deleted'; END IF;

  SELECT * INTO c FROM public.competitors WHERE id = p_competitor FOR UPDATE;
  IF c.id IS NULL OR c.archived THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;

  SELECT * INTO judge FROM public.competitor_judges
  WHERE competitor_id = p_competitor AND user_id = p_user AND expected;
  IF judge.user_id IS NULL THEN RAISE EXCEPTION 'You are not assigned to this competitor division'; END IF;
  IF p_kind IN ('put_event', 'delete_event') AND judge.scoring_type <> 'technical' THEN
    RAISE EXCEPTION 'Technical Judge assignment required';
  END IF;
  IF p_kind = 'performance' AND judge.scoring_type <> 'performance' THEN
    RAISE EXCEPTION 'Performance Judge assignment required';
  END IF;

  SELECT * INTO w FROM public.scoring_windows
  WHERE revision = p_window_revision AND competitor_id = p_competitor;
  IF w.revision IS NULL OR p_window_token IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.scoring_window_tokens t
    WHERE t.token = p_window_token AND t.revision = w.revision
      AND t.competitor_id = p_competitor AND t.user_id = p_user
  ) THEN
    RAISE EXCEPTION 'Scoring window authorization is missing or invalid. Keep this action queued and reconnect to reconcile it.';
  END IF;

  -- A browser/device timestamp cannot prove when an offline edit occurred.
  -- Accept queued work only under the currently open server-side window.
  IF c.status <> 'active' OR w.closed_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM public.scoring_windows current_window
    WHERE current_window.competitor_id = p_competitor
      AND current_window.revision = w.revision
      AND current_window.closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Scoring window closed. This offline work remains saved on this device. Ask the Organizer to reopen this competitor, then explicitly reconcile the saved work.';
  END IF;

  SELECT * INTO saved FROM public.submissions
  WHERE competitor_id = p_competitor AND historical_user_id = p_user
  FOR UPDATE;
  IF saved.id IS NULL THEN
    INSERT INTO public.submissions(
      competitor_id, user_id, historical_user_id, judge_name_snapshot,
      judge_role_snapshot, slot, scoring_type
    ) VALUES (
      p_competitor, p_user, p_user, judge.display_name,
      judge.role_snapshot, judge.roster_order, judge.scoring_type
    ) RETURNING * INTO saved;
  END IF;
  IF saved.scoring_type IS DISTINCT FROM judge.scoring_type THEN
    RAISE EXCEPTION 'Saved submission scoring group does not match the official roster';
  END IF;
  IF saved.version <> p_version THEN RAISE EXCEPTION 'Version conflict: reload server copy before retrying'; END IF;
  IF saved.finished THEN RAISE EXCEPTION 'Submission is already submitted; ask the Organizer to reopen the competitor'; END IF;
  IF p_kind = 'finish' AND (p_payload->>'finished')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only an Organizer can reopen a submitted score';
  END IF;

  before_data := to_jsonb(saved);
  IF p_kind = 'put_event' THEN
    saved.events := (
      SELECT coalesce(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS x(value, ord)
      WHERE value->>'id' <> p_payload->>'id'
    ) || jsonb_build_array(
      p_payload || jsonb_build_object(
        'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )
    );
  ELSIF p_kind = 'delete_event' THEN
    saved.events := (
      SELECT coalesce(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS x(value, ord)
      WHERE value->>'id' <> p_payload->>'id'
    );
  ELSIF p_kind = 'performance' THEN
    IF jsonb_typeof(p_payload->'patches') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Performance score patch must contain 1–6 category updates';
    END IF;
    IF jsonb_array_length(p_payload->'patches') NOT BETWEEN 1 AND 6 THEN
      RAISE EXCEPTION 'Performance score patch must contain 1–6 category updates';
    END IF;
    IF jsonb_typeof(saved.performance) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Saved Performance score has an invalid six-category structure; no values were changed';
    END IF;
    IF jsonb_array_length(saved.performance) <> 6 THEN
      RAISE EXCEPTION 'Saved Performance score has an invalid six-category structure; no values were changed';
    END IF;
    FOR patch IN SELECT value FROM jsonb_array_elements(p_payload->'patches') LOOP
      IF jsonb_typeof(patch) IS DISTINCT FROM 'object'
        OR jsonb_typeof(patch->'index') IS DISTINCT FROM 'number'
        OR jsonb_typeof(patch->'value') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Each Performance patch requires a numeric category index and score';
      END IF;
      patch_index_number := (patch->>'index')::numeric;
      patch_value := (patch->>'value')::numeric;
      IF patch_index_number <> trunc(patch_index_number)
        OR patch_index_number NOT BETWEEN 0 AND 5
        OR patch_value NOT BETWEEN 0 AND 5
        OR patch_value * 2 <> trunc(patch_value * 2) THEN
        RAISE EXCEPTION 'Performance patch values must use category indexes 0–5 and scores 0–5 in 0.5 increments';
      END IF;
      patch_index := patch_index_number::integer;
      IF patch_index = ANY(patched_indexes) THEN
        RAISE EXCEPTION 'Performance patch contains a duplicate category index';
      END IF;
      patched_indexes := array_append(patched_indexes, patch_index);
      saved.performance := jsonb_set(
        saved.performance,
        ARRAY[patch_index::text],
        to_jsonb(patch_value),
        false
      );
    END LOOP;
  ELSIF p_kind = 'finish' THEN
    saved.finished := true;
  ELSIF p_kind = 'dq' THEN
    saved.dq := (p_payload->>'dq')::boolean;
  ELSE
    RAISE EXCEPTION 'Invalid operation';
  END IF;

  saved.events := (
    SELECT coalesce(jsonb_agg(value ORDER BY value->>'at'), '[]'::jsonb)
    FROM jsonb_array_elements(saved.events)
  );
  UPDATE public.submissions
  SET events = saved.events,
      performance = saved.performance,
      finished = saved.finished,
      dq = saved.dq,
      version = version + 1,
      submitted_at = CASE WHEN saved.finished THEN coalesce(submitted_at, now()) ELSE submitted_at END,
      updated_at = now()
  WHERE id = saved.id;

  INSERT INTO public.operations(id, user_id, historical_user_id, competitor_id)
  VALUES (p_id, p_user, p_user, p_competitor);
  INSERT INTO public.audit(user_id, competitor_id, action, prior, next)
  VALUES (
    p_user, p_competitor, p_kind, before_data,
    (SELECT to_jsonb(s) FROM public.submissions s WHERE s.id = saved.id)
  );
  RETURN jsonb_build_object('ok', true, 'version', saved.version + 1);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_score(uuid, integer, uuid, uuid, integer, text, jsonb, uuid, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score(uuid, integer, uuid, uuid, integer, text, jsonb, uuid, uuid)
  TO service_role;

COMMIT;
