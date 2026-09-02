import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El orden que este test defiende: token → cuenta (404), firma (403), y
// SOLO ENTONCES la base de datos. Un webhook que escribe antes de
// verificar es una API pública de escritura.
// ============================================================

const TOKEN = 'a'.repeat(64)
const AUTH_TOKEN = '12345678901234567890123456789012'
const PATH = `/api/twilio/${TOKEN}/sms/inbound`

const { state, writes } = vi.hoisted(() => ({
  state: { config: null as Record<string, unknown> | null },
  writes: [] as { table: string; op: string; payload: unknown }[],
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

const messages: Record<string, unknown>[] = []
const contacts: Record<string, unknown>[] = []
const conversations: Record<string, unknown>[] = []

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const eqs: [string, unknown][] = []
      let mode: 'select' | 'insert' | 'update' = 'select'
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn((c: string, v: unknown) => {
        eqs.push([c, v])
        return b
      })
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        mode = 'insert'
        writes.push({ table, op: 'insert', payload })
        if (table === 'messages') messages.push(payload)
        if (table === 'contacts') contacts.push(payload)
        if (table === 'conversations') conversations.push(payload)
        return b
      })
      b.update = vi.fn((payload: Record<string, unknown>) => {
        mode = 'update'
        writes.push({ table, op: 'update', payload })
        return b
      })
      const eqOf = (col: string) => eqs.find(([c]) => c === col)?.[1]
      const terminal = () => {
        if (mode !== 'select') {
          return { data: { id: `${table}-new` }, error: null }
        }
        if (table === 'messages') {
          const pmid = eqOf('provider_message_id')
          const hit = messages.find((m) => m.provider_message_id === pmid)
          return { data: hit ?? null, error: null }
        }
        if (table === 'contacts') {
          return { data: contacts[0] ? { id: 'contacts-new' } : null, error: null }
        }
        if (table === 'conversations') {
          return { data: conversations[0] ? { id: 'conversations-new' } : null, error: null }
        }
        if (table === 'accounts') {
          return { data: { owner_user_id: 'user-owner' }, error: null }
        }
        return { data: null, error: null }
      }
      b.maybeSingle = vi.fn(async () => terminal())
      b.single = vi.fn(async () => terminal())
      b.then = (resolve: (v: unknown) => unknown) => resolve(terminal())
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

function post(token: string, params: Record<string, string>, signature?: string | null) {
  const body = new URLSearchParams(params).toString()
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const sig = signature === undefined ? sign(params) : signature
  if (sig) headers['X-Twilio-Signature'] = sig
  const req = new Request(`http://localhost/api/twilio/${token}/sms/inbound`, {
    method: 'POST',
    headers,
    body,
  })
  return POST(req as never, { params: Promise.resolve({ token }) })
}

const INBOUND = {
  From: '+34600111222',
  To: '+34910000000',
  Body: 'Hola, quiero cita',
  MessageSid: 'SM00000000000000000000000000000001',
  NumMedia: '0',
}

beforeEach(() => {
  writes.length = 0
  messages.length = 0
  contacts.length = 0
  conversations.length = 0
  state.config = {
    accountId: 'acct-1',
    accountSid: 'AC1',
    authToken: AUTH_TOKEN,
    webhookToken: TOKEN,
    recordingEnabled: false,
  }
})

describe('POST /api/twilio/[token]/sms/inbound', () => {
  it('token desconocido → 404 y ni una escritura', async () => {
    const res = await post('b'.repeat(64), INBOUND)
    expect(res.status).toBe(404)
    expect(writes).toHaveLength(0)
  })

  it('firma inválida → 403 y CERO escrituras en BD', async () => {
    const res = await post(TOKEN, INBOUND, 'obviamente-mala')
    expect(res.status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('sin header de firma → 403 y cero escrituras', async () => {
    const res = await post(TOKEN, INBOUND, null)
    expect(res.status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('firma válida → persiste el mensaje con channel sms y provider twilio', async () => {
    const res = await post(TOKEN, INBOUND)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/xml')
    expect(await res.text()).toContain('<Response></Response>')

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      channel: 'sms',
      sender_type: 'customer',
      content_text: 'Hola, quiero cita',
      provider: 'twilio',
      provider_message_id: INBOUND.MessageSid,
      status: 'delivered',
    })
  })

  it('reentrega del mismo MessageSid → un solo mensaje', async () => {
    await post(TOKEN, INBOUND)
    await post(TOKEN, INBOUND)
    expect(messages).toHaveLength(1)
  })

  it('responde XML también al rechazar, nunca JSON (error 12300 de Twilio)', async () => {
    const res = await post(TOKEN, INBOUND, 'mala')
    expect(res.headers.get('content-type')).toContain('text/xml')
  })
})
