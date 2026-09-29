BEGIN;

-- Competitor rows are exposed only through the authorization-aware state API.
-- RLS does not apply to TRUNCATE, so revoke table writes as well as SELECT from
-- client roles; the server continues to use the service_role grant.
REVOKE ALL PRIVILEGES ON TABLE public.competitors FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.competitors TO service_role;

COMMIT;
