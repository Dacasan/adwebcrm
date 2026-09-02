-- ============================================================
-- 075_sendgrid_config.sql — credenciales de SendGrid por cuenta (BYO).
--
-- Espeja `email_config` (040) y `twilio_config` (074): 1:1 con
-- `accounts`, owner-only, API key encriptada en reposo.
--
-- Igual que Twilio, la firma del webhook depende de una clave POR CUENTA
-- (aquí una pública ECDSA P-256, no un secreto compartido), así que el
-- endpoint necesita resolver la cuenta antes de verificar: de ahí el
-- `webhook_token` en la ruta.
--
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS sendgrid_config (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_encrypted     text NOT NULL,
  from_email            text NOT NULL,
  from_name             text,
  reply_to              text,
  webhook_public_key    text,
  webhook_token         text NOT NULL UNIQUE,
  domain_authenticated  boolean NOT NULL DEFAULT false,
  domain_checked_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sendgrid_config_webhook_token ON sendgrid_config (webhook_token);

COMMENT ON COLUMN sendgrid_config.webhook_public_key IS
  'Clave pública ECDSA P-256 (base64, SPKI DER) que SendGrid genera al activar el Signed Event Webhook. SIN ELLA el endpoint rechaza con 503 — igual que hoy hace el de Resend sin RESEND_WEBHOOK_SECRET. Fail-closed a propósito.';
COMMENT ON COLUMN sendgrid_config.webhook_token IS
  '32 bytes hex. Va en la ruta /api/sendgrid/{webhook_token}/webhook para poder resolver la cuenta (y con ella la clave pública) antes de verificar la firma.';
COMMENT ON COLUMN sendgrid_config.domain_authenticated IS
  'Estado de la autenticación de dominio (DKIM/SPF) leído de GET /v3/whitelabel/domains. Un from_email sin DKIM firmado va a spam SIN error: el envío de CAMPAÑAS se bloquea si esto es false. El transaccional no.';
COMMENT ON COLUMN sendgrid_config.domain_checked_at IS
  'Cuándo se comprobó por última vez la autenticación de dominio.';

ALTER TABLE sendgrid_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sendgrid_config_select ON sendgrid_config;
CREATE POLICY sendgrid_config_select ON sendgrid_config FOR SELECT
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS sendgrid_config_insert ON sendgrid_config;
CREATE POLICY sendgrid_config_insert ON sendgrid_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS sendgrid_config_update ON sendgrid_config;
CREATE POLICY sendgrid_config_update ON sendgrid_config FOR UPDATE
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP TRIGGER IF EXISTS set_updated_at ON sendgrid_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sendgrid_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
