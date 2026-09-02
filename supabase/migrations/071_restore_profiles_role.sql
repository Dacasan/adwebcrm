-- ============================================================
-- 071) RESTORE profiles.role — undo of 069's premature drop
--
-- 069_tenancy_and_conversion_hardening.sql dropped
-- `profiles.role` assuming it was dead ("0 readers"), but the
-- client auth flow (src/hooks/use-auth.tsx) and the settings
-- profile form (src/components/settings/profile-form.tsx) still
-- read it — the upstream wacrm original keeps it (001_initial_
-- schema.sql:19, `role TEXT DEFAULT 'user'`) and its code selects
-- it. Dropping the column broke the profile fetch on every login:
--   ERROR: column profiles.role does not exist
-- This restores the column with the exact original definition.
-- ============================================================

alter table public.profiles
  add column if not exists role text default 'user';