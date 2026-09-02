-- ============================================================
-- 079_tracking_config.sql — identificadores de medición por cuenta
-- (vista de Tracking en Settings — PLAN-META-CAPI-MVP §8).
--
-- Calcada del patrón `*_config` (075_sendgrid_config.sql): 1:1 con
-- `accounts`, owner-only, secreto encriptado en reposo, trigger
-- set_updated_at. Sin policy de delete — la fila nace con el primer
-- valor y NO se borra desde la UI (vaciar campos, nunca drop).
--
-- QUÉ NO ES (§8.0): no es un interruptor. Pegar un ID aquí LO GUARDA,
-- no lo activa: el píxel de Meta / GTM / GA4 / Hotjar / la etiqueta de
-- navegador de Google Ads viven en el SITIO Astro (otro proyecto, otro
-- despliegue). El envío real del CRM sigue leyendo las variables de
-- entorno hasta la fase T2 (§8.7).
--
-- Todas las columnas de valores son nullable: nadie configura cinco
-- plataformas el mismo día; un NOT NULL obligaría a inventar cadenas
-- vacías para guardar el único valor que sí se tiene.
--
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS tracking_config (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                   uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  meta_pixel_id                text,
  meta_dataset_id              text,
  meta_access_token_encrypted  text,
  meta_test_event_code         text,
  gtm_container_id             text,
  ga4_measurement_id           text,
  google_ads_conversion_id     text,
  google_ads_conversion_label  text,
  hotjar_site_id               text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN tracking_config.meta_pixel_id IS
  'ID del píxel de Meta. Lo consume el <script> del SITIO Astro, no el CRM. Guardar aquí no lo activa (§8.6).';
COMMENT ON COLUMN tracking_config.meta_dataset_id IS
  'Dataset de la CAPI. Separado del pixel_id a propósito: en Business Messaging (CTWA) NO coinciden (§8.3). Hoy el envío real lee META_CAPI_DATASET_ID del entorno.';
COMMENT ON COLUMN tracking_config.meta_access_token_encrypted IS
  'Token de la CAPI encriptado con encrypt() (AES-256-GCM). NUNCA sale del servidor: el GET solo expone has_meta_access_token.';
COMMENT ON COLUMN tracking_config.gtm_container_id IS
  'Contenedor GTM (GTM-XXXX). Lo consume el sitio Astro, no el CRM.';
COMMENT ON COLUMN tracking_config.ga4_measurement_id IS
  'Measurement ID de GA4 (G-XXXX). Lo consume el sitio Astro, no el CRM.';
COMMENT ON COLUMN tracking_config.google_ads_conversion_id IS
  'ID de conversión de Google Ads (AW-XXXX). La etiqueta de navegador la consume el sitio; el loop de servidor usa GOOGLE_ADS_* del entorno.';
COMMENT ON COLUMN tracking_config.hotjar_site_id IS
  'Site ID de Hotjar. Lo consume el sitio Astro; no participa en conversiones.';

ALTER TABLE tracking_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_config_select ON tracking_config;
CREATE POLICY tracking_config_select ON tracking_config FOR SELECT
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS tracking_config_insert ON tracking_config;
CREATE POLICY tracking_config_insert ON tracking_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS tracking_config_update ON tracking_config;
CREATE POLICY tracking_config_update ON tracking_config FOR UPDATE
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

-- Sin policy de DELETE a propósito (§8.8-5): ahí vive un token que puede
-- escribir en el dataset de anuncios del cliente. Vaciar campos ≠ borrar fila.

DROP TRIGGER IF EXISTS set_updated_at ON tracking_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracking_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
