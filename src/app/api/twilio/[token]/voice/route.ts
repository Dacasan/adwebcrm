import { type NextRequest } from 'next/server'

import { findContactByPhone } from '@/lib/inbound/resolve'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { connectedAgentIdentities, upsertTwilioCall } from '@/lib/providers/twilio/calls'
import {
  loadTwilioConfigByWebhookToken,
  twilioWebhookPath,
  twilioWebhookUrl,
  type TwilioConfig,
} from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import {
  hangupTwiML,
  inboundToClientsTwiML,
  inboundToNumberTwiML,
  outboundTwiML,
  voicemailTwiML,
} from '@/lib/providers/twilio/twiml'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/{webhook_token}/voice — la única ruta de TwiML.
//
// Dos ramas, y la discriminación es el parámetro `From`:
//
//   From = "client:u_xxx"  → SALIENTE desde el navegador. `To` viene de
//                            device.connect({ params: { To } }).
//   cualquier otra cosa    → ENTRANTE. `To` es el DID de la cuenta.
//
// La entrante hace TIMBRE SIMULTÁNEO sobre los agentes conectados con un
// <Client> por identidad; si no hay ninguno, desvía al `fallback_number`;
// y si tampoco lo hay, buzón. Nada de esto necesita el patrón de dos
// patas de Telnyx: Twilio enruta al navegador por la identidad del
// Access Token.
// ============================================================

export const runtime = 'nodejs'
export const maxDuration = 30

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

function dialUrls(cfg: TwilioConfig) {
  return {
    actionUrl: twilioWebhookUrl(cfg.webhookToken, '/voice/action'),
    statusCallbackUrl: twilioWebhookUrl(cfg.webhookToken, '/voice/status'),
    // La grabación es opt-in por cuenta y por defecto está apagada: en
    // España grabar exige informar y en EE. UU. hay estados de doble
    // consentimiento. Sin `recording_enabled` no se pide callback y por
    // tanto el <Dial> sale sin `record`.
    recordingCallbackUrl: cfg.recordingEnabled
      ? twilioWebhookUrl(cfg.webhookToken, '/voice/recording')
      : null,
  }
}

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
    path: twilioWebhookPath(token, '/voice'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:voice] signature rejected (${check.reason})`)
    return xml(hangupTwiML(), 403)
  }

  const from = params.From ?? ''
  const to = params.To ?? ''
  const callSid = params.CallSid ?? ''
  const urls = dialUrls(cfg)

  try {
    // ---- Rama saliente: la origina el softphone ----
    if (from.startsWith('client:')) {
      if (!to) return xml(hangupTwiML())
      if (!cfg.defaultFromNumber) {
        console.error('[twilio:voice] outbound without default_from_number')
        return xml(hangupTwiML())
      }

      const admin = supabaseAdmin()
      const contact = await findContactByPhone(admin, cfg.accountId, to)
      await upsertTwilioCall(admin, {
        accountId: cfg.accountId,
        callSid,
        direction: 'outbound',
        status: 'initiated',
        fromNumber: cfg.defaultFromNumber,
        toNumber: to,
        contactId: contact?.id ?? null,
      })

      return xml(outboundTwiML({ ...urls, callerId: cfg.defaultFromNumber, to }))
    }

    // ---- Rama entrante ----
    const admin = supabaseAdmin()
    const contact = await findContactByPhone(admin, cfg.accountId, from)
    await upsertTwilioCall(admin, {
      accountId: cfg.accountId,
      callSid,
      direction: 'inbound',
      status: 'ringing',
      fromNumber: from,
      toNumber: to,
      contactId: contact?.id ?? null,
    })

    const identities = await connectedAgentIdentities(admin, cfg.accountId)
    if (identities.length > 0) {
      // Un <Client> por agente dentro de un solo <Dial>: Twilio los hace
      // sonar a la vez y conecta al primero que descuelgue.
      return xml(
        inboundToClientsTwiML({
          ...urls,
          // El caller id de la pata hacia el navegador es quien llama, no
          // el DID: así el agente ve el número del paciente.
          callerId: from || (cfg.defaultFromNumber ?? to),
          identities,
        }),
      )
    }

    if (cfg.fallbackNumber) {
      return xml(
        inboundToNumberTwiML({
          ...urls,
          callerId: cfg.defaultFromNumber ?? to,
          to: cfg.fallbackNumber,
        }),
      )
    }

    return xml(
      voicemailTwiML({
        message:
          'Gracias por llamar. En este momento no podemos atenderte. Deja tu mensaje después de la señal y te devolvemos la llamada.',
        recordingCallbackUrl: urls.recordingCallbackUrl,
      }),
    )
  } catch (err) {
    // Un fallo aquí no puede dejar la llamada colgada en silencio: se
    // responde TwiML válido igualmente.
    console.error('[twilio:voice] handler error:', err)
    return xml(hangupTwiML())
  }
}
