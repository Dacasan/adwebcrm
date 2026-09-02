"use client"

// ============================================================
// useTwilioVoice — softphone sobre `@twilio/voice-sdk`.
//
// Devuelve EXACTAMENTE el mismo contrato que `useTelnyx` para que
// `use-voice.ts` pueda intercambiarlos sin que los componentes de
// `components/voice/*` cambien.
//
// ── Tres cosas de la versión de Telnyx que NO se portan ──────
//
// 1. Todo el andamiaje anti-486 (`REGISTRATION_SETTLE_MS`, el margen
//    entre llamadas, `lastCallEndedAtRef`, el parado manual de pistas).
//    Era una patología del registro SIP de Telnyx; Twilio no la tiene.
// 2. `attachRemoteAudio` / `cleanupRemoteAudio` y el
//    `<audio id="remoteAudio">`: el SDK de Twilio gestiona el audio.
// 3. El chequeo de `isRegistered` antes de contestar.
//
// ── Y una que aparece y no existía: el refresco de token ─────
// El Access Token vive una hora. Sin escuchar `tokenWillExpire` la
// sesión muere en silencio a los 60 minutos y el usuario solo nota que
// dejaron de entrarle llamadas. Es el fallo más común de esta
// integración, por eso está aquí y tiene test.
//
// Hold: NO se implementa. El Voice JS SDK no lo expone y producto lo ha
// descartado (§Fase 4). `toggleHold` existe para cumplir el contrato y
// no hace nada; la UI ni siquiera pinta el botón, porque consulta
// `capabilities.hold`.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react"
import { Call, Device } from "@twilio/voice-sdk"

import type { CallState, ConnectionStatus, TelnyxCallInfo, UseTelnyxReturn } from "./use-telnyx"

/** Segundos de margen: se refresca en cuanto Twilio avisa, no al expirar. */
const TOKEN_ENDPOINT = "/api/twilio/token"

interface TokenResponse {
  token?: string
  identity?: string
  expiresIn?: number
  retryable?: boolean
}

function describeCall(call: Call, state: CallState, duration: number, isMuted: boolean): TelnyxCallInfo {
  const params = call.parameters ?? {}
  const custom = call.customParameters
  const direction: "inbound" | "outbound" = params.From ? "inbound" : "outbound"
  return {
    id: params.CallSid ?? "twilio-call",
    state,
    direction,
    callerNumber: direction === "inbound" ? params.From : (custom?.get("To") ?? undefined),
    callerName: undefined,
    destinationNumber: direction === "outbound" ? (custom?.get("To") ?? undefined) : undefined,
    duration,
    isMuted,
    // Twilio no tiene hold; se reporta siempre false en vez de mentir.
    isOnHold: false,
  }
}

export function useTwilioVoice({ enabled = true }: { enabled?: boolean } = {}): UseTelnyxReturn {
  const deviceRef = useRef<Device | null>(null)
  const callRef = useRef<Call | null>(null)
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const callStartTimeRef = useRef<number | null>(null)

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected")
  const [isRegistered, setIsRegistered] = useState(false)
  const [currentCall, setCurrentCall] = useState<TelnyxCallInfo | null>(null)
  const [isMuted, setIsMuted] = useState(false)

  const isMutedRef = useRef(false)
  useEffect(() => {
    isMutedRef.current = isMuted
  }, [isMuted])

  const startDurationTimer = useCallback(() => {
    callStartTimeRef.current = Date.now()
    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current)
    durationIntervalRef.current = setInterval(() => {
      if (callStartTimeRef.current) {
        const elapsed = Math.floor((Date.now() - callStartTimeRef.current) / 1000)
        setCurrentCall((prev) => (prev ? { ...prev, duration: elapsed } : null))
      }
    }, 1000)
  }, [])

  const stopDurationTimer = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current)
      durationIntervalRef.current = null
    }
    callStartTimeRef.current = null
  }, [])

  const fetchToken = useCallback(async (): Promise<TokenResponse | null> => {
    const res = await fetch(TOKEN_ENDPOINT, { method: "POST" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as TokenResponse
      setConnectionStatus(body.retryable === false ? "config_error" : "error")
      return null
    }
    return (await res.json()) as TokenResponse
  }, [])

  const bindCall = useCallback(
    (call: Call, initialState: CallState) => {
      callRef.current = call
      setIsMuted(false)
      setCurrentCall(describeCall(call, initialState, 0, false))

      call.on("accept", () => {
        startDurationTimer()
        setCurrentCall(describeCall(call, "active", 0, isMutedRef.current))
      })

      const finish = () => {
        stopDurationTimer()
        callRef.current = null
        setIsMuted(false)
        setCurrentCall((prev) => (prev ? { ...prev, state: "ended", isMuted: false } : null))
      }
      call.on("disconnect", finish)
      call.on("cancel", finish)
      call.on("reject", finish)
      call.on("error", (err: unknown) => {
        console.error("[twilio:voice] call error:", err)
        finish()
      })
    },
    [startDurationTimer, stopDurationTimer],
  )

  const connect = useCallback(async () => {
    if (!enabled) return
    if (deviceRef.current) {
      setConnectionStatus("connected")
      return
    }
    setConnectionStatus("connecting")

    try {
      const cred = await fetchToken()
      if (!cred?.token) return

      const device = new Device(cred.token, {
        logLevel: "error",
        // Ringtone entrante del SDK: loopea mientras la llamada pende y
        // para al aceptar/rechazar (docs: twilio.com/docs/voice/sdks/
        // javascript/twiliodevice — DeviceOptions.sounds).
        sounds: { incoming: "/sounds/phone-ring.opus" },
      })
      deviceRef.current = device

      device.on("registered", () => {
        setIsRegistered(true)
        setConnectionStatus("connected")
      })
      device.on("unregistered", () => {
        setIsRegistered(false)
      })
      device.on("error", (err: unknown) => {
        console.error("[twilio:voice] device error:", err)
        setConnectionStatus("error")
      })
      device.on("incoming", (call: Call) => {
        bindCall(call, "ringing_inbound")
      })
      // Sin esto la sesión muere en silencio a la hora.
      device.on("tokenWillExpire", async () => {
        try {
          const refreshed = await fetchToken()
          if (refreshed?.token) device.updateToken(refreshed.token)
        } catch (err) {
          console.error("[twilio:voice] token refresh failed:", err)
        }
      })

      // `register()` es lo que abre la escucha de entrantes. Sin él el
      // dispositivo puede llamar pero nunca recibe.
      await device.register()
    } catch (err) {
      console.error("[twilio:voice] connect failed:", err)
      setConnectionStatus("error")
    }
  }, [bindCall, enabled, fetchToken])

  const disconnect = useCallback(() => {
    stopDurationTimer()
    try {
      callRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      deviceRef.current?.destroy()
    } catch {
      /* ignore */
    }
    deviceRef.current = null
    callRef.current = null
    setIsRegistered(false)
    setConnectionStatus("disconnected")
    setCurrentCall(null)
  }, [stopDurationTimer])

  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  const makeCall = useCallback(
    async (destinationNumber: string): Promise<boolean> => {
      const device = deviceRef.current
      if (!device || !destinationNumber) return false
      try {
        // Los `params` llegan al TwiML como POST: `To` es lo que lee
        // /api/twilio/{token}/voice en su rama saliente.
        const call = await device.connect({ params: { To: destinationNumber } })
        bindCall(call, "ringing_outbound")
        return true
      } catch (err) {
        console.error("[twilio:voice] makeCall failed:", err)
        return false
      }
    },
    [bindCall],
  )

  const answer = useCallback(() => {
    try {
      callRef.current?.accept()
    } catch {
      /* ignore */
    }
  }, [])

  const reject = useCallback(() => {
    try {
      callRef.current?.reject()
    } catch {
      /* ignore */
    }
  }, [])

  const hangup = useCallback(() => {
    try {
      callRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    callRef.current = null
    stopDurationTimer()
  }, [stopDurationTimer])

  const toggleMute = useCallback(() => {
    const call = callRef.current
    if (!call) return
    try {
      const next = !isMutedRef.current
      call.mute(next)
      setIsMuted(next)
      setCurrentCall((prev) => (prev ? { ...prev, isMuted: next } : null))
    } catch {
      /* ignore */
    }
  }, [])

  /** No-op deliberado: Twilio no tiene hold. Ver la cabecera del archivo. */
  const toggleHold = useCallback(() => {}, [])

  const sendDTMF = useCallback((digit: string) => {
    try {
      callRef.current?.sendDigits(digit)
    } catch {
      /* ignore */
    }
  }, [])

  return {
    connectionStatus,
    isRegistered,
    currentCall,
    makeCall,
    answer,
    reject,
    hangup,
    toggleMute,
    toggleHold,
    sendDTMF,
    connect,
    disconnect,
  }
}
