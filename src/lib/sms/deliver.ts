import type { SupabaseClient } from '@supabase/supabase-js'

import { UNSUBSCRIBED_TAG } from '@/lib/email/unsubscribe-url'
import { resolveSmsProvider } from '@/lib/providers/registry'
import type { SmsProviderId } from '@/lib/providers/types'

// ============================================================
// Entrega de un SMS saliente: resolver proveedor → enviar → persistir.
//
// Vive en `lib/` y no dentro del `route.ts` por la misma razón que
// `lib/api/calls/dial.ts`: el envío de SMS ya tiene DOS caminos (el paso
// `send_sms` del engine y ahora el envío manual del inbox) y el repo ya
// arrastra cinco copias del par "insert en messages + bump de
// conversations". Este módulo es la definición ÚNICA de cómo se persiste
// un SMS saliente para todo lo nuevo.
//
// Las columnas que escribe son EXACTAMENTE las de `engine.ts` (paso
// `send_sms`), y no por estética: de ellas depende que los webhooks de
// estado encuentren la fila después.
//   · Twilio  busca por (provider, provider_message_id) — índice parcial
//             de la 076.
//   · Telnyx  sigue buscando por `metadata.telnyx_message_id`, así que
//             ese campo se rellena SOLO cuando el proveedor es Telnyx.
// Sin esas claves el mensaje se queda clavado en 'sent' para siempre.
//
// `channel: 'sms'` se escribe EXPLÍCITAMENTE. La columna tiene DEFAULT
// 'whatsapp' (041) y apoyarse en el default es justo lo que hace hoy el
// core de WhatsApp; en cuanto el inbox elige canal, el default deja de
// ser una fuente de verdad aceptable.
//
// El engine NO se ha migrado a este helper todavía (su copia usa el
// cliente service-role y su propio find-or-create de conversación); es
// deuda anotada, no una divergencia deliberada.
// ============================================================

/** Fallo de envío con status HTTP ya decidido, para que la ruta mapee un
 *  solo `catch` sin comparar mensajes por substring. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SmsSendError'
  }
}

/**
 * Baja aplicable al SMS.
 *
 * El único primitivo de supresión que existe hoy en el repo es el tag
 * "Unsubscribed" (lib/email/unsubscribe-url), que nació para email pero
 * es por cuenta y agnóstico de canal: lo pone /unsubscribe/[contactId] y
 * lo consulta `assertNotUnsubscribed` antes de cada email. Se reutiliza
 * aquí — bloquear de más es el lado correcto en el que equivocarse — en
 * vez de inventar un tag paralelo que nadie escribiría.
 *
 * OJO: sin detección de STOP en los webhooks de SMS entrante, este tag
 * nunca lo pondrá un cliente por SMS. La comprobación es correcta pero
 * hoy solo se activa por bajas de email.
 *
 * Se consulta con el cliente del caller (RLS): `contact_tags_select` y
 * `tags_select` son de miembro de cuenta (017), así que un agente ve la
 * fila. No hace falta service-role para esto.
 */
export async function assertSmsNotSuppressed(
  db: SupabaseClient,
  contactId: string,
): Promise<void> {
  const { data } = await db
    .from('contact_tags')
    .select('tag_id, tags!inner(name)')
    .eq('contact_id', contactId)
    .eq('tags.name', UNSUBSCRIBED_TAG)
    .maybeSingle()

  if (data) {
    throw new SmsSendError(
      `This contact has the "${UNSUBSCRIBED_TAG}" tag — SMS not sent`,
      403,
      'suppressed',
    )
  }
}

export interface DeliverSmsArgs {
  accountId: string
  /** Destinatario en E.164 CON '+': los dos proveedores lo exigen. */
  to: string
  text: string
  /** Para la comprobación de baja. Null en un envío a un número suelto. */
  contactId: string | null
  /** Hilo donde persistir. Null = no hay conversación que tocar. */
  conversationId: string | null
}

export interface DeliverSmsResult {
  provider: SmsProviderId
  providerMessageId: string
  /** Número emisor. Con Messaging Service de Twilio solo se sabe a posteriori. */
  from: string
  /** Id de la fila de `messages`. Null si no había hilo o el insert falló. */
  messageId: string | null
  conversationId: string | null
}

export async function deliverSms(
  db: SupabaseClient,
  args: DeliverSmsArgs,
): Promise<DeliverSmsResult> {
  // La baja se comprueba ANTES de tocar al proveedor: un SMS entregado no
  // se des-envía, y además se factura.
  if (args.contactId) {
    await assertSmsNotSuppressed(db, args.contactId)
  }

  // Quién manda el SMS lo decide `provider_routing` (073), no este módulo.
  const provider = await resolveSmsProvider(args.accountId)
  const { providerMessageId, from } = await provider.send(args.accountId, {
    to: args.to,
    text: args.text,
  })

  const telnyxMsgId = provider.id === 'telnyx' ? providerMessageId : null
  const base = { provider: provider.id, providerMessageId, from }

  // Sin hilo no hay dónde guardarlo. El SMS ya salió: devolverlo como
  // error sería mentir sobre lo que recibió el cliente.
  if (!args.conversationId) {
    return { ...base, messageId: null, conversationId: null }
  }

  const ts = new Date().toISOString()
  const { data: inserted, error: insErr } = await db
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender_type: 'agent',
      content_type: 'text',
      content_text: args.text,
      channel: 'sms',
      status: 'sent',
      metadata: { telnyx_message_id: telnyxMsgId },
      provider: provider.id,
      provider_message_id: providerMessageId,
      created_at: ts,
    })
    .select('id')
    .single()

  if (insErr) {
    // Mismo criterio que el engine: el envío YA ocurrió, así que un fallo
    // al guardar se registra pero no convierte la operación en un error.
    // El precio es un SMS invisible en el inbox, no un doble envío.
    console.error('[sms] outbound persist failed:', insErr.message)
    return { ...base, messageId: null, conversationId: args.conversationId }
  }

  // Bump de la conversación igual que el resto del inbox. `unread_count`
  // NO se toca: es un saliente.
  await db
    .from('conversations')
    .update({ last_message_text: args.text, last_message_at: ts })
    .eq('id', args.conversationId)

  return {
    ...base,
    messageId: (inserted as { id: string } | null)?.id ?? null,
    conversationId: args.conversationId,
  }
}
