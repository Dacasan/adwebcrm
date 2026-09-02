-- ============================================================
-- 077_email_webhook_provider.sql — el webhook de email deja de ser de Resend.
--
-- Dos cosas, en este orden:
--
--   1) Ensanchar el CHECK de `email_sends.status` para admitir 'queued'.
--      SendGrid devuelve metadatos propios (`custom_args`) en CADA evento
--      del webhook, y eso permite un patrón que Resend no permite:
--      insertar la fila ANTES de enviar y mandar su `id` con el correo.
--      Así el webhook siempre encuentra su fila, incluso cuando el evento
--      llega antes de que termine nuestro UPDATE — que ocurre. Ese estado
--      previo a 'sent' es 'queued', y hoy la constraint lo rechaza.
--
--      Este es el ÚNICO DROP que el plan autoriza, y solo porque la
--      sentencia siguiente recrea la MISMA constraint ensanchada.
--
--   2) `_on_email_webhook_v2`, que trabaja por (provider, message_id) o
--      directamente por el id de la fila — `email_sends.id` para el
--      transaccional, `email_campaign_recipients.id` para las campañas.
--      La vieja `_on_email_webhook` pasa a delegar para no romper el
--      webhook de Resend en vuelo.
--
-- La semántica es la de 048 + 053, no una nueva: delivered/bounced mueven
-- `status`; opened/clicked incrementan contador y sellan la fecha la
-- primera vez; los recipients de campaña avanzan su ladder forward-only
-- para que el trigger de agregación O(1) de 052 haga sus cuentas solo.
--
-- Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1) CHECK ensanchado + supresión
-- ------------------------------------------------------------
ALTER TABLE public.email_sends DROP CONSTRAINT IF EXISTS email_sends_status_check;
ALTER TABLE public.email_sends ADD CONSTRAINT email_sends_status_check
  CHECK (status IN ('queued','sent','delivered','bounced','failed'));

ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz;

COMMENT ON COLUMN public.email_sends.suppressed_at IS
  'Sello de spamreport / unsubscribe de SendGrid. No tienen análogo en el modelo de Resend; se registran aquí en vez de tirarse. La gestión completa de supresiones (ASM groups, sincronización de listas) queda fuera de alcance — plan §10.';

CREATE INDEX IF NOT EXISTS idx_email_sends_suppressed
  ON public.email_sends (account_id, suppressed_at) WHERE suppressed_at IS NOT NULL;

-- ------------------------------------------------------------
-- 2) RPC v2
--
-- Resolución de la fila, por orden de preferencia:
--   a) p_send_id — el uuid que SendGrid nos devuelve en custom_args. Es
--      exacto y no depende de correlacionar ids del proveedor.
--   b) (provider, provider_message_id) — el camino de respaldo.
--
-- La rama de Resend acepta ADEMÁS `resend_message_id`: entre aplicar la
-- 076 y desplegar el código hay filas con la columna vieja poblada y la
-- nueva vacía, y ese hueco no puede perder eventos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._on_email_webhook_v2(
  p_provider     text,
  p_message_id   text,
  p_trigger      text,
  p_send_id      uuid DEFAULT NULL,
  p_recipient_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_legacy boolean := (p_provider = 'resend');
BEGIN
  -- ---------- email_sends ----------
  IF p_trigger = 'delivered' THEN
    UPDATE public.email_sends
       SET status = 'delivered'
     WHERE (
             (p_send_id IS NOT NULL AND id = p_send_id)
          OR (p_send_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_send_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       -- 'queued' entra en el ladder: con el patrón insert-before-send de
       -- SendGrid, el evento puede ganarle la carrera a nuestro UPDATE a
       -- 'sent'. Excluirlo perdería la entrega en silencio.
       AND status IN ('queued','sent');

  ELSIF p_trigger = 'bounced' THEN
    UPDATE public.email_sends
       SET status = 'bounced'
     WHERE (
             (p_send_id IS NOT NULL AND id = p_send_id)
          OR (p_send_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_send_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       AND status IN ('queued','sent');

  ELSIF p_trigger = 'opened' THEN
    UPDATE public.email_sends
       SET opened_count = opened_count + 1,
           opened_at = coalesce(opened_at, now())
     WHERE (
             (p_send_id IS NOT NULL AND id = p_send_id)
          OR (p_send_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_send_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           );

  ELSIF p_trigger = 'clicked' THEN
    UPDATE public.email_sends
       SET clicked_count = clicked_count + 1,
           clicked_at = coalesce(clicked_at, now())
     WHERE (
             (p_send_id IS NOT NULL AND id = p_send_id)
          OR (p_send_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_send_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           );

  ELSIF p_trigger = 'suppressed' THEN
    -- spamreport / unsubscribe. No mueve `status`: el correo SÍ llegó;
    -- lo que cambia es que este destinatario no debe recibir más.
    UPDATE public.email_sends
       SET suppressed_at = coalesce(suppressed_at, now())
     WHERE (
             (p_send_id IS NOT NULL AND id = p_send_id)
          OR (p_send_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_send_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           );
  END IF;

  -- ---------- email_campaign_recipients ----------
  -- Ladder forward-only idéntico al de 053. Los UPDATE disparan el
  -- trigger de agregación de 052, así que los contadores de
  -- `email_campaigns` se mantienen solos.
  IF p_trigger = 'delivered' THEN
    UPDATE public.email_campaign_recipients
       SET status = 'delivered',
           delivered_at = coalesce(delivered_at, now())
     WHERE (
             (p_recipient_id IS NOT NULL AND id = p_recipient_id)
          OR (p_recipient_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_recipient_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       AND status = 'sent';

  ELSIF p_trigger = 'bounced' THEN
    UPDATE public.email_campaign_recipients
       SET status = 'bounced',
           error_message = coalesce(error_message, p_provider || ' bounce'),
           delivered_at = coalesce(delivered_at, now())
     WHERE (
             (p_recipient_id IS NOT NULL AND id = p_recipient_id)
          OR (p_recipient_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_recipient_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       AND status = 'sent';

  ELSIF p_trigger = 'opened' THEN
    UPDATE public.email_campaign_recipients
       SET status = 'opened',
           opened_at = coalesce(opened_at, now())
     WHERE (
             (p_recipient_id IS NOT NULL AND id = p_recipient_id)
          OR (p_recipient_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_recipient_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       AND status IN ('sent','delivered');

  ELSIF p_trigger = 'clicked' THEN
    UPDATE public.email_campaign_recipients
       SET status = 'clicked',
           clicked_at = coalesce(clicked_at, now())
     WHERE (
             (p_recipient_id IS NOT NULL AND id = p_recipient_id)
          OR (p_recipient_id IS NULL AND provider = p_provider AND provider_message_id = p_message_id)
          OR (p_recipient_id IS NULL AND v_legacy AND resend_message_id = p_message_id)
           )
       AND status IN ('sent','delivered','opened');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._on_email_webhook_v2(text, text, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._on_email_webhook_v2(text, text, text, uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 3) La vieja delega. El webhook de Resend desplegado hoy la sigue
--    llamando con su firma de dos argumentos; sustituirla por una
--    delegación mantiene ese contrato intacto y deja UNA sola
--    implementación de la semántica.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._on_email_webhook(
  p_resend_message_id text,
  p_trigger text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._on_email_webhook_v2('resend', p_resend_message_id, p_trigger, NULL, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public._on_email_webhook(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._on_email_webhook(text, text) TO service_role;
