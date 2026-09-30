BEGIN;

-- Associate idempotency receipts with their competitor so division removal can
-- delete only operations from that division. This is additive; it does not
-- change or remove existing operation receipts.
ALTER TABLE public.operations
  ADD COLUMN IF NOT EXISTS competitor_id uuid;
ALTER TABLE public.operations
  DROP CONSTRAINT IF EXISTS operations_competitor_id_fkey;
ALTER TABLE public.operations
  ADD CONSTRAINT operations_competitor_id_fkey
  FOREIGN KEY (competitor_id) REFERENCES public.competitors(id) ON DELETE CASCADE;

-- Older receipts and their audit rows were written in the same transaction.
-- Attach only when matching evidence identifies exactly one competitor;
-- ambiguous legacy receipts remain unattached rather than risking data loss.
WITH candidates AS (
  SELECT o.id, max(a.competitor_id::text)::uuid AS competitor_id
  FROM public.operations o
  JOIN public.audit a
    ON a.created_at = o.created_at
   AND (
     a.user_id = coalesce(o.historical_user_id, o.user_id)
     OR a.prior->>'historical_user_id' = coalesce(o.historical_user_id, o.user_id)::text
     OR a.next->>'historical_user_id' = coalesce(o.historical_user_id, o.user_id)::text
     OR a.prior->>'user_id' = coalesce(o.historical_user_id, o.user_id)::text
     OR a.next->>'user_id' = coalesce(o.historical_user_id, o.user_id)::text
   )
  WHERE o.competitor_id IS NULL
    AND a.competitor_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.competitors c WHERE c.id = a.competitor_id)
    AND a.action IN ('put_event', 'delete_event', 'performance', 'finish', 'dq')
  GROUP BY o.id
  HAVING count(DISTINCT a.competitor_id) = 1
)
UPDATE public.operations o
SET competitor_id = c.competitor_id
FROM candidates c
WHERE c.id = o.id;

CREATE INDEX IF NOT EXISTS operations_competitor_id_idx
  ON public.operations(competitor_id);

-- Preserve active-window authorization and scoring validation while associating
-- every new idempotency receipt with the competitor that produced it.
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
    saved.performance := p_payload->'values';
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

-- Permanent deletion of one division only. Competitor, submission, roster,
-- scoring-window, token, audit and idempotency rows are removed transactionally;
-- accounts and all rows for other divisions remain untouched. Configuration is
-- global in this schema, so no global scoring rules are changed here.
CREATE OR REPLACE FUNCTION public.delete_division(
  p_actor uuid, p_division text, p_confirmation text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  competitor_ids uuid[];
  competitor_count integer;
  submission_count integer;
  submitted_count integer;
  active_cleared boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active AND role = 'organizer'
  ) THEN
    RAISE EXCEPTION 'Organizer access required';
  END IF;
  IF p_division IS NULL OR length(btrim(p_division)) = 0
     OR p_confirmation IS NULL
     OR p_confirmation NOT IN (p_division, 'DELETE DIVISION') THEN
    RAISE EXCEPTION 'Type the exact division name or DELETE DIVISION to confirm permanent deletion';
  END IF;

  PERFORM pg_advisory_xact_lock(2026);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_division, 0));
  PERFORM 1 FROM public.divisions WHERE name = p_division FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Division not found'; END IF;

  SELECT coalesce(array_agg(id), '{}'::uuid[])
  INTO competitor_ids
  FROM public.competitors
  WHERE division = p_division;
  competitor_count := coalesce(cardinality(competitor_ids), 0);
  SELECT count(*)::integer,
         count(*) FILTER (WHERE finished)::integer
  INTO submission_count, submitted_count
  FROM public.submissions
  WHERE competitor_id = ANY(competitor_ids);
  SELECT EXISTS (
    SELECT 1 FROM public.competitors
    WHERE id = ANY(competitor_ids) AND status = 'active'
  ) INTO active_cleared;

  DELETE FROM public.audit WHERE competitor_id = ANY(competitor_ids);
  DELETE FROM public.audit
  WHERE action IN ('division_create', 'judge_assignments')
    AND coalesce(next->>'name', next->>'division', prior->>'name', prior->>'division') = p_division;
  DELETE FROM public.submissions WHERE competitor_id = ANY(competitor_ids);
  DELETE FROM public.operations WHERE competitor_id = ANY(competitor_ids);
  DELETE FROM public.competitors WHERE id = ANY(competitor_ids);
  DELETE FROM public.divisions WHERE name = p_division;

  -- Signal all connected clients even when this division had no competitor row
  -- (and therefore did not fire the competitors change trigger).
  UPDATE public.live_signal SET changed_at = clock_timestamp() WHERE id;

  INSERT INTO public.audit(user_id, action, prior, next)
  VALUES (
    p_actor,
    'division_permanently_deleted',
    jsonb_build_object(
      'division', p_division,
      'competitors', competitor_count,
      'submissions', submission_count,
      'submitted_scores', submitted_count
    ),
    jsonb_build_object('deleted', true, 'active_competitor_cleared', active_cleared)
  );

  RETURN jsonb_build_object(
    'division', p_division,
    'competitors', competitor_count,
    'submissions', submission_count,
    'submitted_scores', submitted_count,
    'activeCompetitorCleared', active_cleared
  );
END;
$$;
REVOKE ALL ON FUNCTION public.delete_division(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_division(uuid, text, text) TO service_role;

COMMIT;
