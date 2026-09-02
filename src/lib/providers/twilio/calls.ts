import type { SupabaseClient } from '@supabase/supabase-js'

import { OFFLINE_AFTER_MS } from '@/lib/presence'
import { agentIdentity } from './identity'

// ============================================================
// Persistencia de llamadas de Twilio. Separado del adaptador porque aquí
// no hay SDK: solo la tabla `calls` y el par (provider, provider_call_id)
// de la migración 076.
// ============================================================

export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'ended' | 'failed'

/**
 * Alta o actualización de la fila de una llamada. Upsert sobre
 * (provider, provider_call_id) — el índice único parcial de la 076 — para
 * que una reentrega del mismo `CallSid` NUNCA cree una segunda fila.
 */
export async function upsertTwilioCall(
  admin: SupabaseClient,
  args: {
    accountId: string
    callSid: string
    direction: 'inbound' | 'outbound'
    status: CallStatus
    fromNumber: string
    toNumber: string
    contactId?: string | null
  },
): Promise<void> {
  const { error } = await admin.from('calls').upsert(
    {
      account_id: args.accountId,
      contact_id: args.contactId ?? null,
      direction: args.direction,
      status: args.status,
      from_number: args.fromNumber,
      to_number: args.toNumber,
      provider: 'twilio',
      provider_call_id: args.callSid,
    },
    { onConflict: 'provider,provider_call_id', ignoreDuplicates: true },
  )
  if (error) console.error('[twilio:voice] call upsert failed:', error.message)
}

/** Parche sobre una fila ya existente, localizada por CallSid + cuenta. */
export async function patchTwilioCall(
  admin: SupabaseClient,
  accountId: string,
  callSid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('calls')
    .update(patch)
    .eq('provider', 'twilio')
    .eq('provider_call_id', callSid)
    // Aislamiento de tenancy: aunque el CallSid viniera de otra cuenta,
    // el UPDATE no puede tocarla.
    .eq('account_id', accountId)
  if (error) console.error('[twilio:voice] call patch failed:', error.message)
}

export async function findTwilioCall(
  admin: SupabaseClient,
  accountId: string,
  callSid: string,
): Promise<{ id: string; contact_id: string | null; disposition: string | null } | null> {
  const { data } = await admin
    .from('calls')
    .select('id, contact_id, disposition')
    .eq('provider', 'twilio')
    .eq('provider_call_id', callSid)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as { id: string; contact_id: string | null; disposition: string | null } | null) ?? null
}

/**
 * Identidades de softphone que deben sonar: los miembros con heartbeat
 * fresco en `member_presence` (024).
 *
 * El umbral es `OFFLINE_AFTER_MS` de `@/lib/presence` — la MISMA constante
 * que usa el roster de la UI. Escribir aquí otro número haría que un
 * agente apareciera en verde y no le sonara el teléfono, que es la clase
 * de incoherencia que nadie diagnostica.
 */
export async function connectedAgentIdentities(
  admin: SupabaseClient,
  accountId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const cutoff = new Date(now - OFFLINE_AFTER_MS).toISOString()
  const { data, error } = await admin
    .from('member_presence')
    .select('user_id')
    .eq('account_id', accountId)
    .gte('last_seen_at', cutoff)

  if (error) {
    console.error('[twilio:voice] presence lookup failed:', error.message)
    return []
  }
  return ((data as { user_id: string }[] | null) ?? []).map((row) => agentIdentity(row.user_id))
}
