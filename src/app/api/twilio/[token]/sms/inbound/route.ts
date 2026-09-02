import { type NextRequest } from 'next/server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { ingestInboundSms } from '@/lib/inbound/sms-ingest'
import { loadTwilioConfigByWebhookToken, twilioWebhookPath } from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/{webhook_token}/sms/inbound — SMS entrante.
//
// Orden NO negociable (§4.2):
//   1. token de la ruta → cuenta. Sin fila: 404 y se acabó. 404 y no 403
//      a propósito: un 403 confirmaría que el token existe.
//   2. verificar la firma con el Auth Token DE ESA CUENTA.
//   3. solo entonces, tocar la base de datos.
//
// La respuesta es TwiML vacío con `text/xml`. Si se responde JSON, Twilio
// lo marca como error 12300 en el debugger aunque el status sea 200.
// ============================================================

export const runtime = 'nodejs'

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

function notFound(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 404,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params

  const cfg = await loadTwilioConfigByWebhookToken(token)
  if (!cfg) return notFound()

  const limit = checkRateLimit(`twilio-webhook:${token}`, RATE_LIMITS.twilioWebhook)
  if (!limit.success) return xml(EMPTY_TWIML, 429)

  const raw = await req.text()
  const params = parseFormBody(raw)

  const check = verifyTwilioSignature({
    authToken: cfg.authToken,
    signature: req.headers.get('x-twilio-signature'),
    path: twilioWebhookPath(token, '/sms/inbound'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:sms] signature rejected (${check.reason})`)
    return xml('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 403)
  }

  // A partir de aquí el payload está autenticado.
  const from = params.From ?? ''
  const messageSid = params.MessageSid ?? params.SmsSid ?? ''
  const numMedia = Number(params.NumMedia ?? '0')

  try {
    const result = await ingestInboundSms(supabaseAdmin(), {
      accountId: cfg.accountId,
      from,
      text: params.Body ?? '',
      provider: 'twilio',
      providerMessageId: messageSid,
      metadata: {
        twilio_to: params.To ?? null,
        // El MMS entrante se registra como texto con la cuenta de
        // adjuntos: el espejado de media entrante (061) es de WhatsApp y
        // migrarlo a SMS es otro trabajo. Perder la señal sería peor.
        ...(Number.isFinite(numMedia) && numMedia > 0 ? { twilio_num_media: numMedia } : {}),
      },
    })
    if (result.status === 'ignored') {
      console.warn(`[twilio:sms] inbound ignored: ${result.reason}`)
    }
  } catch (err) {
    // Nunca se devuelve 500: Twilio reintentaría el mismo mensaje y el
    // fallo (ya logueado) se repetiría en bucle.
    console.error('[twilio:sms] inbound handler error:', err)
  }

  return xml(EMPTY_TWIML)
}
