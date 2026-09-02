import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Riesgo #2 del plan: «Secreto de API Key perdido». Twilio SOLO devuelve
// el secreto en la creación. Si no se persiste ahí mismo, no hay forma
// de recuperarlo y hay que crear otra clave — dejando una huérfana viva
// en la cuenta del cliente.
// ============================================================

const { state, updates, newKeysCreate, applicationsCreate, applicationsFetch } = vi.hoisted(
  () => ({
    state: {
      cfg: {
        accountId: 'acct-1',
        accountSid: 'AC1',
        authToken: 'tok',
        apiKeySid: null as string | null,
        apiKeySecret: null as string | null,
        twimlAppSid: null as string | null,
        webhookToken: 'a'.repeat(64),
      },
      updateError: null as { message: string } | null,
    },
    updates: [] as Record<string, unknown>[],
    newKeysCreate: vi.fn(async (_args?: Record<string, unknown>) => ({
      sid: 'SK123',
      secret: 'super-secreto',
    })),
    applicationsCreate: vi.fn(async (_args?: Record<string, unknown>) => ({ sid: 'AP123' })),
    applicationsFetch: vi.fn(async () => ({ voiceUrl: '' as string })),
  }),
)

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload)
        return b
      })
      b.eq = vi.fn(async () => ({ error: state.updateError }))
      return b
    },
  }),
}))

const applicationsUpdate = vi.fn(async () => ({}))

vi.mock('./client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createTwilioClient: () => ({
      newKeys: { create: newKeysCreate },
      applications: Object.assign(
        (_sid: string) => ({ fetch: applicationsFetch, update: applicationsUpdate }),
        { create: applicationsCreate },
      ),
    }),
  }
})

import { decrypt } from '@/lib/whatsapp/encryption'
import { ensureApiKey, ensureTwiMLApp } from './provision'

beforeEach(() => {
  updates.length = 0
  state.updateError = null
  state.cfg = {
    accountId: 'acct-1',
    accountSid: 'AC1',
    authToken: 'tok',
    apiKeySid: null,
    apiKeySecret: null,
    twimlAppSid: null,
    webhookToken: 'a'.repeat(64),
  }
  newKeysCreate.mockClear()
  applicationsCreate.mockClear()
  applicationsFetch.mockReset()
  applicationsFetch.mockResolvedValue({ voiceUrl: '' })
  applicationsUpdate.mockClear()
})

afterEach(() => vi.restoreAllMocks())

describe('ensureApiKey', () => {
  it('crea la clave y persiste el secreto ENCRIPTADO, no en claro', async () => {
    const result = await ensureApiKey('acct-1', state.cfg as never)

    expect(result).toEqual({ sid: 'SK123', secret: 'super-secreto' })
    expect(updates).toHaveLength(1)
    const stored = updates[0].api_key_secret_encrypted as string
    expect(stored).not.toBe('super-secreto')
    expect(stored).toContain(':')
    // Y sigue siendo recuperable: encriptado, no destruido.
    expect(decrypt(stored)).toBe('super-secreto')
  })

  it('si ya hay clave guardada, no crea otra', async () => {
    state.cfg.apiKeySid = 'SKexistente'
    state.cfg.apiKeySecret = 'secreto-viejo'
    const result = await ensureApiKey('acct-1', state.cfg as never)
    expect(result).toEqual({ sid: 'SKexistente', secret: 'secreto-viejo' })
    expect(newKeysCreate).not.toHaveBeenCalled()
  })

  it('si no se puede persistir, lanza — una clave que no sabemos usar es peor que ninguna', async () => {
    state.updateError = { message: 'db down' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(ensureApiKey('acct-1', state.cfg as never)).rejects.toThrow(
      /could not persist Twilio API key/,
    )
    // Y se avisa con el SID, que es lo único que permite ir a revocarla.
    expect(error.mock.calls.some((c) => String(c[0]).includes('SK123'))).toBe(true)
  })
})

describe('ensureTwiMLApp', () => {
  it('crea la app apuntando al webhook de ESTA cuenta', async () => {
    const sid = await ensureTwiMLApp('acct-1', state.cfg as never)
    expect(sid).toBe('AP123')
    expect(applicationsCreate.mock.calls[0][0]).toMatchObject({
      voiceUrl: `https://ci.example.test/api/twilio/${'a'.repeat(64)}/voice`,
      voiceMethod: 'POST',
    })
    expect(updates[0]).toEqual({ twiml_app_sid: 'AP123' })
  })

  it('reutiliza la app existente y le re-apunta el voiceUrl si cambió la base', async () => {
    state.cfg.twimlAppSid = 'APviejo'
    applicationsFetch.mockResolvedValue({ voiceUrl: 'https://dominio-viejo/api/twilio/x/voice' })
    const sid = await ensureTwiMLApp('acct-1', state.cfg as never)
    expect(sid).toBe('APviejo')
    expect(applicationsCreate).not.toHaveBeenCalled()
    expect(applicationsUpdate).toHaveBeenCalledTimes(1)
  })

  it('si la app guardada ya no existe en Twilio (404), la recrea', async () => {
    state.cfg.twimlAppSid = 'APborrada'
    applicationsFetch.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sid = await ensureTwiMLApp('acct-1', state.cfg as never)
    expect(sid).toBe('AP123')
    expect(applicationsCreate).toHaveBeenCalledTimes(1)
  })
})
