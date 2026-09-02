"use client"

// ============================================================
// VoiceWindow — ventana flotante VoIP (Fase 2, DAD §4.3 spec exacta).
// <div className="fixed bottom-6 right-6 z-50 flex h-[520px] w-[380px] flex-col
//                 overflow-hidden rounded-xl border bg-card shadow-2xl">
// Tabs: Contacts | Recent | Keypad (activo con border-b-2 border-primary).
// Incoming: Accept bg-green-600 / Reject bg-destructive.
// Active: timer mm:ss, Mute/Hold/Keypad, End bg-destructive.
//
// P0 "no me entero de las llamadas": la ventana vive SIEMPRE montada
// (el launcher ya no la desmonta — desmontarla destruye el Device y con
// él la escucha de entrantes, use-twilio-voice.ts:204-208). Se OCULTA
// con CSS (`hidden`) y se AUTO-ABRE al llegar `ringing_inbound`
// (`shown = open || ringing`): popup grande centrado con backdrop.
// El ringtone lo gestiona el SDK (DeviceOptions.sounds en
// use-twilio-voice.ts) — aquí solo se desbloquea el autoplay con el
// primer gesto del usuario (política de navegadores).
// ============================================================

import { useEffect } from "react"
import { Phone, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useVoice } from "@/hooks/use-voice"
import { VoiceActiveView } from "@/components/voice/voice-active-view"
import { VoiceContactsTab } from "@/components/voice/voice-contacts-tab"
import { VoiceIncomingView } from "@/components/voice/voice-incoming-view"
import { VoiceKeypadTab } from "@/components/voice/voice-keypad-tab"
import { VoiceRecentTab } from "@/components/voice/voice-recent-tab"

export function VoiceWindow({
  open = true,
  onClose,
}: {
  /** Estado del launcher: false = oculta (PERO sigue montada y registrada). */
  open?: boolean
  onClose: () => void
}) {
  const {
    connectionStatus,
    isRegistered,
    currentCall,
    makeCall,
    answer,
    reject,
    hangup,
    toggleMute,
    toggleHold,
    connect,
    provider,
    capabilities,
  } = useVoice()

  useEffect(() => {
    void connect()
  }, [connect])

  // Desbloqueo de autoplay: el ringtone del SDK solo suena si hubo un
  // gesto del usuario antes de la primera llamada. El primer clic en el
  // dashboard pre-carga el audio muteado y lo libera (doc Twilio/Flex:
  // "Workarounds" de autoplay por navegador).
  useEffect(() => {
    const unlock = () => {
      try {
        const a = new Audio("/sounds/phone-ring.opus")
        a.muted = true
        a.play()
          .then(() => {
            a.pause()
            a.currentTime = 0
          })
          .catch(() => {})
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("pointerdown", unlock, { once: true })
    return () => window.removeEventListener("pointerdown", unlock)
  }, [])

  const busy = currentCall?.state === "active" || currentCall?.state === "held"
  const ringing = currentCall?.state === "ringing_inbound"
  // Auto-apertura: aunque el launcher la tenga cerrada, una entrante
  // SIEMPRE se muestra. Al contestar/rechazar vuelve a su estado previo.
  const shown = open || ringing

  return (
    <>
      <audio id="remoteAudio" className="hidden" autoPlay />

      {ringing && <div className="fixed inset-0 z-40 bg-black/50" aria-hidden="true" />}

      <div
        className={`fixed z-50 flex h-[520px] w-[380px] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl ${
          shown
            ? ringing
              ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              : "bottom-6 right-6"
            : "hidden"
        }`}
      >
        <header className="flex h-12 shrink-0 items-center justify-between bg-primary px-4 text-primary-foreground">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Phone className="h-4 w-4" />
            VoIP
            <span className="text-xs font-normal opacity-80">
              {isRegistered ? "· online" : connectionStatus === "connecting" ? "· connecting…" : "· offline"}
            </span>
          </span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>

        {!isRegistered && connectionStatus !== "connecting" && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
            {connectionStatus === "config_error"
              ? `${provider === "twilio" ? "Twilio" : "Telnyx"} not configured — check Settings.`
              : `Phone offline — configure ${provider === "twilio" ? "Twilio" : "Telnyx"} in Settings.`}
          </div>
        )}

        {ringing && currentCall ? (
          <VoiceIncomingView call={currentCall} onAnswer={answer} onReject={reject} />
        ) : currentCall && (currentCall.state === "active" || currentCall.state === "held" || currentCall.state === "ringing_outbound") ? (
          <VoiceActiveView
            call={currentCall}
            onHangup={hangup}
            onToggleMute={toggleMute}
            onToggleHold={toggleHold}
            capabilities={capabilities}
          />
        ) : (
          <Tabs defaultValue="contacts" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-3 grid w-auto grid-cols-3 gap-1">
              <TabsTrigger value="contacts">Contacts</TabsTrigger>
              <TabsTrigger value="recent">Recent</TabsTrigger>
              <TabsTrigger value="keypad">Keypad</TabsTrigger>
            </TabsList>
            <TabsContent value="contacts" className="min-h-0 flex-1">
              <VoiceContactsTab onCall={(n) => void makeCall(n)} />
            </TabsContent>
            <TabsContent value="recent" className="min-h-0 flex-1">
              <VoiceRecentTab />
            </TabsContent>
            <TabsContent value="keypad" className="min-h-0 flex-1">
              <VoiceKeypadTab onCall={(n) => void makeCall(n)} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </>
  )
}
