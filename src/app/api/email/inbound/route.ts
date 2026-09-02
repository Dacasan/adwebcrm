import { NextResponse, type NextRequest } from 'next/server'

import { ingestInboundEmail } from '@/lib/inbound/email-ingest'
import { EmailError, verifyResendWebhook } from '@/lib/email/send'
import { supabaseAdmin } from '@/lib/telnyx/admin-client'

// ============================================================
// POST /api/email/inbound — webhook `email.received` de Resend.
//
// Cada webhook de Resend tiene su propio secreto Svix: este endpoint
// usa RESEND_INBOUND_WEBHOOK_SECRET (el de /api/email/webhook es el del
// webhook de tracking de envíos y es OTRO secreto). Fail-closed igual
// que su hermano: sin secret → 503, firma inválida → 400.
//
// Cuenta: la bandeja receptora es `email_config.from_email` (hello@…).
// El evento se ingesta solo si data.to[] la incluye; 0 o ≥2 cuentas →
// ack sin ingestar (mismas guardas que el webhook de WhatsApp).
//
// Cuerpo: el payload trae metadatos (email_id, message_id, subject,
// from, to, adjuntos); el texto/html vive en la API de received emails
// (GET /received-emails/:id), que exige una key con permiso de lectura
// (RESEND_INBOUND_API_KEY). Si el payload llegara a traer text/html se
// usa y no se llama a la API.
// ============================================================

interface InboundWebhookPayload {
  type?: string
  created_at?: string
  data?: {
    email_id?: string
    message_id?: string
    subject?: string
    from?: string
    to?: string[]
    text?: string
    html?: string
    attachments?: unknown[]
  }
}

/** "Nombre <a@b.com>" → "a@b.com"; "a@b.com" → "a@b.com". */
function extractAddress(value: string | undefined): string | null {
  if (!value) return null
  const match = /<([^>]+)>/.exec(value)
  const email = (match ? match[1] : value).trim().toLowerCase()
  return email.includes('@') ? email : null
}

/** "Nombre <a@b.com>" → "Nombre"; "a@b.com" → null. */
function extractDisplayName(value: string | undefined): string | null {
  if (!value) return null
  const match = /^\s*(.+?)\s*<[^>]+>\s*$/.exec(value)
  if (!match) return null
  // Los clientes citan el nombre cuando lleva coma: «"Ruiz, Ana" <a@b.com>».
  const name = match[1].trim().replace(/^"(.*)"$/, '$1').trim()
  return name || null
}

async function fetchBody(
  emailId: string,
): Promise<{ text: string | null; html: string | null }> {
  const apiKey = process.env.RESEND_INBOUND_API_KEY
  if (!apiKey) return { text: null, html: null }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      console.error(`[email:inbound] received-emails respondió ${res.status}`)
      return { text: null, html: null }
    }
    const body = (await res.json()) as { text?: string; html?: string }
    return { text: body.text ?? null, html: body.html ?? null }
  } catch (err) {
    console.error('[email:inbound] received-emails fetch falló:', err)
    return { text: null, html: null }
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  const raw = await req.text()

  let event: InboundWebhookPayload
  try {
    event = (await verifyResendWebhook(
      raw,
      {
        id: req.headers.get('svix-id'),
        timestamp: req.headers.get('svix-timestamp'),
        signature: req.headers.get('svix-signature'),
      },
      secret,
    )) as InboundWebhookPayload
  } catch (err) {
    const message = err instanceof EmailError ? err.message : 'invalid signature'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  // Solo ingestamos email.received; cualquier otro evento que llegue a
  // este webhook se ackea sin tocar la BD.
  const data = event.data
  const emailId = data?.email_id
  if (event.type !== 'email.received' || !data || !emailId) {
    return NextResponse.json({ ok: true })
  }
  const from = extractAddress(data.from)
  const to = (data.to ?? []).map(extractAddress).filter((x): x is string => Boolean(x))

  // Cuenta: la config de email cuya from_email es la bandeja receptora.
  const admin = supabaseAdmin()
  const { data: configs } = await admin
    .from('email_config')
    .select('account_id, from_email')
    .in('from_email', to)

  if (!configs || configs.length === 0) {
    console.warn('[email:inbound] sin email_config para', to, '— ack sin ingestar')
    return NextResponse.json({ ok: true })
  }
  if (configs.length > 1) {
    console.error(
      `[email:inbound] ${configs.length} cuentas comparten la bandeja ${to.join(', ')} — ack sin ingestar`,
    )
    return NextResponse.json({ ok: true })
  }

  // Cuerpo: el payload a veces lo trae; si no, lo pedimos a la API.
  let text = data.text ?? null
  let html = data.html ?? null
  if (text === null && html === null) {
    const body = await fetchBody(emailId)
    text = body.text
    html = body.html
  }

  const result = await ingestInboundEmail(admin, {
    accountId: configs[0].account_id,
    from: from ?? '',
    fromName: extractDisplayName(data.from),
    to: to[0] ?? '',
    subject: data.subject ?? null,
    text,
    html,
    emailId,
    messageId: data.message_id ?? null,
    receivedAt: event.created_at ?? null,
    attachments: data.attachments,
  })

  // Fail-open en la ingestión: siempre ack para que Resend no reintente
  // infinito; el resultado queda logueado (mismo estándar que el webhook
  // de tracking).
  if (result.status === 'ignored') {
    console.warn('[email:inbound] ignorado:', result.reason)
  }

  return NextResponse.json({ ok: true, result: result.status })
}
