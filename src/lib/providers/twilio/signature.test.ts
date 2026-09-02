import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { parseFormBody, verifyTwilioSignature } from './signature'

// ============================================================
// La firma se calcula sobre la URL COMPLETA + los parámetros ordenados y
// concatenados. El vector de prueba se construye AQUÍ con `node:crypto`,
// no con el SDK: si el día de mañana el SDK cambia de algoritmo, este
// test tiene que enterarse en vez de acompañarlo.
//
// `TWILIO_WEBHOOK_BASE_URL` viene de vitest.config.ts y DEBE coincidir
// con el de CI, o esto pasa en un sitio y falla en el otro.
// ============================================================

const AUTH_TOKEN = '12345678901234567890123456789012'
const BASE = 'https://ci.example.test'
const PATH = '/api/twilio/abc123/sms/inbound'

const PARAMS = {
  From: '+34600111222',
  To: '+34910000000',
  Body: 'Hola clínica',
  MessageSid: 'SM00000000000000000000000000000001',
}

/** Réplica independiente del algoritmo documentado por Twilio. */
function signRequest(token: string, url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  return crypto.createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64')
}

const VALID = signRequest(AUTH_TOKEN, `${BASE}${PATH}`, PARAMS)

describe('verifyTwilioSignature', () => {
  it('acepta una firma válida', () => {
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: VALID,
        path: PATH,
        params: PARAMS,
      }),
    ).toEqual({ ok: true })
  })

  it('rechaza si se altera un parámetro', () => {
    const tampered = { ...PARAMS, Body: 'Transfiere 5000 euros' }
    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      signature: VALID,
      path: PATH,
      params: tampered,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature mismatch')
  })

  it('rechaza si se altera el path (una barra de más invalida todo)', () => {
    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      signature: VALID,
      path: `${PATH}/`,
      params: PARAMS,
    })
    expect(result.ok).toBe(false)
  })

  it('rechaza sin header de firma', () => {
    const result = verifyTwilioSignature({
      authToken: AUTH_TOKEN,
      signature: null,
      path: PATH,
      params: PARAMS,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('missing')
  })

  it('rechaza con el Auth Token de otra cuenta', () => {
    const result = verifyTwilioSignature({
      authToken: '99999999999999999999999999999999',
      signature: VALID,
      path: PATH,
      params: PARAMS,
    })
    expect(result.ok).toBe(false)
  })

  it('rechaza si la cuenta no tiene Auth Token (fail-closed)', () => {
    const result = verifyTwilioSignature({
      authToken: '',
      signature: VALID,
      path: PATH,
      params: PARAMS,
    })
    expect(result.ok).toBe(false)
  })
})

describe('parseFormBody', () => {
  it('convierte el cuerpo form-urlencoded en un objeto plano', () => {
    expect(parseFormBody('From=%2B34600111222&Body=Hola+cl%C3%ADnica')).toEqual({
      From: '+34600111222',
      Body: 'Hola clínica',
    })
  })

  it('un cuerpo vacío da un objeto vacío, no lanza', () => {
    expect(parseFormBody('')).toEqual({})
  })
})
