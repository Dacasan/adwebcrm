import { createResendClient, loadEmailConfig } from '@/lib/email/send'
import type { EmailProvider } from '../types'

// ============================================================
// Adaptador de email de Resend.
//
// Envuelve `src/lib/email/send.ts` sin tocarlo. Resend no admite
// metadatos que vuelvan en el webhook (eso es `custom_args` de SendGrid),
// así que `input.sendId` se ignora aquí: la correlación sigue siendo por
// `resend_message_id`, exactamente como hoy.
// ============================================================

export const resendEmail: EmailProvider = {
  id: 'resend',

  async send(accountId, input) {
    const { apiKey, fromEmail, replyTo } = await loadEmailConfig(accountId)
    const { id } = await createResendClient(apiKey).send(fromEmail, replyTo, {
      to: input.to,
      subject: input.subject,
      html: input.html,
    })
    return { providerMessageId: id }
  },
}
