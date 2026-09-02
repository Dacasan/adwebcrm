"use client"

// ============================================================
// useVoice — fachada del softphone.
//
// Elige el hook del proveedor activo y devuelve el contrato de
// `useTelnyx`, para que los componentes de `components/voice/*` no sepan
// de proveedores. Lo único que añade son `provider` y `capabilities`:
// los proveedores NO son intercambiables al 100% y la UI debe preguntar
// antes de pintar un botón (§6.3) en vez de suponer.
//
// LOS DOS HOOKS SE LLAMAN SIEMPRE. No es un descuido: es la regla de los
// hooks de React. El inactivo no conecta gracias a `enabled`.
// ============================================================

import { useEffect, useState } from "react"

import { VOICE_CAPABILITIES_BY_PROVIDER } from "@/lib/providers/capabilities"
import type { VoiceCapabilities, VoiceProviderId } from "@/lib/providers/types"
import { useTelnyx, type UseTelnyxReturn } from "./use-telnyx"
import { useTwilioVoice } from "./use-twilio-voice"

export interface UseVoiceReturn extends UseTelnyxReturn {
  provider: VoiceProviderId
  capabilities: VoiceCapabilities
  /** false mientras aún no se sabe qué proveedor sirve a esta cuenta. */
  routingLoaded: boolean
}

/**
 * Routing de voz de la cuenta. Mientras carga se asume `telnyx`, que es
 * el default de la migración 073: una cuenta sin fila se comporta
 * exactamente como antes de este plan.
 */
export function useVoiceProvider(): { provider: VoiceProviderId; loaded: boolean } {
  const [provider, setProvider] = useState<VoiceProviderId>("telnyx")
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/providers/routing")
        if (!res.ok) return
        const data = (await res.json()) as { voice?: VoiceProviderId }
        if (!cancelled && (data.voice === "telnyx" || data.voice === "twilio")) {
          setProvider(data.voice)
        }
      } catch {
        /* se queda en el default */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { provider, loaded }
}

/**
 * Qué hook puede conectar. Pura para poder testearla sin renderizar:
 * ninguno de los dos conecta hasta saber cuál toca — conectar "por si
 * acaso" al de Telnyx registraría un softphone SIP en una cuenta que ya
 * está en Twilio, y ese registro fantasma sí tiene efectos.
 */
export function voiceHookEnablement(
  provider: VoiceProviderId,
  routingLoaded: boolean,
): { telnyx: boolean; twilio: boolean } {
  return {
    telnyx: routingLoaded && provider === "telnyx",
    twilio: routingLoaded && provider === "twilio",
  }
}

export function useVoice(): UseVoiceReturn {
  const { provider, loaded } = useVoiceProvider()

  const enabled = voiceHookEnablement(provider, loaded)
  const telnyx = useTelnyx({ enabled: enabled.telnyx })
  const twilio = useTwilioVoice({ enabled: enabled.twilio })

  const active = provider === "twilio" ? twilio : telnyx

  return {
    ...active,
    provider,
    capabilities: VOICE_CAPABILITIES_BY_PROVIDER[provider],
    routingLoaded: loaded,
  }
}
