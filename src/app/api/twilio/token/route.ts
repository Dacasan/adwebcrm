import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ProviderError, ProviderNotConfiguredError } from '@/lib/providers/errors'
import { twilioVoice } from '@/lib/providers/twilio/voice'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/twilio/token — Access Token del softphone. Rol: agent.
//
// Se firma con la API Key de la cuenta (creada sola la primera vez), no
// con el Auth Token. La identidad es `u_<uuid sin guiones>`: Twilio solo
// admite alfanuméricos y guiones bajos, y un UUID con guiones NO da error
// — simplemente no registra el dispositivo y las entrantes nunca suenan.
//
// TTL de una hora. El cliente DEBE refrescar con `tokenWillExpire`; sin
// eso la sesión muere en silencio a los 60 minutos y es el fallo más
// común de esta integración.
// ============================================================

export const runtime = 'nodejs'

export async function POST() {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(`twilio-token:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const token = await twilioVoice.issueClientToken(ctx.accountId, ctx.userId)

    return NextResponse.json({
      provider: token.provider,
      token: token.token,
      identity: token.identity,
      expiresIn: token.expiresIn,
      capabilities: twilioVoice.capabilities,
    })
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      // `retryable: false` — el hook lo lee para distinguir "falta
      // configurar Twilio" de "el servidor tuvo un mal rato", y pintar
      // `config_error` en vez de reintentar para siempre.
      return NextResponse.json({ error: err.message, retryable: false }, { status: 404 })
    }
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 })
    }
    return toErrorResponse(err)
  }
}
