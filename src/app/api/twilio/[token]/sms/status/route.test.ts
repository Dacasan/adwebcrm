import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = 'a'.repeat(64)
const AUTH_TOKEN = '12345678901234567890123456789012'
const PATH = `/api/twilio/${TOKEN}/sms/status`
const SID = 'SM00000000000000000000000000000001'

const { state, runAutomationsForTrigger } = vi.hoisted(() => ({
  state: {
    config: null as Record<string, unknown> | null,
    message: null as Record<string, unknown> | null,
    updates: [] as Record<string, unknown>[],
  },
  runAutomationsForTrigger: vi.fn(async (_args: Record<string, unknown>) => []),
}))

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger }))

vi.mock('@/lib/providers/twilio/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadTwilioConfigByWebhookToken: vi.fn(async (token: string) =>
      token === TOKEN ? state.config : null,
    ),
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.update = vi.fn((payload: Record<string, unknown>) => {
        state.updates.push(payload)
        return b
      })
      b.maybeSingle = vi.fn(async () => ({ data: state.message, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
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

beforeEach(() => {
  state.config = { accountId: 'acct-1', authToken: AUTH_TOKEN, webhookToken: TOKEN }
  state.updates = []
  state.message = {
    id: 'msg-1',
    status: 'sent',
    conversation_id: 'conv-1',
    metadata: {},
    conversations: { account_id: 'acct-1', contact_id: 'contact-1' },
  }
  runAutomationsForTrigger.mockClear()
})

describe('POST /api/twilio/[token]/sms/status', () => {
  it('delivered marca la fila y dispara message_delivered UNA vez', async () => {
    await post({ MessageSid: SID, MessageStatus: 'delivered' })
    expect(state.updates[0]).toMatchObject({ status: 'delivered' })
    expect(runAutomationsForTrigger).toHaveBeenCalledTimes(1)
    expect(runAutomationsForTrigger.mock.calls[0][0]).toMatchObject({
      triggerType: 'message_delivered',
      contactId: 'contact-1',
    })
  })

  it('la reentrega del mismo estado no vuelve a disparar nada', async () => {
    state.message = { ...state.message, status: 'delivered' }
    await post({ MessageSid: SID, MessageStatus: 'delivered' })
    expect(state.updates).toHaveLength(0)
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('failed guarda el ErrorCode y dispara message_failed', async () => {
    await post({ MessageSid: SID, MessageStatus: 'failed', ErrorCode: '30034' })
    expect(state.updates[0]).toMatchObject({
      status: 'failed',
      metadata: { twilio_error_code: '30034' },
    })
    expect(runAutomationsForTrigger.mock.calls[0][0]).toMatchObject({
      triggerType: 'message_failed',
    })
  })

  it('`sent` actualiza el estado pero no dispara automatizaciones', async () => {
    // La fila todavía no tiene estado de entrega; si ya fuera 'sent', el
    // guard de idempotencia cortaría antes (y eso lo cubre el test de
    // reentrega).
    state.message = { ...state.message, status: null }
    await post({ MessageSid: SID, MessageStatus: 'sent' })
    expect(state.updates[0]).toMatchObject({ status: 'sent' })
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('`queued` no toca nada: es ruido previo al envío', async () => {
    await post({ MessageSid: SID, MessageStatus: 'queued' })
    expect(state.updates).toHaveLength(0)
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('aislamiento de tenancy: un mensaje de otra cuenta no se toca', async () => {
    state.message = { ...state.message, conversations: { account_id: 'acct-2', contact_id: 'c9' } }
    await post({ MessageSid: SID, MessageStatus: 'delivered' })
    expect(state.updates).toHaveLength(0)
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('firma inválida → 403 sin escrituras', async () => {
    const req = new Request(`http://localhost${PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'mala',
      },
      body: new URLSearchParams({ MessageSid: SID, MessageStatus: 'delivered' }).toString(),
    })
    const res = await POST(req as never, { params: Promise.resolve({ token: TOKEN }) })
    expect(res.status).toBe(403)
    expect(state.updates).toHaveLength(0)
  })
})
