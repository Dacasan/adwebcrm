import { type NextRequest } from 'next/server'

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadTwilioConfigByWebhookToken, twilioWebhookPath } from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/{webhook_token}/sms/status — ciclo de vida del SMS
// saliente (`statusCallback` de messages.create).
//
//   queued | accepted | sending   → se ignoran (ruido previo al envío)
//   sent                          → messages.status = 'sent'
//   delivered                     → 'delivered' + trigger message_delivered
//   undelivered | failed          → 'failed'    + trigger message_failed
//
// La fila se busca por (provider='twilio', provider_message_id=MessageSid),
// el par genérico de la 076.
// ============================================================

export const runtime = 'nodejs'

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

function xml(status = 200): Response {
  return new Response(EMPTY_TWIML, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

type MessageStatus = 'sent' | 'delivered' | 'failed'

function mapStatus(twilioStatus: string): MessageStatus | null {
  switch (twilioStatus) {
    case 'sent':
      return 'sent'
    case 'delivered':
    case 'read':
      return 'delivered'
    case 'undelivered':
    case 'failed':
      return 'failed'
    default:
      // queued, accepted, sending, scheduled, canceled: sin estado nuevo
      // que persistir. `canceled` nunca llega a red, así que tampoco es
      // un fallo de entrega.
      return null
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  const cfg = await loadTwilioConfigByWebhookToken(token)
  if (!cfg) return xml(404)

  const limit = checkRateLimit(`twilio-webhook:${token}`, RATE_LIMITS.twilioWebhook)
  if (!limit.success) return xml(429)

  const raw = await req.text()
  const params = parseFormBody(raw)

  const check = verifyTwilioSignature({
    authToken: cfg.authToken,
    signature: req.headers.get('x-twilio-signature'),
    path: twilioWebhookPath(token, '/sms/status'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:sms] status signature rejected (${check.reason})`)
    return xml(403)
  }

  const messageSid = params.MessageSid ?? params.SmsSid ?? ''
  const status = mapStatus(params.MessageStatus ?? params.SmsStatus ?? '')
  if (!messageSid || !status) return xml()

  try {
    const admin = supabaseAdmin()
    const { data: msg } = await admin
      .from('messages')
      .select('id, status, conversation_id, metadata, conversations(account_id, contact_id)')
      .eq('provider', 'twilio')
      .eq('provider_message_id', messageSid)
      .maybeSingle()

    if (!msg) {
      console.warn(`[twilio:sms] status for unknown message ${messageSid}, ignored`)
      return xml()
    }

    const conv = msg.conversations as unknown as {
      account_id: string
      contact_id: string | null
    } | null

    // Aislamiento de tenancy: un token válido de la cuenta A no puede
    // mover una fila de la cuenta B aunque adivine su MessageSid.
    if (!conv?.account_id || conv.account_id !== cfg.accountId) {
      console.warn(`[twilio:sms] status for ${messageSid} crosses accounts, ignored`)
      return xml()
    }

    // Idempotencia: Twilio reentrega. Si el estado ya es el mismo, no se
    // vuelve a escribir ni se vuelve a disparar la automatización.
    if (msg.status === status) return xml()

    const metadata = {
      ...((msg.metadata as Record<string, unknown> | null) ?? {}),
      ...(params.ErrorCode ? { twilio_error_code: params.ErrorCode } : {}),
      ...(params.ErrorMessage ? { twilio_error_message: params.ErrorMessage } : {}),
    }

    await admin.from('messages').update({ status, metadata }).eq('id', msg.id)

    if (status !== 'sent' && conv.contact_id) {
      await runAutomationsForTrigger({
        accountId: cfg.accountId,
        triggerType: status === 'delivered' ? 'message_delivered' : 'message_failed',
        contactId: conv.contact_id,
        context: { conversation_id: msg.conversation_id },
      }).catch((err) =>
        console.error('[automations] twilio sms delivery dispatch failed:', err),
      )
    }
  } catch (err) {
    console.error('[twilio:sms] status handler error:', err)
  }

  return xml()
}
