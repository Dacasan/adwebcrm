import { type NextRequest } from 'next/server'

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { findContactByPhone } from '@/lib/inbound/resolve'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { findTwilioCall, patchTwilioCall } from '@/lib/providers/twilio/calls'
import {
  loadTwilioConfigByWebhookToken,
  twilioWebhookPath,
  twilioWebhookUrl,
} from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import { hangupTwiML, voicemailTwiML } from '@/lib/providers/twilio/twiml'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/{webhook_token}/voice/action — el `action` del <Dial>.
//
// Aquí vive la DETECCIÓN DE PERDIDA, y es mucho más limpia que el
// `isMissedInbound()` de Telnyx (que tenía que adivinarlo cruzando
// hangup_cause y hangup_leg). Twilio lo dice explícitamente:
//
//   DialCallStatus ∈ {no-answer, busy, failed, canceled} → perdida
//   DialCallStatus = completed                           → atendida
//
// El `context` de la automatización conserva EXACTAMENTE las mismas
// claves que hoy (`call_id`, `call_direction`, `call_hangup_cause`,
// `missed_call_number`): hay automatizaciones de clientes leyéndolas.
// ============================================================

export const runtime = 'nodejs'
export const maxDuration = 30

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

const MISSED = new Set(['no-answer', 'busy', 'failed', 'canceled'])

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  const cfg = await loadTwilioConfigByWebhookToken(token)
  if (!cfg) return xml(hangupTwiML(), 404)

  const limit = checkRateLimit(`twilio-webhook:${token}`, RATE_LIMITS.twilioWebhook)
  if (!limit.success) return xml(hangupTwiML(), 429)

  const raw = await req.text()
  const params = parseFormBody(raw)

  const check = verifyTwilioSignature({
    authToken: cfg.authToken,
    signature: req.headers.get('x-twilio-signature'),
    path: twilioWebhookPath(token, '/voice/action'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:voice] action signature rejected (${check.reason})`)
    return xml(hangupTwiML(), 403)
  }

  const callSid = params.CallSid ?? ''
  const dialStatus = params.DialCallStatus ?? ''
  const from = params.From ?? ''
  const direction = from.startsWith('client:') ? 'outbound' : 'inbound'

  if (!callSid) return xml(hangupTwiML())

  try {
    const admin = supabaseAdmin()

    if (!MISSED.has(dialStatus)) {
      // Atendida (`completed`) o un estado que no dice nada: se marca la
      // disposición y se cuelga. NO se dispara ninguna automatización.
      if (dialStatus === 'completed') {
        await patchTwilioCall(admin, cfg.accountId, callSid, { disposition: 'completed' })
      }
      return xml(hangupTwiML())
    }

    // ---- Perdida ----
    const existing = await findTwilioCall(admin, cfg.accountId, callSid)

    // Idempotencia: Twilio reentrega el action. Una llamada ya marcada
    // como perdida no vuelve a disparar la automatización.
    const alreadyMissed = existing?.disposition === 'missed'
    await patchTwilioCall(admin, cfg.accountId, callSid, {
      disposition: 'missed',
      hangup_cause: dialStatus,
    })

    if (!alreadyMissed && direction === 'inbound') {
      const contact = existing?.contact_id
        ? { id: existing.contact_id }
        : await findContactByPhone(admin, cfg.accountId, from)

      await runAutomationsForTrigger({
        accountId: cfg.accountId,
        triggerType: 'missed_call',
        contactId: contact?.id ?? null,
        context: {
          call_id: callSid,
          call_direction: 'inbound',
          call_hangup_cause: dialStatus,
          missed_call_number: from || undefined,
        },
      }).catch((err) => console.error('[automations] missed_call dispatch failed:', err))
    }

    // Que quien llamó pueda dejar mensaje en vez de escuchar un corte.
    return xml(
      voicemailTwiML({
        message:
          'No hemos podido atenderte. Deja tu mensaje después de la señal y te devolvemos la llamada.',
        recordingCallbackUrl: cfg.recordingEnabled
          ? twilioWebhookUrl(cfg.webhookToken, '/voice/recording')
          : null,
      }),
    )
  } catch (err) {
    console.error('[twilio:voice] action handler error:', err)
    return xml(hangupTwiML())
  }
}
