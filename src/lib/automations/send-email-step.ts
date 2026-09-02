import { supabaseAdmin } from '@/lib/supabase/admin'
import { resolveEmailProvider } from '@/lib/providers/registry'
import type { EmailProviderId } from '@/lib/providers/types'
import { UNSUBSCRIBED_TAG } from '@/lib/email/unsubscribe-url'

/**
 * Baja real sobre el primitivo de tags: si el contacto lleva el tag
 * "Unsubscribed", el envío se bloquea. Lo consultan el paso de
 * automatizaciones (`deliverAutomationEmail`) y el envío de campañas.
 * Lo añade GET /unsubscribe/[contactId] (que a su vez dispara los
 * automatismos `tag_added` del engine).
 */
export async function assertNotUnsubscribed(
  accountId: string,
  contactId: string,
): Promise<void> {
  const admin = supabaseAdmin()
  const { data } = await admin
    .from('contact_tags')
    .select('tag_id, tags!inner(name)')
    .eq('contact_id', contactId)
    .eq('tags.name', UNSUBSCRIBED_TAG)
    .maybeSingle()
  if (data) {
    throw new Error(
      `contact ${contactId} has the "${UNSUBSCRIBED_TAG}" tag — email not sent`,
    )
  }
}

/**
 * Entrega de un `send_email` de automatización.
 *
 * Vive aparte del engine porque hay DOS caminos que la necesitan: el paso
 * en vivo (`runStep`) y el drenaje de `message_queue`, que reproduce un
 * envío que la cuota diaria aplazó. Si el cuerpo siguiera dentro del
 * switch del engine, el drenaje tendría que copiarlo — que es justo cómo
 * el resto de canales acabaron con cinco copias del mismo pipeline.
 *
 * El asunto y el HTML llegan YA interpolados: la sustitución de variables
 * necesita el `ExecuteArgs` de la ejecución, que no sobrevive a la cola.
 * Se renderiza antes de consultar la cuota y se guarda el resultado en el
 * payload, igual que `send_message` hace con su texto.
 *
 * ── Dos órdenes de operaciones, y no es un capricho ──────────
 *
 * Resend solo devuelve su id DESPUÉS de enviar, así que la fila de
 * `email_sends` se escribe al final: enviar → insertar. Es lo que se ha
 * hecho siempre y se conserva intacto.
 *
 * SendGrid admite `custom_args`, metadatos que vuelven en CADA evento del
 * webhook. Eso permite invertir el orden: insertar la fila en 'queued',
 * mandar su `id` con el correo y actualizar a 'sent'. La ventaja no es
 * estética — los eventos de SendGrid llegan a veces ANTES de que termine
 * nuestro update, y con el orden de Resend el webhook no encontraría su
 * fila. El estado 'queued' lo habilita la migración 077.
 */
export async function deliverAutomationEmail(args: {
  accountId: string
  /** Null en el envío manual a una dirección suelta (`/api/email/send`). */
  contactId: string | null
  /** Null cuando el envío se reproduce desde la cola. */
  automationId: string | null
  templateName: string
  recipient: string
  subject: string
  html: string
}): Promise<{
  provider: EmailProviderId
  providerMessageId: string
  /** Alias histórico de `providerMessageId`. Vacío si el proveedor no es Resend. */
  resendMessageId: string
}> {
  const provider = await resolveEmailProvider(args.accountId)

  // Baja real: un contacto con el tag "Unsubscribed" no recibe email.
  if (args.contactId) {
    await assertNotUnsubscribed(args.accountId, args.contactId)
  }

  const baseRow = {
    account_id: args.accountId,
    contact_id: args.contactId,
    automation_id: args.automationId,
    template_name: args.templateName,
    recipient: args.recipient,
    subject: args.subject,
    html: args.html,
    provider: provider.id,
  }

  if (provider.id === 'sendgrid') {
    const admin = supabaseAdmin()
    // 1) Fila primero, para tener un id que mandar en customArgs.
    const { data: row, error: insErr } = await admin
      .from('email_sends')
      .insert({ ...baseRow, status: 'queued' })
      .select('id')
      .single()
    if (insErr || !row?.id) {
      throw new Error(`could not stage email_sends row: ${insErr?.message ?? 'no id returned'}`)
    }

    try {
      const { providerMessageId } = await provider.send(args.accountId, {
        to: args.recipient,
        subject: args.subject,
        html: args.html,
        sendId: row.id as string,
      })
      await admin
        .from('email_sends')
        .update({ status: 'sent', provider_message_id: providerMessageId })
        .eq('id', row.id)
      return { provider: 'sendgrid', providerMessageId, resendMessageId: '' }
    } catch (err) {
      // La fila NO se borra: una huérfana en 'failed' es una señal de
      // diagnóstico, no basura. Borrarla escondería el fallo.
      await admin.from('email_sends').update({ status: 'failed' }).eq('id', row.id)
      throw err
    }
  }

  // Camino histórico (Resend): enviar y luego persistir.
  const { providerMessageId } = await provider.send(args.accountId, {
    to: args.recipient,
    subject: args.subject,
    html: args.html,
  })

  // Persistir en email_sends (DAD §7.7 — Item 13 del plan §13): el webhook de
  // Resend actualiza status/contadores por resend_message_id (048), y el
  // genérico por (provider, provider_message_id) desde la 076.
  await supabaseAdmin().from('email_sends').insert({
    ...baseRow,
    status: 'sent',
    resend_message_id: providerMessageId,
    provider_message_id: providerMessageId,
  })

  return { provider: provider.id, providerMessageId, resendMessageId: providerMessageId }
}
