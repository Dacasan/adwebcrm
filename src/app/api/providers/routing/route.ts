import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  loadProviderRouting,
  saveProviderRouting,
  type ProviderRouting,
} from '@/lib/providers/routing'
import { isEmailProviderId, isSmsProviderId, isVoiceProviderId } from '@/lib/providers/types'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { VOICE_CAPABILITIES_BY_PROVIDER } from '@/lib/providers/capabilities'

// ============================================================
// /api/providers/routing — qué proveedor sirve cada canal.
//
// GET  viewer+ : la UI necesita saberlo para pintar solo los botones que
//                el proveedor activo soporta (§6.3).
// PUT  owner   : cambiar de proveedor mueve tráfico facturado.
//
// La respuesta incluye las capacidades de voz para que el cliente no
// tenga que replicar la tabla de divergencias.
// ============================================================

export const runtime = 'nodejs'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const routing = await loadProviderRouting(ctx.accountId)
    return NextResponse.json({
      ...routing,
      capabilities: VOICE_CAPABILITIES_BY_PROVIDER[routing.voice],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await requireRole('owner')

    const limit = checkRateLimit(`provider-routing:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    const patch: Partial<ProviderRouting> = {}
    if (body.voice !== undefined) {
      if (!isVoiceProviderId(body.voice)) {
        return NextResponse.json({ error: 'voice must be telnyx or twilio' }, { status: 400 })
      }
      patch.voice = body.voice
    }
    if (body.sms !== undefined) {
      if (!isSmsProviderId(body.sms)) {
        return NextResponse.json({ error: 'sms must be telnyx or twilio' }, { status: 400 })
      }
      patch.sms = body.sms
    }
    if (body.email !== undefined) {
      if (!isEmailProviderId(body.email)) {
        return NextResponse.json({ error: 'email must be resend or sendgrid' }, { status: 400 })
      }
      patch.email = body.email
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    // Se escribe con `ctx.supabase`, no service-role: la policy owner-only
    // de la 073 es quien autoriza de verdad.
    await saveProviderRouting(ctx.supabase, ctx.accountId, patch)

    const routing = await loadProviderRouting(ctx.accountId)
    return NextResponse.json({
      ...routing,
      capabilities: VOICE_CAPABILITIES_BY_PROVIDER[routing.voice],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
