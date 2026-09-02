import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  isEmailProviderId,
  isSmsProviderId,
  isVoiceProviderId,
  type EmailProviderId,
  type SmsProviderId,
  type VoiceProviderId,
} from './types'

// ============================================================
// Lectura/escritura de `provider_routing` (migración 073).
//
// La regla de oro (§6.1): la ausencia de fila y un valor inesperado en BD
// resuelven al MISMO sitio — los defaults históricos. Ninguna cuenta
// cambia de comportamiento sin una escritura explícita, y un enum
// ensanchado en el futuro no puede tumbar el envío de un SMS.
// ============================================================

export interface ProviderRouting {
  voice: VoiceProviderId
  sms: SmsProviderId
  email: EmailProviderId
}

export const DEFAULT_ROUTING: ProviderRouting = {
  voice: 'telnyx',
  sms: 'telnyx',
  email: 'resend',
}

interface RoutingRow {
  voice_provider?: unknown
  sms_provider?: unknown
  email_provider?: unknown
}

/** Normaliza una fila cruda a un routing válido, cayendo al default y logueando. */
export function normalizeRouting(row: RoutingRow | null | undefined): ProviderRouting {
  if (!row) return { ...DEFAULT_ROUTING }

  const pick = <T>(
    value: unknown,
    guard: (v: unknown) => v is T,
    fallback: T,
    column: string,
  ): T => {
    if (value === null || value === undefined) return fallback
    if (guard(value)) return value
    // Un valor fuera del enum solo puede venir de una escritura manual o de
    // una migración futura. Degradar al default es preferible a lanzar: el
    // canal sigue funcionando por el camino conocido.
    console.warn(
      `[providers:routing] unexpected ${column}=${String(value)} — falling back to '${String(fallback)}'`,
    )
    return fallback
  }

  return {
    voice: pick(row.voice_provider, isVoiceProviderId, DEFAULT_ROUTING.voice, 'voice_provider'),
    sms: pick(row.sms_provider, isSmsProviderId, DEFAULT_ROUTING.sms, 'sms_provider'),
    email: pick(row.email_provider, isEmailProviderId, DEFAULT_ROUTING.email, 'email_provider'),
  }
}

/**
 * Routing efectivo de una cuenta. Nunca lanza: un error de BD también
 * cae a los defaults (con log) — el precio de fallar aquí sería no poder
 * enviar nada, y el camino histórico siempre está disponible.
 */
export async function loadProviderRouting(accountId: string): Promise<ProviderRouting> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('provider_routing')
      .select('voice_provider, sms_provider, email_provider')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.warn(`[providers:routing] read failed for ${accountId}: ${error.message}`)
      return { ...DEFAULT_ROUTING }
    }
    return normalizeRouting(data as RoutingRow | null)
  } catch (err) {
    // El try/catch no es decorativo: cubre el caso de que el propio
    // cliente service-role no pueda construirse (falta de env en un
    // proceso que solo quería mandar un SMS). Fallar aquí dejaría a la
    // cuenta sin canal; degradar al camino histórico la deja igual que
    // antes de este plan, que es exactamente el invariante de §6.1.
    console.warn(
      `[providers:routing] unavailable for ${accountId}, using defaults:`,
      err instanceof Error ? err.message : err,
    )
    return { ...DEFAULT_ROUTING }
  }
}

/**
 * Guarda el routing (upsert por account_id). Recibe el cliente Supabase
 * del CALLER — la ruta de settings usa `ctx.supabase` para que la policy
 * owner-only de la 073 sea quien autoriza, no el service-role.
 */
export async function saveProviderRouting(
  client: SupabaseClient,
  accountId: string,
  patch: Partial<ProviderRouting>,
): Promise<void> {
  const payload: Record<string, unknown> = { account_id: accountId }
  if (patch.voice) payload.voice_provider = patch.voice
  if (patch.sms) payload.sms_provider = patch.sms
  if (patch.email) payload.email_provider = patch.email

  const { error } = await client
    .from('provider_routing')
    .upsert(payload, { onConflict: 'account_id' })
  if (error) throw new Error(`could not save provider routing: ${error.message}`)
}
