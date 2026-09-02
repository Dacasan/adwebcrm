import twilio from 'twilio'

import { twilioWebhookBase } from './config'

// ============================================================
// Verificación de `X-Twilio-Signature` (HMAC-SHA1 sobre la URL completa
// más los parámetros ordenados del cuerpo form-urlencoded).
//
// Con BYO, cada cuenta firma con SU Auth Token. Eso crea un problema de
// orden — para verificar hay que saber de qué cuenta se trata, y para
// saberlo habría que confiar en el cuerpo sin verificar. Se resuelve
// metiendo un `webhook_token` en la RUTA: resuelve la cuenta sin leer ni
// un byte del cuerpo. Ver §4.2 del plan.
//
// La comparación en tiempo constante la hace `twilio.validateRequest`.
// NO escribas tu propio HMAC.
// ============================================================

export interface SignatureCheck {
  ok: boolean
  reason?: string
}

export function verifyTwilioSignature(args: {
  authToken: string
  signature: string | null
  /** Path EXACTO configurado en Twilio, p. ej. `/api/twilio/<token>/voice`. */
  path: string
  /** Params ya parseados del cuerpo form-urlencoded. */
  params: Record<string, string>
}): SignatureCheck {
  if (!args.signature) return { ok: false, reason: 'missing X-Twilio-Signature' }
  if (!args.authToken) return { ok: false, reason: 'account has no auth token' }

  let url: string
  try {
    url = `${twilioWebhookBase()}${args.path}`
  } catch (err) {
    // Base mal configurada: fail-closed. Un webhook que acepta sin poder
    // verificar es una API pública de escritura.
    return { ok: false, reason: err instanceof Error ? err.message : 'base url not configured' }
  }

  try {
    const ok = twilio.validateRequest(args.authToken, args.signature, url, args.params)
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' }
  } catch {
    return { ok: false, reason: 'signature verification failed' }
  }
}

/**
 * Cuerpo `application/x-www-form-urlencoded` → objeto plano, que es la
 * forma que espera `validateRequest`.
 *
 * Twilio manda cada clave una sola vez; si llegara repetida gana la
 * última, igual que hace `Object.fromEntries`. Se lee del texto CRUDO
 * porque la firma se calcula sobre lo que vino por el cable.
 */
export function parseFormBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v
  return params
}
