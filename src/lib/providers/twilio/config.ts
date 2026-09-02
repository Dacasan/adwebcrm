import crypto from 'node:crypto'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ProviderNotConfiguredError } from '../errors'

// ============================================================
// Carga de `twilio_config` (migración 074) y construcción de las URLs
// de webhook.
//
// Todo lo de este archivo es service-role: lo consumen webhooks sin
// sesión y rutas de servidor. La escritura de credenciales, en cambio,
// va por `ctx.supabase` en `/api/twilio/config` para que la policy
// owner-only sea quien autoriza.
// ============================================================

export interface TwilioConfig {
  accountId: string
  accountSid: string
  /** Auth Token desencriptado. Firma los webhooks entrantes. */
  authToken: string
  apiKeySid: string | null
  /** Secreto de la API Key, desencriptado. */
  apiKeySecret: string | null
  twimlAppSid: string | null
  messagingServiceSid: string | null
  defaultFromNumber: string | null
  fallbackNumber: string | null
  recordingEnabled: boolean
  regulatoryBundleSid: string | null
  addressSid: string | null
  webhookToken: string
}

const COLUMNS =
  'account_id, account_sid, auth_token_encrypted, api_key_sid, api_key_secret_encrypted, ' +
  'twiml_app_sid, messaging_service_sid, default_from_number, fallback_number, ' +
  'recording_enabled, regulatory_bundle_sid, address_sid, webhook_token'

interface Row {
  account_id: string
  account_sid: string
  auth_token_encrypted: string
  api_key_sid: string | null
  api_key_secret_encrypted: string | null
  twiml_app_sid: string | null
  messaging_service_sid: string | null
  default_from_number: string | null
  fallback_number: string | null
  recording_enabled: boolean | null
  regulatory_bundle_sid: string | null
  address_sid: string | null
  webhook_token: string
}

function hydrate(row: Row): TwilioConfig {
  return {
    accountId: row.account_id,
    accountSid: row.account_sid,
    authToken: decrypt(row.auth_token_encrypted),
    apiKeySid: row.api_key_sid ?? null,
    apiKeySecret: row.api_key_secret_encrypted ? decrypt(row.api_key_secret_encrypted) : null,
    twimlAppSid: row.twiml_app_sid ?? null,
    messagingServiceSid: row.messaging_service_sid ?? null,
    defaultFromNumber: row.default_from_number ?? null,
    fallbackNumber: row.fallback_number ?? null,
    recordingEnabled: row.recording_enabled === true,
    regulatoryBundleSid: row.regulatory_bundle_sid ?? null,
    addressSid: row.address_sid ?? null,
    webhookToken: row.webhook_token,
  }
}

/** Config de la cuenta. Lanza `ProviderNotConfiguredError` si no hay fila. */
export async function loadTwilioConfig(accountId: string): Promise<TwilioConfig> {
  const { data, error } = await supabaseAdmin()
    .from('twilio_config')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) {
    throw new ProviderNotConfiguredError(
      'Twilio is not configured for this account (Settings › Phone › Twilio)',
      'twilio',
    )
  }
  return hydrate(data as unknown as Row)
}

/**
 * Resolución de tenancy de los webhooks: del token de la ruta a la
 * cuenta. Devuelve `null` cuando el token no existe — el webhook responde
 * 404 sin más trabajo, y sin confirmar qué tokens existen.
 */
export async function loadTwilioConfigByWebhookToken(
  webhookToken: string,
): Promise<TwilioConfig | null> {
  if (!webhookToken || !/^[0-9a-f]{64}$/i.test(webhookToken)) return null

  const { data, error } = await supabaseAdmin()
    .from('twilio_config')
    .select(COLUMNS)
    .eq('webhook_token', webhookToken)
    .maybeSingle()

  if (error || !data) return null
  return hydrate(data as unknown as Row)
}

/** 32 bytes hex. Rotable: al rotarlo hay que repegar las URLs en Twilio. */
export function generateWebhookToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Base pública de los webhooks, SIN barra final.
 *
 * Nunca se deriva de `req.url` a propósito: la firma `X-Twilio-Signature`
 * se calcula sobre la URL completa, así que un proxy que reescriba el host
 * (o un `x-forwarded-proto` perdido) invalidaría TODAS las peticiones sin
 * dejar más rastro que un 403. Una variable explícita convierte ese fallo
 * silencioso en un error de arranque.
 */
export function twilioWebhookBase(): string {
  const base =
    process.env.TWILIO_WEBHOOK_BASE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!base) {
    throw new Error(
      'TWILIO_WEBHOOK_BASE_URL not configured — the Twilio signature is computed over the full URL, so it cannot be inferred',
    )
  }
  return base.replace(/\/$/, '')
}

/** Path de un webhook de esta cuenta, p. ej. `/api/twilio/<token>/voice`. */
export function twilioWebhookPath(webhookToken: string, suffix: string): string {
  const clean = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `/api/twilio/${webhookToken}${clean}`
}

/** URL absoluta del webhook. Es la que se pega en la consola de Twilio. */
export function twilioWebhookUrl(webhookToken: string, suffix: string): string {
  return `${twilioWebhookBase()}${twilioWebhookPath(webhookToken, suffix)}`
}

/**
 * Igual que `twilioWebhookUrls`, pero devuelve `null` en vez de lanzar
 * cuando la base pública no está configurada. La usa la pantalla de
 * Settings: un despliegue al que le falta `TWILIO_WEBHOOK_BASE_URL` tiene
 * que poder abrir la pantalla y leer el aviso, no recibir un 500 opaco.
 */
export function twilioWebhookUrlsOrNull(webhookToken: string) {
  try {
    return twilioWebhookUrls(webhookToken)
  } catch {
    return null
  }
}

/** Las seis URLs que la UI muestra con un botón de copiar (§Fase 7). */
export function twilioWebhookUrls(webhookToken: string) {
  return {
    voice: twilioWebhookUrl(webhookToken, '/voice'),
    voice_status: twilioWebhookUrl(webhookToken, '/voice/status'),
    voice_action: twilioWebhookUrl(webhookToken, '/voice/action'),
    voice_recording: twilioWebhookUrl(webhookToken, '/voice/recording'),
    sms_inbound: twilioWebhookUrl(webhookToken, '/sms/inbound'),
    sms_status: twilioWebhookUrl(webhookToken, '/sms/status'),
  }
}
