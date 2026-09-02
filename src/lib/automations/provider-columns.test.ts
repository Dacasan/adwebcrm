import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Migración 076: el par genérico (provider, provider_*_id) convive con
// las columnas viejas. Lo que se afirma aquí es la CONVIVENCIA — que el
// paso de Telnyx escribe las tres cosas — porque es lo que permitirá
// unificar las consultas más adelante sin romper lo que hay en vuelo.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    contact: { id: 'c1', name: 'Ana', email: 'ana@x.com', phone: '+34600111222', company: '' },
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    messageInserts: [] as Record<string, unknown>[],
    emailInserts: [] as Record<string, unknown>[],
  },
}))

vi.mock('./admin-client', () => {
  const { state } = h
  function builder(table: string) {
    const ops = { table, type: 'select', payload: undefined as unknown }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.insert = (p: unknown) => {
      ops.type = 'insert'
      ops.payload = p
      if (table === 'messages') state.messageInserts.push(p as Record<string, unknown>)
      return b
    }
    b.update = () => b
    b.upsert = () => b
    b.eq = () => b
    b.gte = () => b
    b.is = () => b
    b.order = () => b
    b.limit = () => b
    const resolve = () => {
      if (table === 'contacts') return { data: state.contact, error: null }
      if (table === 'automations') return { data: state.automations, error: null }
      if (table === 'automation_steps') return { data: state.steps, error: null }
      if (table === 'automation_logs') return { data: { id: 'log1' }, error: null }
      if (table === 'conversations') return { data: { id: 'conv-1' }, error: null }
      return { data: null, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF)
    return b
  }
  return {
    supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc: async () => ({ error: null }) }),
  }
})

vi.mock('@/lib/telnyx/api', () => ({
  loadTelnyxSendConfig: async () => ({
    apiKey: 'key',
    fromNumber: '+34910000000',
    messagingProfileId: 'mp-1',
  }),
  createTelnyxClient: () => ({ sendSms: async () => ({ id: 'telnyx-msg-1' }) }),
}))

import { runAutomationsForTrigger } from './engine'

const ACCOUNT = 'acct-1'

beforeEach(() => {
  h.state.messageInserts = []
  h.state.emailInserts = []
  h.state.steps = [
    {
      id: 's1',
      automation_id: 'auto-1',
      step_type: 'send_sms',
      step_config: { text: 'Hola' },
      position: 0,
    },
  ]
  h.state.automations = [
    {
      id: 'auto-1',
      account_id: ACCOUNT,
      user_id: 'user-1',
      name: 'sms',
      trigger_type: 'missed_call',
      trigger_config: {},
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    },
  ]
})

describe('send_sms escribe las columnas de proveedor (076)', () => {
  it('la fila de messages lleva provider, provider_message_id y el metadata histórico', async () => {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'missed_call',
      contactId: 'c1',
      context: {},
    })

    expect(h.state.messageInserts).toHaveLength(1)
    const row = h.state.messageInserts[0]
    expect(row).toMatchObject({
      channel: 'sms',
      provider: 'telnyx',
      provider_message_id: 'telnyx-msg-1',
    })
    // Compatibilidad: el webhook de Telnyx sigue buscando por esta clave,
    // y tiene que valer exactamente lo mismo que la columna nueva.
    expect((row.metadata as { telnyx_message_id?: string }).telnyx_message_id).toBe(
      'telnyx-msg-1',
    )
    expect((row.metadata as { telnyx_message_id?: string }).telnyx_message_id).toBe(
      row.provider_message_id,
    )
  })
})
