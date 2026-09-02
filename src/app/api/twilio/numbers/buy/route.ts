import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  ProviderError,
  ProviderNotConfiguredError,
  RegulatoryBundleRequiredError,
} from '@/lib/providers/errors'
import { buyNumber } from '@/lib/providers/twilio/numbers'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// POST /api/twilio/numbers/buy — compra un número. owner.
//
// NO HAY GATE DE REPUTACIÓN, y no es un olvido: Twilio no publica un
// score del número que compras (§Fase 5). Lo que sí bloquea la compra:
//   · el número ya no está disponible          → 4xx de Twilio
//   · falta el Regulatory Bundle o la dirección → 409 accionable
// ============================================================

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('owner')

    const limit = checkRateLimit(`twilio-buy:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await req.json().catch(() => ({}))) as { number?: string; country?: string }
    const number = typeof body.number === 'string' ? body.number.trim() : ''
    if (!number) {
      return NextResponse.json({ error: 'number is required' }, { status: 400 })
    }
    if (!isValidE164(number)) {
      return NextResponse.json(
        { error: 'number must be a valid E.164 phone number' },
        { status: 400 },
      )
    }

    const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : null
    const bought = await buyNumber(ctx.accountId, `+${normalizePhone(number)}`, country)

    return NextResponse.json({
      ok: true,
      provider: 'twilio',
      sid: bought.sid,
      number: bought.phoneNumber,
      voice_url: bought.voiceUrl,
      sms_url: bought.smsUrl,
      note: 'number purchased and already pointed at this account webhooks',
    })
  } catch (err) {
    if (err instanceof RegulatoryBundleRequiredError) {
      return NextResponse.json(
        {
          error: 'regulatory_bundle_required',
          country: err.country,
          message: err.message,
        },
        { status: 409 },
      )
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 })
    }
    return toErrorResponse(err)
  }
}
