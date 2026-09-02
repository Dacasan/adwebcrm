import { ProviderNotConfiguredError } from '../errors'
import type { SmsProvider } from '../types'
import { twilioForAccount, withTwilioRetry } from './client'
import { twilioWebhookUrl } from './config'

// ============================================================
// Adaptador SMS de Twilio.
//
// La preferencia por `messagingServiceSid` sobre `from` no es un detalle
// de estilo: es lo que exige A2P 10DLC en EE. UU. (un número suelto sin
// Messaging Service vinculado a una campaña devuelve 30034) y lo que da
// geo-match y sticky sender en internacional. Cuando hay servicio, el
// `from` NO se manda: Twilio elige el remitente del pool.
// ============================================================

export const twilioSms: SmsProvider = {
  id: 'twilio',

  async send(accountId, input) {
    const { client, cfg } = await twilioForAccount(accountId)

    if (!cfg.messagingServiceSid && !cfg.defaultFromNumber) {
      throw new ProviderNotConfiguredError(
        'send_sms needs a Messaging Service SID or a default from number (Settings › Phone › Twilio)',
        'twilio',
      )
    }

    const sender = cfg.messagingServiceSid
      ? { messagingServiceSid: cfg.messagingServiceSid }
      : { from: cfg.defaultFromNumber as string }

    const message = await withTwilioRetry(
      () =>
        client.messages.create({
          to: input.to,
          body: input.text,
          ...sender,
          statusCallback: twilioWebhookUrl(cfg.webhookToken, '/sms/status'),
        }),
      'messages.create',
    )

    return {
      providerMessageId: message.sid,
      // Con Messaging Service el remitente lo elige Twilio y solo se
      // conoce a posteriori, en la respuesta.
      from: message.from ?? cfg.defaultFromNumber ?? '',
    }
  },
}
