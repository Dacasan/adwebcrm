import twilio, { type Twilio } from 'twilio'

import { ProviderError, RegulatoryBundleRequiredError } from '../errors'
import { loadTwilioConfig, type TwilioConfig } from './config'

// ============================================================
// Factoría del SDK de Twilio + política de reintentos + traducción de
// errores. Es el ÚNICO sitio (junto con los demás archivos de esta
// carpeta) donde se importa `twilio`; lo vigila R1 de
// `scripts/verify-providers.mjs`.
// ============================================================

export function createTwilioClient(accountSid: string, authToken: string): Twilio {
  return twilio(accountSid, authToken)
}

/** Cliente ya autenticado con las credenciales de la cuenta + su config. */
export async function twilioForAccount(
  accountId: string,
): Promise<{ client: Twilio; cfg: TwilioConfig }> {
  const cfg = await loadTwilioConfig(accountId)
  return { client: createTwilioClient(cfg.accountSid, cfg.authToken), cfg }
}

// ------------------------------------------------------------
// Errores
// ------------------------------------------------------------

interface TwilioRestError {
  status?: number
  code?: number
  message?: string
  moreInfo?: string
}

function asRestError(err: unknown): TwilioRestError | null {
  if (!err || typeof err !== 'object') return null
  const e = err as TwilioRestError
  return typeof e.status === 'number' || typeof e.code === 'number' ? e : null
}

/** Códigos de Twilio que significan "falta papeleo regulatorio" (§Fase 5). */
export const REGULATORY_ERROR_CODES = new Set([21649, 21650])

/**
 * Traduce un error del SDK a la jerarquía de `providers/errors`. Un
 * bloqueo regulatorio NO es un 500: es un 409 con instrucción accionable,
 * porque el usuario puede resolverlo y nosotros no.
 */
export function mapTwilioError(err: unknown, context: string, country?: string | null): Error {
  const rest = asRestError(err)
  if (!rest) {
    return err instanceof Error ? err : new ProviderError(String(err), 'twilio')
  }
  const message = rest.message ?? 'Twilio request failed'

  if (rest.code && REGULATORY_ERROR_CODES.has(rest.code)) {
    return new RegulatoryBundleRequiredError(
      `${country ?? 'This country'} requires an approved Regulatory Bundle (and a registered address) before buying this number. ` +
        'Create it in Twilio Console › Phone Numbers › Regulatory Compliance and paste its SID in Settings.',
      country ?? null,
    )
  }

  return new ProviderError(`${context}: ${message}`, 'twilio', rest.status, rest.code)
}

// ------------------------------------------------------------
// Reintentos
//
// Twilio devuelve 429 con `Retry-After` cuando se pasa el rate limit de
// la cuenta. Reintentar un 4xx que NO sea 429 es siempre un error: el
// payload es inválido y la segunda llamada fallará igual, cobrando otra
// petición y alargando la respuesta al webhook.
// ------------------------------------------------------------

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 250

export function isRetryableTwilioError(err: unknown): boolean {
  const rest = asRestError(err)
  if (!rest || typeof rest.status !== 'number') {
    // Fallo de red / DNS / socket: sin status. Merece reintento.
    return true
  }
  if (rest.status === 429) return true
  return rest.status >= 500
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Exponencial con jitter, máximo 3 intentos. El jitter evita que N
 * instancias que recibieron el mismo 429 vuelvan a golpear a la vez.
 */
export async function withTwilioRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === MAX_ATTEMPTS || !isRetryableTwilioError(err)) break
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * BASE_DELAY_MS)
      console.warn(`[twilio] ${context} attempt ${attempt} failed, retrying in ${backoff + jitter}ms`)
      await sleep(backoff + jitter)
    }
  }
  throw mapTwilioError(lastErr, context)
}
