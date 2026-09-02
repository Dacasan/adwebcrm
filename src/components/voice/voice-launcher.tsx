"use client"

// VoiceLauncher — botón flotante + VoiceWindow (softphone Fase 2, DAD §4.3).
// Se monta en el dashboard-shell en TODAS las páginas.
//
// P0 "no me entero de las llamadas": la VoiceWindow ya no se desmonta al
// cerrar — permanece montada (Device de Twilio registrado y escuchando
// entrantes en cualquier página) y solo se OCULTA con CSS. Al llegar una
// llamada la ventana se auto-abre sola (voice-window.tsx: shown = open
// || ringing) y el ringtone lo pone el SDK (DeviceOptions.sounds).

import { useState } from "react"
import { Phone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { VoiceWindow } from "@/components/voice/voice-window"

export function VoiceLauncher() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <VoiceWindow open={open} onClose={() => setOpen(false)} />
      <Button
        type="button"
        size="icon"
        onClick={() => setOpen(true)}
        className={`fixed bottom-6 right-6 z-40 h-12 w-12 rounded-full shadow-lg ${open ? "hidden" : ""}`}
        aria-label="Open VoIP phone"
      >
        <Phone className="h-5 w-5" />
      </Button>
    </>
  )
}
