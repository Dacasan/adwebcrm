import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Dos cosas que este test defiende:
//
//  1. El guard SSRF. El payload del webhook está firmado, pero el
//     allowlist de hosts es la última línea si algún día deja de estarlo:
//     solo `api.twilio.com`.
//  2. La autenticación de la descarga. La RecordingUrl de Twilio NO es
//     una URL firmada pública: sin HTTP Basic devuelve 401 y la
//     grabación se pierde con un log como único síntoma.
// ============================================================

const TOKEN = 'a'.repeat(64)
const AUTH_TOKEN = '12345678901234567890123456789012'
const PATH = `/api/twilio/${TOKEN}/voice/recording`
const CALL_SID = 'CA00000000000000000000000000000001'

const { state, findTwilioCall, uploads, updates } = vi.hoisted(() => ({
  state: { config: null as Record<string, unknown> | null },
  findTwilioCall: vi.fn(async (..._args: unknown[]) => ({
    id: 'call-1',
    contact_id: null as string | null,
    disposition: null as string | null,
  })),
  uploads: [] as { path: string; size: number }[],
  updates: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/providers/twilio/calls', () => ({ findTwilioCall }))
vi.mock('@/lib/providers/twilio/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadTwilioConfigByWebhookToken: vi.fn(async (token: string) =>
      token === TOKEN ? state.config : null,
    ),
  }
})
vi.mock('@/lib/storage/upload-media', () => ({
  buildMediaPath: (accountId: string, name: string) => `account-${accountId}/1700-${name}`,
}))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload)
        return b
      })
      b.eq = vi.fn(() => b)
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
    storage: {
      from: () => ({
        upload: vi.fn(async (path: string, body: Buffer) => {
          uploads.push({ path, size: body.byteLength })
          return { data: { path }, error: null }
        }),
      }),
    },
  }),
}))

import { POST } from './route'

function sign(params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], `https://ci.example.test${PATH}`)
  return crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64')
}

function post(params: Record<string, string>) {
  const req = new Request(`http://localhost${PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': sign(params),
    },
    body: new URLSearchParams(params).toString(),
  })
  return POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
}

const fetchMock = vi.fn()

beforeEach(() => {
  state.config = {
    accountId: 'acct-1',
    accountSid: 'AC1',
    authToken: AUTH_TOKEN,
    webhookToken: TOKEN,
    recordingEnabled: true,
  }
  uploads.length = 0
  updates.length = 0
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-length' ? '1024' : null) },
    arrayBuffer: async () => new ArrayBuffer(1024),
  })
  vi.stubGlobal('fetch', fetchMock)
})

describe('POST /api/twilio/[token]/voice/recording', () => {
  it('descarga con HTTP Basic y sube al bucket privado', async () => {
    await post({
      CallSid: CALL_SID,
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
      RecordingStatus: 'completed',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`AC1:${AUTH_TOKEN}`).toString('base64')}`,
    )
    expect(uploads).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      recording_storage_path: uploads[0].path,
      recording_url: '/api/calls/call-1/recording',
    })
  })

  it('host distinto de api.twilio.com → no descarga NADA (guard SSRF)', async () => {
    await post({
      CallSid: CALL_SID,
      RecordingUrl: 'https://evil.example/2010-04-01/Recordings/RE1',
      RecordingStatus: 'completed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
  })

  it('http:// tampoco pasa, aunque el host sea el bueno', async () => {
    await post({
      CallSid: CALL_SID,
      RecordingUrl: 'http://api.twilio.com/Recordings/RE1',
      RecordingStatus: 'completed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un content-length gigante corta antes de traerse los bytes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(500 * 1024 * 1024) },
      arrayBuffer: async () => new ArrayBuffer(8),
    })
    await post({
      CallSid: CALL_SID,
      RecordingUrl: 'https://api.twilio.com/Recordings/RE1',
      RecordingStatus: 'completed',
    })
    expect(uploads).toHaveLength(0)
  })

  it('un estado que no es `completed` se ignora', async () => {
    await post({
      CallSid: CALL_SID,
      RecordingUrl: 'https://api.twilio.com/Recordings/RE1',
      RecordingStatus: 'in-progress',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('firma inválida → 403 y sin descarga', async () => {
    const req = new Request(`http://localhost${PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'mala',
      },
      body: new URLSearchParams({
        CallSid: CALL_SID,
        RecordingUrl: 'https://api.twilio.com/Recordings/RE1',
        RecordingStatus: 'completed',
      }).toString(),
    })
    const res = await POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
