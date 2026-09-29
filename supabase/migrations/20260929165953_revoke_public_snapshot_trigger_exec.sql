BEGIN;

-- Trigger functions must not be callable through the exposed PostgREST RPC API.
REVOKE ALL ON FUNCTION public.snapshot_competitor_judges() FROM public,anon,authenticated;

COMMIT;
