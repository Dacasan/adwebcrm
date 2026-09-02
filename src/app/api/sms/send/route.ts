import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { findOrCreateConversation } from '@/lib/inbound/resolve'
import { ProviderError, ProviderNotConfiguredError } from '@/lib/providers/errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { deliverSms, SmsSendError } from '@/lib/sms/deliver'
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// POST /api/sms/send — envío manual de un SMS (agent+).
//   body: { contactId?, to?, text, conversationId? }
//
// Espejo de /api/whatsapp/send: misma auth, mismo acotado por cuenta,
// misma forma de errores. Lo que NO tiene, porque es de WhatsApp y no
// del SMS: ventana de 24 h, plantillas de Meta, interactivos, media y
// citas (`reply_to_message_id`). El adaptador `SmsProvider.send` solo
// acepta `{ to, text }`.
//
// El rol se comprueba AQUÍ y no se delega a RLS. La razón es la misma
// que documenta /api/whatsapp/send, y con SMS pesa más: al proveedor se
// le llama ANTES de persistir, así que un viewer conseguiría que saliera
// un SMS facturado y entregado que RLS solo impediría GUARDAR. Un SMS no
// se des-envía.
//
// La entrega y la persistencia viven en `lib/sms/deliver.ts` para que el
// canal SMS tenga UNA sola definición de "cómo se guarda un saliente"
// (columnas idénticas a las del paso `send_sms` del engine, de las que
// dependen los webhooks de estado para encontrar la fila).
// ============================================================

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    // Bucket propio: si compartiera `send:${userId}` con WhatsApp, el
    // composer de un canal se comería el presupuesto del otro.
    const limit = checkRateLimit(`sms-send:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    let body: {
      contactId?: string
      to?: string
      text?: string
      conversationId?: string
    }
    try {
      body = (await req.json()) as typeof body
    } catch {
      // Un body malformado es un 400, no el 500 genérico que da un
      // `await req.json()` sin envolver.
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }

    // ------------------------------------------------------------
    // Resolver destinatario e hilo. Todo acotado por `ctx.accountId`:
    // `messages` no tiene account_id (la tenencia se deriva de
    // conversations), así que verificar aquí no es defensivo, es la
    // única barrera antes del insert.
    //
    // Un id ajeno responde 404 y nunca 403: un 403 confirmaría que la
    // fila existe en otra cuenta.
    // ------------------------------------------------------------
    let conversationId: string | null = null
    let contactId: string | null = null
    let phone = typeof body.to === 'string' ? body.to.trim() : ''

    if (typeof body.conversationId === 'string' && body.conversationId) {
      const { data: conv } = await ctx.supabase
        .from('conversations')
        .select('id, contact_id')
        .eq('id', body.conversationId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!conv) {
        return NextResponse.json({ error: 'conversation not found' }, { status: 404 })
      }
      conversationId = conv.id as string
      contactId = (conv.contact_id as string | null) ?? null
    } else if (typeof body.contactId === 'string' && body.contactId) {
      contactId = body.contactId
    }

    // Teléfono del contacto. La lectura vuelve a filtrar por account_id
    // para que un contactId ajeno no revele ni un número ni la existencia
    // de la fila.
    //
    // Con contacto resuelto, `to` se IGNORA a propósito aunque venga en
    // el body. Si se respetara, un POST con { contactId: A, to: <número
    // de B> } mandaría el SMS a B mientras la comprobación de baja corre
    // sobre A y la fila de `messages` se escribe en el hilo de A: se
    // saltaría el opt-out de B y el CRM registraría un mensaje que ese
    // contacto nunca recibió. El opt-out no puede depender de que el
    // cliente mande datos coherentes. Sin contacto, `to` manda: es el
    // caso de un número suelto.
    if (contactId) {
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id, phone')
        .eq('id', contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!contact) {
        return NextResponse.json({ error: 'contact not found' }, { status: 404 })
      }
      phone = (contact.phone as string | null) ?? ''
    }

    if (!phone) {
      return NextResponse.json(
        { error: 'either contactId or to is required (and the contact must have a phone)' },
        { status: 400 },
      )
    }

    // Los dos proveedores exigen E.164 CON '+'. `normalizePhone` deja
    // solo dígitos; el prefijo se garantiza aquí. Mismo convenio que el
    // paso `send_sms` del engine y que `dial.ts`.
    const to = `+${normalizePhone(phone)}`
    if (!isValidE164(to)) {
      return NextResponse.json({ error: 'invalid phone number' }, { status: 400 })
    }

    // Envío a un número suelto sin contacto conocido: se intenta
    // enganchar al contacto de la cuenta que ya tenga ese número, para
    // que el SMS aterrice en su hilo en vez de perderse. NO se crea un
    // contacto: fabricar filas desde una ruta de envío es trabajo de la
    // ingesta entrante, y `contacts.phone_normalized` es una columna
    // generada con UNIQUE por cuenta (022) — un alta a ciegas aquí es
    // justo cómo se acaba con contactos duplicados.
    if (!contactId) {
      const { data: match } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('phone_normalized', normalizePhone(to))
        .maybeSingle()
      if (match) contactId = match.id as string
    }

    // Un contacto sin hilo todavía (alta manual, envío en frío) recibe el
    // suyo con el convenio compartido de UNA conversación por
    // (cuenta, contacto) — el mismo helper que usan los webhooks
    // entrantes, para no crear una quinta variante del find-or-create.
    // `user_id` es obligatorio: la columna es NOT NULL (001).
    //
    // La baja del contacto la comprueba `deliverSms`, o sea DESPUÉS de
    // esto: un contacto suprimido y sin hilo se queda con una
    // conversación vacía. Se acepta a cambio de tener la supresión
    // definida en un solo sitio (mismo criterio que el email, donde vive
    // dentro de `deliverAutomationEmail`).
    if (!conversationId && contactId) {
      const resolved = await findOrCreateConversation(
        ctx.supabase,
        ctx.accountId,
        contactId,
        ctx.userId,
      )
      if (!resolved.id) {
        return NextResponse.json(
          { error: 'could not open a conversation for this contact' },
          { status: 500 },
        )
      }
      conversationId = resolved.id
    }

    const delivered = await deliverSms(ctx.supabase, {
      accountId: ctx.accountId,
      to,
      text,
      contactId,
      conversationId,
    })

    return NextResponse.json({
      ok: true,
      messageId: delivered.messageId,
      conversationId: delivered.conversationId,
    })
  } catch (err) {
    // Baja del contacto: 403 con instrucción, nunca un 500 opaco.
    if (err instanceof SmsSendError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    // Falta de configuración del proveedor → 400, igual que `dial.ts`
    // (el error lleva 404 dentro, pero para el front es "arréglalo en
    // Settings", no "no existe").
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof ProviderError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 })
    }
    // Telnyx lanza su propio error sin tipar cuando la cuenta no tiene
    // fila de config; misma comprobación por mensaje que hace `dial.ts`
    // para no devolver un 500 por algo que el usuario puede arreglar.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('config not found')) {
      return NextResponse.json(
        { error: 'SMS is not configured for this account' },
        { status: 400 },
      )
    }
    console.error('Error in SMS send POST:', err)
    return toErrorResponse(err)
  }
}
