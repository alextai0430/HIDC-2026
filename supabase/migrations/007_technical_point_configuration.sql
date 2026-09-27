BEGIN;

CREATE TABLE public.scoring_configuration (
  config_id text PRIMARY KEY CHECK (config_id = 'global'),
  revision integer NOT NULL CHECK (revision > 0),
  data_revision integer NOT NULL DEFAULT 1 CHECK (data_revision > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.scoring_configuration(config_id, revision, rules)
VALUES (
  'global',
  1,
  '{
    "bases": {
      "#": {"2D": 0.7, "3D": 6, "4D": 15},
      "T": {"1D": 0.1, "2D": 1, "3D": 6, "4D": 12, "VD": 0.2},
      "O": {"1D": 0.2, "2D": 1.2, "3D": 4, "4D": 8, "VD": 0.5},
      "F": {"2D": 1.5, "3D": 5, "4D": 10},
      "S": {"1D": 0.1, "2D": 1, "3D": 6, "4D": 12, "VD": 0.2},
      "W": {"1D": 0.2, "VD": 0.4},
      "R": {"1D": 0.4, "2D": 1.2, "3D": 6, "4D": 12, "VD": 1}
    },
    "deductions": {
      "Unintentional Drop": -0.3,
      "Tangle": -0.5,
      "Time Violation": -2,
      "Other Rule Violation": -2
    },
    "levels": {"0.5": 0.5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10},
    "features": {"T1": 1.7, "T2": 3, "T3": 5, "A": 1.7}
  }'::jsonb
);

ALTER TABLE public.scoring_configuration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoring_configuration FROM anon, authenticated;
GRANT ALL ON public.scoring_configuration TO service_role;

CREATE OR REPLACE FUNCTION public.bump_scoring_data_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE scoring_configuration
  SET data_revision=data_revision+1
  WHERE config_id='global';
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER submissions_bump_scoring_data_revision
AFTER INSERT OR UPDATE OR DELETE ON public.submissions
FOR EACH ROW EXECUTE FUNCTION public.bump_scoring_data_revision();
CREATE TRIGGER competitors_bump_scoring_data_revision
AFTER INSERT OR UPDATE OR DELETE ON public.competitors
FOR EACH ROW EXECUTE FUNCTION public.bump_scoring_data_revision();

CREATE OR REPLACE FUNCTION public.update_scoring_configuration(
  p_actor uuid,
  p_expected_revision integer,
  p_expected_data_revision integer,
  p_rules jsonb,
  p_impact jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  current_config scoring_configuration;
  saved_config scoring_configuration;
  changed_rules jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id=p_actor AND active
      AND username IN ('organizer', 'alexandertai')
      AND (role='server_admin' OR is_admin)
  ) THEN
    RAISE EXCEPTION 'Technical point configuration access denied';
  END IF;

  IF jsonb_typeof(p_rules) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'bases') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'deductions') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'levels') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'features') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_impact) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid technical point configuration';
  END IF;

  SELECT * INTO current_config
  FROM scoring_configuration
  WHERE config_id='global'
  FOR UPDATE;
  IF current_config.config_id IS NULL THEN
    RAISE EXCEPTION 'Global technical point configuration is missing';
  END IF;
  IF current_config.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Technical point configuration changed; reload before saving';
  END IF;
  IF current_config.data_revision <> p_expected_data_revision THEN
    RAISE EXCEPTION 'Scoring data changed; reload the impact preview before saving';
  END IF;
  IF current_config.rules = p_rules THEN
    RETURN jsonb_build_object(
      'changed', false,
      'revision', current_config.revision,
      'data_revision', current_config.data_revision,
      'rules', current_config.rules,
      'updated_at', current_config.updated_at
    );
  END IF;

  WITH old_values AS (
    SELECT 'base:' || category.key || ':' || dimension.key AS rule_key,
      dimension.value AS rule_value
    FROM jsonb_each(current_config.rules->'bases') AS category
    CROSS JOIN LATERAL jsonb_each(category.value) AS dimension
    UNION ALL
    SELECT 'deduction:' || entry.key, entry.value
    FROM jsonb_each(current_config.rules->'deductions') AS entry
    UNION ALL
    SELECT 'level:' || entry.key, entry.value
    FROM jsonb_each(current_config.rules->'levels') AS entry
    UNION ALL
    SELECT 'feature:' || entry.key, entry.value
    FROM jsonb_each(current_config.rules->'features') AS entry
  ), new_values AS (
    SELECT 'base:' || category.key || ':' || dimension.key AS rule_key,
      dimension.value AS rule_value
    FROM jsonb_each(p_rules->'bases') AS category
    CROSS JOIN LATERAL jsonb_each(category.value) AS dimension
    UNION ALL
    SELECT 'deduction:' || entry.key, entry.value
    FROM jsonb_each(p_rules->'deductions') AS entry
    UNION ALL
    SELECT 'level:' || entry.key, entry.value
    FROM jsonb_each(p_rules->'levels') AS entry
    UNION ALL
    SELECT 'feature:' || entry.key, entry.value
    FROM jsonb_each(p_rules->'features') AS entry
  )
  SELECT COALESCE(jsonb_agg(COALESCE(old.rule_key, new.rule_key) ORDER BY COALESCE(old.rule_key, new.rule_key)), '[]'::jsonb)
  INTO changed_rules
  FROM old_values AS old
  FULL OUTER JOIN new_values AS new USING (rule_key)
  WHERE old.rule_value IS DISTINCT FROM new.rule_value;

  UPDATE scoring_configuration
  SET rules=p_rules, revision=revision+1, updated_by=p_actor, updated_at=now()
  WHERE config_id='global'
  RETURNING * INTO saved_config;

  INSERT INTO audit(user_id, action, prior, next)
  VALUES (
    p_actor,
    'scoring_configuration_update',
    jsonb_build_object(
      'revision', current_config.revision,
      'rules', current_config.rules
    ),
    jsonb_build_object(
      'revision', saved_config.revision,
      'rules', saved_config.rules,
      'affected_rules', changed_rules,
      'impact', p_impact,
      'recalculation', jsonb_build_object(
        'performed', true,
        'mode', 'derived_on_read',
        'at', saved_config.updated_at
      )
    )
  );

  RETURN jsonb_build_object(
    'changed', true,
    'revision', saved_config.revision,
    'data_revision', saved_config.data_revision,
    'rules', saved_config.rules,
    'updated_at', saved_config.updated_at,
    'impact', p_impact
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_scoring_configuration(uuid, integer, integer, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_scoring_configuration(uuid, integer, integer, jsonb, jsonb) TO service_role;

COMMIT;
