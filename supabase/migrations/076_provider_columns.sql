-- ============================================================
-- 076_provider_columns.sql — desacopla las tablas de tráfico del proveedor.
--
-- Hoy `calls` habla Telnyx (`telnyx_call_control_id`), `messages` guarda el
-- id en `metadata.telnyx_message_id` y `email_sends` está clavada en
-- `resend_message_id`. Con dos proveedores por canal eso deja de escalar:
-- se añade el par genérico (`provider`, `provider_message_id` /
-- `provider_call_id`) y se rellena hacia atrás con lo que ya había.
--
-- Las columnas viejas SE MANTIENEN. El código de Telnyx y Resend las sigue
-- usando y borrarlas rompería llamadas y envíos en vuelo; se deprecan en
-- documentación, no en SQL (plan §3.4).
--
-- Aditiva e idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- calls
-- ------------------------------------------------------------
ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS provider         text NOT NULL DEFAULT 'telnyx'
    CHECK (provider IN ('telnyx','twilio')),
  ADD COLUMN IF NOT EXISTS provider_call_id text;

COMMENT ON COLUMN public.calls.provider IS
  'Proveedor que sirvió la llamada. Default ''telnyx'': todas las filas históricas lo son.';
COMMENT ON COLUMN public.calls.provider_call_id IS
  'Id de la llamada en el proveedor (Telnyx call_control_id, Twilio CallSid). Reemplaza a telnyx_call_control_id, que se conserva por compatibilidad.';

-- Backfill: lo que ya existe es Telnyx y su id vive en la columna vieja.
UPDATE public.calls
   SET provider_call_id = telnyx_call_control_id
 WHERE provider_call_id IS NULL AND telnyx_call_control_id IS NOT NULL;

-- Único: es la garantía de idempotencia de los webhooks. Una reentrega del
-- mismo CallSid no puede crear una segunda fila.
--
-- Deliberadamente NO es un índice parcial (`WHERE provider_call_id IS NOT
-- NULL`), aunque las filas sin id sean muchas. Razón: el webhook resuelve
-- la idempotencia con un upsert `ON CONFLICT (provider, provider_call_id)`,
-- y PostgREST emite esa cláusula SIN el predicado del índice. Postgres no
-- puede inferir un índice PARCIAL a partir de un ON CONFLICT sin WHERE, y
-- la operación falla entera con «no unique or exclusion constraint matching
-- the ON CONFLICT specification».
--
-- Un índice completo funciona igual de bien aquí: en un índice único de
-- Postgres los NULL nunca son iguales entre sí, así que las filas
-- históricas sin `provider_call_id` conviven sin colisionar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_provider_call_id
  ON public.calls (provider, provider_call_id);

-- ------------------------------------------------------------
-- messages
--
-- Sin default: `messages` mezcla WhatsApp (Meta), SMS (Telnyx/Twilio) y
-- futuros canales. Poner 'telnyx' por defecto etiquetaría mal cada mensaje
-- de WhatsApp existente. NULL = "el canal lo dice" (compatibilidad).
-- ------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS provider            text,
  ADD COLUMN IF NOT EXISTS provider_message_id text;

COMMENT ON COLUMN public.messages.provider IS
  'Proveedor del canal: telnyx | twilio para SMS; NULL en WhatsApp (Meta Cloud API) y filas anteriores a 076.';
COMMENT ON COLUMN public.messages.provider_message_id IS
  'Id del mensaje en el proveedor. En SMS de Telnyx duplica metadata.telnyx_message_id (que se conserva).';

CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id
  ON public.messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ------------------------------------------------------------
-- email_sends
-- ------------------------------------------------------------
ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS provider            text NOT NULL DEFAULT 'resend'
    CHECK (provider IN ('resend','sendgrid')),
  ADD COLUMN IF NOT EXISTS provider_message_id text;

COMMENT ON COLUMN public.email_sends.provider IS
  'Proveedor del envío. Default ''resend'': todo lo histórico lo es.';
COMMENT ON COLUMN public.email_sends.provider_message_id IS
  'Id del mensaje en el proveedor. Reemplaza a resend_message_id, que se conserva por compatibilidad con el webhook de Resend en vuelo.';

UPDATE public.email_sends
   SET provider_message_id = resend_message_id
 WHERE provider_message_id IS NULL AND resend_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_sends_provider_message_id
  ON public.email_sends (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ------------------------------------------------------------
-- email_campaign_recipients — el mismo par
-- ------------------------------------------------------------
ALTER TABLE public.email_campaign_recipients
  ADD COLUMN IF NOT EXISTS provider            text NOT NULL DEFAULT 'resend'
    CHECK (provider IN ('resend','sendgrid')),
  ADD COLUMN IF NOT EXISTS provider_message_id text;

COMMENT ON COLUMN public.email_campaign_recipients.provider_message_id IS
  'Id del mensaje en el proveedor; el webhook de campañas lo usa igual que email_sends.';

UPDATE public.email_campaign_recipients
   SET provider_message_id = resend_message_id
 WHERE provider_message_id IS NULL AND resend_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ecr_provider_message_id
  ON public.email_campaign_recipients (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
