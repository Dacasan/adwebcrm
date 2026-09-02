import { type NextRequest } from 'next/server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { findTwilioCall } from '@/lib/providers/twilio/calls'
import { loadTwilioConfigByWebhookToken, twilioWebhookPath } from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import { hangupTwiML } from '@/lib/providers/twilio/twiml'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { buildMediaPath } from '@/lib/storage/upload-media'

// ============================================================
// POST /api/twilio/{webhook_token}/voice/recording —
// `recordingStatusCallback`.
//
// DIFERENCIA IMPORTANTE CON TELNYX: la `RecordingUrl` de Twilio NO es una
// URL firmada pública. Requiere autenticación HTTP Basic con
// AccountSid:AuthToken. Descargarla "a pelo" devuelve 401 y deja la
// grabación fuera del bucket sin más síntoma que un log.
//
// El guard SSRF del webhook de Telnyx se mantiene, con otro allowlist:
// aquí solo `api.twilio.com`. El límite de tamaño y la comprobación de
// `content-length` también, por la misma razón: el payload podría estar
// manipulado y no vamos a traernos 4 GB a memoria por si acaso.
// ============================================================

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_RECORDING_BYTES = 200 * 1024 * 1024
const TWILIO_MEDIA_HOSTS = new Set(['api.twilio.com'])

function xml(status = 200): Response {
  return new Response(hangupTwiML(), {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
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
    path: twilioWebhookPath(token, '/voice/recording'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:voice] recording signature rejected (${check.reason})`)
    return xml(403)
  }

  const callSid = params.CallSid ?? ''
  const recordingUrl = params.RecordingUrl ?? ''
  const status = params.RecordingStatus ?? 'completed'

  if (status !== 'completed' || !callSid || !recordingUrl) return xml()

  try {
    let parsed: URL
    try {
      parsed = new URL(recordingUrl)
    } catch {
      console.warn('[twilio:voice] recording URL invalid, ignored')
      return xml()
    }
    if (parsed.protocol !== 'https:' || !TWILIO_MEDIA_HOSTS.has(parsed.hostname)) {
      console.warn(`[twilio:voice] recording host not allowed: ${parsed.hostname}, ignored`)
      return xml()
    }

    const admin = supabaseAdmin()
    const call = await findTwilioCall(admin, cfg.accountId, callSid)
    if (!call?.id) {
      console.warn('[twilio:voice] recording without a calls row, ignored')
      return xml()
    }

    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
    const res = await fetch(`${parsed.toString()}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error('[twilio:voice] recording download failed:', res.status)
      return xml()
    }

    const contentLength = Number(res.headers?.get?.('content-length') ?? 0)
    if (contentLength > MAX_RECORDING_BYTES) {
      console.error('[twilio:voice] recording exceeds maximum size, ignored')
      return xml()
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    // Segundo control: `content-length` puede faltar o mentir.
    if (buffer.byteLength > MAX_RECORDING_BYTES) {
      console.error('[twilio:voice] recording exceeds maximum size, ignored')
      return xml()
    }

    const path = buildMediaPath(cfg.accountId, 'recording.mp3')
    const { error: upErr } = await admin.storage
      .from('call-recordings')
      .upload(path, buffer, { contentType: 'audio/mpeg', upsert: false })
    if (upErr) {
      console.error('[twilio:voice] recording upload failed:', upErr.message)
      return xml()
    }

    await admin
      .from('calls')
      .update({
        recording_storage_path: path,
        // El bucket es privado: `recording_url` apunta al proxy
        // autenticado, nunca a Storage ni a Twilio.
        recording_url: `/api/calls/${call.id}/recording`,
      })
      .eq('id', call.id)
      .eq('account_id', cfg.accountId)
  } catch (err) {
    console.error('[twilio:voice] recording handler error:', err)
  }

  return xml()
}
