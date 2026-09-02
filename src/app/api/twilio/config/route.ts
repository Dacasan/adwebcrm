import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { createTwilioClient } from '@/lib/providers/twilio/client'
import {
  generateWebhookToken,
  twilioWebhookUrlsOrNull,
} from '@/lib/providers/twilio/config'

// ============================================================
// /api/twilio/config — credenciales BYO de Twilio. owner-only.
//
// Espeja `/api/telnyx/config`: valida ANTES de guardar, encripta el
// secreto y persiste vía `ctx.supabase` (RLS owner-only) — nunca con
// service-role, que se saltaría la policy que justifica el "owner-only".
//
// GET nunca devuelve un secreto desencriptado. Devuelve booleanos
// (`has_auth_token`) y las URLs de webhook ya construidas, que es el
// paso donde más gente se atasca.
// ============================================================

export const runtime = 'nodejs'

const SID_RE = /^AC[0-9a-fA-F]{32}$/

export async function GET() {
  try {
    const ctx = await requireRole('owner')

    const { data: row, error } = await ctx.supabase
      .from('twilio_config')
      .select(
        'account_sid, api_key_sid, twiml_app_sid, messaging_service_sid, default_from_number, ' +
          'fallback_number, recording_enabled, regulatory_bundle_sid, address_sid, webhook_token, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'could not load twilio config' }, { status: 500 })
    }
    if (!row) return NextResponse.json({ configured: false })
    // La columna se pide como una cadena concatenada, así que PostgREST no
    // puede inferir el shape: se declara aquí, una vez.
    const data = row as unknown as {
      account_sid: string
      api_key_sid: string | null
      twiml_app_sid: string | null
      messaging_service_sid: string | null
      default_from_number: string | null
      fallback_number: string | null
      recording_enabled: boolean | null
      regulatory_bundle_sid: string | null
      address_sid: string | null
      webhook_token: string
      updated_at: string
    }

    return NextResponse.json({
      configured: true,
      account_sid: data.account_sid,
      // El Auth Token y el secreto de la API Key NO salen de aquí jamás.
      has_auth_token: true,
      has_api_key: Boolean(data.api_key_sid),
      api_key_sid: data.api_key_sid,
      twiml_app_sid: data.twiml_app_sid,
      messaging_service_sid: data.messaging_service_sid,
      default_from_number: data.default_from_number,
      fallback_number: data.fallback_number,
      recording_enabled: data.recording_enabled === true,
      regulatory_bundle_sid: data.regulatory_bundle_sid,
      address_sid: data.address_sid,
      webhook_token: data.webhook_token,
      webhook_urls: twilioWebhookUrlsOrNull(data.webhook_token),
      updated_at: data.updated_at,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('owner')

    const limit = checkRateLimit(`twilio-config:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'bad body' }, { status: 400 })
    }

    const str = (k: string): string =>
      typeof body[k] === 'string' ? (body[k] as string).trim() : ''

    const { data: existing } = await ctx.supabase
      .from('twilio_config')
      .select('id, account_sid, webhook_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const accountSid = str('account_sid') || (existing?.account_sid as string | undefined) || ''
    const authToken = str('auth_token')

    if (!accountSid) {
      return NextResponse.json({ error: 'account_sid is required' }, { status: 400 })
    }
    if (!SID_RE.test(accountSid)) {
      return NextResponse.json(
        { error: 'account_sid must look like ACxxxxxxxx… (34 chars)' },
        { status: 400 },
      )
    }
    if (!existing && !authToken) {
      return NextResponse.json({ error: 'auth_token is required' }, { status: 400 })
    }

    // Validar contra Twilio ANTES de guardar nada — mismo "guardar y
    // verificar" que Telnyx. Solo cuando llega un token nuevo: en un
    // guardado que solo cambia el número de fallback no hay nada que
    // validar y una llamada de red de más solo añade latencia y fallos.
    if (authToken) {
      try {
        await createTwilioClient(accountSid, authToken).api.v2010.accounts(accountSid).fetch()
      } catch {
        return NextResponse.json({ error: 'invalid Twilio credentials' }, { status: 400 })
      }
    }

    const payload: Record<string, unknown> = { account_sid: accountSid }
    if (authToken) {
      payload.auth_token_encrypted = encrypt(authToken)
      // El Auth Token cambió: la API Key firmada con el anterior sigue
      // siendo válida (son credenciales independientes), así que NO se
      // descarta. Lo que sí caduca son las firmas de webhook en vuelo.
    }
    for (const [field, column] of [
      ['messaging_service_sid', 'messaging_service_sid'],
      ['default_from_number', 'default_from_number'],
      ['fallback_number', 'fallback_number'],
      ['regulatory_bundle_sid', 'regulatory_bundle_sid'],
      ['address_sid', 'address_sid'],
    ] as const) {
      const value = str(field)
      // Cadena vacía explícita = borrar el campo; ausente = no tocarlo.
      if (field in body) payload[column] = value || null
    }
    if (typeof body.recording_enabled === 'boolean') {
      payload.recording_enabled = body.recording_enabled
    }

    // Rotación del token de webhook: cambia TODAS las URLs de esta
    // cuenta, así que la respuesta devuelve las nuevas para repegarlas.
    const rotate = body.rotate_webhook_token === true
    let webhookToken = (existing?.webhook_token as string | undefined) ?? ''
    if (!existing || rotate) {
      webhookToken = generateWebhookToken()
      payload.webhook_token = webhookToken
    }

    const { error } = existing
      ? await ctx.supabase.from('twilio_config').update(payload).eq('account_id', ctx.accountId)
      : await ctx.supabase
          .from('twilio_config')
          .insert({ ...payload, account_id: ctx.accountId })

    if (error) {
      console.error('[twilio:config] save failed:', error.message)
      return NextResponse.json({ error: 'could not save twilio config' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      rotated: rotate,
      webhook_token: webhookToken,
      webhook_urls: twilioWebhookUrlsOrNull(webhookToken),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
