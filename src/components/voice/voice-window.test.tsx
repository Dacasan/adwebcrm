import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

// VoiceWindow — tabs (Contacts/Recent/Keypad), incoming (Accept/Reject),
// active (timer, End). El repo NO usa jsdom/testing-library: patrón
// renderToStaticMarkup (node env). La lógica interactiva del keypad se
// extrae a la función pura `appendKey` y se testea directo. (DAD §7.)

// La ventana consume la FACHADA `useVoice`, no un proveedor concreto:
// ese es justo el punto del plan Twilio/SendGrid. Se mockea la fachada y
// se cubren los dos proveedores.
vi.mock("@/hooks/use-voice", () => ({
  useVoice: vi.fn(),
}))

import { VoiceWindow } from "./voice-window"
import { appendKey } from "./voice-keypad-tab"
import { useVoice, type UseVoiceReturn } from "@/hooks/use-voice"
import { VOICE_CAPABILITIES_BY_PROVIDER } from "@/lib/providers/capabilities"

const mockUseVoice = vi.mocked(useVoice)

function baseMock(overrides: Partial<UseVoiceReturn> = {}): UseVoiceReturn {
  const provider = overrides.provider ?? "telnyx"
  return {
    connectionStatus: "connected",
    isRegistered: true,
    currentCall: null,
    makeCall: vi.fn(async () => true),
    answer: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    toggleMute: vi.fn(),
    toggleHold: vi.fn(),
    sendDTMF: vi.fn(),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    provider,
    capabilities: VOICE_CAPABILITIES_BY_PROVIDER[provider],
    routingLoaded: true,
    ...overrides,
  }
}

const ACTIVE_CALL = {
  id: "c1",
  state: "active" as const,
  direction: "outbound" as const,
  destinationNumber: "+15550123",
  duration: 95,
  isMuted: false,
  isOnHold: false,
}

beforeEach(() => {
  mockUseVoice.mockReturnValue(baseMock())
})

describe("appendKey (keypad, lógica pura)", () => {
  it("concatena teclas en el orden pulsado", () => {
    expect(appendKey(appendKey(appendKey("", "1"), "2"), "3")).toBe("123")
  })
})

describe("VoiceWindow", () => {
  it("renderiza las 3 tabs", () => {
    const html = renderToStaticMarkup(
      React.createElement(VoiceWindow, { onClose: () => {} }),
    )
    expect(html).toContain("Contacts")
    expect(html).toContain("Recent")
    expect(html).toContain("Keypad")
  })

  it("renderiza incoming: Accept + Reject + número del que llama", () => {
    mockUseVoice.mockReturnValue(
      baseMock({
        currentCall: {
          id: "c1",
          state: "ringing_inbound",
          direction: "inbound",
          callerNumber: "+15550123",
          duration: 0,
          isMuted: false,
          isOnHold: false,
        },
      }),
    )
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).toContain("Accept")
    expect(html).toContain("Reject")
    expect(html).toContain("+15550123")
  })

  it("renderiza active: timer mm:ss y botón End", () => {
    mockUseVoice.mockReturnValue(
      baseMock({
        currentCall: {
          id: "c1",
          state: "active",
          direction: "outbound",
          destinationNumber: "+15550123",
          duration: 95,
          isMuted: false,
          isOnHold: false,
        },
      }),
    )
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).toContain("01:35")
    expect(html).toContain("End call")
  })

  it("muestra aviso offline cuando no está registrado", () => {
    mockUseVoice.mockReturnValue(baseMock({ isRegistered: false, connectionStatus: "error" }))
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).toContain("Phone offline")
  })
})

describe("VoiceWindow — capacidades por proveedor (§6.3)", () => {
  it("con Telnyx pinta el botón de Hold", () => {
    mockUseVoice.mockReturnValue(baseMock({ provider: "telnyx", currentCall: ACTIVE_CALL }))
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).toContain("Hold")
  })

  it("con Twilio NO lo pinta: su SDK no tiene hold y un botón muerto es peor que ninguno", () => {
    mockUseVoice.mockReturnValue(baseMock({ provider: "twilio", currentCall: ACTIVE_CALL }))
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).not.toContain("Hold")
    // Lo que sí siguen estando: mute y colgar.
    expect(html).toContain("Mute")
    expect(html).toContain("End call")
  })

  it("el aviso de configuración nombra al proveedor activo", () => {
    mockUseVoice.mockReturnValue(
      baseMock({ provider: "twilio", isRegistered: false, connectionStatus: "config_error" }),
    )
    const html = renderToStaticMarkup(React.createElement(VoiceWindow, { onClose: () => {} }))
    expect(html).toContain("Twilio not configured")
  })
})
