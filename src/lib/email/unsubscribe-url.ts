// ============================================================
// Baja de emails sobre primitivos existentes — cero lógica nueva.
//
//   1. Tag "Unsubscribed" (tabla `tags`, scoped por account).
//   2. GET /unsubscribe/[contactId] añade el tag con
//      `addContactTagIfAbsent` (lib/contacts/tag-write).
//   3. El engine despacha los automatismos `tag_added` solos
//      (engine.ts) — cualquier automatización configurada reacciona.
//   4. `assertNotUnsubscribed` (send-email-step) consulta el tag
//      antes de enviar: baja real, no decorativa.
//
// La variable `{{unsubscribe_url}}` la resuelven los call-sites de
// `contactText` vía el parámetro `extras` — link único por contacto.
// ============================================================

export const UNSUBSCRIBED_TAG = 'Unsubscribed'

/**
 * URL pública de baja para un contacto. Sin `contactId` (envío suelto
 * a una dirección sin contacto) cae a la página informativa de
 * /unsubscribe — nunca a un `href` vacío.
 */
export function buildUnsubscribeUrl(contactId: string | null | undefined): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '')
  if (!base) return ''
  return contactId ? `${base}/unsubscribe/${contactId}` : `${base}/unsubscribe`
}
