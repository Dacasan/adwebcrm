import { twiml } from 'twilio'
// El namespace con los tipos de atributos (`ClientAttributes`,
// `SayLanguage`…) no viaja en el barrel de 'twilio': `twiml.VoiceResponse`
// es la CLASE. Este import de tipos trae la parte de namespace del mismo
// módulo — sigue siendo el SDK de Twilio, dentro de la carpeta que R1
// autoriza a importarlo.
import type VoiceResponseTypes from 'twilio/lib/twiml/VoiceResponse'

// ============================================================
// Constructores de TwiML. FUNCIONES PURAS: sin BD, sin red, sin
// `process.env`. Todo lo que necesitan llega por argumento, y por eso se
// testean sin un solo mock — que es donde está el valor de este archivo.
//
// El XML lo genera `twilio.twiml.VoiceResponse`, no una plantilla de
// strings. La razón es el escapado: un `&` en el nombre de una clínica o
// un `<` en un mensaje de buzón rompen un documento hecho a mano, y el
// fallo aparece como una llamada que se cae sin explicación.
//
// ── Por qué esto reemplaza al patrón de dos patas ────────────
// En Telnyx la entrante exige contestar la pata A, crear una pata B hacia
// el SIP del agente sobre la conexión de credenciales, unirlas con bridge
// y colgar la huérfana para evitar el 486. En Twilio ese patrón no
// existe: se enruta al navegador por la IDENTIDAD del Access Token y el
// timbre simultáneo entre N agentes es un `<Dial>` con N `<Client>`.
// ============================================================

type SayAttributes = NonNullable<Parameters<twiml.VoiceResponse['say']>[0]>
type SayLanguage = SayAttributes extends { language?: infer L } ? L : never

/** Segundos de timbre antes de considerar que nadie contesta. */
export const DEFAULT_DIAL_TIMEOUT_SECS = 25

/** Duración máxima de un mensaje de buzón. */
export const VOICEMAIL_MAX_LENGTH_SECS = 180

export interface DialCommonArgs {
  /** Caller id mostrado al destino (E.164 de la cuenta). */
  callerId: string
  /** `action` del <Dial>: aquí se decide si la llamada fue perdida. */
  actionUrl: string
  /** statusCallback por pata; null para no pedirlo. */
  statusCallbackUrl?: string | null
  /**
   * recordingStatusCallback. NULL cuando la cuenta no ha activado la
   * grabación — es opt-in por cuenta (`twilio_config.recording_enabled`,
   * default false) porque en España grabar exige informar y en EE. UU.
   * hay estados de doble consentimiento.
   */
  recordingCallbackUrl?: string | null
  timeoutSecs?: number
  /** `record-from-answer-dual` cuando se quieren canales separados (QA). */
  dualChannel?: boolean
}

function dialAttributes(args: DialCommonArgs) {
  const record = args.recordingCallbackUrl
    ? args.dualChannel
      ? ('record-from-answer-dual' as const)
      : ('record-from-answer' as const)
    : undefined

  return {
    callerId: args.callerId,
    action: args.actionUrl,
    method: 'POST' as const,
    timeout: args.timeoutSecs ?? DEFAULT_DIAL_TIMEOUT_SECS,
    ...(record ? { record } : {}),
    ...(args.recordingCallbackUrl
      ? {
          recordingStatusCallback: args.recordingCallbackUrl,
          recordingStatusCallbackMethod: 'POST' as const,
        }
      : {}),
  }
}

/**
 * Los eventos van como ARRAY en el builder del SDK (`ClientEvent[]`), no
 * como la cadena separada por espacios del XML: el propio builder la
 * serializa. Pasar la cadena compila con `any` y falla en runtime.
 */
const DIAL_STATUS_EVENTS = ['initiated', 'ringing', 'answered', 'completed'] as const

function clientAttributes(
  statusCallbackUrl?: string | null,
): VoiceResponseTypes.ClientAttributes {
  if (!statusCallbackUrl) return {}
  return {
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: [...DIAL_STATUS_EVENTS],
  }
}

function numberAttributes(
  statusCallbackUrl?: string | null,
): VoiceResponseTypes.NumberAttributes {
  if (!statusCallbackUrl) return {}
  return {
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: [...DIAL_STATUS_EVENTS],
  }
}

/**
 * Entrante hacia los softphones conectados. Un `<Client>` por identidad:
 * Twilio hace TIMBRE SIMULTÁNEO y conecta al primero que descuelgue. Es
 * una línea de XML — no lo implementes tú con una cola.
 */
export function inboundToClientsTwiML(
  args: DialCommonArgs & { identities: string[] },
): string {
  const response = new twiml.VoiceResponse()
  const dial = response.dial(dialAttributes(args))
  for (const identity of args.identities) {
    dial.client(clientAttributes(args.statusCallbackUrl), identity)
  }
  return response.toString()
}

/** Entrante desviada a un número (el `fallback_number` de la cuenta). */
export function inboundToNumberTwiML(args: DialCommonArgs & { to: string }): string {
  const response = new twiml.VoiceResponse()
  const dial = response.dial(dialAttributes(args))
  dial.number(numberAttributes(args.statusCallbackUrl), args.to)
  return response.toString()
}

/** Saliente originada en el navegador (`device.connect({ params: { To } })`). */
export function outboundTwiML(args: DialCommonArgs & { to: string }): string {
  return inboundToNumberTwiML(args)
}

/**
 * Buzón: ni agentes conectados ni número de desvío. Se avisa y se graba,
 * en vez de colgar en seco, que es lo que hace que un paciente no vuelva
 * a llamar.
 */
export function voicemailTwiML(args: {
  message: string
  recordingCallbackUrl: string | null
  /**
   * `SayLanguage` no se exporta del namespace del SDK, así que el tipo se
   * deriva de la firma de `say()`. Derivarlo en vez de copiar la lista de
   * 60 locales evita que se quede vieja en el próximo bump del SDK.
   */
  language?: SayLanguage
  maxLengthSecs?: number
}): string {
  const response = new twiml.VoiceResponse()
  response.say({ language: args.language ?? 'es-ES' }, args.message)
  if (args.recordingCallbackUrl) {
    response.record({
      maxLength: args.maxLengthSecs ?? VOICEMAIL_MAX_LENGTH_SECS,
      playBeep: true,
      recordingStatusCallback: args.recordingCallbackUrl,
      recordingStatusCallbackMethod: 'POST',
    })
  }
  response.hangup()
  return response.toString()
}

/** Se acabó: cuelga sin decir nada (rechazo explícito, error de config). */
export function hangupTwiML(): string {
  const response = new twiml.VoiceResponse()
  response.hangup()
  return response.toString()
}

/** Identidad de softphone de un usuario. Ver `twilio/identity.ts`. */
export { agentIdentity, userIdFromIdentity } from './identity'
