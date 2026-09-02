-- ============================================================
-- 070_single_queue_conversion.sql — cola única (punto 1 consolidación)
--
-- `conversion_deliveries` (066) y `message_queue` (050) son la misma
-- cosa: filas pendientes con due_at que un cron reclama (pending →
-- claimed), reintenta con backoff y abandona con last_error. Dos colas
-- para el mismo mecanismo = dos drains, dos crons, dos CHECK de status.
--
-- Consolidación: conversion_deliveries DESAPARECE y sus conversiones
-- viven en `message_queue` con channel='conversion' (CHECK ampliado en
-- la 069). El dedup UNIQUE(conversion_event_id, platform) se replica
-- como índice único parcial sobre payload->>'conversion_event_id' +
-- payload->>'platform'.
--
-- 0 filas en producción (verificado 2026-08-15): no hay datos que
-- migrar, solo se reescribe el trigger y se dropea la tabla.
--
-- Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1) _conversion_enqueue — encola en message_queue (channel='conversion')
--    El payload lleva `platform` + `conversion_event_id` (uuid del
--    tracking_event) para el dedup y el snapshot que el adapter
--    necesita (misma forma que el payload de conversion_deliveries).
--
--    OJO orden: el trigger se dropea ANTES que la función (el trigger
--    depende de la función; al revés Postgres da 2BP01).
-- ------------------------------------------------------------
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
  if new.event_type not in ('lead','qualified_lead','appointment_booked',
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

drop trigger if exists trg_conversion_enqueue on public.tracking_events;
create trigger trg_conversion_enqueue
  after insert on public.tracking_events
  for each row execute function public._conversion_enqueue();

-- ------------------------------------------------------------
-- 2) Dedup hard: UNIQUE(conversion_event_id, platform) replicado en
--    message_queue. channel='conversion' + conversion_event_id y
--    platform en el payload → una conversión por plataforma UNA vez,
--    incluso si el cron se solapa o el evento se re-inserta.
-- ------------------------------------------------------------
create unique index if not exists idx_message_queue_conversion_dedup
  on public.message_queue (
    (payload ->> 'conversion_event_id'),
    (payload ->> 'platform')
  )
  where channel = 'conversion'
    and payload ->> 'conversion_event_id' is not null
    and payload ->> 'platform' is not null;

-- ------------------------------------------------------------
-- 2b) CHECK de status: + 'permanent' (el drain de conversión lo usa
--     como terminal tras MAX_ATTEMPTS, igual que conversion_deliveries).
-- ------------------------------------------------------------
alter table public.message_queue
  drop constraint if exists message_queue_status_check,
  add constraint message_queue_status_check
    check (status in ('pending','claimed','sent','failed','permanent'));

-- ------------------------------------------------------------
-- 3) DROP conversion_deliveries (0 filas en prod, verificado).
--    CASCADE limpia su policy e índices.
-- ------------------------------------------------------------
drop table if exists public.conversion_deliveries;

-- Grants del helper (mismo patrón que 066: nadie ejecuta directo).
revoke all on function public._conversion_enqueue() from public, anon, authenticated;