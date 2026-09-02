import { afterEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// La preferencia por Messaging Service no es estética: un número suelto
// sin servicio vinculado a una campaña A2P 10DLC devuelve 30034 en EE.
// UU., y en internacional se pierden geo-match y sticky sender.
// ============================================================

const { create, state } = vi.hoisted(() => ({
  create: vi.fn(async (args: Record<string, unknown>) => ({
    sid: 'SM123',
    from: (args.from as string) ?? '+34910999999',
  })),
  state: {
    cfg: {
      accountId: 'acct-1',
      accountSid: 'AC1',
      authToken: 'tok',
      messagingServiceSid: null as string | null,
      defaultFromNumber: '+34910000000' as string | null,
      webhookToken: 'a'.repeat(64),
    },
  },
}))

vi.mock('./client', () => ({
  twilioForAccount: async () => ({ client: { messages: { create } }, cfg: state.cfg }),
  withTwilioRetry: async <T>(fn: () => Promise<T>) => fn(),
}))

afterEach(() => {
  create.mockClear()
  state.cfg.messagingServiceSid = null
  state.cfg.defaultFromNumber = '+34910000000'
})

describe('twilioSms.send', () => {
  it('con Messaging Service NO manda `from`', async () => {
    state.cfg.messagingServiceSid = 'MG123'
    const { twilioSms } = await import('./sms')
    await twilioSms.send('acct-1', { to: '+34600111222', text: 'Hola' })

    const args = create.mock.calls[0][0]
    expect(args.messagingServiceSid).toBe('MG123')
    expect(args).not.toHaveProperty('from')
  })

  it('sin Messaging Service cae al número por defecto', async () => {
    const { twilioSms } = await import('./sms')
    await twilioSms.send('acct-1', { to: '+34600111222', text: 'Hola' })

    const args = create.mock.calls[0][0]
    expect(args.from).toBe('+34910000000')
    expect(args).not.toHaveProperty('messagingServiceSid')
  })

  it('siempre pide statusCallback en la ruta con el token de la cuenta', async () => {
    const { twilioSms } = await import('./sms')
    await twilioSms.send('acct-1', { to: '+34600111222', text: 'Hola' })

    expect(create.mock.calls[0][0].statusCallback).toBe(
      `https://ci.example.test/api/twilio/${'a'.repeat(64)}/sms/status`,
    )
  })

  it('devuelve el SID y el remitente que eligió Twilio', async () => {
    state.cfg.messagingServiceSid = 'MG123'
    const { twilioSms } = await import('./sms')
    const result = await twilioSms.send('acct-1', { to: '+34600111222', text: 'Hola' })
    expect(result.providerMessageId).toBe('SM123')
  })

  it('sin servicio NI número, falla con un mensaje accionable y sin llamar a Twilio', async () => {
    state.cfg.messagingServiceSid = null
    state.cfg.defaultFromNumber = null
    const { twilioSms } = await import('./sms')
    await expect(twilioSms.send('acct-1', { to: '+34600111222', text: 'Hola' })).rejects.toThrow(
      /Messaging Service SID or a default from number/,
    )
    expect(create).not.toHaveBeenCalled()
  })
})
