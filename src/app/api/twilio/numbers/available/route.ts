import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ProviderError, ProviderNotConfiguredError } from '@/lib/providers/errors'
import { listAvailableNumbers } from '@/lib/providers/twilio/numbers'

// ============================================================
// GET /api/twilio/numbers/available?country=ES&area_code=91 — inventario
// de números comprables. agent+ (mirar no compra nada).
// ============================================================

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    const url = new URL(req.url)
    const country = (url.searchParams.get('country') ?? '').trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) {
      return NextResponse.json(
        { error: 'country must be a 2-letter ISO code (ES, US, MX…)' },
        { status: 400 },
      )
    }

    const areaCodeRaw = url.searchParams.get('area_code')
    const areaCode = areaCodeRaw ? Number(areaCodeRaw) : undefined
    if (areaCodeRaw && !Number.isInteger(areaCode)) {
      return NextResponse.json({ error: 'area_code must be a number' }, { status: 400 })
    }

    const numbers = await listAvailableNumbers(ctx.accountId, {
      country,
      areaCode,
      contains: url.searchParams.get('contains')?.trim() || undefined,
      limit: 20,
    })

    return NextResponse.json({ provider: 'twilio', country, numbers })
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
