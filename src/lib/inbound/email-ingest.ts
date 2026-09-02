import type { SupabaseClient } from '@supabase/supabase-js'

import { findOrCreateContactByEmail, findOrCreateConversation } from './resolve'

// ============================================================
// Ingesta de un email ENTRANTE (webhook `email.received` de Resend).
//
// Espejo de sms-ingest para el canal email: el webhook traduce SU
// payload a este input y llama aquí. Reusa las mismas primitivas de
// resolve.ts (una conversación por (cuenta, contacto)) y la RPC
// `bump_conversation_on_inbound` (059) para unread/last_message, igual
// que hace el webhook de WhatsApp.
//
// Idempotencia: Resend reentrega webhooks. El dedupe mira el par
// genérico (`provider`, `provider_message_id`) — provider='resend',
// provider_message_id=data.email_id — y el índice único
// (conversation_id, message_id) hace de red de seguridad con el
// Message-ID RFC del email.
// ============================================================

export interface InboundEmailInput {
  accountId: string
  /** Dirección del remitente (data.from, sin nombre display). */
  from: string
  /** Nombre para mostrar del remitente, si el correo lo traía. */
  fromName?: string | null
  /** Dirección receptora (la bandeja del CRM, data.to[0]). */
  to: string
  subject: string | null
  text: string | null
  html: string | null
  /** data.email_id de Resend — clave de dedupe. */
  emailId: string
  /** Message-ID RFC (data.message_id) — threading. */
  messageId: string | null
  receivedAt?: string | null
  /** Adjuntos (metadata del webhook, sin contenido binario). */
  attachments?: unknown[]
}

export type InboundEmailResult =
  | { status: 'stored'; messageId: string | null; conversationId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }

const NO_BODY_FALLBACK = '(sin cuerpo)'

/** HTML → texto plano de juguete: suficiente para el preview del inbox
 *  cuando el email solo trae cuerpo HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function ingestInboundEmail(
  admin: SupabaseClient,
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  if (!input.from) return { status: 'ignored', reason: 'no sender' }
  if (!input.emailId) return { status: 'ignored', reason: 'no email_id' }

  // Dedupe ANTES de crear nada: una reentrega no debe fabricar contacto
  // ni conversación (mismo orden que sms-ingest).
  const { data: dupe } = await admin
    .from('messages')
    .select('id')
    .eq('provider', 'resend')
    .eq('provider_message_id', input.emailId)
    .maybeSingle()
  if (dupe) return { status: 'duplicate' }

  // El dueño de la cuenta es el user_id de auditoría que exigen las FK
  // NOT NULL de contacts/conversations (001:38, 001:142) — el mismo rol
  // que usa el webhook de WhatsApp con whatsapp_config.user_id.
  const { data: account } = await admin
    .from('accounts')
    .select('owner_user_id')
    .eq('id', input.accountId)
    .maybeSingle()
  const ownerUserId = (account?.owner_user_id as string | undefined) ?? null
  if (!ownerUserId) return { status: 'ignored', reason: 'account not found' }

  const contactId = await findOrCreateContactByEmail(
    admin,
    input.accountId,
    input.from,
    ownerUserId,
    input.fromName,
  )
  if (!contactId) return { status: 'ignored', reason: 'could not resolve contact' }

  const conversation = await findOrCreateConversation(
    admin,
    input.accountId,
    contactId,
    ownerUserId,
  )
  const ts = input.receivedAt ?? new Date().toISOString()

  const textFromHtml = input.html ? htmlToText(input.html) : ''
  const contentText =
    (input.text ?? '').trim() || textFromHtml || input.subject || NO_BODY_FALLBACK

  const metadata: Record<string, unknown> = {
    subject: input.subject,
    to: input.to,
    message_id: input.messageId,
    ...(input.html ? { html: input.html } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  }

  const { data: inserted, error } = await admin
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: 'text',
      content_text: contentText,
      channel: 'email',
      status: 'delivered',
      message_id: input.messageId,
      metadata,
      provider: 'resend',
      provider_message_id: input.emailId,
      created_at: ts,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    // El índice único (conversation_id, message_id) también rechaza
    // reentregas: si el dupe del pre-check se coló por carrera, cuenta
    // como duplicate y no como error.
    if (error.code === '23505') return { status: 'duplicate' }
    console.error('[resend:email] inbound insert failed:', error)
    return { status: 'ignored', reason: 'insert failed' }
  }

  // Misma RPC que el webhook de WhatsApp (059): sube unread_count y
  // refresca last_message de la conversación. Atómica, agnóstica del canal.
  const { error: bumpError } = await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText.slice(0, 200),
  })
  if (bumpError) {
    console.error('[resend:email] bump_conversation_on_inbound failed:', bumpError)
  }

  return {
    status: 'stored',
    messageId: (inserted?.id as string | undefined) ?? null,
    conversationId: conversation.id,
  }
}
