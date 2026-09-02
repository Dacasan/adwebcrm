import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ProviderError, ProviderNotConfiguredError } from '@/lib/providers/errors'
import { checkNumber } from '@/lib/providers/twilio/lookup'
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// POST /api/twilio/numbers/check — validez, tipo de línea y carrier vía
// Lookup v2. agent+.
//
// `score` viene SIEMPRE null, con una `note` explicando que Twilio no
// publica reputación del número que compras. Es deliberado: el gate de
// reputación de Telnyx no tiene equivalente y simular uno sería vender
// una garantía inexistente.
// ============================================================

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    const body = (await req.json().catch(() => ({}))) as { number?: string }
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

    const result = await checkNumber(ctx.accountId, `+${normalizePhone(number)}`)
    return NextResponse.json({ provider: 'twilio', ...result })
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 })
    }
    return toErrorResponse(err)
  }
}
