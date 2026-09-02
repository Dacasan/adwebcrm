import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Dos órdenes de operaciones, uno por proveedor:
//
//   Resend    enviar → insertar (el id solo existe después del envío)
//   SendGrid  insertar 'queued' → enviar con ese id → actualizar 'sent'
//
// El segundo existe porque los eventos del webhook de SendGrid llegan a
// veces ANTES de que termine nuestro update. El primero se conserva
// intacto: es un test de regresión del camino que ya funcionaba.
// ============================================================

const { calls, state } = vi.hoisted(() => ({
  calls: [] as { op: string; payload?: unknown }[],
  state: {
    provider: 'resend' as 'resend' | 'sendgrid',
    sendThrows: false,
  },
}))

const send = vi.fn(async (_accountId: string, input: Record<string, unknown>) => {
  calls.push({ op: 'send', payload: input })
  if (state.sendThrows) throw new Error('provider down')
  return { providerMessageId: 'msg-1' }
})

vi.mock('@/lib/providers/registry', () => ({
  resolveEmailProvider: async () => ({ id: state.provider, send }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        calls.push({ op: 'insert', payload })
        return b
      })
      b.update = vi.fn((payload: Record<string, unknown>) => {
        calls.push({ op: 'update', payload })
        return b
      })
      b.select = vi.fn(() => b)
      // `.eq` encadenable: assertNotUnsubscribed hace .eq().eq().maybeSingle().
      b.eq = vi.fn(() => b)
      b.single = vi.fn(async () => ({ data: { id: 'send-uuid' }, error: null }))
      // maybeSingle → null: el contacto de estos tests NO tiene el tag
      // "Unsubscribed" (assertNotUnsubscribed no debe lanzar).
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { deliverAutomationEmail } from './send-email-step'

const ARGS = {
  accountId: 'acct-1',
  contactId: 'c1',
  automationId: 'auto-1',
  templateName: 'missed_call',
  recipient: 'ana@x.com',
  subject: 'Hola',
  html: '<p>Hola</p>',
}

beforeEach(() => {
  calls.length = 0
  state.provider = 'resend'
  state.sendThrows = false
  send.mockClear()
})

describe('camino Resend (regresión: no debe cambiar nada)', () => {
  it('envía primero y persiste después, con las columnas vieja y nueva', async () => {
    const result = await deliverAutomationEmail(ARGS)

    expect(calls.map((c) => c.op)).toEqual(['send', 'insert'])
    expect(calls[1].payload).toMatchObject({
      account_id: 'acct-1',
      status: 'sent',
      provider: 'resend',
      resend_message_id: 'msg-1',
      provider_message_id: 'msg-1',
    })
    expect(result).toEqual({
      provider: 'resend',
      providerMessageId: 'msg-1',
      resendMessageId: 'msg-1',
    })
  })

  it('no manda sendId: Resend no devuelve metadatos en su webhook', async () => {
    await deliverAutomationEmail(ARGS)
    expect(send.mock.calls[0][1]).not.toHaveProperty('sendId')
  })
})

describe('camino SendGrid', () => {
  beforeEach(() => {
    state.provider = 'sendgrid'
  })

  it('inserta en queued, envía con el id en customArgs y cierra en sent', async () => {
    const result = await deliverAutomationEmail(ARGS)

    expect(calls.map((c) => c.op)).toEqual(['insert', 'send', 'update'])
    expect(calls[0].payload).toMatchObject({ status: 'queued', provider: 'sendgrid' })
    expect(calls[1].payload).toMatchObject({ sendId: 'send-uuid' })
    expect(calls[2].payload).toMatchObject({ status: 'sent', provider_message_id: 'msg-1' })
    expect(result.provider).toBe('sendgrid')
    // El alias histórico queda vacío: este id NO es de Resend.
    expect(result.resendMessageId).toBe('')
  })

  it('si el envío falla, la fila se marca failed y NO se borra', async () => {
    state.sendThrows = true
    await expect(deliverAutomationEmail(ARGS)).rejects.toThrow('provider down')

    expect(calls.map((c) => c.op)).toEqual(['insert', 'send', 'update'])
    expect(calls[2].payload).toEqual({ status: 'failed' })
    expect(calls.some((c) => c.op === 'delete')).toBe(false)
  })
})
