-- =============================================================================
-- ROLLBACK — onboarding temporário Meta Coexistence (somente DEV).
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.meta_coexistence_onboardings;
DROP TABLE IF EXISTS public.meta_coexistence_csrf_states;

COMMIT;
