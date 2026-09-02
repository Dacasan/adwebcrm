import { describe, expect, it, vi, afterEach } from 'vitest'

import { DEFAULT_ROUTING, normalizeRouting } from './routing'

// ============================================================
// El invariante de §6.1 vive aquí: fila ausente, columna nula o valor
// inesperado resuelven TODOS a los defaults históricos. Si este archivo
// se pone rojo, alguna cuenta existente acaba de cambiar de proveedor
// sin que nadie lo pidiera.
// ============================================================

describe('normalizeRouting', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sin fila devuelve los defaults (telnyx/telnyx/resend)', () => {
    expect(normalizeRouting(null)).toEqual(DEFAULT_ROUTING)
    expect(normalizeRouting(undefined)).toEqual(DEFAULT_ROUTING)
  })

  it('respeta los valores válidos de la fila', () => {
    expect(
      normalizeRouting({
        voice_provider: 'twilio',
        sms_provider: 'twilio',
        email_provider: 'sendgrid',
      }),
    ).toEqual({ voice: 'twilio', sms: 'twilio', email: 'sendgrid' })
  })

  it('mezcla: voz en twilio, email en resend', () => {
    expect(
      normalizeRouting({ voice_provider: 'twilio', sms_provider: 'telnyx', email_provider: 'resend' }),
    ).toEqual({ voice: 'twilio', sms: 'telnyx', email: 'resend' })
  })

  it('un valor inesperado cae al default y LOGUEA, no lanza', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      normalizeRouting({ voice_provider: 'vonage', sms_provider: null, email_provider: 42 }),
    ).toEqual(DEFAULT_ROUTING)
    // Dos columnas inválidas → dos avisos; la nula es legítima y no avisa.
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('voice_provider=vonage')
  })
})

describe('loadProviderRouting', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  function mockAdmin(result: { data: unknown; error: { message: string } | null }) {
    vi.doMock('@/lib/supabase/admin', () => ({
      supabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(result) }),
          }),
        }),
      }),
    }))
  }

  it('fila ausente → defaults', async () => {
    mockAdmin({ data: null, error: null })
    vi.resetModules()
    const { loadProviderRouting, DEFAULT_ROUTING: D } = await import('./routing')
    await expect(loadProviderRouting('acct-1')).resolves.toEqual(D)
  })

  it('error de BD → defaults con aviso, nunca lanza', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockAdmin({ data: null, error: { message: 'boom' } })
    vi.resetModules()
    const { loadProviderRouting, DEFAULT_ROUTING: D } = await import('./routing')
    await expect(loadProviderRouting('acct-1')).resolves.toEqual(D)
    expect(warn).toHaveBeenCalled()
  })

  it('fila con twilio → twilio', async () => {
    mockAdmin({
      data: { voice_provider: 'twilio', sms_provider: 'twilio', email_provider: 'sendgrid' },
      error: null,
    })
    vi.resetModules()
    const { loadProviderRouting } = await import('./routing')
    await expect(loadProviderRouting('acct-1')).resolves.toEqual({
      voice: 'twilio',
      sms: 'twilio',
      email: 'sendgrid',
    })
  })
})
