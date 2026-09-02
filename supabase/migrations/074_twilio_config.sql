-- ============================================================
-- 074_twilio_config.sql — credenciales de Twilio por cuenta (BYO).
--
-- Espeja `telnyx_config` (038): 1:1 con `accounts`, owner-only, secretos
-- ENCRIPTADOS en reposo (AES-256-GCM vía src/lib/whatsapp/encryption.ts).
--
-- El modelo es BYO — cada cuenta trae su propio Account SID y Auth Token.
-- NO hay credenciales globales de Twilio, y esa decisión tiene una
-- consecuencia estructural: la firma `X-Twilio-Signature` se calcula con
-- el Auth Token DE LA CUENTA, así que el webhook necesita saber de qué
-- cuenta se trata ANTES de poder verificar. De ahí `webhook_token`, que
-- viaja en la ruta del webhook (plan §4.2).
--
-- Idempotente — seguro de correr varias veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS twilio_config (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  account_sid               text NOT NULL,
  auth_token_encrypted      text NOT NULL,
  api_key_sid               text,
  api_key_secret_encrypted  text,
  twiml_app_sid             text,
  messaging_service_sid     text,
  default_from_number       text,
  fallback_number           text,
  recording_enabled         boolean NOT NULL DEFAULT false,
  regulatory_bundle_sid     text,
  address_sid               text,
  webhook_token             text NOT NULL UNIQUE,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_twilio_config_webhook_token ON twilio_config (webhook_token);
CREATE INDEX IF NOT EXISTS idx_twilio_config_from_number   ON twilio_config (default_from_number);

COMMENT ON COLUMN twilio_config.webhook_token IS
  '32 bytes hex (crypto.randomBytes(32).toString(''hex'')). Va en la ruta de TODOS los webhooks de esta cuenta: /api/twilio/{webhook_token}/…. Es lo que permite resolver el Auth Token antes de verificar la firma. Rotable desde Settings — al rotarlo hay que repegar las URLs en la consola de Twilio.';
COMMENT ON COLUMN twilio_config.api_key_sid IS
  'API Key (SKxxx) creada por ensureApiKey(). Firma los Access Token del softphone; nunca se usa el Auth Token para eso.';
COMMENT ON COLUMN twilio_config.api_key_secret_encrypted IS
  'Secreto de la API Key, encriptado. Twilio SOLO lo devuelve en la creación: si se pierde no hay forma de recuperarlo y hay que crear otra clave. Por eso se persiste en la misma operación que lo crea.';
COMMENT ON COLUMN twilio_config.twiml_app_sid IS
  'TwiML App (APxxx) cuyo voiceUrl apunta a /api/twilio/{webhook_token}/voice. Es el destino de device.connect() del softphone.';
COMMENT ON COLUMN twilio_config.messaging_service_sid IS
  'Messaging Service (MGxxx). Se prefiere SIEMPRE sobre default_from_number al enviar: es lo que exige A2P 10DLC en EE. UU. y lo que da geo-match y sticky sender en internacional.';
COMMENT ON COLUMN twilio_config.fallback_number IS
  'Destino de la entrante cuando no hay ningún agente conectado. Sin él la llamada cae al buzón.';
COMMENT ON COLUMN twilio_config.recording_enabled IS
  'Grabación de llamadas, opt-in por cuenta y por defecto FALSE. En España grabar exige informar y en EE. UU. hay estados de doble consentimiento: activarla es una decisión legal del cliente, no un default técnico.';
COMMENT ON COLUMN twilio_config.regulatory_bundle_sid IS
  'Regulatory Bundle aprobado (BUxxx). España, México y buena parte de LATAM lo exigen para comprar un número; sin él la compra devuelve 21649.';
COMMENT ON COLUMN twilio_config.address_sid IS
  'Dirección registrada (ADxxx) asociada al bundle. Su ausencia devuelve 21650.';

ALTER TABLE twilio_config ENABLE ROW LEVEL SECURITY;

-- Owner-only, idéntico a telnyx_config: solo el owner ve o edita
-- credenciales. Webhooks y rutas de servidor usan service-role, que
-- bypasea RLS; el navegador nunca lee esta fila salvo como owner.
DROP POLICY IF EXISTS twilio_config_select ON twilio_config;
CREATE POLICY twilio_config_select ON twilio_config FOR SELECT
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS twilio_config_insert ON twilio_config;
CREATE POLICY twilio_config_insert ON twilio_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS twilio_config_update ON twilio_config;
CREATE POLICY twilio_config_update ON twilio_config FOR UPDATE
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

-- delete: sin policy — la config se revoca en sitio, nunca se borra.

DROP TRIGGER IF EXISTS set_updated_at ON twilio_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON twilio_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
