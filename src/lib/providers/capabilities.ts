import type { VoiceCapabilities, VoiceProviderId } from './types'

// ============================================================
// Tabla de capacidades de voz, PURA y sin dependencias de servidor: la
// importan tanto las rutas como los hooks del navegador.
//
// Los proveedores no son intercambiables al 100%, y la UI pregunta en vez
// de suponer (§6.3). Las divergencias vivas hoy:
//
//   hold      Telnyx sí (call.hold()/unhold() en su SDK de navegador),
//             Twilio no — el Voice JS SDK no lo expone y tenerlo exigiría
//             conferencia server-side. Producto lo ha DESCARTADO: no es
//             deuda aplazada, es una capacidad que no va a existir.
//   transfer  ninguno de los dos, hoy. Declarado fuera de alcance.
// ============================================================

export const VOICE_CAPABILITIES_BY_PROVIDER: Record<VoiceProviderId, VoiceCapabilities> = {
  telnyx: { hold: true, transfer: false, dtmf: true, recording: true },
  twilio: { hold: false, transfer: false, dtmf: true, recording: true },
}
