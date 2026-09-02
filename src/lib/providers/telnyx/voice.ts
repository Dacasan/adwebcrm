import {
  createTelnyxClient,
  ensureWebrtcCredential,
  loadTelnyxApiKey,
  loadTelnyxDialConfig,
  TelnyxApiError,
} from '@/lib/telnyx/api'
import { ProviderNotConfiguredError } from '../errors'
import type { VoiceCapabilities, VoiceProvider } from '../types'

// ============================================================
// Adaptador de voz de Telnyx.
//
// Envuelve `src/lib/telnyx/api.ts` y el webhook existente. El patrón de
// dos patas (contestar A, crear B hacia el SIP del agente, bridge) sigue
// viviendo donde estaba: aquí solo se exponen las tres operaciones que
// el contrato pide.
// ============================================================

/**
 * Telnyx SÍ tiene hold en el SDK de navegador (`call.hold()`/`unhold()`),
 * y por eso su botón se queda. Twilio no — ver `twilio/voice.ts`.
 */
const TELNYX_CAPABILITIES: VoiceCapabilities = {
  hold: true,
  transfer: false,
  dtmf: true,
  recording: true,
}

function webhookUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000'
  return `${base.replace(/\/$/, '')}/api/telnyx/webhook`
}

export const telnyxVoice: VoiceProvider = {
  id: 'telnyx',
  capabilities: TELNYX_CAPABILITIES,

  async dial(accountId, input) {
    const cfg = await loadTelnyxDialConfig(accountId)
    if (!cfg.connectionId) {
      throw new ProviderNotConfiguredError('Telnyx Call Control App not configured', 'telnyx')
    }
    const dialed = await createTelnyxClient(cfg.apiKey).dial({
      to: input.to,
      from: cfg.fromNumber,
      connectionId: cfg.connectionId,
      webhookUrl: webhookUrl(),
    })
    return { providerCallId: dialed.callControlId, from: cfg.fromNumber }
  },

  async hangup(accountId, providerCallId) {
    const apiKey = await loadTelnyxApiKey(accountId)
    await createTelnyxClient(apiKey).hangupCall(providerCallId)
  },

  async issueClientToken(accountId) {
    // Mismo camino que `/api/telnyx/token`: asegurar la credencial WebRTC
    // (se crea sola la primera vez) y pedirle a Telnyx el login_token. El
    // JWT lo emite Telnyx, nunca se firma localmente.
    const credentialId = await ensureWebrtcCredential(accountId)
    const apiKey = await loadTelnyxApiKey(accountId)
    const { token } = await createTelnyxClient(apiKey).createWebrtcToken(credentialId)
    if (!token) throw new TelnyxApiError('Telnyx returned an empty login token')
    return {
      provider: 'telnyx',
      token,
      // Telnyx registra el softphone por credencial SIP, no por identidad:
      // el JWT ya lleva dentro a quién representa. La identidad explícita
      // es una noción de Twilio; aquí se devuelve vacía a propósito.
      identity: '',
      // POST /v2/telephony_credentials/{id}/token emite un JWT de 24 h.
      expiresIn: 24 * 3600,
    }
  },
}
