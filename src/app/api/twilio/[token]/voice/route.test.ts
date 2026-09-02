import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// La escalera de la entrante: agentes conectados → fallback → buzón.
// Y la rama saliente, que se distingue por `From: client:…`.
// ============================================================

const TOKEN = 'a'.repeat(64)
const AUTH_TOKEN = '12345678901234567890123456789012'
const PATH = `/api/twilio/${TOKEN}/voice`
const CALL_SID = 'CA00000000000000000000000000000001'

const { state, upsertTwilioCall, connectedAgentIdentities } = vi.hoisted(() => ({
  state: { config: null as Record<string, unknown> | null, identities: [] as string[] },
  upsertTwilioCall: vi.fn(async (..._args: unknown[]) => {}),
  connectedAgentIdentities: vi.fn(async (..._args: unknown[]) => [] as string[]),
}))

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/inbound/resolve', () => ({
  findContactByPhone: vi.fn(async () => ({ id: 'contact-1' })),
}))
vi.mock('@/lib/providers/twilio/calls', () => ({
  upsertTwilioCall,
  connectedAgentIdentities,
}))
vi.mock('@/lib/providers/twilio/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadTwilioConfigByWebhookToken: vi.fn(async (token: string) =>
      token === TOKEN ? state.config : null,
    ),
  }
})

import { POST } from './route'

function sign(params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], `https://ci.example.test${PATH}`)
  return crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64')
}

async function post(params: Record<string, string>) {
  const req = new Request(`http://localhost${PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': sign(params),
    },
    body: new URLSearchParams(params).toString(),
  })
  const res = await POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
  return { res, xml: await res.text() }
}

beforeEach(() => {
  state.config = {
    accountId: 'acct-1',
    accountSid: 'AC1',
    authToken: AUTH_TOKEN,
    webhookToken: TOKEN,
    defaultFromNumber: '+34910000000',
    fallbackNumber: null,
    recordingEnabled: false,
  }
  upsertTwilioCall.mockClear()
  connectedAgentIdentities.mockReset()
  connectedAgentIdentities.mockResolvedValue([])
})

describe('POST /api/twilio/[token]/voice — entrante', () => {
  it('con agentes conectados hace timbre simultáneo (un <Client> por agente)', async () => {
    connectedAgentIdentities.mockResolvedValue(['u_a', 'u_b'])
    const { xml } = await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(xml.match(/<Client/g)).toHaveLength(2)
    expect(xml.match(/<Dial/g)).toHaveLength(1)
    // El agente ve el número de quien llama, no su propio DID.
    expect(xml).toContain('callerId="+34600111222"')
  })

  it('sin agentes pero con fallback, desvía al número', async () => {
    state.config = { ...state.config, fallbackNumber: '+34699888777' }
    const { xml } = await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(xml).toContain('>+34699888777</Number>')
    expect(xml).not.toContain('<Client')
  })

  it('sin agentes y sin fallback, buzón', async () => {
    const { xml } = await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(xml).toContain('<Say')
    expect(xml).toContain('<Hangup/>')
    expect(xml).not.toContain('<Dial')
  })

  it('registra la llamada por (provider, CallSid) para que la reentrega no duplique', async () => {
    await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(upsertTwilioCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        callSid: CALL_SID,
        direction: 'inbound',
        status: 'ringing',
      }),
    )
  })

  it('con grabación desactivada, el <Dial> no lleva `record`', async () => {
    connectedAgentIdentities.mockResolvedValue(['u_a'])
    const { xml } = await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(xml).not.toContain('record=')
  })

  it('con grabación activada por la cuenta, sí lo lleva', async () => {
    state.config = { ...state.config, recordingEnabled: true }
    connectedAgentIdentities.mockResolvedValue(['u_a'])
    const { xml } = await post({ CallSid: CALL_SID, From: '+34600111222', To: '+34910000000' })
    expect(xml).toContain('record="record-from-answer"')
  })
})

describe('POST /api/twilio/[token]/voice — saliente del navegador', () => {
  it('`From: client:` marca al `To` con el DID de la cuenta como caller id', async () => {
    const { xml } = await post({ CallSid: CALL_SID, From: 'client:u_abc', To: '+34600111222' })
    expect(xml).toContain('callerId="+34910000000"')
    expect(xml).toContain('>+34600111222</Number>')
    expect(upsertTwilioCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ direction: 'outbound' }),
    )
  })

  it('no hace sonar a nadie: la rama saliente ni consulta la presencia', async () => {
    await post({ CallSid: CALL_SID, From: 'client:u_abc', To: '+34600111222' })
    expect(connectedAgentIdentities).not.toHaveBeenCalled()
  })
})

describe('guardias', () => {
  it('token desconocido → 404 con TwiML válido', async () => {
    const req = new Request(`http://localhost${PATH}`, { method: 'POST', body: '' })
    const res = await POST(req as never, { params: Promise.resolve({ token: 'b'.repeat(64) }) })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/xml')
  })

  it('firma inválida → 403 y sin escribir la llamada', async () => {
    const req = new Request(`http://localhost${PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'mala',
      },
      body: new URLSearchParams({ CallSid: CALL_SID, From: '+34600111222' }).toString(),
    })
    const res = await POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
    expect(res.status).toBe(403)
    expect(upsertTwilioCall).not.toHaveBeenCalled()
  })
})
