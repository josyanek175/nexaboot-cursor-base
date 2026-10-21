-- DEV/HOMOLOGAÇÃO SOMENTE. Revisar antes de aplicar; não executar em produção.
-- Não altera empresas existentes nem movimenta dados entre empresas.
BEGIN;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_slug_unique
  ON public.companies (lower(slug)) WHERE slug IS NOT NULL;
COMMIT;
