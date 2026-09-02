import { jwt } from 'twilio'

import { ProviderNotConfiguredError } from '../errors'
import type { VoiceCapabilities, VoiceProvider } from '../types'
import { twilioForAccount, withTwilioRetry } from './client'
import { twilioWebhookUrl } from './config'
import { agentIdentity } from './identity'
import { ensureApiKey, ensureTwiMLApp } from './provision'
import { inboundToClientsTwiML, inboundToNumberTwiML } from './twiml'

// ============================================================
// Adaptador de voz de Twilio.
// ============================================================

/**
 * `hold: false` no es deuda ni un descuido: el Voice JS SDK NO expone
 * hold, y tenerlo exigiría montar una conferencia server-side. Producto
 * lo ha descartado. La UI lee esta bandera y oculta el botón (§6.3); no
 * hay stub que lance ni TODO que reabrir.
 *
 * `transfer: false` sí es alcance declarado fuera del plan (§10).
 */
const TWILIO_CAPABILITIES: VoiceCapabilities = {
  hold: false,
  transfer: false,
  dtmf: true,
  recording: true,
}

/** Vida del Access Token del softphone. El cliente refresca antes. */
export const VOICE_TOKEN_TTL_SECS = 3600

export const twilioVoice: VoiceProvider = {
  id: 'twilio',
  capabilities: TWILIO_CAPABILITIES,

  /**
   * Click-to-call desde el servidor: Twilio llama al destino y, cuando
   * descuelga, lo conecta con el softphone del agente que pulsó el botón
   * (o con el `fallback_number` si no hay softphone).
   *
   * El TwiML va INLINE en vez de por `url` a propósito: una TwiML
   * generada aquí no necesita webhook, y evita que esta llamada saliente
   * entre por `/voice`, cuya rama entrante volvería a hacer sonar a todo
   * el mundo.
   */
  async dial(accountId, input) {
    const { client, cfg } = await twilioForAccount(accountId)
    if (!cfg.defaultFromNumber) {
      throw new ProviderNotConfiguredError(
        'Twilio needs a default from number to place calls (Settings › Phone › Twilio)',
        'twilio',
      )
    }

    const common = {
      callerId: cfg.defaultFromNumber,
      actionUrl: twilioWebhookUrl(cfg.webhookToken, '/voice/action'),
      statusCallbackUrl: twilioWebhookUrl(cfg.webhookToken, '/voice/status'),
      recordingCallbackUrl: cfg.recordingEnabled
        ? twilioWebhookUrl(cfg.webhookToken, '/voice/recording')
        : null,
    }

    const bridgeTwiml = input.agentIdentity
      ? inboundToClientsTwiML({ ...common, identities: [input.agentIdentity] })
      : cfg.fallbackNumber
        ? inboundToNumberTwiML({ ...common, to: cfg.fallbackNumber })
        : null

    if (!bridgeTwiml) {
      throw new ProviderNotConfiguredError(
        'Twilio click-to-call needs a connected softphone or a fallback number',
        'twilio',
      )
    }

    const call = await withTwilioRetry(
      () =>
        client.calls.create({
          to: input.to,
          from: cfg.defaultFromNumber as string,
          twiml: bridgeTwiml,
          statusCallback: twilioWebhookUrl(cfg.webhookToken, '/voice/status'),
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        }),
      'calls.create',
    )

    return { providerCallId: call.sid, from: cfg.defaultFromNumber }
  },

  async hangup(accountId, providerCallId) {
    const { client } = await twilioForAccount(accountId)
    await withTwilioRetry(
      () => client.calls(providerCallId).update({ status: 'completed' }),
      'calls.update(completed)',
    )
  },

  /**
   * Access Token del softphone. Se firma con la API Key, NUNCA con el
   * Auth Token: el Auth Token no debe salir del servidor ni indirectamente.
   */
  async issueClientToken(accountId, userId) {
    const { cfg } = await twilioForAccount(accountId)
    const [apiKey, twimlAppSid] = await Promise.all([
      ensureApiKey(accountId, cfg),
      ensureTwiMLApp(accountId, cfg),
    ])

    const identity = agentIdentity(userId)
    const token = new jwt.AccessToken(cfg.accountSid, apiKey.sid, apiKey.secret, {
      identity,
      ttl: VOICE_TOKEN_TTL_SECS,
    })
    token.addGrant(
      new jwt.AccessToken.VoiceGrant({
        outgoingApplicationSid: twimlAppSid,
        incomingAllow: true,
      }),
    )

    return {
      provider: 'twilio',
      token: token.toJwt(),
      identity,
      expiresIn: VOICE_TOKEN_TTL_SECS,
    }
  },
}
