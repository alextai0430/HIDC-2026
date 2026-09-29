BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hotkey_preferences jsonb NOT NULL DEFAULT '{"enabled":true,"keys":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS hotkeys_updated_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz;

-- Judges receive roster rows only through the authorized state API. In particular,
-- authenticated clients cannot enumerate future competitors through PostgREST.
DROP POLICY IF EXISTS roster ON public.competitors;
REVOKE SELECT ON public.competitors FROM anon, authenticated;

-- Keep the existing slot column only as a private ordering key. A division can
-- now have up to ten judges without violating the original submissions CHECK.
ALTER TABLE public.submissions DROP CONSTRAINT IF EXISTS submissions_slot_check;
ALTER TABLE public.submissions ADD CONSTRAINT submissions_slot_check CHECK (slot BETWEEN 1 AND 10);

ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS historical_user_id uuid;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS judge_name_snapshot text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS judge_role_snapshot text;
UPDATE public.submissions AS s
SET historical_user_id = coalesce(s.historical_user_id, s.user_id),
    judge_name_snapshot = coalesce(s.judge_name_snapshot, p.name),
    judge_role_snapshot = coalesce(s.judge_role_snapshot, p.role)
FROM public.profiles AS p
WHERE p.id = s.user_id;
ALTER TABLE public.submissions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.submissions DROP CONSTRAINT IF EXISTS submissions_user_id_fkey;
ALTER TABLE public.submissions
  ADD CONSTRAINT submissions_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.operations ADD COLUMN IF NOT EXISTS historical_user_id uuid;
UPDATE public.operations SET historical_user_id = user_id WHERE historical_user_id IS NULL;
ALTER TABLE public.operations ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.operations DROP CONSTRAINT IF EXISTS operations_user_id_fkey;
ALTER TABLE public.operations
  ADD CONSTRAINT operations_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.profiles(id) ON DELETE SET NULL;

-- A competitor's judge roster becomes an immutable event snapshot when the
-- competitor is created. user_id is intentionally not a foreign key: deleting
-- an account must not destroy score attribution or finalized calculations.
CREATE TABLE IF NOT EXISTS public.competitor_judges (
  competitor_id uuid NOT NULL REFERENCES public.competitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  scoring_type text NOT NULL CHECK (scoring_type IN ('technical','performance')),
  -- Current divisions are capped at ten, but legacy competitions may have
  -- historical judges from more than one roster revision.
  roster_order integer NOT NULL CHECK (roster_order > 0),
  display_name text NOT NULL,
  role_snapshot text NOT NULL,
  expected boolean NOT NULL DEFAULT true,
  PRIMARY KEY (competitor_id, user_id),
  UNIQUE (competitor_id, roster_order)
);
ALTER TABLE public.competitor_judges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competitor_judges FROM anon, authenticated;
GRANT ALL ON public.competitor_judges TO service_role;

INSERT INTO public.competitor_judges(competitor_id,user_id,scoring_type,roster_order,display_name,role_snapshot)
SELECT c.id,dj.user_id,coalesce(s.scoring_type,dj.scoring_type),dj.slot,
       coalesce(s.judge_name_snapshot,p.name),coalesce(s.judge_role_snapshot,p.role)
FROM public.competitors AS c
JOIN public.division_judges AS dj ON dj.division=c.division
JOIN public.profiles AS p ON p.id=dj.user_id
LEFT JOIN public.submissions AS s ON s.competitor_id=c.id AND s.historical_user_id=dj.user_id
ON CONFLICT (competitor_id,user_id) DO NOTHING;
-- Preserve scores from a prior roster without allowing their slot to collide
-- with the current division roster. A former judge counts only if already
-- submitted; unfinished departed work remains historical but not expected.
WITH former AS (
  SELECT s.competitor_id,s.historical_user_id,
         coalesce(s.scoring_type,CASE WHEN s.slot<=3 THEN 'technical' ELSE 'performance' END) AS scoring_type,
         coalesce(s.judge_name_snapshot,'Deleted Judge') AS display_name,
         coalesce(s.judge_role_snapshot,'former_judge') AS role_snapshot,
         s.finished,
         coalesce((SELECT max(cj.roster_order) FROM public.competitor_judges cj WHERE cj.competitor_id=s.competitor_id),0)
           + row_number() OVER (PARTITION BY s.competitor_id ORDER BY s.slot,s.historical_user_id) AS roster_order
  FROM public.submissions s
  WHERE s.historical_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.competitor_judges cj WHERE cj.competitor_id=s.competitor_id AND cj.user_id=s.historical_user_id)
)
INSERT INTO public.competitor_judges(competitor_id,user_id,scoring_type,roster_order,display_name,role_snapshot,expected)
SELECT competitor_id,historical_user_id,scoring_type,roster_order,display_name,role_snapshot,finished
FROM former;

-- The published judge group is immutable as soon as a competitor exists in
-- the division. New competitors cannot be added before a complete 2–10 roster.
CREATE OR REPLACE FUNCTION public.snapshot_competitor_judges()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; tech integer; perf integer;
BEGIN
  SELECT count(*)::integer,
         count(*) FILTER (WHERE scoring_type='technical')::integer,
         count(*) FILTER (WHERE scoring_type='performance')::integer
  INTO n,tech,perf FROM public.division_judges WHERE division=NEW.division;
  IF n < 2 OR n > 10 OR tech < 1 OR perf < 1 THEN
    RAISE EXCEPTION 'Set a valid division roster of 2–10 judges, including at least one Technical Judge and one Performance Judge, before adding competitors';
  END IF;
  INSERT INTO public.competitor_judges(competitor_id,user_id,scoring_type,roster_order,display_name,role_snapshot)
  SELECT NEW.id,dj.user_id,dj.scoring_type,dj.slot,p.name,p.role
  FROM public.division_judges AS dj JOIN public.profiles AS p ON p.id=dj.user_id
  WHERE dj.division=NEW.division ORDER BY dj.slot;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_competitor_judges() FROM public,anon,authenticated;
DROP TRIGGER IF EXISTS competitor_judge_snapshot ON public.competitors;
CREATE TRIGGER competitor_judge_snapshot AFTER INSERT ON public.competitors
FOR EACH ROW EXECUTE FUNCTION public.snapshot_competitor_judges();

CREATE OR REPLACE FUNCTION public.prevent_competitor_division_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.division IS DISTINCT FROM OLD.division AND EXISTS (
    SELECT 1 FROM public.competitor_judges WHERE competitor_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'A competitor division cannot change after its official judge roster is snapshotted';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS competitor_division_roster_lock ON public.competitors;
CREATE TRIGGER competitor_division_roster_lock BEFORE UPDATE OF division ON public.competitors
FOR EACH ROW EXECUTE FUNCTION public.prevent_competitor_division_change();

CREATE TABLE IF NOT EXISTS public.scoring_windows (
  revision uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id uuid NOT NULL REFERENCES public.competitors(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS scoring_windows_one_open_per_competitor
  ON public.scoring_windows(competitor_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS public.scoring_window_tokens (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision uuid NOT NULL REFERENCES public.scoring_windows(revision) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES public.competitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS scoring_window_tokens_judge_window_idx
  ON public.scoring_window_tokens(revision,competitor_id,user_id);
-- These reverse lookup indexes support scoring-window checks and cascade cleanup
-- by competitor/account; the composite token uniqueness index alone cannot serve
-- predicates that start with user_id or competitor_id.
CREATE INDEX IF NOT EXISTS scoring_windows_competitor_id_idx
  ON public.scoring_windows(competitor_id);
CREATE INDEX IF NOT EXISTS scoring_window_tokens_competitor_id_idx
  ON public.scoring_window_tokens(competitor_id);
CREATE INDEX IF NOT EXISTS scoring_window_tokens_user_id_idx
  ON public.scoring_window_tokens(user_id);
ALTER TABLE public.scoring_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scoring_window_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoring_windows,public.scoring_window_tokens FROM anon,authenticated;
GRANT ALL ON public.scoring_windows,public.scoring_window_tokens TO service_role;

-- Realtime carries only a timestamp change; clients must refetch authorized
-- state instead of receiving competitor rows or score payloads.
DROP TRIGGER IF EXISTS competitor_signal ON public.competitors;
CREATE TRIGGER competitor_signal AFTER INSERT OR UPDATE OR DELETE ON public.competitors
FOR EACH STATEMENT EXECUTE FUNCTION public.signal_change();

-- One-time bootstrap windows for legacy currently-active competitors.
INSERT INTO public.scoring_windows(competitor_id)
SELECT id FROM public.competitors WHERE status='active' AND NOT archived
ON CONFLICT DO NOTHING;
-- Legacy activated competitors have placeholder submissions but no window
-- record. Preserve their eligibility for an explicit organizer reopen while
-- keeping future competitors (which have no submissions) ineligible.
INSERT INTO public.scoring_windows(competitor_id,opened_at,closed_at)
SELECT c.id,min(s.updated_at),max(s.updated_at)
FROM public.competitors c JOIN public.submissions s ON s.competitor_id=c.id
WHERE c.status<>'active' AND NOT c.archived
GROUP BY c.id;

CREATE OR REPLACE FUNCTION public.issue_scoring_window(p_user uuid,p_competitor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.scoring_windows; token_value uuid;
BEGIN
  SELECT * INTO w FROM public.scoring_windows
  WHERE competitor_id=p_competitor AND closed_at IS NULL;
  IF w.revision IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.competitors c
    JOIN public.competitor_judges cj ON cj.competitor_id=c.id AND cj.user_id=p_user AND cj.expected
    JOIN public.profiles p ON p.id=p_user AND p.active AND NOT p.archived
    WHERE c.id=p_competitor AND c.status='active' AND NOT c.archived
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.scoring_window_tokens(revision,competitor_id,user_id)
  VALUES(w.revision,p_competitor,p_user)
  ON CONFLICT(revision,competitor_id,user_id) DO NOTHING
  RETURNING token INTO token_value;
  IF token_value IS NULL THEN
    SELECT t.token INTO token_value FROM public.scoring_window_tokens t
    WHERE t.revision=w.revision AND t.competitor_id=p_competitor AND t.user_id=p_user;
  END IF;
  RETURN jsonb_build_object('competitor_id',p_competitor,'revision',w.revision,
    'token',token_value,'opened_at',w.opened_at);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_scoring_window(uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.issue_scoring_window(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.manage_judge_assignments(p_actor uuid,p_division text,p_assignments jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; target uuid; target_order integer; target_type text; n integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND role='organizer') THEN RAISE EXCEPTION 'Organizer required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.divisions WHERE name=p_division) THEN RAISE EXCEPTION 'Division unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM public.competitors WHERE division=p_division) THEN
    RAISE EXCEPTION 'This division roster is locked because competitors already exist';
  END IF;
  IF jsonb_typeof(p_assignments)<>'array' THEN RAISE EXCEPTION 'Assignments must be a list'; END IF;
  n:=jsonb_array_length(p_assignments);
  IF n<2 OR n>10 THEN RAISE EXCEPTION 'Assign between two and ten judges'; END IF;
  IF (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_assignments))<>n
     OR (SELECT count(DISTINCT (value->>'slot')::integer) FROM jsonb_array_elements(p_assignments))<>n
     OR (SELECT min((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments))<>1
     OR (SELECT max((value->>'slot')::integer) FROM jsonb_array_elements(p_assignments))<>n THEN
    RAISE EXCEPTION 'Choose a different judge for each assignment';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type'='technical')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_assignments) WHERE value->>'scoring_type'='performance') THEN
    RAISE EXCEPTION 'Assign at least one Technical Judge and one Performance Judge';
  END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    LEFT JOIN public.profiles p ON p.id=(a.value->>'user_id')::uuid
    WHERE p.id IS NULL OR NOT p.active OR p.archived
      OR a.value->>'scoring_type' NOT IN ('technical','performance')
      OR (p.role='technical_judge' AND a.value->>'scoring_type'<>'technical')
      OR (p.role='performance_judge' AND a.value->>'scoring_type'<>'performance')
      OR p.role NOT IN ('technical_judge','performance_judge','organizer')
  ) THEN RAISE EXCEPTION 'Select active accounts whose role matches the scoring group'; END IF;
  DELETE FROM public.division_judges WHERE division=p_division;
  FOR item IN SELECT value FROM jsonb_array_elements(p_assignments) ORDER BY (value->>'slot')::integer LOOP
    target:=(item->>'user_id')::uuid; target_order:=(item->>'slot')::integer; target_type:=item->>'scoring_type';
    INSERT INTO public.division_judges(division,slot,user_id,scoring_type) VALUES(p_division,target_order,target,target_type);
  END LOOP;
  INSERT INTO public.audit(user_id,action,next) VALUES(p_actor,'judge_assignments',jsonb_build_object('division',p_division,'assignments',p_assignments));
END;
$$;
REVOKE ALL ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_judge_assignments(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.apply_score(
  p_user uuid,p_slot integer,p_id uuid,p_competitor uuid,p_version integer,p_kind text,p_payload jsonb,
  p_window_revision uuid,p_window_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE saved public.submissions; c public.competitors; account public.profiles;
        judge public.competitor_judges; w public.scoring_windows; before_data jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_competitor::text,0));
  IF EXISTS(SELECT 1 FROM public.operations WHERE id=p_id AND historical_user_id=p_user) THEN
    SELECT * INTO saved FROM public.submissions WHERE competitor_id=p_competitor AND historical_user_id=p_user;
    RETURN jsonb_build_object('duplicate',true,'version',coalesce(saved.version,0));
  END IF;
  SELECT * INTO account FROM public.profiles WHERE id=p_user AND active AND NOT archived;
  IF account.id IS NULL THEN RAISE EXCEPTION 'Account is inactive or was deleted'; END IF;
  SELECT * INTO c FROM public.competitors WHERE id=p_competitor FOR UPDATE;
  IF c.id IS NULL OR c.archived THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
  SELECT * INTO judge FROM public.competitor_judges WHERE competitor_id=p_competitor AND user_id=p_user AND expected;
  IF judge.user_id IS NULL THEN RAISE EXCEPTION 'You are not assigned to this competitor division'; END IF;
  IF p_kind IN ('put_event','delete_event') AND judge.scoring_type<>'technical' THEN RAISE EXCEPTION 'Technical Judge assignment required'; END IF;
  IF p_kind='performance' AND judge.scoring_type<>'performance' THEN RAISE EXCEPTION 'Performance Judge assignment required'; END IF;
  SELECT * INTO w FROM public.scoring_windows WHERE revision=p_window_revision AND competitor_id=p_competitor;
  IF w.revision IS NULL OR p_window_token IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.scoring_window_tokens t WHERE t.token=p_window_token AND t.revision=w.revision
      AND t.competitor_id=p_competitor AND t.user_id=p_user
  ) THEN RAISE EXCEPTION 'Scoring window authorization is missing or invalid. Keep this action queued and reconnect to reconcile it.'; END IF;
  -- A browser/device timestamp cannot prove when an offline edit occurred.
  -- Accept queue items only under the currently open server-side window.
  IF c.status<>'active' OR w.closed_at IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM public.scoring_windows current_window
    WHERE current_window.competitor_id=p_competitor AND current_window.revision=w.revision
      AND current_window.closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Scoring window closed. This offline work remains saved on this device. Ask the Organizer to reopen this competitor, then explicitly reconcile the saved work.';
  END IF;
  SELECT * INTO saved FROM public.submissions WHERE competitor_id=p_competitor AND historical_user_id=p_user FOR UPDATE;
  IF saved.id IS NULL THEN
    INSERT INTO public.submissions(competitor_id,user_id,historical_user_id,judge_name_snapshot,judge_role_snapshot,slot,scoring_type)
    VALUES(p_competitor,p_user,p_user,judge.display_name,judge.role_snapshot,judge.roster_order,judge.scoring_type) RETURNING * INTO saved;
  END IF;
  IF saved.scoring_type IS DISTINCT FROM judge.scoring_type THEN RAISE EXCEPTION 'Saved submission scoring group does not match the official roster'; END IF;
  IF saved.version<>p_version THEN RAISE EXCEPTION 'Version conflict: reload server copy before retrying'; END IF;
  IF saved.finished THEN RAISE EXCEPTION 'Submission is already submitted; ask the Organizer to reopen the competitor'; END IF;
  IF p_kind='finish' AND (p_payload->>'finished')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Only an Organizer can reopen a submitted score'; END IF;
  before_data:=to_jsonb(saved);
  IF p_kind='put_event' THEN
    -- Use server receipt time for the official sequence. Client event timestamps
    -- remain local-only metadata and never authorize late edits.
    saved.events:=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS x(value,ord) WHERE value->>'id'<>p_payload->>'id')
      ||jsonb_build_array(p_payload||jsonb_build_object('at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
  ELSIF p_kind='delete_event' THEN
    saved.events:=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(saved.events) WITH ORDINALITY AS x(value,ord) WHERE value->>'id'<>p_payload->>'id');
  ELSIF p_kind='performance' THEN saved.performance:=p_payload->'values';
  ELSIF p_kind='finish' THEN saved.finished:=true;
  ELSIF p_kind='dq' THEN saved.dq:=(p_payload->>'dq')::boolean;
  ELSE RAISE EXCEPTION 'Invalid operation'; END IF;
  saved.events:=(SELECT coalesce(jsonb_agg(value ORDER BY value->>'at'),'[]'::jsonb) FROM jsonb_array_elements(saved.events));
  UPDATE public.submissions SET events=saved.events,performance=saved.performance,finished=saved.finished,dq=saved.dq,
    version=version+1,submitted_at=CASE WHEN saved.finished THEN coalesce(submitted_at,now()) ELSE submitted_at END,updated_at=now()
  WHERE id=saved.id;
  INSERT INTO public.operations(id,user_id,historical_user_id) VALUES(p_id,p_user,p_user);
  INSERT INTO public.audit(user_id,competitor_id,action,prior,next)
  VALUES(p_user,p_competitor,p_kind,before_data,(SELECT to_jsonb(s) FROM public.submissions s WHERE s.id=saved.id));
  RETURN jsonb_build_object('ok',true,'version',saved.version+1);
END;
$$;
DROP FUNCTION IF EXISTS public.apply_score(uuid,integer,uuid,uuid,integer,text,jsonb);
REVOKE ALL ON FUNCTION public.apply_score(uuid,integer,uuid,uuid,integer,text,jsonb,uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score(uuid,integer,uuid,uuid,integer,text,jsonb,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.manage_competitor(p_actor uuid,p_action text,p_data jsonb,p_development boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old_data jsonb; target uuid; old_position integer; new_position integer; target_division text; target_status text; next_target uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(2026);
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND role='organizer') THEN RAISE EXCEPTION 'Organizer required'; END IF;
  target:=(p_data->>'id')::uuid;
  SELECT to_jsonb(c) INTO old_data FROM public.competitors c WHERE id=target;
  IF p_action='activate' THEN
    SELECT status,division INTO target_status,target_division FROM public.competitors WHERE id=target AND NOT archived;
    IF target_status IS NULL THEN RAISE EXCEPTION 'Competitor unavailable'; END IF;
    IF target_status='upcoming' THEN
      SELECT id INTO next_target FROM public.competitors WHERE status='upcoming' AND NOT archived ORDER BY position LIMIT 1;
      IF target<>next_target THEN RAISE EXCEPTION 'Competitors must be activated in performance order'; END IF;
    ELSIF target_status='locked' AND NOT EXISTS (
      SELECT 1 FROM public.scoring_windows WHERE competitor_id=target
    ) THEN
      RAISE EXCEPTION 'Only the next competitor in performance order can be started';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.competitor_judges WHERE competitor_id=target AND expected) THEN RAISE EXCEPTION 'This competitor has no finalized judge roster'; END IF;
    UPDATE public.scoring_windows SET closed_at=clock_timestamp() WHERE closed_at IS NULL;
    UPDATE public.competitors SET status='locked' WHERE status='active';
    UPDATE public.competitors SET status='active' WHERE id=target AND NOT archived;
    INSERT INTO public.scoring_windows(competitor_id) VALUES(target);
    INSERT INTO public.submissions(competitor_id,user_id,historical_user_id,judge_name_snapshot,judge_role_snapshot,slot,scoring_type)
      SELECT target,cj.user_id,cj.user_id,cj.display_name,cj.role_snapshot,cj.roster_order,cj.scoring_type
      FROM public.competitor_judges cj JOIN public.profiles p ON p.id=cj.user_id AND p.active AND NOT p.archived
      WHERE cj.competitor_id=target AND cj.expected ON CONFLICT(competitor_id,user_id) DO UPDATE
      SET finished=false,submitted_at=NULL,version=public.submissions.version+1,updated_at=clock_timestamp();
  ELSIF p_action='save' THEN
    IF p_data->>'status'='active' AND coalesce(old_data->>'status','')<>'active' THEN RAISE EXCEPTION 'Use the floor advance control to activate a competitor'; END IF;
    IF target IS NULL AND (
      (SELECT count(*) FROM public.division_judges WHERE division=coalesce(p_data->>'division','')) NOT BETWEEN 2 AND 10
      OR NOT EXISTS(SELECT 1 FROM public.division_judges WHERE division=coalesce(p_data->>'division','') AND scoring_type='technical')
      OR NOT EXISTS(SELECT 1 FROM public.division_judges WHERE division=coalesce(p_data->>'division','') AND scoring_type='performance')
    ) THEN
      RAISE EXCEPTION 'Assign and save a valid 2–10 judge division roster, including Technical and Performance, before adding a competitor';
    END IF;
    IF old_data->>'division' IS DISTINCT FROM p_data->>'division' AND EXISTS(SELECT 1 FROM public.competitor_judges WHERE competitor_id=target) THEN
      RAISE EXCEPTION 'A division cannot be changed after its official judge roster is snapshotted';
    END IF;
    old_position:=(old_data->>'position')::integer; new_position:=(p_data->>'position')::integer;
    IF old_position IS NULL THEN UPDATE public.competitors SET position=position+1 WHERE position>=new_position;
    ELSIF new_position<old_position THEN UPDATE public.competitors SET position=position+1 WHERE position>=new_position AND position<old_position;
    ELSIF new_position>old_position THEN UPDATE public.competitors SET position=position-1 WHERE position>old_position AND position<=new_position; END IF;
    INSERT INTO public.competitors(id,name,division,position,status,dq,archived)
    VALUES(coalesce(target,gen_random_uuid()),p_data->>'name',p_data->>'division',new_position,coalesce(p_data->>'status','upcoming'),coalesce((p_data->>'dq')::boolean,false),coalesce((p_data->>'archived')::boolean,false))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,division=excluded.division,position=excluded.position,status=excluded.status,dq=excluded.dq,archived=excluded.archived RETURNING id INTO target;
  ELSIF p_action='lock' THEN
    UPDATE public.competitors SET status='locked' WHERE id=target;
    UPDATE public.scoring_windows SET closed_at=clock_timestamp() WHERE competitor_id=target AND closed_at IS NULL;
  ELSE RAISE EXCEPTION 'Unknown roster action'; END IF;
  INSERT INTO public.audit(user_id,competitor_id,action,prior,next) VALUES(p_actor,target,p_action,old_data,(SELECT to_jsonb(c) FROM public.competitors c WHERE id=target));
END;
$$;
REVOKE ALL ON FUNCTION public.manage_competitor(uuid,text,jsonb,boolean) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_competitor(uuid,text,jsonb,boolean) TO service_role;

-- A global reopen is the same organizer-controlled floor operation as activate:
-- it rotates the window and unlocks every assigned judge's saved submission.
CREATE OR REPLACE FUNCTION public.review_submission(p_actor uuid,p_id uuid,p_version integer,p_finished boolean,p_dq boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.submissions;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND role='organizer') THEN RAISE EXCEPTION 'Organizer access required'; END IF;
  SELECT * INTO s FROM public.submissions WHERE id=p_id FOR UPDATE;
  IF s.id IS NULL OR s.version<>p_version THEN RAISE EXCEPTION 'Version conflict: refresh this submission'; END IF;
  IF p_finished=false THEN RAISE EXCEPTION 'Reopen the competitor globally from Floor Control'; END IF;
  UPDATE public.submissions SET finished=true,dq=p_dq,version=version+1,submitted_at=coalesce(submitted_at,now()),updated_at=now() WHERE id=p_id;
  INSERT INTO public.audit(user_id,competitor_id,action,prior,next) VALUES(p_actor,s.competitor_id,'admin_review',to_jsonb(s),(SELECT to_jsonb(x) FROM public.submissions x WHERE id=p_id));
END;
$$;
REVOKE ALL ON FUNCTION public.review_submission(uuid,uuid,integer,boolean,boolean) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_submission(uuid,uuid,integer,boolean,boolean) TO service_role;

-- Deletion is two-phase only to allow private avatar cleanup before the Auth
-- deletion. The AFTER-trigger work below is in the same transaction as auth.users
-- deletion; a missing pending row aborts it.
CREATE TABLE IF NOT EXISTS public.pending_judge_deletions (
  target_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  prior_active boolean NOT NULL,
  prior_assignments jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.pending_judge_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_judge_deletions FROM anon,authenticated;
GRANT ALL ON public.pending_judge_deletions TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_judge_deletion(p_actor uuid,p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.profiles; active_organizers integer; assignments jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor AND active AND role='organizer') THEN RAISE EXCEPTION 'Organizer access required'; END IF;
  SELECT * INTO target FROM public.profiles WHERE id=p_target FOR UPDATE;
  IF target.id IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF lower(target.username)='alexandertai' THEN RAISE EXCEPTION 'alexandertai is the protected full-access Organizer account'; END IF;
  IF target.role='organizer' AND target.active THEN
    SELECT count(*)::integer INTO active_organizers FROM public.profiles WHERE role='organizer' AND active;
    IF active_organizers<=1 THEN RAISE EXCEPTION 'At least one active Organizer account must remain'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(dj) ORDER BY dj.division,dj.slot),'[]'::jsonb) INTO assignments
  FROM public.division_judges dj WHERE dj.user_id=p_target;
  INSERT INTO public.pending_judge_deletions(target_id,actor_id,prior_active,prior_assignments)
  VALUES(p_target,p_actor,target.active,assignments)
  ON CONFLICT(target_id) DO UPDATE SET actor_id=excluded.actor_id,prior_active=excluded.prior_active,prior_assignments=excluded.prior_assignments,created_at=clock_timestamp();
  UPDATE public.profiles SET active=false WHERE id=p_target;
  DELETE FROM public.division_judges WHERE user_id=p_target;
  DELETE FROM public.scoring_window_tokens WHERE user_id=p_target;
  RETURN jsonb_build_object('avatar_path',target.avatar_path,'username',target.username,'role',target.role);
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_judge_deletion(uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_judge_deletion(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_judge_deletion(p_actor uuid,p_target uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pending public.pending_judge_deletions; assignment jsonb;
BEGIN
  SELECT * INTO pending FROM public.pending_judge_deletions WHERE target_id=p_target AND actor_id=p_actor FOR UPDATE;
  IF pending.target_id IS NULL THEN RETURN; END IF;
  UPDATE public.profiles SET active=pending.prior_active WHERE id=p_target;
  FOR assignment IN SELECT value FROM jsonb_array_elements(pending.prior_assignments) LOOP
    INSERT INTO public.division_judges(division,slot,user_id,scoring_type)
    VALUES(assignment->>'division',(assignment->>'slot')::integer,p_target,assignment->>'scoring_type')
    ON CONFLICT(division,slot) DO NOTHING;
  END LOOP;
  DELETE FROM public.pending_judge_deletions WHERE target_id=p_target;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_judge_deletion(uuid,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_judge_deletion(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.preserve_scores_on_auth_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pending public.pending_judge_deletions; target_profile public.profiles;
BEGIN
  SELECT * INTO pending FROM public.pending_judge_deletions WHERE target_id=OLD.id FOR UPDATE;
  IF pending.target_id IS NULL THEN RAISE EXCEPTION 'Organizer must confirm permanent account deletion first'; END IF;
  SELECT * INTO target_profile FROM public.profiles WHERE id=OLD.id FOR UPDATE;
  UPDATE public.submissions SET historical_user_id=OLD.id,
    judge_name_snapshot=coalesce(judge_name_snapshot,target_profile.name,'Deleted Judge'),
    judge_role_snapshot=coalesce(judge_role_snapshot,target_profile.role,'former_judge'),user_id=NULL
  WHERE user_id=OLD.id;
  UPDATE public.operations SET historical_user_id=OLD.id,user_id=NULL WHERE user_id=OLD.id;
  UPDATE public.competitor_judges SET expected=false
  WHERE user_id=OLD.id AND NOT EXISTS(
    SELECT 1 FROM public.submissions s WHERE s.competitor_id=competitor_judges.competitor_id
      AND s.historical_user_id=OLD.id AND s.finished
  );
  DELETE FROM public.audit a WHERE a.action IN ('account_create','account_update','account_role_change','account_archive','account_reactivate','account_delete','account_delete_failed')
    AND (a.prior::text LIKE '%'||OLD.id::text||'%' OR a.next::text LIKE '%'||OLD.id::text||'%'
      OR a.prior::text LIKE '%'||target_profile.username||'%' OR a.next::text LIKE '%'||target_profile.username||'%');
  UPDATE public.audit SET user_id=NULL WHERE user_id=OLD.id;
  DELETE FROM public.profiles WHERE id=OLD.id;
  DELETE FROM public.pending_judge_deletions WHERE target_id=OLD.id;
  INSERT INTO public.audit(user_id,action,prior,next) VALUES(pending.actor_id,'account_permanently_deleted',NULL,'{}'::jsonb);
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS preserve_scores_on_auth_delete ON auth.users;
CREATE TRIGGER preserve_scores_on_auth_delete BEFORE DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.preserve_scores_on_auth_delete();
REVOKE ALL ON FUNCTION public.preserve_scores_on_auth_delete() FROM public,anon,authenticated;

-- RLS helpers evaluate auth.uid() once per statement while retaining the same
-- semantics. There is intentionally no direct competitor SELECT policy.
DROP POLICY IF EXISTS own_profile ON public.profiles;
CREATE POLICY own_profile ON public.profiles FOR SELECT TO authenticated USING (id=(SELECT auth.uid()));
DROP POLICY IF EXISTS division_read ON public.divisions;
CREATE POLICY division_read ON public.divisions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id=(SELECT auth.uid()) AND active));
DROP POLICY IF EXISTS live_read ON public.live_signal;
CREATE POLICY live_read ON public.live_signal FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id=(SELECT auth.uid()) AND active));

CREATE INDEX IF NOT EXISTS competitors_division_position_idx ON public.competitors(division,position);
CREATE INDEX IF NOT EXISTS division_judges_user_id_idx ON public.division_judges(user_id);
CREATE INDEX IF NOT EXISTS submissions_user_id_idx ON public.submissions(user_id);
CREATE INDEX IF NOT EXISTS submissions_historical_user_id_idx ON public.submissions(historical_user_id);
CREATE INDEX IF NOT EXISTS operations_user_id_idx ON public.operations(user_id);
CREATE INDEX IF NOT EXISTS operations_historical_user_id_idx ON public.operations(historical_user_id);
CREATE INDEX IF NOT EXISTS competitor_judges_user_id_idx ON public.competitor_judges(user_id,competitor_id);
CREATE INDEX IF NOT EXISTS scoring_configuration_updated_by_idx ON public.scoring_configuration(updated_by);

COMMIT;
