import crypto from 'node:crypto'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ProviderNotConfiguredError } from '../errors'

// ============================================================
// Carga de `sendgrid_config` (migración 075). Mismo patrón que
// `twilio/config.ts`: service-role para leer, `ctx.supabase` para
// escribir desde la ruta de settings.
// ============================================================

export interface SendGridConfig {
  accountId: string
  apiKey: string
  fromEmail: string
  fromName: string | null
  replyTo: string | null
  /** Clave pública ECDSA del Signed Event Webhook. Sin ella: 503. */
  webhookPublicKey: string | null
  webhookToken: string
  domainAuthenticated: boolean
}

const COLUMNS =
  'account_id, api_key_encrypted, from_email, from_name, reply_to, webhook_public_key, ' +
  'webhook_token, domain_authenticated'

interface Row {
  account_id: string
  api_key_encrypted: string
  from_email: string
  from_name: string | null
  reply_to: string | null
  webhook_public_key: string | null
  webhook_token: string
  domain_authenticated: boolean | null
}

function hydrate(row: Row): SendGridConfig {
  return {
    accountId: row.account_id,
    apiKey: decrypt(row.api_key_encrypted),
    fromEmail: row.from_email,
    fromName: row.from_name ?? null,
    replyTo: row.reply_to ?? null,
    webhookPublicKey: row.webhook_public_key ?? null,
    webhookToken: row.webhook_token,
    domainAuthenticated: row.domain_authenticated === true,
  }
}

export async function loadSendGridConfig(accountId: string): Promise<SendGridConfig> {
  const { data, error } = await supabaseAdmin()
    .from('sendgrid_config')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) {
    throw new ProviderNotConfiguredError(
      'SendGrid is not configured for this account (Settings › Email › SendGrid)',
      'sendgrid',
    )
  }
  return hydrate(data as unknown as Row)
}

/** Del token de la ruta a la cuenta, antes de verificar la firma. */
export async function loadSendGridConfigByWebhookToken(
  webhookToken: string,
): Promise<SendGridConfig | null> {
  if (!webhookToken || !/^[0-9a-f]{64}$/i.test(webhookToken)) return null
  const { data, error } = await supabaseAdmin()
    .from('sendgrid_config')
    .select(COLUMNS)
    .eq('webhook_token', webhookToken)
    .maybeSingle()
  if (error || !data) return null
  return hydrate(data as unknown as Row)
}

export function generateSendGridWebhookToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * URL del webhook. Devuelve `null` si no hay base pública configurada, en
 * vez de lanzar: la pantalla de Settings tiene que poder abrirse y avisar
 * de que falta la variable, no devolver un 500 opaco.
 */
export function sendgridWebhookUrl(webhookToken: string): string | null {
  const base =
    process.env.TWILIO_WEBHOOK_BASE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!base) return null
  return `${base.replace(/\/$/, '')}/api/sendgrid/${webhookToken}/webhook`
}
