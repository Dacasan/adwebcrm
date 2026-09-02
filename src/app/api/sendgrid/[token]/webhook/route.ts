import { NextResponse, type NextRequest } from 'next/server'

import { loadSendGridConfigByWebhookToken } from '@/lib/providers/sendgrid/config'
import { verifySendGridSignature } from '@/lib/providers/sendgrid/signature'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/supabase/admin'

// ============================================================
// POST /api/sendgrid/{webhook_token}/webhook — Signed Event Webhook.
//
// Reglas, en este orden:
//   1. token → cuenta (404 si no existe).
//   2. sin `webhook_public_key` en la config → 503, igual que hoy hace el
//      de Resend sin `RESEND_WEBHOOK_SECRET`. Fail-closed.
//   3. verificar la firma sobre el rawBody COMPLETO antes de parsear.
//   4. procesar en lote: un solo RPC por (envío, tipo de evento).
//   5. ackear 200 SIEMPRE tras verificar. SendGrid reintenta muy
//      agresivamente y un 500 por una fila ausente devuelve el lote
//      entero, una y otra vez.
// ============================================================

export const runtime = 'nodejs'
export const maxDuration = 30

type Trigger = 'delivered' | 'bounced' | 'opened' | 'clicked' | 'suppressed'

interface SendGridEvent {
  event?: string
  sg_message_id?: string
  /** custom_arg: uuid de `email_sends` (transaccional). */
  email_send_id?: string
  /** custom_arg: uuid de `email_campaign_recipients` (campañas). */
  campaign_recipient_id?: string
  account_id?: string
  [k: string]: unknown
}

function mapEvent(event: string): Trigger | null {
  switch (event) {
    case 'delivered':
      return 'delivered'
    case 'bounce':
    case 'dropped':
    case 'blocked':
      return 'bounced'
    case 'open':
      return 'opened'
    case 'click':
      return 'clicked'
    case 'spamreport':
    case 'unsubscribe':
      // No tienen análogo en el modelo de Resend. No se tiran: sellan
      // `email_sends.suppressed_at` (077). La gestión completa de
      // supresiones (ASM groups, sincronización de listas) queda fuera de
      // alcance — plan §10.
      return 'suppressed'
    default:
      // processed, deferred, group_unsubscribe, group_resubscribe…
      return null
  }
}

/**
 * `sg_message_id` del webhook = `{x-message-id}.recvd-...`. Comparten
 * prefijo pero NO son iguales, así que para cruzarlo con lo que
 * guardamos al enviar hay que quedarse con la parte anterior al punto.
 */
function normalizeMessageId(sgMessageId: string): string {
  const dot = sgMessageId.indexOf('.')
  return dot === -1 ? sgMessageId : sgMessageId.slice(0, dot)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  const cfg = await loadSendGridConfigByWebhookToken(token)
  if (!cfg) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const limit = checkRateLimit(`sendgrid-webhook:${token}`, RATE_LIMITS.sendgridWebhook)
  if (!limit.success) return NextResponse.json({ error: 'rate limited' }, { status: 429 })

  if (!cfg.webhookPublicKey) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  const raw = await req.text()

  const check = verifySendGridSignature({
    publicKeyB64: cfg.webhookPublicKey,
    signatureB64: req.headers.get('x-twilio-email-event-webhook-signature'),
    timestamp: req.headers.get('x-twilio-email-event-webhook-timestamp'),
    rawBody: raw,
  })
  if (!check.ok) {
    console.warn(`[sendgrid:webhook] signature rejected (${check.reason})`)
    return NextResponse.json({ error: 'invalid signature' }, { status: 403 })
  }

  let events: SendGridEvent[]
  try {
    const parsed = JSON.parse(raw)
    events = Array.isArray(parsed) ? (parsed as SendGridEvent[]) : []
  } catch {
    return NextResponse.json({ error: 'bad body' }, { status: 400 })
  }

  try {
    await processEvents(cfg.accountId, events)
  } catch (err) {
    // Se loguea y se ackea igualmente: devolver 500 traería el lote entero
    // de vuelta, con el mismo resultado.
    console.error('[sendgrid:webhook] batch processing failed:', err)
  }

  return NextResponse.json({ ok: true })
}

/** Clave de agrupación: preferimos el uuid propio; el id del proveedor es el respaldo. */
function groupKey(
  sendId: string | null,
  recipientId: string | null,
  messageId: string | null,
): string | null {
  if (sendId) return `send:${sendId}`
  if (recipientId) return `rcpt:${recipientId}`
  if (messageId) return `msg:${messageId}`
  return null
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

async function processEvents(accountId: string, events: SendGridEvent[]): Promise<void> {
  const groups = new Map<
    string,
    {
      sendId: string | null
      recipientId: string | null
      messageId: string | null
      triggers: Set<Trigger>
    }
  >()

  for (const event of events) {
    const trigger = mapEvent(typeof event.event === 'string' ? event.event : '')
    if (!trigger) continue

    // Aislamiento de tenancy, primera línea: `account_id` viaja en
    // custom_args en todo lo que mandamos nosotros. Si viene y no es esta
    // cuenta, el evento no es nuestro.
    if (typeof event.account_id === 'string' && event.account_id !== accountId) continue

    const sendId = uuidOrNull(event.email_send_id)
    const recipientId = uuidOrNull(event.campaign_recipient_id)
    const messageId =
      typeof event.sg_message_id === 'string' ? normalizeMessageId(event.sg_message_id) : null

    const key = groupKey(sendId, recipientId, messageId)
    if (!key) continue

    const group = groups.get(key)
    if (group) group.triggers.add(trigger)
    else groups.set(key, { sendId, recipientId, messageId, triggers: new Set([trigger]) })
  }

  if (groups.size === 0) return

  const admin = supabaseAdmin()

  // Aislamiento de tenancy, segunda línea: para los eventos sin
  // `account_id` (envíos anteriores, o mandados desde fuera del CRM con
  // la misma API key) se comprueba contra la BD que la fila es de esta
  // cuenta. Dos consultas por lote, no una por evento.
  const all = [...groups.values()]
  const sendIds = all.map((g) => g.sendId).filter((v): v is string => !!v)
  const recipientIds = all
    .filter((g) => !g.sendId)
    .map((g) => g.recipientId)
    .filter((v): v is string => !!v)
  const messageIds = all
    .filter((g) => !g.sendId && !g.recipientId)
    .map((g) => g.messageId)
    .filter((v): v is string => !!v)

  const allowedSendIds = new Set<string>()
  if (sendIds.length > 0) {
    const { data } = await admin
      .from('email_sends')
      .select('id')
      .eq('account_id', accountId)
      .in('id', sendIds)
    for (const row of (data as { id: string }[] | null) ?? []) allowedSendIds.add(row.id)
  }

  // Los recipients de campaña no llevan `account_id`: se comprueban vía
  // su campaña. Dos consultas planas en vez de un embed de PostgREST,
  // que falla con PGRST200 cuando la caché de esquema va retrasada.
  const allowedRecipientIds = new Set<string>()
  if (recipientIds.length > 0) {
    const { data: rows } = await admin
      .from('email_campaign_recipients')
      .select('id, email_campaign_id')
      .in('id', recipientIds)
    const candidates = (rows as { id: string; email_campaign_id: string }[] | null) ?? []
    if (candidates.length > 0) {
      const { data: campaigns } = await admin
        .from('email_campaigns')
        .select('id')
        .eq('account_id', accountId)
        .in('id', [...new Set(candidates.map((c) => c.email_campaign_id))])
      const ownCampaigns = new Set(
        ((campaigns as { id: string }[] | null) ?? []).map((c) => c.id),
      )
      for (const row of candidates) {
        if (ownCampaigns.has(row.email_campaign_id)) allowedRecipientIds.add(row.id)
      }
    }
  }

  const allowedMessageIds = new Set<string>()
  if (messageIds.length > 0) {
    const [sends, recipients] = await Promise.all([
      admin
        .from('email_sends')
        .select('provider_message_id')
        .eq('account_id', accountId)
        .eq('provider', 'sendgrid')
        .in('provider_message_id', messageIds),
      admin
        .from('email_campaign_recipients')
        .select('provider_message_id')
        .eq('provider', 'sendgrid')
        .in('provider_message_id', messageIds),
    ])
    for (const row of (sends.data as { provider_message_id: string }[] | null) ?? []) {
      allowedMessageIds.add(row.provider_message_id)
    }
    for (const row of (recipients.data as { provider_message_id: string }[] | null) ?? []) {
      allowedMessageIds.add(row.provider_message_id)
    }
  }

  for (const group of groups.values()) {
    const authorized = group.sendId
      ? allowedSendIds.has(group.sendId)
      : group.recipientId
        ? allowedRecipientIds.has(group.recipientId)
        : group.messageId
          ? allowedMessageIds.has(group.messageId)
          : false
    if (!authorized) {
      console.warn('[sendgrid:webhook] event outside this account, ignored')
      continue
    }

    for (const trigger of group.triggers) {
      const { error } = await admin.rpc('_on_email_webhook_v2', {
        p_provider: 'sendgrid',
        p_message_id: group.messageId ?? '',
        p_trigger: trigger,
        p_send_id: group.sendId,
        p_recipient_id: group.recipientId,
      })
      if (error) {
        console.error(`[sendgrid:webhook] rpc ${trigger} failed: ${error.message}`)
      }
    }
  }
}
