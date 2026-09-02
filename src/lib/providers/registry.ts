import { loadProviderRouting, type ProviderRouting } from './routing'
import type {
  EmailProvider,
  EmailProviderId,
  SmsProvider,
  SmsProviderId,
  VoiceProvider,
  VoiceProviderId,
} from './types'

// ============================================================
// Registry — de `account_id` al adaptador que sirve ese canal.
//
// Los adaptadores se importan de forma PEREZOSA (`await import`) a
// propósito: así el módulo que resuelve el proveedor no arrastra el SDK
// de Twilio ni el de SendGrid a ningún bundle que solo necesite saber
// "quién sirve la voz de esta cuenta". Es la mitad barata de la regla de
// dependencias de §2.3; la otra mitad la vigila `verify-providers.mjs`.
// ============================================================

async function voiceAdapter(id: VoiceProviderId): Promise<VoiceProvider> {
  if (id === 'twilio') return (await import('./twilio/voice')).twilioVoice
  return (await import('./telnyx/voice')).telnyxVoice
}

async function smsAdapter(id: SmsProviderId): Promise<SmsProvider> {
  if (id === 'twilio') return (await import('./twilio/sms')).twilioSms
  return (await import('./telnyx/sms')).telnyxSms
}

async function emailAdapter(id: EmailProviderId): Promise<EmailProvider> {
  if (id === 'sendgrid') return (await import('./sendgrid/email')).sendgridEmail
  return (await import('./resend/email')).resendEmail
}

export async function resolveVoiceProvider(accountId: string): Promise<VoiceProvider> {
  const routing = await loadProviderRouting(accountId)
  return voiceAdapter(routing.voice)
}

export async function resolveSmsProvider(accountId: string): Promise<SmsProvider> {
  const routing = await loadProviderRouting(accountId)
  return smsAdapter(routing.sms)
}

export async function resolveEmailProvider(accountId: string): Promise<EmailProvider> {
  const routing = await loadProviderRouting(accountId)
  return emailAdapter(routing.email)
}

/**
 * Los tres a la vez cuando el caller ya sabe que necesita más de uno —
 * una sola lectura de `provider_routing` en vez de tres.
 */
export async function resolveProviders(accountId: string): Promise<{
  routing: ProviderRouting
  voice: VoiceProvider
  sms: SmsProvider
  email: EmailProvider
}> {
  const routing = await loadProviderRouting(accountId)
  const [voice, sms, email] = await Promise.all([
    voiceAdapter(routing.voice),
    smsAdapter(routing.sms),
    emailAdapter(routing.email),
  ])
  return { routing, voice, sms, email }
}

/** Capacidades de voz de la cuenta sin instanciar nada más (§6.3). */
export async function resolveVoiceCapabilities(accountId: string) {
  const provider = await resolveVoiceProvider(accountId)
  return { provider: provider.id, capabilities: provider.capabilities }
}
