BEGIN;

-- Install the new event modifier as a versioned global scoring-rule change.
-- Older events have no execution property and remain E0 / Normal in the scorer.
WITH prior AS MATERIALIZED (
  SELECT config_id, revision, rules
  FROM public.scoring_configuration
  WHERE config_id = 'global'
  FOR UPDATE
), updated AS (
  UPDATE public.scoring_configuration AS config
  SET rules = jsonb_set(
        prior.rules,
        '{executions}',
        '{"E0":1,"E-1":0.9,"E-2":0.8,"E-3":0.7}'::jsonb,
        true
      ),
      revision = config.revision + 1,
      updated_by = NULL,
      updated_at = now()
  FROM prior
  WHERE config.config_id = prior.config_id
    AND prior.rules->'executions' IS DISTINCT FROM '{"E0":1,"E-1":0.9,"E-2":0.8,"E-3":0.7}'::jsonb
  RETURNING config.revision, config.rules, config.updated_at
)
INSERT INTO public.audit(user_id, action, prior, next)
SELECT
  NULL,
  'scoring_configuration_update',
  jsonb_build_object('revision', prior.revision, 'rules', prior.rules),
  jsonb_build_object(
    'revision', updated.revision,
    'rules', updated.rules,
    'affected_rules', jsonb_build_array('execution:E0', 'execution:E-1', 'execution:E-2', 'execution:E-3'),
    'recalculation', jsonb_build_object(
      'performed', true,
      'mode', 'derived_on_read',
      'at', updated.updated_at,
      'reason', 'execution scoring introduced; legacy events default to E0'
    )
  )
FROM prior CROSS JOIN updated;

CREATE OR REPLACE FUNCTION public.update_scoring_configuration(
  p_actor uuid,
  p_expected_revision integer,
  p_expected_data_revision integer,
  p_rules jsonb,
  p_impact jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_config public.scoring_configuration;
  saved_config public.scoring_configuration;
  changed_rules jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_actor AND active
      AND username IN ('organizer', 'alexandertai')
      AND (role = 'server_admin' OR is_admin)
  ) THEN
    RAISE EXCEPTION 'Technical point configuration access denied';
  END IF;

  IF jsonb_typeof(p_rules) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'bases') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'deductions') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'levels') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'features') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_rules->'executions') IS DISTINCT FROM 'object'
     OR NOT (p_rules->'executions' ?& ARRAY['E0', 'E-1', 'E-2', 'E-3']::text[])
     OR EXISTS (
       SELECT 1
       FROM jsonb_each(p_rules->'executions') AS execution(key, value)
       WHERE execution.key NOT IN ('E0', 'E-1', 'E-2', 'E-3')
         OR jsonb_typeof(execution.value) <> 'number'
         OR (execution.value::text)::numeric < 0.01
         OR (execution.value::text)::numeric > 100
     )
     OR jsonb_typeof(p_impact) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid technical point configuration';
  END IF;

  SELECT * INTO current_config
  FROM public.scoring_configuration
  WHERE config_id = 'global'
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
    UNION ALL
    SELECT 'execution:' || entry.key, entry.value
    FROM jsonb_each(current_config.rules->'executions') AS entry
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
    UNION ALL
    SELECT 'execution:' || entry.key, entry.value
    FROM jsonb_each(p_rules->'executions') AS entry
  )
  SELECT COALESCE(
    jsonb_agg(COALESCE(old.rule_key, new.rule_key) ORDER BY COALESCE(old.rule_key, new.rule_key)),
    '[]'::jsonb
  )
  INTO changed_rules
  FROM old_values AS old
  FULL OUTER JOIN new_values AS new USING (rule_key)
  WHERE old.rule_value IS DISTINCT FROM new.rule_value;

  UPDATE public.scoring_configuration
  SET rules = p_rules,
      revision = revision + 1,
      updated_by = p_actor,
      updated_at = now()
  WHERE config_id = 'global'
  RETURNING * INTO saved_config;

  INSERT INTO public.audit(user_id, action, prior, next)
  VALUES (
    p_actor,
    'scoring_configuration_update',
    jsonb_build_object('revision', current_config.revision, 'rules', current_config.rules),
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
