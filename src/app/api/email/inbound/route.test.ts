import { beforeEach, describe, expect, it, vi } from 'vitest'

import { POST } from './route'

// Contrato HTTP del webhook inbound (espejo de /api/email/webhook):
// fail-closed 503/400, ack de eventos ajenos, e ingestión con el admin
// de Supabase mockeado (mismo estilo que los tests del webhook de Telnyx).
// La firma Svix NO se computa aquí: `verifyResendWebhook` se mockea para
// controlar el evento parseado (la criptografía real ya la cubre el SDK).

vi.mock('@/lib/email/send', () => ({
  verifyResendWebhook: vi.fn(),
  EmailError: class EmailError extends Error {},
}))

vi.mock('@/lib/telnyx/admin-client', () => ({
  supabaseAdmin: () => currentAdmin,
}))

import { EmailError, verifyResendWebhook } from '@/lib/email/send'

const mockedVerify = vi.mocked(verifyResendWebhook)

type Row = Record<string, unknown>

/** Admin falso: builders encadenables que resuelven por tabla. Captura
 *  inserts y rpcs para asertar qué escribió la ingesta. */
function makeAdmin(opts: {
  dupe?: Row | null
  emailConfig?: Row[]
  account?: Row | null
  contact?: Row | null
  conversation?: Row | null
  insertError?: { code?: string; message?: string } | null
}) {
  const calls = {
    inserts: [] as Array<{ table: string; row: Row }>,
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  }
  const build = (table: string) => {
    let inserted = false
    const self: Record<string, unknown> = {}
    const s = self as {
      select: () => typeof self
      eq: () => typeof self
      ilike: () => typeof self
      in: () => typeof self
      insert: (row: Row) => typeof self
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>
      single: () => Promise<{ data: unknown; error: unknown }>
      then: (resolve: (v: unknown) => unknown) => unknown
    }
    const payload = () => {
      if (inserted) {
        // El 23505 simulado solo aplica al insert de messages: el error
        // real sale del índice único (conversation_id, message_id).
        if (opts.insertError && table === 'messages')
          return { data: null, error: opts.insertError }
        const id = table === 'messages' ? 'm-new' : 'c-new'
        return { data: { id }, error: null }
      }
      if (table === 'messages') return { data: opts.dupe ?? null, error: null }
      if (table === 'email_config') return { data: opts.emailConfig ?? [], error: null }
      if (table === 'accounts') return { data: opts.account ?? null, error: null }
      if (table === 'contacts') return { data: opts.contact ?? null, error: null }
      if (table === 'conversations') return { data: opts.conversation ?? null, error: null }
      return { data: null, error: null }
    }
    s.select = () => s
    s.eq = () => s
    s.ilike = () => s
    s.in = () => s
    s.insert = (row: Row) => {
      inserted = true
      calls.inserts.push({ table, row })
      return s
    }
    s.maybeSingle = async () => payload()
    s.single = async () => payload()
    s.then = (resolve: (v: unknown) => unknown) => resolve(payload())
    return s
  }
  return {
    calls,
    from: (table: string) => build(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpcs.push({ fn, args })
      return { data: null, error: null }
    },
  }
}

type Admin = ReturnType<typeof makeAdmin> | undefined
let currentAdmin: Admin = undefined

function post(body: string) {
  const req = new Request('http://localhost/api/email/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return POST(req as unknown as Parameters<typeof POST>[0])
}

const RECEIVED_EVENT = {
  type: 'email.received',
  created_at: '2026-08-28T22:34:28.092Z',
  data: {
    email_id: 'e-123',
    message_id: '<abc@cliente.com>',
    subject: 'Consulta',
    from: 'Luis <luis@cliente.com>',
    to: ['hello@example.com'],
    text: 'Quiero agendar una limpieza.',
  },
}

const CONFIG = [{ account_id: 'acc-1', from_email: 'hello@example.com' }]

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  currentAdmin = undefined
})

describe('POST /api/email/inbound (fail-closed)', () => {
  it('503 sin RESEND_INBOUND_WEBHOOK_SECRET configurado (no ackea)', async () => {
    const res = await post(JSON.stringify(RECEIVED_EVENT))
    expect(res.status).toBe(503)
  })

  it('400 si la firma Svix es inválida', async () => {
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test')
    mockedVerify.mockRejectedValue(new EmailError('invalid signature'))
    const res = await post(JSON.stringify(RECEIVED_EVENT))
    expect(res.status).toBe(400)
  })

  it('ack sin tocar la BD para eventos que no son email.received', async () => {
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test')
    currentAdmin = makeAdmin({ emailConfig: CONFIG })
    mockedVerify.mockResolvedValue({
      type: 'email.delivered',
      data: { email_id: 'e-1' },
    } as Awaited<ReturnType<typeof verifyResendWebhook>>)
    const res = await post(JSON.stringify({ type: 'email.delivered', data: { email_id: 'e-1' } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(currentAdmin.calls.inserts).toHaveLength(0)
    expect(currentAdmin.calls.rpcs).toHaveLength(0)
  })
})

describe('POST /api/email/inbound (ingesta)', () => {
  const stubAndVerify = async () => {
    vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test')
    mockedVerify.mockResolvedValue(
      // `email.received` (inbound) no está en la unión de eventos del SDK
      // de Resend, así que el cast pasa por `unknown` — es un fixture del
      // webhook, no una promesa sobre el tipo del SDK.
      RECEIVED_EVENT as unknown as Awaited<ReturnType<typeof verifyResendWebhook>>,
    )
  }

  it('ingesta feliz: contacto + conversación + message channel=email + bump RPC', async () => {
    await stubAndVerify()
    const admin = makeAdmin({
      emailConfig: CONFIG,
      account: { owner_user_id: 'u-owner' },
    })
    currentAdmin = admin

    const res = await post(JSON.stringify(RECEIVED_EVENT))
    expect(res.status).toBe(200)
    expect((await res.json()).result).toBe('stored')

    const contactInsert = admin.calls.inserts.find((c) => c.table === 'contacts')
    expect(contactInsert?.row.email).toBe('luis@cliente.com')
    expect(contactInsert?.row.user_id).toBe('u-owner')
    // Nunca un contacto sin nombre: el display name del remitente, y si
    // no viniera, la propia dirección (espejo de `name || phone` en WA).
    expect(contactInsert?.row.name).toBe('Luis')

    const conversationInsert = admin.calls.inserts.find((c) => c.table === 'conversations')
    expect(conversationInsert?.row.user_id).toBe('u-owner')

    const messageInsert = admin.calls.inserts.find((c) => c.table === 'messages')
    expect(messageInsert).toBeDefined()
    expect(messageInsert?.row.channel).toBe('email')
    expect(messageInsert?.row.provider).toBe('resend')
    expect(messageInsert?.row.provider_message_id).toBe('e-123')
    expect(messageInsert?.row.message_id).toBe('<abc@cliente.com>')
    expect(messageInsert?.row.sender_type).toBe('customer')
    expect(messageInsert?.row.content_text).toBe('Quiero agendar una limpieza.')
    expect((messageInsert?.row.metadata as Row).subject).toBe('Consulta')

    expect(admin.calls.rpcs).toHaveLength(1)
    expect(admin.calls.rpcs[0].fn).toBe('bump_conversation_on_inbound')
    expect(admin.calls.rpcs[0].args.p_conversation_id).toBe('c-new')
  })

  it('reentrega del webhook → duplicate, sin insertar ni bump', async () => {
    await stubAndVerify()
    const admin = makeAdmin({ emailConfig: CONFIG, dupe: { id: 'm-old' } })
    currentAdmin = admin

    const res = await post(JSON.stringify(RECEIVED_EVENT))
    expect((await res.json()).result).toBe('duplicate')
    expect(admin.calls.inserts.filter((c) => c.table === 'messages')).toHaveLength(0)
    expect(admin.calls.rpcs).toHaveLength(0)
  })

  it('bandeja sin email_config → ack sin ingestar', async () => {
    await stubAndVerify()
    const admin = makeAdmin({ emailConfig: [] })
    currentAdmin = admin

    const res = await post(JSON.stringify(RECEIVED_EVENT))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toBeUndefined()
    expect(admin.calls.inserts).toHaveLength(0)
  })

  it('carrera de reentrega (23505 del índice único) → duplicate', async () => {
    await stubAndVerify()
    const admin = makeAdmin({
      emailConfig: CONFIG,
      account: { owner_user_id: 'u-owner' },
      insertError: { code: '23505', message: 'duplicate key' },
    })
    currentAdmin = admin

    const res = await post(JSON.stringify(RECEIVED_EVENT))
    expect((await res.json()).result).toBe('duplicate')
  })
})
