import { afterEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El registry traduce `provider_routing` a un adaptador. Lo que se
// afirma aquí es el mapeo y, sobre todo, que un routing ausente o
// corrupto NO deja a la cuenta sin canal.
// ============================================================

function mockRouting(row: unknown, error: { message: string } | null = null) {
  vi.doMock('@/lib/supabase/admin', () => ({
    supabaseAdmin: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error }) }),
        }),
      }),
    }),
  }))
  vi.resetModules()
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('resolve*Provider', () => {
  it('sin fila devuelve los adaptadores históricos', async () => {
    mockRouting(null)
    const { resolveVoiceProvider, resolveSmsProvider, resolveEmailProvider } = await import(
      './registry'
    )
    expect((await resolveVoiceProvider('acct-1')).id).toBe('telnyx')
    expect((await resolveSmsProvider('acct-1')).id).toBe('telnyx')
    expect((await resolveEmailProvider('acct-1')).id).toBe('resend')
  })

  it('con voice_provider=twilio devuelve el adaptador de Twilio', async () => {
    mockRouting({ voice_provider: 'twilio', sms_provider: 'twilio', email_provider: 'sendgrid' })
    const { resolveVoiceProvider, resolveSmsProvider, resolveEmailProvider } = await import(
      './registry'
    )
    expect((await resolveVoiceProvider('acct-1')).id).toBe('twilio')
    expect((await resolveSmsProvider('acct-1')).id).toBe('twilio')
    expect((await resolveEmailProvider('acct-1')).id).toBe('sendgrid')
  })

  it('un valor inesperado en BD cae al default y loguea, no lanza', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRouting({ voice_provider: 'vonage', sms_provider: 'vonage', email_provider: 'mailgun' })
    const { resolveVoiceProvider, resolveEmailProvider } = await import('./registry')
    expect((await resolveVoiceProvider('acct-1')).id).toBe('telnyx')
    expect((await resolveEmailProvider('acct-1')).id).toBe('resend')
    expect(warn).toHaveBeenCalled()
  })

  it('routing mixto: voz en Twilio, email en Resend', async () => {
    mockRouting({ voice_provider: 'twilio', sms_provider: 'telnyx', email_provider: 'resend' })
    const { resolveProviders } = await import('./registry')
    const { routing, voice, sms, email } = await resolveProviders('acct-1')
    expect(routing).toEqual({ voice: 'twilio', sms: 'telnyx', email: 'resend' })
    expect(voice.id).toBe('twilio')
    expect(sms.id).toBe('telnyx')
    expect(email.id).toBe('resend')
  })
})

describe('capacidades divergentes (§6.3)', () => {
  it('Telnyx conserva hold; Twilio no lo tiene', async () => {
    mockRouting(null)
    const { resolveVoiceCapabilities } = await import('./registry')
    const telnyx = await resolveVoiceCapabilities('acct-1')
    expect(telnyx).toEqual({
      provider: 'telnyx',
      capabilities: { hold: true, transfer: false, dtmf: true, recording: true },
    })

    mockRouting({ voice_provider: 'twilio' })
    const { resolveVoiceCapabilities: resolveTwilio } = await import('./registry')
    const twilio = await resolveTwilio('acct-1')
    expect(twilio.provider).toBe('twilio')
    expect(twilio.capabilities.hold).toBe(false)
    expect(twilio.capabilities.dtmf).toBe(true)
  })
})
