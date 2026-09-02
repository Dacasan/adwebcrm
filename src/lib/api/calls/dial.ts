import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ProviderError, ProviderNotConfiguredError } from '@/lib/providers/errors'
import { resolveVoiceProvider } from '@/lib/providers/registry'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// Click-to-call agnóstico de proveedor. agent+.
//
// El handler vive en `lib/` y no en el `route.ts` porque lo sirven DOS
// rutas: `/api/calls/dial` y la histórica `/api/telnyx/call`. Next no
// admite reexportar `runtime` de otro route, así que cada una declara el
// suyo y comparte esta implementación.
//
// Sustituye a `/api/telnyx/call`, que sigue existiendo y re-exporta esta
// (los componentes `today-queue` y `contact-sidebar` la llaman por su
// nombre viejo). Quién marca lo decide `provider_routing`, no la URL.
//
// La fila de `calls` se inserta VÍA ctx.supabase (cliente-user) para que
// la policy `calls_insert` (agent+) refuerce el rol en RLS — decisión
// original de la 039, que este cambio no toca.
// ============================================================

export async function handleDial(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(`dial:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    let body: { contactId?: string; agentIdentity?: string }
    try {
      body = (await req.json()) as { contactId?: string; agentIdentity?: string }
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }
    if (!body.contactId) {
      return NextResponse.json({ error: 'contactId is required' }, { status: 400 })
    }

    const contact = await ctx.supabase
      .from('contacts')
      .select('id, phone')
      .eq('id', body.contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!contact.data) {
      return NextResponse.json({ error: 'contact not found' }, { status: 404 })
    }

    const to = `+${normalizePhone((contact.data.phone as string | null) ?? '')}`
    if (!isValidE164(to)) {
      return NextResponse.json({ error: 'contact has no valid phone' }, { status: 400 })
    }

    const provider = await resolveVoiceProvider(ctx.accountId)
    const dialed = await provider.dial(ctx.accountId, {
      to,
      contactId: contact.data.id as string,
      agentIdentity: body.agentIdentity,
    })

    const { error } = await ctx.supabase.from('calls').insert({
      account_id: ctx.accountId,
      contact_id: contact.data.id,
      direction: 'outbound',
      status: 'initiated',
      from_number: dialed.from,
      to_number: to,
      provider: provider.id,
      provider_call_id: dialed.providerCallId,
      // Compatibilidad: el webhook de Telnyx sigue buscando por la
      // columna vieja. Para Twilio se deja nula.
      ...(provider.id === 'telnyx'
        ? { telnyx_call_control_id: dialed.providerCallId }
        : {}),
    })
    if (error) {
      return NextResponse.json({ error: 'could not log call' }, { status: 500 })
    }

    // La respuesta es EXACTAMENTE la que devolvía `/api/telnyx/call`.
    // Añadir campos aquí no aporta nada al front y rompería su test.
    return NextResponse.json({ ok: true, callControlId: dialed.providerCallId })
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 })
    }
    // Telnyx lanza su propio error cuando la cuenta no está configurada;
    // la comprobación por mensaje se mantiene para no cambiar el status
    // que hoy recibe el front en ese caso.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('config not found')) {
      return NextResponse.json({ error: 'Telnyx is not configured for this account' }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
