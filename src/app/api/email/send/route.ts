import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { contactText } from '@/lib/automations/engine'
import { buildUnsubscribeUrl } from '@/lib/email/unsubscribe-url'
import { fetchTagNames, tagsExtra } from '@/lib/email/contact-tags'
import { deliverAutomationEmail } from '@/lib/automations/send-email-step'
import type { VariableMapping } from '@/hooks/use-broadcast-sending'

// ============================================================
// POST /api/email/send — envía un email manualmente (agent+).
//   body: { contactId? | to?, template, variables? }          (por template)
//   body: { contactId? | to?, subject, body_html }            (ad-hoc)
// Dos modos: por template (lo carga por nombre) o ad-hoc (el contenido
// viene inline — composición libre del picker/contacto). En ambos interpola
// `{{ name }}`, `{{ tags }}`, `{{ vars.* }}` con `contactText` (misma fuente
// de campos que el motor de automatizaciones, §9.3.1 — sin copiar lógica)
// y entrega por el proveedor que diga `provider_routing`.
//
// La entrega va por `deliverAutomationEmail` en vez de repetir aquí el
// envío + el insert en `email_sends`. Con SendGrid ese orden se INVIERTE
// (fila primero, para mandar su id en customArgs), y tener dos copias del
// pipeline garantizaba que una de las dos se quedara con el orden viejo.
// ============================================================

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    let body: {
      contactId?: string
      to?: string
      template?: string
      subject?: string
      body_html?: string
      variables?: Record<string, VariableMapping>
    }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    // Modo ad-hoc: subject + body_html inline; si falta alguno, modo template.
    const inlineSubject = typeof body.subject === 'string' ? body.subject.trim() : ''
    const inlineBody = typeof body.body_html === 'string' ? body.body_html.trim() : ''
    const isInline = inlineSubject !== '' && inlineBody !== ''

    const templateName = isInline
      ? 'ad_hoc'
      : typeof body.template === 'string'
        ? body.template.trim()
        : ''
    if (!templateName) {
      return NextResponse.json(
        { error: 'template is required (or subject + body_html)' },
        { status: 400 },
      )
    }

    // Resolver el destinatario: contactId (validando que sea del account) o `to` directo.
    let to = ''
    let contactFields: { name: string; email: string; phone: string; company: string } | null = null
    if (typeof body.contactId === 'string' && body.contactId) {
      const { data: contact, error } = await ctx.supabase
        .from('contacts')
        .select('name, email, phone, company')
        .eq('id', body.contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (error || !contact) {
        return NextResponse.json({ error: 'contact not found' }, { status: 404 })
      }
      to = contact.email ?? ''
      contactFields = {
        name: contact.name ?? '',
        email: contact.email ?? '',
        phone: contact.phone ?? '',
        company: contact.company ?? '',
      }
    } else if (typeof body.to === 'string' && body.to.trim()) {
      to = body.to.trim()
    }
    if (!to) {
      return NextResponse.json(
        { error: 'either contactId or to is required (and contact must have an email)' },
        { status: 400 },
      )
    }

    const variables = body.variables
    // `{{ tags }}` se resuelve como extra: los tags viven en contact_tags+tags,
    // no en la fila del contacto — misma vía que `unsubscribe_url` (extras del
    // call-site), con la consulta centralizada en fetchTagNames.
    const contactIdForTags = typeof body.contactId === 'string' ? body.contactId : null
    const tagMap = contactIdForTags
      ? await fetchTagNames(ctx.supabase, [contactIdForTags])
      : new Map<string, string[]>()
    const unsubExtras = {
      unsubscribe_url: buildUnsubscribeUrl(contactIdForTags),
      ...tagsExtra(tagMap, contactIdForTags ?? ''),
    }

    let rawSubject: string | null = null
    let rawBody: string | null = null
    if (isInline) {
      rawSubject = inlineSubject
      rawBody = inlineBody
    } else {
      const { data: tpl } = await ctx.supabase
        .from('email_templates')
        .select('subject, body_html')
        .eq('account_id', ctx.accountId)
        .eq('name', templateName)
        .maybeSingle()
      const template = tpl as { subject: string; body_html: string } | null
      if (!template) {
        return NextResponse.json({ error: 'template not found' }, { status: 404 })
      }
      rawSubject = template.subject
      rawBody = template.body_html
    }

    const subject = contactText(rawSubject, variables, contactFields, unsubExtras)
    const html = contactText(rawBody, variables, contactFields, unsubExtras)

    const delivered = await deliverAutomationEmail({
      accountId: ctx.accountId,
      contactId: typeof body.contactId === 'string' ? body.contactId : null,
      automationId: null,
      templateName,
      recipient: to,
      subject,
      html,
    })

    return NextResponse.json({
      ok: true,
      provider: delivered.provider,
      messageId: delivered.providerMessageId,
      // Nombre histórico de la respuesta; se conserva para no romper a
      // quien ya la esté leyendo.
      resendMessageId: delivered.resendMessageId,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}