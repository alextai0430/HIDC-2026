-- Keep active-account validation in the Realtime read policy without granting
-- judges direct read access to profile rows.
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.hidc_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.active IS TRUE
  );
$$;

REVOKE ALL ON FUNCTION private.hidc_active_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.hidc_active_user() TO authenticated;

DROP POLICY IF EXISTS live_read ON public.live_signal;
CREATE POLICY live_read
ON public.live_signal
FOR SELECT
TO authenticated
USING ((SELECT private.hidc_active_user()));
