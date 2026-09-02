// ============================================================
// Contratos de proveedor (plan Twilio/SendGrid §4.1).
//
// Este archivo es DELIBERADAMENTE puro: solo tipos. No importa SDKs, ni
// Supabase, ni `next/server`. Es lo que permite que rutas, componentes y
// el engine de automatizaciones lo importen sin arrastrar nada de
// servidor al bundle del cliente (regla de dependencias §2.3).
// ============================================================

export type VoiceProviderId = 'telnyx' | 'twilio'
export type SmsProviderId = 'telnyx' | 'twilio'
export type EmailProviderId = 'resend' | 'sendgrid'

export const VOICE_PROVIDER_IDS: readonly VoiceProviderId[] = ['telnyx', 'twilio']
export const SMS_PROVIDER_IDS: readonly SmsProviderId[] = ['telnyx', 'twilio']
export const EMAIL_PROVIDER_IDS: readonly EmailProviderId[] = ['resend', 'sendgrid']

export function isVoiceProviderId(v: unknown): v is VoiceProviderId {
  return typeof v === 'string' && (VOICE_PROVIDER_IDS as readonly string[]).includes(v)
}
export function isSmsProviderId(v: unknown): v is SmsProviderId {
  return typeof v === 'string' && (SMS_PROVIDER_IDS as readonly string[]).includes(v)
}
export function isEmailProviderId(v: unknown): v is EmailProviderId {
  return typeof v === 'string' && (EMAIL_PROVIDER_IDS as readonly string[]).includes(v)
}

// ------------------------------------------------------------
// Voz
// ------------------------------------------------------------

export interface OutboundCallInput {
  /** E.164 destino. */
  to: string
  contactId: string | null
  /** Identidad del softphone que origina (Twilio); ignorada por Telnyx. */
  agentIdentity?: string
}

export interface OutboundCallResult {
  providerCallId: string
  from: string
}

/**
 * Capacidades que la UI debe consultar antes de pintar un botón (§6.3).
 * Los proveedores NO son intercambiables al 100%: `hold` existe en Telnyx
 * y no en el Voice JS SDK de Twilio. La UI pregunta, no supone.
 */
export interface VoiceCapabilities {
  hold: boolean
  transfer: boolean
  dtmf: boolean
  recording: boolean
}

export interface VoiceClientToken {
  provider: VoiceProviderId
  token: string
  identity: string
  /** Segundos hasta expirar; el cliente refresca antes. */
  expiresIn: number
}

export interface VoiceProvider {
  readonly id: VoiceProviderId
  /** Marca saliente desde el servidor (click-to-call sin softphone). */
  dial(accountId: string, input: OutboundCallInput): Promise<OutboundCallResult>
  hangup(accountId: string, providerCallId: string): Promise<void>
  /** Credencial efímera para el softphone del navegador. */
  issueClientToken(accountId: string, userId: string): Promise<VoiceClientToken>
  readonly capabilities: VoiceCapabilities
}

// ------------------------------------------------------------
// SMS
// ------------------------------------------------------------

export interface SendSmsInput {
  to: string
  text: string
  /** Correlación con la fila de `messages`; viaja en el statusCallback. */
  clientRef?: string
}

export interface SendSmsResult {
  providerMessageId: string
  from: string
}

export interface SmsProvider {
  readonly id: SmsProviderId
  send(accountId: string, input: SendSmsInput): Promise<SendSmsResult>
}

// ------------------------------------------------------------
// Email
// ------------------------------------------------------------

export interface SendEmailInput {
  to: string
  subject: string
  html: string
  /** `email_sends.id`; SendGrid lo devuelve en cada evento del webhook. */
  sendId?: string
  /**
   * `email_campaign_recipients.id`, para el mismo truco en campañas. Es
   * un campo aparte y no `sendId` porque apuntan a TABLAS distintas: el
   * webhook decide a cuál escribir según cuál venga.
   */
  recipientId?: string
}

export interface SendEmailResult {
  providerMessageId: string
}

export interface EmailProvider {
  readonly id: EmailProviderId
  send(accountId: string, input: SendEmailInput): Promise<SendEmailResult>
}
