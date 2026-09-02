import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// La detección de perdida en Twilio es explícita — `DialCallStatus` —,
// no hay que deducirla cruzando hangup_cause con hangup_leg como en
// Telnyx. Lo que este test protege es el CONTEXTO de la automatización:
// hay automatizaciones de clientes leyendo esas claves exactas.
// ============================================================

const TOKEN = 'a'.repeat(64)
const AUTH_TOKEN = '12345678901234567890123456789012'
const PATH = `/api/twilio/${TOKEN}/voice/action`
const CALL_SID = 'CA00000000000000000000000000000001'

const { state, runAutomationsForTrigger, patchTwilioCall, findTwilioCall } = vi.hoisted(() => ({
  state: {
    config: null as Record<string, unknown> | null,
    call: null as Record<string, unknown> | null,
  },
  runAutomationsForTrigger: vi.fn(async (_args: Record<string, unknown>) => []),
  patchTwilioCall: vi.fn(async (..._args: unknown[]) => {}),
  findTwilioCall: vi.fn(async () => null as Record<string, unknown> | null),
}))

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/inbound/resolve', () => ({
  findContactByPhone: vi.fn(async () => ({ id: 'contact-1' })),
}))
vi.mock('@/lib/providers/twilio/calls', () => ({ patchTwilioCall, findTwilioCall }))
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

beforeEach(() => {
  state.config = {
    accountId: 'acct-1',
    authToken: AUTH_TOKEN,
    webhookToken: TOKEN,
    recordingEnabled: false,
  }
  state.call = null
  runAutomationsForTrigger.mockClear()
  patchTwilioCall.mockClear()
  findTwilioCall.mockReset()
  findTwilioCall.mockResolvedValue({ id: 'call-1', contact_id: 'contact-1', disposition: null })
})

describe('POST /api/twilio/[token]/voice/action', () => {
  it('no-answer marca missed y dispara missed_call con el contexto de siempre', async () => {
    const res = await post({
      CallSid: CALL_SID,
      DialCallStatus: 'no-answer',
      From: '+34600111222',
    })
    expect(res.status).toBe(200)
    expect(patchTwilioCall).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      CALL_SID,
      expect.objectContaining({ disposition: 'missed' }),
    )
    expect(runAutomationsForTrigger).toHaveBeenCalledTimes(1)
    expect(runAutomationsForTrigger.mock.calls[0][0]).toEqual({
      accountId: 'acct-1',
      triggerType: 'missed_call',
      contactId: 'contact-1',
      context: {
        call_id: CALL_SID,
        call_direction: 'inbound',
        call_hangup_cause: 'no-answer',
        missed_call_number: '+34600111222',
      },
    })
  })

  it.each(['busy', 'failed', 'canceled'])('%s también cuenta como perdida', async (status) => {
    await post({ CallSid: CALL_SID, DialCallStatus: status, From: '+34600111222' })
    expect(runAutomationsForTrigger).toHaveBeenCalledTimes(1)
  })

  it('completed NO dispara nada y marca la llamada como atendida', async () => {
    await post({ CallSid: CALL_SID, DialCallStatus: 'completed', From: '+34600111222' })
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(patchTwilioCall).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      CALL_SID,
      { disposition: 'completed' },
    )
  })

  it('la reentrega de una perdida ya marcada no vuelve a disparar', async () => {
    findTwilioCall.mockResolvedValue({
      id: 'call-1',
      contact_id: 'contact-1',
      disposition: 'missed',
    })
    await post({ CallSid: CALL_SID, DialCallStatus: 'no-answer', From: '+34600111222' })
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('una saliente perdida (From client:) no dispara missed_call', async () => {
    await post({ CallSid: CALL_SID, DialCallStatus: 'no-answer', From: 'client:u_abc' })
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('devuelve TwiML de buzón para que quien llamó pueda dejar mensaje', async () => {
    const res = await post({
      CallSid: CALL_SID,
      DialCallStatus: 'no-answer',
      From: '+34600111222',
    })
    const xml = await res.text()
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(xml).toContain('<Say')
    expect(xml).toContain('<Hangup/>')
  })

  it('firma inválida → 403 y ni un parche en BD', async () => {
    const req = new Request(`http://localhost${PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'mala',
      },
      body: new URLSearchParams({ CallSid: CALL_SID, DialCallStatus: 'no-answer' }).toString(),
    })
    const res = await POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
    expect(res.status).toBe(403)
    expect(patchTwilioCall).not.toHaveBeenCalled()
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('token desconocido → 404', async () => {
    const req = new Request(`http://localhost${PATH}`, { method: 'POST', body: '' })
    const res = await POST(req as never, {
      params: Promise.resolve({ token: 'b'.repeat(64) }),
    })
    expect(res.status).toBe(404)
  })
})
