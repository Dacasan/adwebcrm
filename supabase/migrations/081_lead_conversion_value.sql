-- ============================================================
-- 081_lead_conversion_value.sql — el Lead vuelve a la entrega
-- (revisión de la 080, decidido 2026-09-27: "el simple hecho de que
-- llene el form también debe contarse aunque no tiene tanto valor")
--
-- La 080 sacó 'lead' del trigger para que las pujas no optimizaran
-- curiosos. Decisión final del funnel: el Lead SÍ se entrega — con
-- MENOS VALOR. En Google Ads la conversion action "Lead" se marca
-- SECONDARY (alimenta el modelo de Smart Bidding con el volumen de
-- todos los form fills) y la puja persigue las etapas comerciales
-- marcadas como primary (Good Lead, luego Showed). El valor relativo
-- de cada etapa se configura en las conversion actions de Google Ads,
-- no en el CRM — el CRM transporta value/currency si el evento los
-- trae.
--
-- Este reemplazo es la función de 080 con 'lead' de vuelta en la
-- lista: qualified_lead/better_lead/appointment_*/deal_won/purchase
-- igual que antes. Nada más cambia.
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
  if new.event_type not in ('lead','qualified_lead','better_lead','appointment_booked',
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

-- Grants del helper (mismo patrón que 066/070/080: nadie ejecuta
-- directo). Necesario re-aplicarlo: el drop function + recreate de
-- arriba reinicia los grants de la función.
revoke all on function public._conversion_enqueue() from public, anon, authenticated;
