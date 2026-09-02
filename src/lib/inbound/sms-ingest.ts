import type { SupabaseClient } from '@supabase/supabase-js'

import type { SmsProviderId } from '@/lib/providers/types'
import { findOrCreateContactByPhone, findOrCreateConversation } from './resolve'

// ============================================================
// Ingesta de un SMS entrante, común a Telnyx y Twilio.
//
// El webhook de cada proveedor traduce SU payload a este input y llama
// aquí. Todo lo demás — resolver contacto, resolver conversación,
// deduplicar, insertar en `messages` con `channel='sms'`, refrescar el
// último mensaje de la conversación — es idéntico y vive una sola vez.
//
// Idempotencia: los dos proveedores reentregan. El dedupe mira el par
// genérico (`provider`, `provider_message_id`) y, para Telnyx, también
// el `metadata.telnyx_message_id` histórico, porque las filas anteriores
// a la migración 076 solo tienen eso.
// ============================================================

export interface InboundSmsInput {
  accountId: string
  /** Número del remitente, tal como lo manda el proveedor. */
  from: string
  text: string
  provider: SmsProviderId
  providerMessageId: string
  /** Extras del proveedor que merece la pena conservar (ErrorCode, NumMedia…). */
  metadata?: Record<string, unknown>
}

export type InboundSmsResult =
  | { status: 'stored'; messageId: string | null; conversationId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }

export async function ingestInboundSms(
  admin: SupabaseClient,
  input: InboundSmsInput,
): Promise<InboundSmsResult> {
  if (!input.from) return { status: 'ignored', reason: 'no sender' }

  // Dedupe ANTES de crear nada. Una reentrega no debe fabricar un
  // contacto ni una conversación, solo porque llegó dos veces.
  if (input.providerMessageId) {
    const { data: dupe } = await admin
      .from('messages')
      .select('id')
      .eq('provider', input.provider)
      .eq('provider_message_id', input.providerMessageId)
      .maybeSingle()
    if (dupe) return { status: 'duplicate' }
  }

  if (input.provider === 'telnyx' && input.providerMessageId) {
    // Filas anteriores a la 076: el id solo vive en el metadata.
    const { data: legacy } = await admin
      .from('messages')
      .select('id')
      .eq('metadata->telnyx_message_id', input.providerMessageId)
      .maybeSingle()
    if (legacy) return { status: 'duplicate' }
  }

  // El dueño de la cuenta es el user_id de auditoría que exigen las FK
  // NOT NULL de contacts/conversations (001:38, 001:142) — misma pieza
  // que email-ingest. Sin él, crear contacto/conversación nuevas fallaba
  // en silencio (P1 detectado al integrar el canal email).
  const { data: account } = await admin
    .from('accounts')
    .select('owner_user_id')
    .eq('id', input.accountId)
    .maybeSingle()
  const ownerUserId = (account?.owner_user_id as string | undefined) ?? null
  if (!ownerUserId) return { status: 'ignored', reason: 'account not found' }

  const contactId = await findOrCreateContactByPhone(
    admin,
    input.accountId,
    input.from,
    ownerUserId,
  )
  if (!contactId) return { status: 'ignored', reason: 'could not resolve contact' }

  const conversation = await findOrCreateConversation(
    admin,
    input.accountId,
    contactId,
    ownerUserId,
  )
  const ts = new Date().toISOString()

  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) }
  if (input.provider === 'telnyx') {
    // Compatibilidad: los handlers `message.sent` / `message.finalized` de
    // Telnyx siguen buscando la fila por esta clave.
    metadata.telnyx_message_id = input.providerMessageId
  }

  const { data: inserted, error } = await admin
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: 'text',
      content_text: input.text,
      channel: 'sms',
      status: 'delivered',
      metadata,
      provider: input.provider,
      provider_message_id: input.providerMessageId || null,
      created_at: ts,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    console.error(`[${input.provider}:sms] inbound insert failed:`, error)
    return { status: 'ignored', reason: 'insert failed' }
  }

  await admin
    .from('conversations')
    .update({ last_message_text: input.text, last_message_at: ts })
    .eq('id', conversation.id)

  return {
    status: 'stored',
    messageId: (inserted?.id as string | undefined) ?? null,
    conversationId: conversation.id,
  }
}
