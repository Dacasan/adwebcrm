import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// Resolución de contacto y conversación para tráfico ENTRANTE.
//
// Extraído del webhook de Telnyx sin cambiar una coma de su semántica:
// lo usan ahora los dos webhooks de SMS (Telnyx y Twilio) y la detección
// de llamada perdida. Duplicarlo era el camino corto hacia dos
// convenciones distintas de "una conversación por (cuenta, contacto)".
// ============================================================

export async function findContactByPhone(
  admin: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<{ id: string } | null> {
  if (!phone) return null
  const { data } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone_normalized', normalizePhone(phone))
    .maybeSingle()
  return data
}

export async function findOrCreateConversation(
  admin: SupabaseClient,
  accountId: string,
  contactId: string,
  /** Opcional: user_id de auditoría. `conversations.user_id` es NOT NULL
   *  (001:142) — sin él, el INSERT de una conversación nueva falla. Lo
   *  pasan los flujos que lo conocen (email); los de SMS quedan como están. */
  userId?: string,
): Promise<{ id: string }> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (existing) return existing
  const { data: created } = await admin
    .from('conversations')
    .insert({
      contact_id: contactId,
      account_id: accountId,
      status: 'open',
      ...(userId ? { user_id: userId } : {}),
    })
    .select('id')
    .single()
  return created ?? { id: '' }
}

/** Contacto existente o recién creado a partir del número que escribe.
 *  `userId` es obligatorio: `contacts.user_id` es NOT NULL (001:38) —
 *  sin él el INSERT fallaba en silencio para contactos nuevos. */
export async function findOrCreateContactByPhone(
  admin: SupabaseClient,
  accountId: string,
  phone: string,
  userId: string,
): Promise<string | null> {
  const found = await findContactByPhone(admin, accountId, phone)
  if (found) return found.id
  const { data: inserted } = await admin
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone, name: null })
    .select('id')
    .single()
  return inserted?.id ?? null
}

/** Contacto existente o recién creado a partir del email que escribe.
 *  Espejo de findOrCreateContactByPhone para el canal email: la identidad
 *  del cliente es su dirección (contacts.email, 001) y se compara sin
 *  distinguir mayúsculas — Gmail y Outlook no distinguen, nosotros tampoco.
 *  `userId` es obligatorio: `contacts.user_id` es NOT NULL (001:38). */
export async function findOrCreateContactByEmail(
  admin: SupabaseClient,
  accountId: string,
  email: string,
  userId: string,
  /** Nombre para mostrar del remitente ("Luis Casan <luis@…>"), si venía. */
  displayName?: string | null,
): Promise<string | null> {
  if (!email) return null
  const normalized = email.trim().toLowerCase()
  const { data: found } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .ilike('email', normalized)
    .maybeSingle()
  if (found) return found.id
  const { data: inserted } = await admin
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      // contacts.phone es NOT NULL (001:37) y un contacto email no tiene
      // número: string vacío cumple el constraint y los lookups por
      // teléfono (phone_normalized) no ven esta fila.
      phone: '',
      email: normalized,
      // Un contacto sin nombre sale como una fila vacía en el inbox y en
      // los listados. Igual que el webhook de WhatsApp cae al teléfono
      // (`name || phone`), aquí se cae al email: el nombre para mostrar
      // del remitente si el correo lo traía, y si no la propia dirección.
      name: displayName?.trim() || normalized,
    })
    .select('id')
    .single()
  return inserted?.id ?? null
}
