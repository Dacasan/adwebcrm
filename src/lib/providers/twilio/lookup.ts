import { ProviderError } from '../errors'
import { twilioForAccount } from './client'

// ============================================================
// Lookup v2.
//
// EL AGUJERO QUE HAY QUE CERRAR CONSCIENTEMENTE: Telnyx expone
// `GET /v2/reputation/phone_numbers/{n}` y con eso `/numbers/buy` bloquea
// la compra cuando el score es < 60. **Twilio no tiene equivalente para
// el número que compras.** Lookup evalúa el número de DESTINO, no el
// tuyo.
//
// Así que aquí NO se inventa un score. `score` sale `null` y con una
// `note` que dice por qué. La UI lee `score === null` y no pinta un
// semáforo falso. El requisito real es no mentir sobre una garantía que
// el proveedor no da.
//
// Facturación: cada `field` de Lookup se cobra aparte. Se pide solo
// `line_type_intelligence`; `sms_pumping_risk` NO va en cada check.
// ============================================================

export interface NumberCheckResult {
  number: string
  valid: boolean
  countryCode: string | null
  lineType: string | null
  carrier: string | null
  /** Siempre null en Twilio: el proveedor no ofrece reputación del número propio. */
  score: null
  blocked: boolean
  note: string
}

export async function checkNumber(
  accountId: string,
  e164: string,
): Promise<NumberCheckResult> {
  const { client } = await twilioForAccount(accountId)

  let data: {
    valid: boolean | null
    countryCode: string | null
    lineTypeIntelligence: { type?: string | null; carrier_name?: string | null } | null
  }
  try {
    const fetched = await client.lookups.v2.phoneNumbers(e164).fetch({
      fields: 'line_type_intelligence',
    })
    data = {
      valid: fetched.valid ?? null,
      countryCode: fetched.countryCode ?? null,
      lineTypeIntelligence:
        (fetched.lineTypeIntelligence as { type?: string | null; carrier_name?: string | null } | null) ??
        null,
    }
  } catch (err) {
    const status = (err as { status?: number }).status
    // Un 404 de Lookup significa "número no encontrado", no un fallo del
    // sistema: se reporta como inválido y ya.
    if (status === 404) {
      return {
        number: e164,
        valid: false,
        countryCode: null,
        lineType: null,
        carrier: null,
        score: null,
        blocked: true,
        note: 'Twilio Lookup does not recognise this number.',
      }
    }
    throw new ProviderError(
      `lookups.v2 failed: ${(err as Error).message ?? 'unknown'}`,
      'twilio',
      status,
    )
  }

  const lti = data.lineTypeIntelligence ?? {}

  return {
    number: e164,
    valid: data.valid === true,
    countryCode: data.countryCode ?? null,
    lineType: lti.type ?? null,
    carrier: lti.carrier_name ?? null,
    score: null,
    // El único bloqueo real es que el número no sea válido. No hay gate
    // de reputación porque no hay dato de reputación.
    blocked: data.valid !== true,
    note:
      data.valid === true
        ? 'Twilio does not publish a reputation score for numbers you buy — there is no purchase gate for it. Monitor deliverability after going live.'
        : 'Twilio Lookup reports this number as invalid.',
  }
}
