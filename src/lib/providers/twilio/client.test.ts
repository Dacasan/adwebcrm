import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isRetryableTwilioError,
  mapTwilioError,
  withTwilioRetry,
} from './client'
import { ProviderError, RegulatoryBundleRequiredError } from '../errors'

// ============================================================
// Reintentar un 4xx que no sea 429 es siempre un error: el payload es
// inválido, la segunda llamada fallará igual, y mientras tanto se cobra
// otra petición y se alarga la respuesta al webhook.
// ============================================================

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('isRetryableTwilioError', () => {
  it('429 y 5xx sí', () => {
    expect(isRetryableTwilioError({ status: 429 })).toBe(true)
    expect(isRetryableTwilioError({ status: 500 })).toBe(true)
    expect(isRetryableTwilioError({ status: 503 })).toBe(true)
  })

  it('el resto de 4xx no', () => {
    expect(isRetryableTwilioError({ status: 400, code: 21211 })).toBe(false)
    expect(isRetryableTwilioError({ status: 401 })).toBe(false)
    expect(isRetryableTwilioError({ status: 404 })).toBe(false)
  })

  it('un fallo de red sin status sí (no llegó a haber respuesta)', () => {
    expect(isRetryableTwilioError(new Error('ECONNRESET'))).toBe(true)
  })
})

describe('withTwilioRetry', () => {
  it('devuelve a la primera cuando no hay error', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withTwilioRetry(fn, 'test')).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reintenta un 429 y acaba devolviendo el resultado', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let attempts = 0
    const fn = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
      return 'ok'
    })
    await expect(withTwilioRetry(fn, 'test')).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('para en 3 intentos y traduce el error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('still rate limited'), { status: 429 })
    })
    await expect(withTwilioRetry(fn, 'messages.create')).rejects.toBeInstanceOf(ProviderError)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('NO reintenta un 400: el payload no va a mejorar solo', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('invalid To'), { status: 400, code: 21211 })
    })
    await expect(withTwilioRetry(fn, 'messages.create')).rejects.toBeInstanceOf(ProviderError)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('mapTwilioError', () => {
  it('21649 / 21650 se convierten en bloqueo regulatorio con país', () => {
    const err = mapTwilioError(
      { status: 400, code: 21649, message: 'bundle required' },
      'buy',
      'ES',
    )
    expect(err).toBeInstanceOf(RegulatoryBundleRequiredError)
    expect((err as RegulatoryBundleRequiredError).country).toBe('ES')
    expect((err as RegulatoryBundleRequiredError).status).toBe(409)
  })

  it('el resto conserva status y código para que la ruta decida', () => {
    const err = mapTwilioError({ status: 404, code: 20404, message: 'not found' }, 'fetch')
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(404)
    expect((err as ProviderError).code).toBe(20404)
    expect(err.message).toContain('fetch')
  })

  it('un error que no viene del SDK se devuelve tal cual', () => {
    const original = new Error('boom')
    expect(mapTwilioError(original, 'ctx')).toBe(original)
  })
})
