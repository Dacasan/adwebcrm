import { type NextRequest } from 'next/server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { patchTwilioCall } from '@/lib/providers/twilio/calls'
import { loadTwilioConfigByWebhookToken, twilioWebhookPath } from '@/lib/providers/twilio/config'
import { parseFormBody, verifyTwilioSignature } from '@/lib/providers/twilio/signature'
import { hangupTwiML } from '@/lib/providers/twilio/twiml'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/{webhook_token}/voice/status — `statusCallback` de la
// llamada. Solo contabilidad: la detección de perdida vive en
// /voice/action, que es donde Twilio dice si el <Dial> conectó.
//
//   initiated | ringing   → status 'ringing'
//   in-progress           → 'answered' + answered_at
//   completed             → 'ended' + ended_at + duration_sec
//   busy|failed|no-answer|canceled → 'ended' + hangup_cause
// ============================================================

export const runtime = 'nodejs'

function xml(status = 200): Response {
  return new Response(hangupTwiML(), {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled'])

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
    path: twilioWebhookPath(token, '/voice/status'),
    params,
  })
  if (!check.ok) {
    console.warn(`[twilio:voice] status signature rejected (${check.reason})`)
    return xml(403)
  }

  const callSid = params.CallSid ?? ''
  const callStatus = params.CallStatus ?? ''
  if (!callSid || !callStatus) return xml()

  try {
    const admin = supabaseAdmin()
    const now = new Date().toISOString()

    if (callStatus === 'initiated' || callStatus === 'ringing') {
      await patchTwilioCall(admin, cfg.accountId, callSid, { status: 'ringing' })
    } else if (callStatus === 'in-progress') {
      await patchTwilioCall(admin, cfg.accountId, callSid, {
        status: 'answered',
        answered_at: now,
      })
    } else if (TERMINAL.has(callStatus)) {
      const duration = Number(params.CallDuration ?? '')
      await patchTwilioCall(admin, cfg.accountId, callSid, {
        status: 'ended',
        ended_at: now,
        ...(Number.isFinite(duration) && duration > 0 ? { duration_sec: duration } : {}),
        // `hangup_cause` guarda el CallStatus terminal de Twilio tal cual
        // ('busy', 'no-answer'…): es el vocabulario del proveedor y
        // traducirlo al de Telnyx solo perdería información.
        hangup_cause: callStatus,
      })
    }
  } catch (err) {
    console.error('[twilio:voice] status handler error:', err)
  }

  return xml()
}
