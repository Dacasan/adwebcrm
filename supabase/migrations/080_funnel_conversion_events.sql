-- ============================================================
-- 080_funnel_conversion_events.sql — funnel de conversiones por etapas
-- comerciales (decisión 2026-09-27)
--
-- El form_submit ('lead') deja de ser conversión de plataforma: se
-- registra en tracking_events para reporting y el funnel del dashboard,
-- pero NO se encola a Google Ads ni a Meta CAPI — las pujas se
-- optimizan con las etapas que marca el equipo comercial:
--
--   qualified_lead       Good Lead   (tag, acción emit_conversion)
--   better_lead          Better Lead (tag, acción emit_conversion; el
--                                    lead está dispuesto a viajar)
--   appointment_booked   compró el boleto (módulo de citas)
--   appointment_showed   llegó a la clínica (cita → completed)
--   deal_won / purchase  cerrado (RPC transition_deal)
--
-- La lista del trigger era hardcoded en 070; este reemplazo es idéntico
-- salvo la lista: fuera 'lead', dentro 'better_lead'. Nada más cambia:
-- mismas colas, mismo dedup UNIQUE, mismo drain del cron.
-- ============================================================

drop trigger if exists trg_conversion_enqueue on public.tracking_events;
drop function if exists public._conversion_enqueue();

create or replace function public._conversion_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attr    jsonb := coalesce(new.attribution, '{}'::jsonb);
  v_ids     jsonb := coalesce(v_attr -> 'click_ids', '{}'::jsonb);
  v_goog    boolean;
  v_meta    boolean;
  v_payload jsonb;
begin
  if new.event_type not in ('qualified_lead','better_lead','appointment_booked',
                             'appointment_showed','deal_won','purchase') then
    return null;
  end if;

  v_goog := (v_ids ? 'gclid') or (v_ids ? 'gbraid') or (v_ids ? 'wbraid');
  v_meta := (v_ids ? 'fbclid') or (v_attr ? 'fbc') or (v_attr ? 'fbp');

  v_payload := jsonb_build_object(
    'event_name',          new.event_type,
    'event_id',            new.event_id,
    'conversion_event_id', new.id,
    'contact_id',          new.contact_id,
    'value',               new.value,
    'currency',            new.currency,
    'created_at',          new.created_at
  ) || jsonb_build_object('attribution', v_attr);

  if v_goog then
    insert into public.message_queue
      (account_id, contact_id, channel, payload)
    values (
      new.account_id, new.contact_id, 'conversion',
      v_payload || jsonb_build_object('platform', 'google_ads')
    );
  end if;

  if v_meta then
    insert into public.message_queue
      (account_id, contact_id, channel, payload)
    values (
      new.account_id, new.contact_id, 'conversion',
      v_payload || jsonb_build_object('platform', 'meta_capi')
    );
  end if;

  return null;
end;
$$;

create trigger trg_conversion_enqueue
  after insert on public.tracking_events
  for each row execute function public._conversion_enqueue();

-- Grants del helper (mismo patrón que 066/070: nadie ejecuta directo).
-- Necesario re-aplicarlo: el drop function + recreate de arriba reinicia
-- los grants de la función.
revoke all on function public._conversion_enqueue() from public, anon, authenticated;
