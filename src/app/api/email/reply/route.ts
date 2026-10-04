import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { EmailError, sendEmail } from '@/lib/email/send'
import { assertNotUnsubscribed } from '@/lib/automations/send-email-step'

// ============================================================
// POST /api/email/reply — respuesta de un hilo del inbox por email (agent+).
//   body: { conversationId, text }
//
// Espejo de /api/sms/send: misma auth, mismo acotado por cuenta, misma
// forma de errores. Diferencia clave: el envío de WhatsApp/SMS persiste
// dentro de su pipeline, mientras que /api/email/send va por
// deliverAutomationEmail (email_sends, campañas) y NO escribe en
// `messages` — por eso el composer del hilo nunca lo invocó y un hilo de
// email contestaba por WhatsApp. Esta ruta es la ruta del hilo: envía
// por Resend (config del account) e inserta la fila con channel='email'
// siguiendo el mismo convenio de columnas que la ingesta entrante
// (lib/inbound/email-ingest.ts).
//
// Threading: la respuesta lleva In-Reply-To/References con el Message-ID
// del último email entrante de la conversación, para que en el cliente
// de correo del destinatario quede enhebrada en la conversación original.
// El asunto es "Re: <asunto>" del último entrante. Compondría `headers`
// el SDK de Resend verificado (docs/api-reference/emails/send-email:
// `headers` es un objeto de headers custom).
// ============================================================

/** Contrapartida HTML de un texto del composer: escapa y conserva saltos de línea. */
function textToHtml(text: string): string {
  const escaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  return escaped.replace(/\n/g, '<br>\n')
}

/** Message-ID de email entre <…>, como exige el header In-Reply-To. */
function asAngleBracketId(id: string): string {
  return id.startsWith('<') && id.endsWith('>') ? id : `<${id}>`
}

/* "Re: Re: Re:..." → una sola vez según el asunto del último entrante. */
function replySubject(lastSubject: string): string {
  const base = lastSubject.replace(/^(?:\s*re\s*:\s*)+/i, '')
  return `Re: ${base}`
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(`email-send:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    let body: { conversationId?: string; text?: string }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }

    // La conversación va acotada por cuenta: un id ajeno responde 404 y
    // nunca 403 (confirmaría la existencia de la fila en otra cuenta).
    // `messages` no tiene account_id — la tenencia se deriva de
    // conversations, así que este filtro es la única barrera.
    if (typeof body.conversationId !== 'string' || !body.conversationId) {
      return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
    }
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', body.conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404 })
    }
    const contactId = (conv.contact_id as string | null) ?? null

    // El destinatario SIEMPRE es el email del contacto del hilo: no hay
    // `to` suelto ni se acepta del body, para no enviar a un correo que no
    // es el del contacto mientras la baja y la fila corren sobre él.
    if (!contactId) {
      return NextResponse.json({ error: 'conversation has no contact' }, { status: 400 })
    }
    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id, email')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: 'contact not found' }, { status: 404 })
    }
    const to = (contact.email as string | null) ?? ''
    if (!to) {
      return NextResponse.json(
        { error: 'this contact has no email address' },
        { status: 400 },
      )
    }

    // La baja se comprueba ANTES de tocar al proveedor: un email entregado
    // no se des-envía (mismo orden que deliverSms / deliverAutomationEmail).
    try {
      await assertNotUnsubscribed(ctx.accountId, contactId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('Unsubscribed')) {
        return NextResponse.json({ error: msg }, { status: 403 })
      }
      throw err
    }

    // Threading: el último entrante define Re: e In-Reply-To. Si el hilo
    // no tiene email entrante (respuesta fría), se envía sin headers y
    // con asunto propio — no se fabrica un References inventado.
    const { data: lastInboundEmail } = await ctx.supabase
      .from('messages')
      .select('message_id, metadata')
      .eq('conversation_id', conv.id as string)
      .eq('channel', 'email')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const meta = (lastInboundEmail?.metadata ?? null) as
      | { message_id?: string; subject?: string }
      | null
    const subject = meta?.subject ? replySubject(meta.subject) : 'Reply'
    const inReplyTo = meta?.message_id ? asAngleBracketId(meta.message_id) : null
    const headers: Record<string, string> = inReplyTo
      ? { 'In-Reply-To': inReplyTo, References: inReplyTo }
      : {}

    const sent = await sendEmail(ctx.accountId, {
      to,
      subject,
      html: textToHtml(text),
      headers,
    })

    // El email ya salió: la fila se escribe después, como en deliverSms
    // (un fallo de persistencia no convierte la entrega en error — el
    // precio sería una fila falsa de "failed" por algo que el cliente
    // sí recibió). Idéntico convenio de columnas que la ingesta entrante:
    // metadata.html permite que la burbuja renderice el email enviado.
    const ts = new Date().toISOString()
    const { data: inserted, error: insErr } = await ctx.supabase
      .from('messages')
      .insert({
        conversation_id: conv.id as string,
        sender_type: 'agent',
        content_type: 'text',
        content_text: text,
        channel: 'email',
        status: 'sent',
        metadata: {
          subject,
          to,
          in_reply_to: inReplyTo,
          html: textToHtml(text),
        },
        provider: 'resend',
        provider_message_id: sent.id,
        created_at: ts,
      })
      .select('id')
      .single()

    if (insErr) {
      console.error('[email] outbound reply persist failed:', insErr.message)
      return NextResponse.json({ ok: true, messageId: null, conversationId: conv.id })
    }

    // Bump de la conversación igual que el resto del inbox. `unread_count`
    // NO se toca: es un saliente.
    await ctx.supabase
      .from('conversations')
      .update({ last_message_text: text, last_message_at: ts })
      .eq('id', conv.id as string)

    return NextResponse.json({
      ok: true,
      messageId: (inserted as { id: string } | null)?.id ?? null,
      conversationId: conv.id,
    })
  } catch (err) {
    // Config ausente (email_config): 400 accionable — "arréglalo en
    // Settings", no un 500 opaco. Mismo criterio que /api/sms/send.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('config not found')) {
      return NextResponse.json(
        { error: 'Email is not configured for this account' },
        { status: 400 },
      )
    }
    if (err instanceof EmailError) {
      return NextResponse.json({ error: msg }, { status: 502 })
    }
    console.error('Error in email reply POST:', err)
    return toErrorResponse(err)
  }
}
