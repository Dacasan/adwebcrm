import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { contactText } from '@/lib/automations/engine'
import { assertNotUnsubscribed } from '@/lib/automations/send-email-step'
import { buildUnsubscribeUrl } from '@/lib/email/unsubscribe-url'
import { fetchTagNames, tagsExtra } from '@/lib/email/contact-tags'
import { resolveEmailProvider } from '@/lib/providers/registry'
import { loadSendGridConfig } from '@/lib/providers/sendgrid/config'
import { supabaseAdmin } from '@/lib/telnyx/admin-client'
import type { VariableMapping } from '@/lib/campaigns/types'

// ============================================================
// POST /api/email/campaign/send — envía una campaña de email.
//   body: { campaignId }
//
// Carga la campaña (snapshot subject/body_html + audience + variables),
// resuelve sus recipients con contacto, interpola `{{ name }}`, etc.
// con `contactText` (misma fuente que el motor, §9.3.1), envía con
// Resend y espeja el resultado contra email_campaign_recipients.
//
// Lógica de envío centralizada en el server (no en el cliente):
//   el hook del wizard solo resuelve la audiencia e inserta la campaña +
//   recipients; aquí se hace el envío real. Espeja /api/whatsapp/broadcast.
//
// Quién envía lo decide `provider_routing` (073). Con SendGrid hay un
// GATE ADICIONAL: si el dominio del remitente no está autenticado
// (DKIM/SPF), la campaña NO sale. Un dominio sin firmar no da error —
// simplemente va a spam — y mandar mil correos a la carpeta de spam
// quema la reputación del dominio para siempre. El transaccional sí
// sigue saliendo: ahí el volumen no hace daño y el mensaje importa más.
// ============================================================

const INSERT_BATCH_SIZE = 200
const SEND_BATCH_SIZE = 10
const SEND_BATCH_DELAY_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    let body: { campaignId?: string }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : ''
    if (!campaignId) {
      return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    }

    // ── Load campaign (account-scoped) ─────────────────────────
    const { data: campaign, error: campErr } = await ctx.supabase
      .from('email_campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('account_id', ctx.accountId)
      .single()

    if (campErr || !campaign) {
      return NextResponse.json({ error: 'campaign not found' }, { status: 404 })
    }

    // ── Flip to sending (prevents double-fire across tabs) ─────
    const { error: flipErr } = await ctx.supabase
      .from('email_campaigns')
      .update({ status: 'sending' })
      .eq('id', campaignId)
      .eq('status', 'draft')
    if (flipErr) {
      return NextResponse.json({ error: 'could not mark as sending' }, { status: 500 })
    }

    // ── Load recipients (joined contact) ───────────────────────
    const { data: recipients, error: recsErr } = await ctx.supabase
      .from('email_campaign_recipients')
      .select('*, contact:contacts(*)')
      .eq('email_campaign_id', campaignId)
    if (recsErr || !recipients) {
      return NextResponse.json({ error: 'could not load recipients' }, { status: 500 })
    }

    const totalRecipients = recipients.length
    const variables = (campaign.template_variables ?? {}) as Record<string, VariableMapping>

    // ── Proveedor de email + gate de entregabilidad ────────────
    const emailProvider = await resolveEmailProvider(ctx.accountId)
    if (emailProvider.id === 'sendgrid') {
      const sgCfg = await loadSendGridConfig(ctx.accountId).catch(() => null)
      if (!sgCfg) {
        await ctx.supabase
          .from('email_campaigns')
          .update({ status: 'draft' })
          .eq('id', campaignId)
        return NextResponse.json(
          {
            error: 'sendgrid_not_configured',
            message:
              'This account routes email through SendGrid but has no SendGrid credentials yet (Email › Setup).',
          },
          { status: 400 },
        )
      }
      if (!sgCfg.domainAuthenticated) {
        // Se devuelve la campaña a 'draft': dejarla en 'sending' la
        // bloquearía para siempre (el flip solo actúa sobre 'draft').
        await ctx.supabase
          .from('email_campaigns')
          .update({ status: 'draft' })
          .eq('id', campaignId)
        return NextResponse.json(
          {
            error: 'domain_not_authenticated',
            message:
              'The sender domain is not authenticated in SendGrid (DKIM/SPF). Campaigns are blocked until it is: unauthenticated mail lands in spam and burns the domain reputation. Authenticate it in SendGrid › Settings › Sender Authentication.',
          },
          { status: 409 },
        )
      }
    }

    let failedCount = 0
    let sentCount = 0

    // Small batches con pausa — evita rate limits de Resend, mismo
    // patrón de throttling que broadcast (SEND_BATCH_SIZE/DELAY).
    for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
      const batch = recipients.slice(i, i + SEND_BATCH_SIZE)
      // Tags del lote en UNA query para `{{ tags }}` en subject/body_html.
      const tagMap = await fetchTagNames(
        supabaseAdmin(),
        batch
          .map((rec) => rec.contact?.id)
          .filter((id): id is string => !!id),
      )

      for (const rec of batch) {
        const contact = rec.contact
        const to = contact?.email?.trim()
        if (!to) {
          failedCount++
          await supabaseAdmin()
            .from('email_campaign_recipients')
            .update({ status: 'failed', error_message: 'No email on contact' })
            .eq('id', rec.id)
          continue
        }

        try {
          // Baja real: el tag "Unsubscribed" bloquea el envío de este
          // destinatario (el catch de abajo lo marca como failed).
          await assertNotUnsubscribed(ctx.accountId, contact.id)
          const contactFields = {
            name: contact.name ?? '',
            email: contact.email ?? '',
            phone: contact.phone ?? '',
            company: contact.company ?? '',
          }
          const unsubExtras = {
            unsubscribe_url: buildUnsubscribeUrl(contact.id),
            ...tagsExtra(tagMap, contact.id),
          }
          const subject = contactText(campaign.subject, variables, contactFields, unsubExtras)
          const html = contactText(campaign.body_html, variables, contactFields, unsubExtras)

          const { providerMessageId } = await emailProvider.send(ctx.accountId, {
            to,
            subject,
            html,
            // El uuid del recipient viaja en customArgs y vuelve en cada
            // evento del webhook de SendGrid; Resend lo ignora. Va como
            // `recipientId` y no como `sendId` porque son tablas distintas.
            recipientId: rec.id as string,
          })

          sentCount++
          await supabaseAdmin()
            .from('email_campaign_recipients')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              // La columna vieja solo se rellena cuando el id ES de
              // Resend; el par genérico se rellena siempre (076).
              ...(emailProvider.id === 'resend'
                ? { resend_message_id: providerMessageId }
                : {}),
              provider: emailProvider.id,
              provider_message_id: providerMessageId,
              error_message: null,
            })
            .eq('id', rec.id)
        } catch (err) {
          failedCount++
          await supabaseAdmin()
            .from('email_campaign_recipients')
            .update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Unknown error',
            })
            .eq('id', rec.id)
        }
      }

      if (i + SEND_BATCH_SIZE < recipients.length) {
        await sleep(SEND_BATCH_DELAY_MS)
      }
    }

    // Counts mantenidos por el trigger de la migración 052; solo
    // finalizamos el status. total_recipients lo fija el hook al insertar.
    const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent'
    await ctx.supabase
      .from('email_campaigns')
      .update({ status: finalStatus })
      .eq('id', campaignId)

    return NextResponse.json({
      ok: true,
      total: totalRecipients,
      sent: sentCount,
      failed: failedCount,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}