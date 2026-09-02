import { MailService } from '@sendgrid/mail'

import { ProviderError } from '../errors'

// ============================================================
// Cliente de SendGrid.
//
// Se crea una `MailService` POR LLAMADA en vez de usar el singleton
// `sgMail.setApiKey(...)` del paquete. Con BYO multi-cuenta el singleton
// es una condición de carrera esperando a ocurrir: dos envíos
// concurrentes de cuentas distintas se pisarían la key y un correo
// saldría por la cuenta equivocada.
// ============================================================

export function createSendGridMailer(apiKey: string): MailService {
  const mailer = new MailService()
  mailer.setApiKey(apiKey)
  return mailer
}

interface SendGridErrorish {
  code?: number
  message?: string
  response?: { body?: { errors?: { message?: string }[] } }
}

export function mapSendGridError(err: unknown, context: string): Error {
  const e = err as SendGridErrorish
  const detail =
    e?.response?.body?.errors?.map((x) => x.message).filter(Boolean).join('; ') ||
    e?.message ||
    'SendGrid request failed'
  return new ProviderError(`${context}: ${detail}`, 'sendgrid', e?.code)
}

/**
 * Estado de autenticación de dominio (DKIM/SPF).
 *
 * Se consulta con `fetch` y no con `@sendgrid/client` a propósito: es una
 * sola llamada GET y así no se añade una dependencia más al bundle de
 * servidor ni una excepción más al guard de aislamiento de SDK.
 *
 * Importa de verdad: un `from_email` en un dominio sin DKIM firmado va a
 * spam SIN devolver error. La UI tiene que decirlo ANTES de que alguien
 * mande una campaña, no después.
 */
export async function fetchAuthenticatedDomains(apiKey: string): Promise<
  { domain: string; valid: boolean }[]
> {
  const res = await fetch('https://api.sendgrid.com/v3/whitelabel/domains?limit=50', {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new ProviderError(
      `whitelabel/domains → ${res.status}`,
      'sendgrid',
      res.status,
    )
  }
  const body = (await res.json()) as { domain?: string; valid?: boolean }[]
  return (Array.isArray(body) ? body : []).map((d) => ({
    domain: d.domain ?? '',
    valid: d.valid === true,
  }))
}

/** ¿El dominio del `from_email` está autenticado en esta cuenta? */
export function isDomainAuthenticated(
  fromEmail: string,
  domains: { domain: string; valid: boolean }[],
): boolean {
  const at = fromEmail.lastIndexOf('@')
  if (at === -1) return false
  const domain = fromEmail.slice(at + 1).trim().toLowerCase().replace(/>$/, '')
  return domains.some((d) => d.valid && domain.endsWith(d.domain.toLowerCase()))
}
