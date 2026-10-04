import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests de POST /api/email/reply — respuesta de un hilo del inbox por email.
//
// Mismo andamiaje que el test de /api/sms/send (mock encadenable de
// Supabase con arrays-espía de inserts/updates), porque esta ruta es su
// espejo: auth, acotado por cuenta y forma de errores idénticos.
// Lo que aquí se afirma y allí no: threading (Re: + In-Reply-To
// References sobre el último entrante), insert en `messages` con
// channel='email' y metadata con el HTML del mensaje enviado.
// ---------------------------------------------------------------------------

const messageInserts: Array<Record<string, unknown>> = []
const conversationInserts: Array<Record<string, unknown>> = []
const conversationUpdates: Array<Record<string, unknown>> = []

// Escenario por test.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
/** Último email entrante del hilo (threading). null = hilo sin email previo. */
let lastInboundEmail: Record<string, unknown> | null = null
/** Si no es null, assertNotUnsubscribed lanza con este mensaje. */
let unsubscribedMessage: string | null = null
let callerRole: string = 'admin'

const CONVERSATION = {
  id: 'conv-1',
  account_id: 'acct-1',
  contact_id: 'contact-1',
}

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  email: 'cliente@dataforseo.com',
}

const { sendEmailMock, EmailError } = vi.hoisted(() => {
  const send = vi.fn(
    async (_accountId: string, _input: { to: string; subject: string }) => {
      // Referenciados (aunque no influyan en la respuesta) para que el
      // lint no marque args sin usar en el mock.
      void _accountId
      void _input
      return { id: 'resend-msg-1' }
    },
  )
  class Err extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'EmailError'
    }
  }
  return { sendEmailMock: send, EmailError: Err }
})

const { assertNotUnsubscribed } = vi.hoisted(() => ({
  // Copia del shape real (cuenta + contacto); el mock lanza según el
  // escenario. Importar el original para instanceof no haría falta: la
  // ruta solo distingue el mensaje, y el escaperío da el 403 igual.
  assertNotUnsubscribed: vi.fn(async () => {
    if (unsubscribedMessage) throw new Error(unsubscribedMessage)
  }),
}))

vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock, EmailError }))
vi.mock('@/lib/automations/send-email-step', () => ({ assertNotUnsubscribed }))

// Mock encadenable de Supabase: un builder nuevo por `.from()`, que
// recuerda si hubo `.insert()` y qué columnas se filtraron (para
// distinguir la búsqueda del último entrante de los inserts de fila).
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false
    const selectCols: string[] = []

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          return { data: existingConversation, error: null }
        case 'contact_tags':
          return { data: null, error: null }
        case 'messages':
          // Único select sobre messages: la búsqueda del último entrante
          // para el threading.
          return { data: lastInboundEmail, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      if (table === 'conversations') return { data: { id: 'conv-new' }, error: null }
      if (table === 'messages') return { data: { id: 'msg-1' }, error: null }
      return { data: null, error: null }
    }

    const terminal = () => Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'in', 'order', 'limit', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.eq = vi.fn(() => b)
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'conversations') conversationUpdates.push(payload)
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') conversationInserts.push(payload)
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    // selectCols apunta el payload de `.select` por si conviene discernir
    // en un test futuro qué columnas pidió cada consulta.
    void selectCols.push
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

import { POST } from './route'

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/email/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  )
}

function resetScenario() {
  conversationInserts.length = 0
  messageInserts.length = 0
  conversationUpdates.length = 0
  existingConversation = CONVERSATION
  contactRow = CONTACT
  lastInboundEmail = {
    message_id: 'a1b2c3@dataforseo.com',
    metadata: { message_id: 'a1b2c3@dataforseo.com', subject: 'Welcome to DataForSEO' },
  }
  unsubscribedMessage = null
  callerRole = 'admin'
  supabaseMock = makeSupabaseMock()
  sendEmailMock.mockClear()
  assertNotUnsubscribed.mockClear()
}

describe('POST /api/email/reply — threading y persistencia', () => {
  beforeEach(resetScenario)
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('responde al email del contacto con Re: + In-Reply-To/References e inserta la fila channel email', async () => {
    const res = await post({ conversationId: 'conv-1', text: '  hola  ' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      messageId: 'msg-1',
      conversationId: 'conv-1',
    })

    // Destinatario: el email del contacto del hilo — el body NO manda un `to`.
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock.mock.calls[0]).toEqual([
      'acct-1',
      {
        to: 'cliente@dataforseo.com',
        subject: 'Re: Welcome to DataForSEO',
        html: 'hola',
        headers: {
          'In-Reply-To': '<a1b2c3@dataforseo.com>',
          References: '<a1b2c3@dataforseo.com>',
        },
      },
    ])

    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'hola',
      channel: 'email',
      status: 'sent',
      provider: 'resend',
      provider_message_id: 'resend-msg-1',
    })
    const meta = messageInserts[0].metadata as Record<string, unknown>
    expect(meta.subject).toBe('Re: Welcome to DataForSEO')
    expect(meta.to).toBe('cliente@dataforseo.com')
    expect(meta.in_reply_to).toBe('<a1b2c3@dataforseo.com>')
    // El html de metadata deja que la burbuja renderice el mail enviado.
    expect(meta.html).toBe('hola')

    // Bump de la conversación como en el resto del inbox.
    expect(conversationUpdates).toHaveLength(1)
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: 'hola' })
  })

  it('normaliza un Message-ID que ya viene con <…>', async () => {
    lastInboundEmail = {
      message_id: '<a1b2c3@dataforseo.com>',
      metadata: { message_id: '<a1b2c3@dataforseo.com>', subject: 'Re: Welcome to DataForSEO' },
    }

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    expect(res.status).toBe(200)

    // No debe quedar <…<…>…>: el asunto base pierde los Re: acumulados.
    expect(sendEmailMock.mock.calls[0]?.[1]).toMatchObject({
      subject: 'Re: Welcome to DataForSEO',
      headers: {
        'In-Reply-To': '<a1b2c3@dataforseo.com>',
        References: '<a1b2c3@dataforseo.com>',
      },
    })
  })

  it('email saliente sin email previo en el hilo: sin Re ni headers', async () => {
    lastInboundEmail = null

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    expect(res.status).toBe(200)

    expect(sendEmailMock.mock.calls[0]?.[1]).toMatchObject({
      subject: 'Reply',
      headers: {},
    })
    expect(messageInserts[0]).toMatchObject({ channel: 'email' })
  })
})

describe('POST /api/email/reply — validación y tenencia', () => {
  beforeEach(resetScenario)
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('400 si falta el texto', async () => {
    const res = await post({ conversationId: 'conv-1', text: '   ' })
    expect(res.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('400 si falta conversationId', async () => {
    const res = await post({ text: 'hola' })
    expect(res.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('404 con una conversación de otra cuenta', async () => {
    existingConversation = null

    const res = await post({ conversationId: 'conv-ajena', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(json.error).toMatch(/conversation not found/i)
  })

  it('400 si el contacto no tiene email', async () => {
    contactRow = { id: 'contact-1', account_id: 'acct-1', email: null }

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/no email/i)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('403 si el contacto lleva el tag Unsubscribed, sin enviar nada', async () => {
    unsubscribedMessage = 'contact has the "Unsubscribed" tag — email not sent'

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error).toMatch(/Unsubscribed/)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('403 a un viewer y 200 a un agent', async () => {
    callerRole = 'viewer'
    const viewerRes = await post({ conversationId: 'conv-1', text: 'hola' })
    expect(viewerRes.status).toBe(403)
    expect(sendEmailMock).not.toHaveBeenCalled()

    callerRole = 'agent'
    const agentRes = await post({ conversationId: 'conv-1', text: 'hola' })
    expect(agentRes.status).toBe(200)
  })

  it('body malformado → 400 (no el 500 genérico)', async () => {
    const res = await POST(
      new Request('http://localhost/api/email/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ no json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    )
    expect(res.status).toBe(400)
  })

  it('error de Resend → 502 y fila no insertada', async () => {
    sendEmailMock.mockImplementationOnce(async () => {
      throw new EmailError('Resend error: domain not verified')
    })

    const res = await post({ conversationId: 'conv-1', text: 'hola' })

    expect(res.status).toBe(502)
    expect(messageInserts).toHaveLength(0)
  })
})
