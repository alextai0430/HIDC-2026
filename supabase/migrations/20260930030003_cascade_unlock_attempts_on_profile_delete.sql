BEGIN;

-- Failed Admin-unlock counters are temporary security state. They should not
-- prevent permanent judge-account deletion and have no value after the profile
-- is gone.
ALTER TABLE public.unlock_attempts
  DROP CONSTRAINT IF EXISTS unlock_attempts_user_id_fkey;

ALTER TABLE public.unlock_attempts
  ADD CONSTRAINT unlock_attempts_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.profiles(id)
  ON DELETE CASCADE;

COMMIT;
