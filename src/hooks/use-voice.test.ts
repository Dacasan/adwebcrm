import { describe, expect, it } from 'vitest'

import { VOICE_CAPABILITIES_BY_PROVIDER } from '@/lib/providers/capabilities'
import { voiceHookEnablement } from './use-voice'

// ============================================================
// La fachada llama SIEMPRE a los dos hooks (regla de los hooks de React)
// y desactiva el que no toca. Esto es esa decisión, aislada para poder
// probarla sin renderizar nada.
// ============================================================

describe('voiceHookEnablement', () => {
  it('con routing twilio, useTelnyx recibe enabled: false', () => {
    expect(voiceHookEnablement('twilio', true)).toEqual({ telnyx: false, twilio: true })
  })

  it('con routing telnyx, useTwilioVoice recibe enabled: false', () => {
    expect(voiceHookEnablement('telnyx', true)).toEqual({ telnyx: true, twilio: false })
  })

  it('mientras el routing no ha cargado, NINGUNO conecta', () => {
    expect(voiceHookEnablement('telnyx', false)).toEqual({ telnyx: false, twilio: false })
    expect(voiceHookEnablement('twilio', false)).toEqual({ telnyx: false, twilio: false })
  })

  it('nunca hay dos activos a la vez', () => {
    for (const provider of ['telnyx', 'twilio'] as const) {
      for (const loaded of [true, false]) {
        const e = voiceHookEnablement(provider, loaded)
        expect(Number(e.telnyx) + Number(e.twilio)).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('capacidades por proveedor (§6.3)', () => {
  it('Telnyx conserva hold; Twilio no lo tiene', () => {
    expect(VOICE_CAPABILITIES_BY_PROVIDER.telnyx.hold).toBe(true)
    expect(VOICE_CAPABILITIES_BY_PROVIDER.twilio.hold).toBe(false)
  })

  it('lo que sí comparten: DTMF y grabación', () => {
    for (const caps of Object.values(VOICE_CAPABILITIES_BY_PROVIDER)) {
      expect(caps.dtmf).toBe(true)
      expect(caps.recording).toBe(true)
    }
  })
})
