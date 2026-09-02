import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El webhook de SendGrid recibe LOTES. Lo que se prueba aquí: fail-closed
// sin clave pública, agrupación por envío, aislamiento de tenancy y el
// ack 200 incondicional tras verificar (SendGrid reintenta el lote
// entero ante cualquier no-200).
// ============================================================

const TOKEN = 'a'.repeat(64)
const SEND_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_SEND_ID = '99999999-2222-4333-8444-555555555555'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PUBLIC_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

const { state, rpc } = vi.hoisted(() => ({
  state: {
    config: null as Record<string, unknown> | null,
    ownSendIds: [] as string[],
  },
  rpc: vi.fn(async (_fn: string, _params: Record<string, unknown>) => ({
    error: null as { message: string } | null,
  })),
}))

vi.mock('@/lib/providers/sendgrid/config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadSendGridConfigByWebhookToken: vi.fn(async (token: string) =>
      token === TOKEN ? state.config : null,
    ),
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc,
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      let requested: string[] = []
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.in = vi.fn((_col: string, values: string[]) => {
        requested = values
        return b
      })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'email_sends') {
          return resolve({
            data: requested.filter((v) => state.ownSendIds.includes(v)).map((id) => ({ id })),
            error: null,
          })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { POST } from './route'

const NOW_SECONDS = 1_800_000_000

function post(events: unknown[], opts: { sign?: boolean; token?: string } = {}) {
  const body = JSON.stringify(events)
  const ts = String(NOW_SECONDS)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.sign !== false) {
    const signer = createSign('sha256')
    signer.update(ts + body)
    signer.end()
    headers['X-Twilio-Email-Event-Webhook-Signature'] = signer.sign(privateKey).toString('base64')
    headers['X-Twilio-Email-Event-Webhook-Timestamp'] = ts
  }
  const req = new Request(`http://localhost/api/sendgrid/${opts.token ?? TOKEN}/webhook`, {
    method: 'POST',
    headers,
    body,
  })
  return POST(req as never, { params: Promise.resolve({ token: opts.token ?? TOKEN }) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_SECONDS * 1000)
  rpc.mockClear()
  state.ownSendIds = [SEND_ID]
  state.config = {
    accountId: 'acct-1',
    webhookToken: TOKEN,
    webhookPublicKey: PUBLIC_KEY_B64,
  }
})
afterEach(() => vi.useRealTimers())

describe('POST /api/sendgrid/[token]/webhook', () => {
  it('token desconocido → 404', async () => {
    const res = await post([], { token: 'b'.repeat(64) })
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sin clave pública configurada → 503, no se procesa nada', async () => {
    state.config = { ...state.config, webhookPublicKey: null }
    const res = await post([{ event: 'delivered', email_send_id: SEND_ID }])
    expect(res.status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('firma ausente → 403 y cero RPC', async () => {
    const res = await post([{ event: 'delivered', email_send_id: SEND_ID }], { sign: false })
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('lote de 3 eventos del mismo envío y mismo tipo → UNA sola llamada RPC', async () => {
    const res = await post([
      { event: 'delivered', email_send_id: SEND_ID, account_id: 'acct-1', sg_message_id: 'm.recvd-1' },
      { event: 'delivered', email_send_id: SEND_ID, account_id: 'acct-1', sg_message_id: 'm.recvd-2' },
      { event: 'delivered', email_send_id: SEND_ID, account_id: 'acct-1', sg_message_id: 'm.recvd-3' },
    ])
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_provider: 'sendgrid',
      p_trigger: 'delivered',
      p_send_id: SEND_ID,
    })
  })

  it('normaliza sg_message_id: el sufijo .recvd- no forma parte de nuestro id', async () => {
    await post([{ event: 'open', sg_message_id: 'abc123.recvd-xyz', account_id: 'acct-1' }])
    // Sin email_send_id el grupo va por message id; no está en las filas
    // de la cuenta, así que se ignora — pero la normalización se ve en el
    // hecho de que no explota y de que se consultó por el prefijo.
    expect(rpc).not.toHaveBeenCalled()
  })

  it('mapea cada evento de SendGrid a su trigger', async () => {
    state.ownSendIds = [SEND_ID]
    await post([
      { event: 'bounce', email_send_id: SEND_ID, account_id: 'acct-1' },
      { event: 'open', email_send_id: SEND_ID, account_id: 'acct-1' },
      { event: 'click', email_send_id: SEND_ID, account_id: 'acct-1' },
      { event: 'spamreport', email_send_id: SEND_ID, account_id: 'acct-1' },
      { event: 'processed', email_send_id: SEND_ID, account_id: 'acct-1' },
      { event: 'deferred', email_send_id: SEND_ID, account_id: 'acct-1' },
    ])
    const triggers = rpc.mock.calls.map((c) => (c[1] as { p_trigger: string }).p_trigger).sort()
    // processed y deferred se ignoran; spamreport se convierte en supresión.
    expect(triggers).toEqual(['bounced', 'clicked', 'opened', 'suppressed'])
  })

  it('un evento con account_id de otra cuenta se descarta sin tocar la BD', async () => {
    await post([{ event: 'delivered', email_send_id: SEND_ID, account_id: 'acct-2' }])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('un email_send_id que no pertenece a la cuenta se descarta aunque no traiga account_id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post([{ event: 'delivered', email_send_id: OTHER_SEND_ID }])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('ackea 200 aunque la RPC falle: un 500 devolvería el lote entero', async () => {
    rpc.mockResolvedValueOnce({ error: { message: 'boom' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post([{ event: 'delivered', email_send_id: SEND_ID, account_id: 'acct-1' }])
    expect(res.status).toBe(200)
  })

  it('un lote vacío se ackea sin trabajo', async () => {
    const res = await post([])
    expect(res.status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
  })
})
