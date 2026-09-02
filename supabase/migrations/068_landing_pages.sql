-- ============================================================
-- 068_landing_pages.sql
--
-- Contenido editorial de las landings Astro, por cuenta.
--
-- Hasta ahora las landings vivían como JSON en el filesystem del
-- container (landing/src/data/landings/<slug>.json) y el page editor
-- las escribía en disco. Eso rompía el modelo de deploy reproducible:
-- una imagen nueva reemplaza el filesystem, así que cualquier edición
-- del cliente se perdía en el siguiente deploy.
--
-- Este cambio mueve la FUENTE DE VERDAD a Postgres (tabla multi-tenant
-- con account_id + RLS is_account_member, mismo patrón que contacts en
-- 017). El container sigue materializando los JSON a un filesystem
-- temporal antes de cada `astro build` (ver src/lib/landing-sync.ts y
-- src/instrumentation.ts), pero esa copia es descartable: se regenera
-- desde aquí en cada arranque.
--
-- Los JSON del repo (landing/src/data/landings/*.json) quedan como
-- PLANTILLA inicial: si la cuenta aún no tiene landings propias, el
-- editor y el build usan esos defaults hasta la primera edición, que
-- persiste aquí. Las migraciones NO siembran filas — no hay account_id
-- conocido en tiempo de migración; la plantilla del repo cubre el
-- primer arranque.
--
-- Idempotente (mismo estilo que 017/067).
-- ============================================================

-- ============================================================
-- 1. Tabla
-- ============================================================
CREATE TABLE IF NOT EXISTS landing_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT landing_pages_account_slug_key UNIQUE (account_id, slug)
);

-- Consultas por cuenta (listar landings del cliente).
CREATE INDEX IF NOT EXISTS idx_landing_pages_account
  ON landing_pages(account_id);

COMMENT ON TABLE landing_pages IS
  'Contenido editorial de las landings Astro, por cuenta. Fuente de '
  'verdad del page editor; el container materializa estos JSON a '
  'landing/src/data/landings/ antes de cada astro build.';

COMMENT ON COLUMN landing_pages.blocks IS
  'Bloques de la página (hero, faq, pricing, ...). Validados por la '
  'Content Collection de Astro en build time.';

-- ============================================================
-- 2. Trigger updated_at (patrón del proyecto)
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at ON landing_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON landing_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. RLS — mismo patrón que contacts (017): viewer lee, agent escribe
-- ============================================================
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_pages_select ON landing_pages;
CREATE POLICY landing_pages_select ON landing_pages
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS landing_pages_insert ON landing_pages;
CREATE POLICY landing_pages_insert ON landing_pages
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS landing_pages_update ON landing_pages;
CREATE POLICY landing_pages_update ON landing_pages
  FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS landing_pages_delete ON landing_pages;
CREATE POLICY landing_pages_delete ON landing_pages
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- El page editor escribe vía admin client (service-role, bypass RLS) con
-- filtro account_id explícito — mismo convenio que appointments/queries.
-- Estos grants cubren el acceso REST directo si algún día se expone la
-- tabla al Data API (skill supabase: no exponer sin grants + RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages TO service_role;