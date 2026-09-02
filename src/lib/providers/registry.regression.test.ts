import { afterEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// TEST DE REGRESIÓN PERMANENTE (plan §6.1).
//
//   «Una cuenta con `provider_routing` ausente o en valores por defecto
//    debe comportarse EXACTAMENTE como antes de este plan.»
//
// Si este archivo se pone rojo, alguien acaba de cambiar el proveedor de
// todas las cuentas que nunca pidieron cambiar de proveedor. No lo
// "arregles" ajustando la expectativa.
// ============================================================

const ABSENT = null
const ALL_DEFAULTS = {
  voice_provider: 'telnyx',
  sms_provider: 'telnyx',
  email_provider: 'resend',
}

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

describe.each([
  ['fila ausente', ABSENT],
  ['fila con todos los defaults', ALL_DEFAULTS],
])('cuenta intacta — %s', (_label, row) => {
  it('voz → Telnyx, SMS → Telnyx, email → Resend', async () => {
    mockRouting(row)
    const { resolveProviders } = await import('./registry')
    const { routing, voice, sms, email } = await resolveProviders('acct-legacy')
    expect(routing).toEqual({ voice: 'telnyx', sms: 'telnyx', email: 'resend' })
    expect([voice.id, sms.id, email.id]).toEqual(['telnyx', 'telnyx', 'resend'])
  })

  it('la voz conserva el hold que Telnyx siempre tuvo', async () => {
    mockRouting(row)
    const { resolveVoiceProvider } = await import('./registry')
    expect((await resolveVoiceProvider('acct-legacy')).capabilities.hold).toBe(true)
  })
})

describe('la lectura de routing nunca puede tumbar un envío', () => {
  it('un error de BD degrada a los defaults en vez de lanzar', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRouting(null, { message: 'connection refused' })
    const { resolveSmsProvider } = await import('./registry')
    await expect(resolveSmsProvider('acct-legacy')).resolves.toMatchObject({ id: 'telnyx' })
  })

  it('un cliente service-role que ni siquiera se puede construir, tampoco', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('@/lib/supabase/admin', () => ({
      supabaseAdmin: () => {
        throw new Error('supabaseUrl is required.')
      },
    }))
    vi.resetModules()
    const { resolveEmailProvider } = await import('./registry')
    await expect(resolveEmailProvider('acct-legacy')).resolves.toMatchObject({ id: 'resend' })
  })
})
