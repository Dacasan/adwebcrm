import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ProviderError } from '@/lib/providers/errors'
import {
  fetchAuthenticatedDomains,
  isDomainAuthenticated,
} from '@/lib/providers/sendgrid/client'
import {
  generateSendGridWebhookToken,
  sendgridWebhookUrl,
} from '@/lib/providers/sendgrid/config'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// /api/sendgrid/config — credenciales BYO de SendGrid. owner-only.
//
// Además de guardar, COMPRUEBA Y MUESTRA el estado de autenticación de
// dominio (`GET /v3/whitelabel/domains`). No es un extra: un `from_email`
// en un dominio sin DKIM firmado va a spam sin devolver ningún error, y
// el usuario lo descubre cuando su campaña no la abre nadie. El envío de
// campañas se bloquea si el dominio no está autenticado; el
// transaccional no.
//
// El GET nunca devuelve la API key.
// ============================================================

export const runtime = 'nodejs'

export async function GET() {
  try {
    const ctx = await requireRole('owner')

    const { data: row, error } = await ctx.supabase
      .from('sendgrid_config')
      .select(
        'from_email, from_name, reply_to, webhook_public_key, webhook_token, ' +
          'domain_authenticated, domain_checked_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'could not load sendgrid config' }, { status: 500 })
    }
    if (!row) return NextResponse.json({ configured: false })

    const data = row as unknown as {
      from_email: string
      from_name: string | null
      reply_to: string | null
      webhook_public_key: string | null
      webhook_token: string
      domain_authenticated: boolean | null
      domain_checked_at: string | null
      updated_at: string
    }

    return NextResponse.json({
      configured: true,
      has_api_key: true,
      from_email: data.from_email,
      from_name: data.from_name,
      reply_to: data.reply_to,
      has_webhook_public_key: Boolean(data.webhook_public_key),
      webhook_token: data.webhook_token,
      webhook_url: sendgridWebhookUrl(data.webhook_token),
      domain_authenticated: data.domain_authenticated === true,
      domain_checked_at: data.domain_checked_at,
      updated_at: data.updated_at,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('owner')

    const limit = checkRateLimit(`sendgrid-config:${ctx.userId}`, RATE_LIMITS.adminAction)
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
      .from('sendgrid_config')
      .select('id, from_email, webhook_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const apiKey = str('api_key')
    const fromEmail = str('from_email') || ((existing?.from_email as string | undefined) ?? '')

    if (!existing && !apiKey) {
      return NextResponse.json({ error: 'api_key is required' }, { status: 400 })
    }
    if (!fromEmail) {
      return NextResponse.json({ error: 'from_email is required' }, { status: 400 })
    }

    // Validar la key y, de paso, resolver el estado del dominio. Una sola
    // llamada de red sirve para las dos cosas.
    let domainAuthenticated: boolean | null = null
    if (apiKey) {
      try {
        const domains = await fetchAuthenticatedDomains(apiKey)
        domainAuthenticated = isDomainAuthenticated(fromEmail, domains)
      } catch (err) {
        if (err instanceof ProviderError && err.status === 401) {
          return NextResponse.json({ error: 'invalid SendGrid api key' }, { status: 400 })
        }
        return NextResponse.json({ error: 'invalid SendGrid api key' }, { status: 400 })
      }
    }

    const payload: Record<string, unknown> = { from_email: fromEmail }
    if (apiKey) payload.api_key_encrypted = encrypt(apiKey)
    if ('from_name' in body) payload.from_name = str('from_name') || null
    if ('reply_to' in body) payload.reply_to = str('reply_to') || null
    if ('webhook_public_key' in body) {
      payload.webhook_public_key = str('webhook_public_key') || null
    }
    if (domainAuthenticated !== null) {
      payload.domain_authenticated = domainAuthenticated
      payload.domain_checked_at = new Date().toISOString()
    }

    const rotate = body.rotate_webhook_token === true
    let webhookToken = (existing?.webhook_token as string | undefined) ?? ''
    if (!existing || rotate) {
      webhookToken = generateSendGridWebhookToken()
      payload.webhook_token = webhookToken
    }

    const { error } = existing
      ? await ctx.supabase.from('sendgrid_config').update(payload).eq('account_id', ctx.accountId)
      : await ctx.supabase
          .from('sendgrid_config')
          .insert({ ...payload, account_id: ctx.accountId })

    if (error) {
      console.error('[sendgrid:config] save failed:', error.message)
      return NextResponse.json({ error: 'could not save sendgrid config' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      rotated: rotate,
      webhook_token: webhookToken,
      webhook_url: sendgridWebhookUrl(webhookToken),
      domain_authenticated: domainAuthenticated,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
