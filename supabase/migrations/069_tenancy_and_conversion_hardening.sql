-- ============================================================
-- 069_tenancy_and_conversion_hardening.sql
--
-- Consolidación de seguridad y tenencia pendiente de la auditoría
-- (INFORME-FINAL 2026-08-15, verificado contra HEAD 2c7ba00):
--
--   1. transition_deal: restaurar el JOIN de tenencia de la 049
--      (P0-1/F-01 — la guarda se perdió en 058 y 066). Un trato de la
--      cuenta A ya no puede moverse a una etapa de la cuenta B.
--   2. guard_rules: DROP COLUMN (CHK-1 — muerta desde 067; la rama
--      v_guards de transition_deal se elimina con la reescritura).
--   3. deals.stage_id: ON DELETE CASCADE → RESTRICT (F-08, contra el
--      criterio explícito de 004).
--   4. deal_won: event_id DETERMINÍSTICO + ON CONFLICT DO NOTHING
--      (dedup hard: reactivar un deal ganado no duplica la conversión).
--   5. appointments: extensión btree_gist + EXCLUDE de solapamiento
--      (H3/Fase 4 — la base deja de permitir doble reserva; el app-level
--      findConflicts queda como primera línea, esta es la red).
--   6. calls: policy UPDATE (F-09 — el trigger on_call_missed es
--      AFTER UPDATE OF disposition; sin policy el flujo dependía del
--      service-role).
--   7. notifications: SELECT con account_id + INSERT/DELETE (F-07/S5).
--   8. Policies DELETE faltantes (F-10): email_config, telnyx_config,
--      frequency_rules, message_queue.
--   9. Índice único SMS por metadata->>'telnyx_message_id' (F-12 — el
--      de 046 indexa message_id, que el webhook nunca puebla → inerte).
--  10. Re-backfill de checklists en los stages en INGLÉS de producción
--      (067 backfilleó por nombre en español; prod tiene New Lead,
--      Qualified, Proposal Sent, Negotiation, Won con checklist=[]).
--      Ids DETERMINÍSTICOS literales (misma propiedad que el fix de
--      default-stages.ts: el modal toggles por item.id).
--  11. custom_fields de producción renombrados a inglés (la UI ya es
--      en inglés; los valores referencian por id, no por nombre).
--  12. profiles.role: DROP (P3 — columna muerta, 0 lectores).
--  13. message_queue.channel + 'conversion' (preparación de la
--      consolidación de colas: conversion_deliveries → message_queue).
--
-- Idempotente. No re-ejecutar contra prod sin respaldo (invariante 7).
-- ============================================================

-- ------------------------------------------------------------
-- 1+2+4) transition_deal — JOIN de tenencia + sin guard_rules +
--        event_id determinístico en deal_won
-- ------------------------------------------------------------
drop function if exists public.transition_deal(uuid, uuid, text, text, jsonb, text, integer);

create or replace function public.transition_deal(
  p_deal_id        uuid,
  p_to_stage_id    uuid,
  p_new_status     text        default null,
  p_triggered_by   text        default 'agent',
  p_evidence       jsonb       default null,
  p_override_reason text       default null,
  p_expected_version integer   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal    public.deals%rowtype;
  v_stage   public.pipeline_stages%rowtype;
  v_priority text;
  v_status  text;
begin
  if p_new_status is not null and p_new_status not in ('open','won','lost') then
    raise exception 'transition_deal: status no válido: % (open|won|lost)', p_new_status;
  end if;

  select * into v_deal from public.deals where id = p_deal_id for update;
  if not found then
    raise exception 'transition_deal: deal % no existe', p_deal_id;
  end if;

  if not public.is_account_member(v_deal.account_id, 'agent'::public.account_role_enum) then
    raise exception 'transition_deal: forbidden — se requiere rol agent+ de la cuenta';
  end if;

  if p_expected_version is not null and v_deal.version <> p_expected_version then
    return jsonb_build_object(
      'ok', false, 'code', 'VERSION_CONFLICT',
      'current_version', v_deal.version,
      'expected_version', p_expected_version
    );
  end if;

  -- GUARDA DE TENENCIA (P0-1): la etapa destino debe pertenecer a la
  -- MISMA cuenta que el trato. Este JOIN es una guarda, no una consulta
  -- cualquiera: 058 y 066 lo perdieron al redefinir la función sobre la
  -- versión equivocada. NO reemplazar por un SELECT simple por id.
  select s.* into v_stage
  from public.pipeline_stages s
  join public.pipelines p on p.id = s.pipeline_id and p.account_id = v_deal.account_id
  where s.id = p_to_stage_id;
  if not found then
    raise exception 'transition_deal: stage % no existe en esta cuenta', p_to_stage_id;
  end if;

  v_status := coalesce(p_new_status, v_stage.stage_status, v_deal.status);

  if v_deal.stage_id = p_to_stage_id and v_status = v_deal.status then
    return jsonb_build_object('ok', false, 'code', 'NO_OP', 'message', 'la transición no cambia nada');
  end if;

  if v_status = 'won' then
    v_deal.won_at := now();
    v_deal.lost_at := null;
  elsif v_status = 'lost' then
    v_deal.lost_at := now();
  elsif v_status = 'open' and v_deal.lost_at is not null then
    v_deal.lost_at := null;
  end if;

  v_priority := public._compute_priority(v_deal.tags, v_deal.score, v_status);

  update public.deals
     set stage_id  = p_to_stage_id,
         status    = v_status,
         won_at    = v_deal.won_at,
         lost_at   = v_deal.lost_at,
         priority  = v_priority,
         version   = version + 1,
         updated_at = now()
   where id = p_deal_id;

  insert into public.tracking_events (account_id, event_type, payload)
  values (
    v_deal.account_id,
    'state_changed',
    jsonb_build_object(
      'deal_id',         v_deal.id,
      'from_stage',      v_deal.stage_id,
      'to_stage',        p_to_stage_id,
      'from_status',     v_deal.status,
      'to_status',       v_status,
      'triggered_by',    coalesce(p_triggered_by, 'agent'),
      'evidence',        p_evidence,
      'override_reason', p_override_reason
    )
  );

  -- deal_won == purchase (solo al GANAR, no en reactivaciones repetidas).
  -- event_id DETERMINÍSTICO `deal_won_<deal_id>` + ON CONFLICT DO NOTHING:
  -- el UNIQUE(event_id) descarta re-inserts (reactivación won→open→won) y
  -- reintentos del propio RPC. Sin esto, cada re-ejecución duplicaba la
  -- conversión hacia Google/Meta.
  if v_status = 'won' and v_deal.status <> 'won' then
    insert into public.tracking_events
      (account_id, contact_id, deal_id, event_type, event_id, value, currency, attribution, payload)
    values (
      v_deal.account_id,
      v_deal.contact_id,
      v_deal.id,
      'deal_won',
      'deal_won_' || v_deal.id::text,
      v_deal.value,
      v_deal.currency,
      (select attribution from public.contacts where id = v_deal.contact_id),
      jsonb_build_object('deal_id', v_deal.id, 'title', v_deal.title)
    )
    on conflict (event_id) do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'version',  v_deal.version + 1,
    'status',   v_status,
    'priority', v_priority
  );
end;
$$;

-- ------------------------------------------------------------
-- 2) guard_rules — DROP COLUMN (muerta desde 067)
-- ------------------------------------------------------------
alter table public.pipeline_stages drop column if exists guard_rules;

-- ------------------------------------------------------------
-- 3) deals.stage_id → RESTRICT (F-08)
-- ------------------------------------------------------------
alter table public.deals
  drop constraint if exists deals_stage_id_fkey,
  add constraint deals_stage_id_fkey
    foreign key (stage_id) references public.pipeline_stages(id)
    on delete restrict;

-- ------------------------------------------------------------
-- 5) btree_gist + EXCLUDE de solapamiento en appointments (H3)
--    Solo cuentan citas activas: cancelled/no_show liberan el slot
--    (mismo criterio que findConflicts, que excluye cancelled).
--    El EXCLUDE es la red: no sustituye al app-level, lo respalda.
-- ------------------------------------------------------------
create extension if not exists btree_gist;

alter table public.appointments
  drop constraint if exists appointments_no_overlap;

alter table public.appointments
  add constraint appointments_no_overlap
  exclude using gist (
    account_id with =,
    assigned_user_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status <> 'cancelled' and status <> 'no_show');

-- ------------------------------------------------------------
-- 6) calls: policy UPDATE (F-09)
-- ------------------------------------------------------------
drop policy if exists "calls_update" on public.calls;
create policy "calls_update" on public.calls
  for update using (public.is_account_member(account_id, 'agent'::public.account_role_enum))
  with check (public.is_account_member(account_id, 'agent'::public.account_role_enum));

-- ------------------------------------------------------------
-- 7) notifications: SELECT con account_id + INSERT/DELETE (F-07/S5)
-- ------------------------------------------------------------
drop policy if exists "notifications_select" on public.notifications;
create policy "notifications_select" on public.notifications
  for select using (
    auth.uid() = user_id
    and public.is_account_member(account_id, 'viewer'::public.account_role_enum)
  );

drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (auth.uid() = user_id);

drop policy if exists "notifications_delete" on public.notifications;
create policy "notifications_delete" on public.notifications
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 8) Policies DELETE faltantes (F-10) — admin+
-- ------------------------------------------------------------
drop policy if exists "email_config_delete" on public.email_config;
create policy "email_config_delete" on public.email_config
  for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

drop policy if exists "telnyx_config_delete" on public.telnyx_config;
create policy "telnyx_config_delete" on public.telnyx_config
  for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

drop policy if exists "frequency_rules_delete" on public.frequency_rules;
create policy "frequency_rules_delete" on public.frequency_rules
  for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

drop policy if exists "message_queue_delete" on public.message_queue;
create policy "message_queue_delete" on public.message_queue
  for delete using (public.is_account_member(account_id, 'admin'::public.account_role_enum));

-- ------------------------------------------------------------
-- 9) SMS: columna `metadata` + índice único por telnyx_message_id
--    (F-12 y bug real detectado al aplicar: `messages.metadata` NUNCA
--    existió en el schema — ni 001 ni ninguna migración la crea —, pero
--    el webhook Telnyx (route.ts:611,623,666,682) y el step send_sms
--    del engine (engine.ts:519) la insertan/consultan. Resultado:
--    error 42703 en prod, flujo SMS completo roto silenciosamente
--    (messages con 0 filas). ADD COLUMN aditivo + nullable: sin pérdida,
--    el código existente empieza a funcionar sin tocar una línea.
--    046 indexaba message_id (columna que el webhook nunca puebla) →
--    anti-dupe inerte. El índice único parcial sobre metadata hace el
--    dedupe real de reentregas.
-- ------------------------------------------------------------
alter table public.messages
  add column if not exists metadata jsonb;

comment on column public.messages.metadata is
  'Metadatos por canal: SMS → telnyx_message_id (dedupe + lifecycle).';

drop index if exists idx_messages_telnyx_message_id;
create unique index if not exists idx_messages_telnyx_message_id
  on public.messages ((metadata ->> 'telnyx_message_id'))
  where channel = 'sms' and metadata ->> 'telnyx_message_id' is not null;

-- ------------------------------------------------------------
-- 10) Re-backfill de checklists en los stages en inglés de producción
--     (067 backfilleó por nombre español; los stages reales de la
--     cuenta tienen nombres en inglés y checklist=[]). Ids literales
--     determinísticos — mismo contrato que el fix de default-stages.ts.
-- ------------------------------------------------------------
update public.pipeline_stages
   set checklist = jsonb_build_array(
         jsonb_build_object('id', 'chk-new-lead-0', 'text', 'Contact date and time confirmed', 'position', 0),
         jsonb_build_object('id', 'chk-new-lead-1', 'text', 'Contact reason of interest noted', 'position', 1),
         jsonb_build_object('id', 'chk-new-lead-2', 'text', 'Preferred channel recorded', 'position', 2)
       )
 where checklist = '[]'::jsonb and lower(name) = 'new lead';

update public.pipeline_stages
   set checklist = jsonb_build_array(
         jsonb_build_object('id', 'chk-qualified-0', 'text', 'Approximate budget known', 'position', 0),
         jsonb_build_object('id', 'chk-qualified-1', 'text', 'Decision maker identified', 'position', 1),
         jsonb_build_object('id', 'chk-qualified-2', 'text', 'Purchase timeline estimated', 'position', 2)
       )
 where checklist = '[]'::jsonb and lower(name) = 'qualified';

update public.pipeline_stages
   set checklist = jsonb_build_array(
         jsonb_build_object('id', 'chk-proposal-0', 'text', 'Proposal sent to the contact', 'position', 0),
         jsonb_build_object('id', 'chk-proposal-1', 'text', 'Pricing and scope accepted', 'position', 1)
       )
 where checklist = '[]'::jsonb and lower(name) = 'proposal sent';

update public.pipeline_stages
   set checklist = jsonb_build_array(
         jsonb_build_object('id', 'chk-negotiation-0', 'text', 'Final terms discussed', 'position', 0),
         jsonb_build_object('id', 'chk-negotiation-1', 'text', 'Next step agreed', 'position', 1)
       )
 where checklist = '[]'::jsonb and lower(name) = 'negotiation';

update public.pipeline_stages
   set checklist = jsonb_build_array(
         jsonb_build_object('id', 'chk-won-0', 'text', 'Service fully delivered', 'position', 0),
         jsonb_build_object('id', 'chk-won-1', 'text', 'Payment processed', 'position', 1),
         jsonb_build_object('id', 'chk-won-2', 'text', 'Client feedback collected', 'position', 2)
       )
 where checklist = '[]'::jsonb and lower(name) = 'won';

-- ------------------------------------------------------------
-- 11) custom_fields de producción → inglés (UI ya traducida).
--     Los valores (contact_custom_values) referencian por custom_field_id,
--     así que renombrar field_name es seguro.
-- ------------------------------------------------------------
update public.custom_fields set field_name = 'Ad'      where field_name = 'Anuncio';
update public.custom_fields set field_name = 'Campaign' where field_name = 'Campaña';
update public.custom_fields set field_name = 'Channel' where field_name = 'Canal';
update public.custom_fields set field_name = 'Medium'  where field_name = 'Medio';
update public.custom_fields set field_name = 'Source'  where field_name = 'Origen';
update public.custom_fields set field_name = 'Term'    where field_name = 'Término';

-- ------------------------------------------------------------
-- 12) profiles.role — DROP (P3, columna muerta desde 017)
-- ------------------------------------------------------------
alter table public.profiles drop column if exists role;

-- ------------------------------------------------------------
-- 13) message_queue.channel + 'conversion' (preparación consolidación)
-- ------------------------------------------------------------
alter table public.message_queue
  drop constraint if exists message_queue_channel_check,
  add constraint message_queue_channel_check
    check (channel in ('whatsapp','sms','email','conversion'));