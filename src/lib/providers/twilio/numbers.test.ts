import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Compra y lookup. Los dos puntos que este test fija:
//
//  · `score` es SIEMPRE null en Twilio. El gate de reputación de Telnyx
//    no tiene equivalente y simular uno vendería una garantía que el
//    proveedor no da (§Fase 5).
//  · 21649 / 21650 son un 409 accionable, no un 500.
// ============================================================

const { state, incomingCreate, lookupFetch } = vi.hoisted(() => ({
  state: {
    cfg: {
      accountId: 'acct-1',
      accountSid: 'AC1',
      authToken: 'tok',
      webhookToken: 'a'.repeat(64),
      regulatoryBundleSid: null as string | null,
      addressSid: null as string | null,
    },
  },
  incomingCreate: vi.fn(async (args: Record<string, unknown>) => ({
    sid: 'PN1',
    phoneNumber: args.phoneNumber as string,
  })),
  lookupFetch: vi.fn(async (_opts?: { fields: string }) => ({
    valid: true as boolean,
    countryCode: 'ES' as string | null,
    lineTypeIntelligence: { type: 'mobile', carrier_name: 'Movistar' } as {
      type?: string | null
      carrier_name?: string | null
    } | null,
  })),
}))

vi.mock('./client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    twilioForAccount: async () => ({
      cfg: state.cfg,
      client: {
        incomingPhoneNumbers: { create: incomingCreate },
        lookups: { v2: { phoneNumbers: () => ({ fetch: lookupFetch }) } },
      },
    }),
  }
})

import { checkNumber } from './lookup'
import { buyNumber } from './numbers'
import { RegulatoryBundleRequiredError } from '../errors'

beforeEach(() => {
  incomingCreate.mockClear()
  lookupFetch.mockReset()
  lookupFetch.mockResolvedValue({
    valid: true,
    countryCode: 'ES',
    lineTypeIntelligence: { type: 'mobile', carrier_name: 'Movistar' },
  })
  state.cfg.regulatoryBundleSid = null
  state.cfg.addressSid = null
})

describe('checkNumber (Lookup v2)', () => {
  it('devuelve tipo de línea y carrier, con score null y una nota que lo explica', async () => {
    const result = await checkNumber('acct-1', '+34600111222')
    expect(result).toMatchObject({
      valid: true,
      countryCode: 'ES',
      lineType: 'mobile',
      carrier: 'Movistar',
      score: null,
      blocked: false,
    })
    expect(result.note).toMatch(/does not publish a reputation score/i)
  })

  it('pide SOLO line_type_intelligence — cada field de Lookup se factura aparte', async () => {
    await checkNumber('acct-1', '+34600111222')
    expect(lookupFetch.mock.calls[0][0]).toEqual({ fields: 'line_type_intelligence' })
  })

  it('un número inválido se marca bloqueado, pero el score sigue siendo null', async () => {
    lookupFetch.mockResolvedValue({ valid: false, countryCode: null, lineTypeIntelligence: null })
    const result = await checkNumber('acct-1', '+34600111222')
    expect(result.valid).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.score).toBeNull()
  })

  it('un 404 de Lookup no es un fallo del sistema', async () => {
    lookupFetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    const result = await checkNumber('acct-1', '+34600111222')
    expect(result.valid).toBe(false)
    expect(result.score).toBeNull()
  })
})

describe('buyNumber', () => {
  it('apunta el número a los webhooks de ESTA cuenta en el mismo POST', async () => {
    await buyNumber('acct-1', '+34910000000', 'ES')
    const args = incomingCreate.mock.calls[0][0]
    expect(args).toMatchObject({
      phoneNumber: '+34910000000',
      voiceUrl: `https://ci.example.test/api/twilio/${'a'.repeat(64)}/voice`,
      voiceMethod: 'POST',
      smsUrl: `https://ci.example.test/api/twilio/${'a'.repeat(64)}/sms/inbound`,
      smsMethod: 'POST',
    })
  })

  it('manda bundle y dirección cuando la cuenta los tiene', async () => {
    state.cfg.regulatoryBundleSid = 'BU1'
    state.cfg.addressSid = 'AD1'
    await buyNumber('acct-1', '+34910000000', 'ES')
    expect(incomingCreate.mock.calls[0][0]).toMatchObject({ bundleSid: 'BU1', addressSid: 'AD1' })
  })

  it('sin bundle no manda la clave vacía', async () => {
    await buyNumber('acct-1', '+34910000000', 'ES')
    expect(incomingCreate.mock.calls[0][0]).not.toHaveProperty('bundleSid')
  })

  it.each([21649, 21650])('el código %i se traduce a bloqueo regulatorio, no a un 500', async (code) => {
    incomingCreate.mockRejectedValueOnce(
      Object.assign(new Error('bundle required'), { status: 400, code }),
    )
    const err = await buyNumber('acct-1', '+34910000000', 'ES').catch((e) => e)
    expect(err).toBeInstanceOf(RegulatoryBundleRequiredError)
    expect(err.status).toBe(409)
    expect(err.country).toBe('ES')
    expect(err.message).toMatch(/Regulatory Bundle/)
  })

  it('otros errores de Twilio conservan su status', async () => {
    incomingCreate.mockRejectedValueOnce(
      Object.assign(new Error('number not available'), { status: 400, code: 21422 }),
    )
    const err = await buyNumber('acct-1', '+34910000000', 'ES').catch((e) => e)
    expect(err).not.toBeInstanceOf(RegulatoryBundleRequiredError)
    expect(err.status).toBe(400)
  })
})
