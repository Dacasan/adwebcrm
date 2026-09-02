import { ProviderError } from '../errors'
import type { EmailProvider } from '../types'
import { createSendGridMailer, mapSendGridError } from './client'
import { loadSendGridConfig } from './config'

// ============================================================
// Adaptador de email de SendGrid.
//
// LA PIEZA QUE HACE FÁCIL TODO LO DEMÁS: `customArgs`. Son metadatos que
// SendGrid devuelve en CADA evento del webhook. Con Resend la
// correlación es el `resend_message_id`, que solo se conoce DESPUÉS de
// enviar; con `custom_args` mandamos nuestro propio uuid y el webhook
// siempre encuentra su fila.
//
// Y hay que mandarlo, porque los ids no coinciden: el `sg_message_id` del
// webhook es `{x-message-id}.recvd-...` — comparten prefijo pero NO son
// iguales. Por eso `custom_args` es el camino principal y el prefijo, el
// respaldo.
// ============================================================

export const sendgridEmail: EmailProvider = {
  id: 'sendgrid',

  async send(accountId, input) {
    const cfg = await loadSendGridConfig(accountId)
    const mailer = createSendGridMailer(cfg.apiKey)

    try {
      const [response] = await mailer.send({
        to: input.to,
        from: cfg.fromName ? { email: cfg.fromEmail, name: cfg.fromName } : cfg.fromEmail,
        ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
        subject: input.subject,
        html: input.html,
        customArgs: {
          account_id: accountId,
          ...(input.sendId ? { email_send_id: input.sendId } : {}),
          ...(input.recipientId ? { campaign_recipient_id: input.recipientId } : {}),
        },
      })

      // El id sale de la cabecera `x-message-id` del 202.
      const headers = (response?.headers ?? {}) as Record<string, string | string[] | undefined>
      const raw = headers['x-message-id'] ?? headers['X-Message-Id']
      const providerMessageId = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')

      if (!providerMessageId) {
        // No es fatal (el webhook correlaciona por custom_args), pero sí
        // digno de log: sin él se pierde el camino de respaldo.
        console.warn('[sendgrid] 202 without x-message-id header')
      }

      return { providerMessageId }
    } catch (err) {
      throw mapSendGridError(err, 'mail.send')
    }
  },
}

/** Reexport para las rutas que quieren distinguir el error del proveedor. */
export { ProviderError }
