import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderNotConfiguredError } from '@/lib/providers/errors'

// ---------------------------------------------------------------------------
// Tests de POST /api/sms/send — envío manual de SMS desde el inbox.
//
// Mismo andamiaje que el test de /api/whatsapp/send (mock encadenable de
// Supabase con flag `didInsert` y arrays-espía de inserts), porque esta ruta
// es su espejo: auth, acotado por cuenta y forma de errores idénticos.
// Lo que aquí se afirma y allí no: que el proveedor lo elige el registry
// (nunca Twilio/Telnyx a pelo) y que la fila persistida lleva las claves de
// las que dependen los webhooks de estado (channel/provider/
// provider_message_id/metadata.telnyx_message_id).
// ---------------------------------------------------------------------------

const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []
const conversationUpdates: Array<Record<string, unknown>> = []

// Escenario por test.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
/** Resultado de la búsqueda por `phone_normalized` (camino `to` suelto). */
let contactByPhoneRow: Record<string, unknown> | null = null
/** Fila de contact_tags que representa la baja; null = contacto activo. */
let suppressedRow: Record<string, unknown> | null = null
// El rol del caller, tal y como lo lee `requireRole` del profile. Enviar
// exige 'agent'; un 'viewer' debe rebotar antes de tocar al proveedor.
let callerRole: string = 'admin'

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

const CONVERSATION = {
  id: 'conv-1',
  account_id: 'acct-1',
  contact_id: 'contact-1',
}

// Adaptador SMS falso. La ruta jamás debe hablar con Twilio ni con Telnyx
// directamente: resuelve por el registry, que es lo único que se mockea.
const { resolveSmsProvider, sendSms, providerId } = vi.hoisted(() => {
  const state = { id: 'telnyx' as 'telnyx' | 'twilio' }
  const send = vi.fn(
    async (_accountId: string, _input: { to: string; text: string }) => ({
      providerMessageId: 'provider-msg-1',
      from: '+15550000000',
    }),
  )
  return {
    sendSms: send,
    providerId: state,
    resolveSmsProvider: vi.fn(async () => ({ id: state.id, send })),
  }
})
vi.mock('@/lib/providers/registry', () => ({ resolveSmsProvider }))

// Mock encadenable de Supabase: un builder nuevo por `.from()`, que recuerda
// si hubo `.insert()` (para que el terminal devuelva la fila insertada) y qué
// columnas se filtraron (para distinguir la búsqueda de contacto por id de la
// búsqueda por teléfono).
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false
    const eqCols: string[] = []

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
          return {
            data: eqCols.includes('phone_normalized') ? contactByPhoneRow : contactRow,
            error: null,
          }
        case 'conversations':
          return { data: existingConversation, error: null }
        case 'contact_tags':
          return { data: suppressedRow, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return { data: { id: 'conv-new' }, error: null }
        case 'messages':
          return { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'in', 'order', 'limit', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.eq = vi.fn((col: string) => {
      eqCols.push(col)
      return b
    })
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
    new Request('http://localhost/api/sms/send', {
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
  contactByPhoneRow = null
  suppressedRow = null
  callerRole = 'admin'
  providerId.id = 'telnyx'
  supabaseMock = makeSupabaseMock()
  sendSms.mockClear()
  resolveSmsProvider.mockClear()
}

describe('POST /api/sms/send — camino feliz', () => {
  beforeEach(resetScenario)
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('con contacto resuelto ignora el `to` del body y manda al teléfono del contacto', async () => {
    // Un POST con { contactId, to: <número de OTRO contacto> } entregaría el
    // SMS a ese otro número mientras la comprobación de baja y la fila de
    // `messages` corren sobre el contacto del body: se saltaría el opt-out
    // del dueño real del número y el CRM registraría un mensaje que ese
    // contacto nunca recibió. El teléfono del contacto manda siempre.
    const res = await post({
      contactId: 'contact-1',
      to: '+15550000000',
      text: 'hola',
    })

    expect(res.status).toBe(200)
    expect(sendSms.mock.calls[0]?.[1]).toMatchObject({ to: '+15551234567' })
  })

  it('envía por el proveedor del registry y persiste el mensaje con channel sms', async () => {
    const res = await post({ conversationId: 'conv-1', text: '  hola  ' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      messageId: 'msg-1',
      conversationId: 'conv-1',
    })

    // El proveedor lo elige `provider_routing`, no la ruta.
    expect(resolveSmsProvider).toHaveBeenCalledWith('acct-1')
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(sendSms.mock.calls[0]).toEqual([
      'acct-1',
      // E.164 con '+' y el texto recortado.
      { to: '+15551234567', text: 'hola' },
    ])

    // Las columnas son las mismas que escribe el paso send_sms del engine:
    // de ellas depende que los webhooks de estado encuentren la fila.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'hola',
      channel: 'sms',
      status: 'sent',
      provider: 'telnyx',
      provider_message_id: 'provider-msg-1',
      metadata: { telnyx_message_id: 'provider-msg-1' },
    })

    // Y la conversación queda bumpeada como en el resto del inbox.
    expect(conversationUpdates).toHaveLength(1)
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: 'hola' })
  })

  it('con Twilio deja telnyx_message_id a null (ese webhook busca por el par genérico)', async () => {
    providerId.id = 'twilio'

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    expect(res.status).toBe(200)

    expect(messageInserts[0]).toMatchObject({
      provider: 'twilio',
      provider_message_id: 'provider-msg-1',
      metadata: { telnyx_message_id: null },
    })
  })

  it('abre la conversación del contacto cuando todavía no tiene una', async () => {
    existingConversation = null

    const res = await post({ contactId: 'contact-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.conversationId).toBe('conv-new')
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      // NOT NULL en la tabla: sin user_id el insert falla en silencio.
      user_id: 'user-1',
    })
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-new' })
  })

  it('con `to` suelto y sin contacto conocido envía sin persistir, sin fabricar contactos', async () => {
    existingConversation = null
    contactRow = null
    contactByPhoneRow = null

    const res = await post({ to: '+15559998888', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(sendSms.mock.calls[0]?.[1]).toMatchObject({ to: '+15559998888' })
    expect(json).toEqual({ ok: true, messageId: null, conversationId: null })
    expect(messageInserts).toHaveLength(0)
    expect(conversationInserts).toHaveLength(0)
  })
})

describe('POST /api/sms/send — validación y tenencia', () => {
  beforeEach(resetScenario)
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('400 si falta el texto', async () => {
    const res = await post({ conversationId: 'conv-1', text: '   ' })

    expect(res.status).toBe(400)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('400 si el contacto no tiene teléfono', async () => {
    contactRow = { id: 'contact-1', account_id: 'acct-1', phone: null }

    const res = await post({ contactId: 'contact-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/contactId or to/i)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('404 con una conversación de otra cuenta, sin llamar al proveedor', async () => {
    // El filtro por account_id no devuelve fila; se responde 404 y no 403
    // para no confirmar que el id existe en otra cuenta.
    existingConversation = null

    const res = await post({ conversationId: 'conv-ajena', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/conversation not found/i)
    expect(sendSms).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('404 con un contacto de otra cuenta', async () => {
    contactRow = null

    const res = await post({ contactId: 'contact-ajeno', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('400 con un body malformado en vez del 500 genérico', async () => {
    const res = await POST(
      new Request('http://localhost/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ no json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    )

    expect(res.status).toBe(400)
    expect(sendSms).not.toHaveBeenCalled()
  })
})

describe('POST /api/sms/send — rol, baja y proveedor sin configurar', () => {
  beforeEach(resetScenario)
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rechaza a un viewer con 403 y no llega al proveedor', async () => {
    // Igual que en WhatsApp, el gate de rol va ANTES del proveedor: RLS
    // bloquearía el INSERT, pero el SMS ya habría salido (y facturado) y
    // no se des-envía.
    callerRole = 'viewer'

    const res = await post({ conversationId: 'conv-1', text: 'hola' })

    expect(res.status).toBe(403)
    expect(sendSms).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('deja pasar a un agent', async () => {
    callerRole = 'agent'

    const res = await post({ conversationId: 'conv-1', text: 'hola' })

    expect(res.status).toBe(200)
    expect(sendSms).toHaveBeenCalledTimes(1)
  })

  it('403 si el contacto está dado de baja, sin llamar al proveedor', async () => {
    suppressedRow = { tag_id: 'tag-1', tags: { name: 'Unsubscribed' } }

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error).toMatch(/Unsubscribed/)
    expect(sendSms).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('400 accionable cuando la cuenta no tiene SMS configurado', async () => {
    resolveSmsProvider.mockImplementationOnce(async () => {
      throw new ProviderNotConfiguredError(
        'send_sms needs messaging_profile_id (Settings › Telnyx › SMS)',
        'telnyx',
      )
    })

    const res = await post({ conversationId: 'conv-1', text: 'hola' })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/messaging_profile_id/)
    expect(messageInserts).toHaveLength(0)
  })
})
