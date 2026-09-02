-- 078_email_inbound.sql
-- Email ENTRANTE vía webhook de Resend (`email.received`).
--
-- 041 introdujo `messages.channel` con CHECK ('whatsapp','sms'). El inbox
-- ya mezcla canales en una sola lista y toda la maquinaria de ingesta es
-- agnóstica del canal — `provider`/`provider_message_id` (076) aceptan
-- 'resend' sin cambios, `metadata` (069) es jsonb libre y la RPC
-- `bump_conversation_on_inbound` (059) no mira el canal. Lo único que
-- bloqueaba un mensaje de email era este CHECK.
--
-- Sin backfill: no existe fila con channel='email' previa a esta pieza.

alter table public.messages
  drop constraint if exists messages_channel_check;

alter table public.messages
  add constraint messages_channel_check
  check (channel in ('whatsapp', 'sms', 'email'));
