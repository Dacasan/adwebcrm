import { createTelnyxClient, loadTelnyxSendConfig } from '@/lib/telnyx/api'
import { ProviderNotConfiguredError } from '../errors'
import type { SmsProvider } from '../types'

// ============================================================
// Adaptador SMS de Telnyx.
//
// ENVUELVE `src/lib/telnyx/api.ts`; no reimplementa nada. La llamada de
// red resultante tiene que ser byte a byte la misma que hacía el paso
// `send_sms` del engine antes del refactor — incluido el hecho de NO
// mandar `webhook_url`: el de Telnyx se configura en el Messaging
// Profile, y añadirlo aquí cambiaría el comportamiento en producción.
// ============================================================

/**
 * Mensaje exacto que el engine lanzaba antes de la abstracción. Hay un
 * test que lo afirma literalmente; no lo reformules.
 */
export const MISSING_MESSAGING_PROFILE =
  'send_sms needs messaging_profile_id (Settings › Telnyx › SMS)'

export const telnyxSms: SmsProvider = {
  id: 'telnyx',

  async send(accountId, input) {
    const cfg = await loadTelnyxSendConfig(accountId)
    if (!cfg.messagingProfileId) {
      throw new ProviderNotConfiguredError(MISSING_MESSAGING_PROFILE, 'telnyx')
    }

    const { id } = await createTelnyxClient(cfg.apiKey).sendSms({
      from: cfg.fromNumber,
      to: input.to,
      text: input.text,
      messagingProfileId: cfg.messagingProfileId,
    })

    return { providerMessageId: id, from: cfg.fromNumber }
  },
}
