-- ============================================================
-- 073_provider_routing.sql — qué proveedor sirve cada canal, por cuenta.
--
-- Convivencia (plan Twilio/SendGrid §0): Telnyx y Twilio viven a la vez,
-- Resend y SendGrid también. Esta tabla es el único interruptor: el
-- registry (`src/lib/providers/registry.ts`) la lee y devuelve el
-- adaptador correspondiente.
--
-- INVARIANTE (plan §6.1): la AUSENCIA de fila equivale a los valores por
-- defecto — `telnyx`/`telnyx`/`resend`. Ninguna cuenta existente cambia de
-- comportamiento al aplicar esta migración, y el registry nunca debe
-- fallar por falta de fila: lee con `maybeSingle()` y aplica defaults.
--
-- RLS
--   SELECT viewer+ (la UI necesita saber qué proveedor está activo para
--   pintar las capacidades correctas — §6.3), INSERT/UPDATE owner-only.
--   Sin DELETE: el routing se cambia en sitio, nunca se borra.
--
-- Idempotente — seguro de correr varias veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS provider_routing (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  voice_provider  text NOT NULL DEFAULT 'telnyx' CHECK (voice_provider IN ('telnyx','twilio')),
  sms_provider    text NOT NULL DEFAULT 'telnyx' CHECK (sms_provider   IN ('telnyx','twilio')),
  email_provider  text NOT NULL DEFAULT 'resend' CHECK (email_provider IN ('resend','sendgrid')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE provider_routing IS
  'Proveedor activo por canal y cuenta. Fila ausente = defaults (telnyx/telnyx/resend): ninguna cuenta cambia de comportamiento sin una escritura explícita.';
COMMENT ON COLUMN provider_routing.voice_provider IS
  'Voz: telnyx (WebRTC + patrón de dos patas) | twilio (TwiML + <Client>).';
COMMENT ON COLUMN provider_routing.sms_provider IS
  'SMS saliente y entrante. El canal de `messages` sigue siendo ''sms'' en ambos casos.';
COMMENT ON COLUMN provider_routing.email_provider IS
  'Email transaccional y campañas: resend | sendgrid.';

ALTER TABLE provider_routing ENABLE ROW LEVEL SECURITY;

-- Leer: viewer+. La UI condiciona botones a las capacidades del proveedor
-- activo (§6.3), así que cualquier miembro necesita el SELECT.
DROP POLICY IF EXISTS provider_routing_select ON provider_routing;
CREATE POLICY provider_routing_select ON provider_routing FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- Escribir: owner. Cambiar de proveedor mueve tráfico facturado y
-- credenciales; es la misma sensibilidad que `telnyx_config` (038).
DROP POLICY IF EXISTS provider_routing_insert ON provider_routing;
CREATE POLICY provider_routing_insert ON provider_routing FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS provider_routing_update ON provider_routing;
CREATE POLICY provider_routing_update ON provider_routing FOR UPDATE
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

-- delete: sin policy a propósito — el routing se reconfigura, no se borra.

DROP TRIGGER IF EXISTS set_updated_at ON provider_routing;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON provider_routing
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
