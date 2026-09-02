import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El token del softphone. Lo importante aquí es la IDENTIDAD: Twilio
// solo admite alfanuméricos y guiones bajos, y un UUID con guiones no da
// error — deja el dispositivo sin registrar y las entrantes no suenan.
// ============================================================

const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 }
const USER_ID = 'a1b2c3d4-e5f6-4788-9abc-def012345678'

const { state, issueClientToken } = vi.hoisted(() => ({
  state: { callerRole: 'agent' },
  issueClientToken: vi.fn(async (_accountId: string, userId: string) => ({
    provider: 'twilio' as const,
    token: 'jwt-token',
    identity: `u_${userId.replace(/-/g, '')}`,
    expiresIn: 3600,
  })),
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = (await importOriginal()) as { ForbiddenError: new (m: string) => Error }
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (RANK[state.callerRole] < RANK[min]) throw new actual.ForbiddenError(`requires ${min}`)
      return {
        accountId: 'acct-1',
        userId: USER_ID,
        role: state.callerRole,
        supabase: {},
        account: { id: 'acct-1', name: 'Acme' },
      }
    }),
  }
})

vi.mock('@/lib/providers/twilio/voice', () => ({
  twilioVoice: {
    id: 'twilio',
    capabilities: { hold: false, transfer: false, dtmf: true, recording: true },
    issueClientToken,
  },
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

beforeEach(() => {
  state.callerRole = 'agent'
  issueClientToken.mockClear()
  __resetRateLimitForTests()
})

describe('POST /api/twilio/token', () => {
  it('la identidad no lleva guiones y cabe en el límite de Twilio', async () => {
    const res = await POST()
    const json = (await res.json()) as { identity: string; expiresIn: number }

    expect(res.status).toBe(200)
    expect(json.identity).toBe('u_a1b2c3d4e5f647889abcdef012345678')
    expect(json.identity).not.toContain('-')
    expect(json.identity.length).toBeLessThanOrEqual(121)
    expect(json.expiresIn).toBe(3600)
  })

  it('devuelve las capacidades para que la UI no suponga (hold = false)', async () => {
    const res = await POST()
    const json = (await res.json()) as { capabilities: { hold: boolean; dtmf: boolean } }
    expect(json.capabilities).toEqual({
      hold: false,
      transfer: false,
      dtmf: true,
      recording: true,
    })
  })

  it('un viewer recibe 403 y no se emite ningún token', async () => {
    state.callerRole = 'viewer'
    const res = await POST()
    expect(res.status).toBe(403)
    expect(issueClientToken).not.toHaveBeenCalled()
  })

  it('sin Twilio configurado devuelve 404 con retryable:false', async () => {
    const { ProviderNotConfiguredError } = await import('@/lib/providers/errors')
    issueClientToken.mockRejectedValueOnce(
      new ProviderNotConfiguredError('Twilio is not configured for this account', 'twilio'),
    )
    const res = await POST()
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ retryable: false })
  })
})
