import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// /api/tracking/config — LA ÚNICA ruta de la vista de Tracking (§8.4).
//
// Guarda los identificadores de medición por cuenta. owner-only en ambos
// verbos. El token de la CAPI se guarda ENCRIPTADO y NUNCA sale del
// servidor: el GET solo expone `has_meta_access_token: boolean` — ni
// enmascarado con longitud real (§8.9-3: filtraría el tamaño del secreto).
//
// POST PARCIAL: solo se tocan los campos presentes en el body (§8.8-7).
// Guardar el site ID de Hotjar no puede vaciar el token de Meta.
//
// Esto NO es un interruptor (§8.0): guardar aquí no activa nada. El envío
// real del CRM lee META_CAPI_* / GOOGLE_ADS_* del entorno hasta la fase T2;
// el píxel/GTM/GA4/Hotjar viven en el sitio Astro.
// ============================================================

export const runtime = 'nodejs'

function capiEnvPresent(): boolean {
  return Boolean(process.env.META_CAPI_DATASET_ID && process.env.META_CAPI_ACCESS_TOKEN)
}

function googleAdsEnvPresent(): boolean {
  return Boolean(
    process.env.GOOGLE_ADS_CUSTOMER_ID &&
      process.env.GOOGLE_ADS_CONVERSION_ACTION_ID &&
      process.env.GOOGLE_ADS_OAUTH_TOKEN
  )
}

export async function GET() {
  try {
    const ctx = await requireRole('owner')

    const { data: row, error } = await ctx.supabase
      .from('tracking_config')
      .select(
        'meta_pixel_id, meta_dataset_id, meta_access_token_encrypted, meta_test_event_code, ' +
          'gtm_container_id, ga4_measurement_id, google_ads_conversion_id, ' +
          'google_ads_conversion_label, hotjar_site_id, updated_at'
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'could not load tracking config' }, { status: 500 })
    }

    if (!row) {
      return NextResponse.json({
        configured: false,
        meta_pixel_id: null,
        meta_dataset_id: null,
        has_meta_access_token: false,
        meta_test_event_code: null,
        gtm_container_id: null,
        ga4_measurement_id: null,
        google_ads_conversion_id: null,
        google_ads_conversion_label: null,
        hotjar_site_id: null,
        capi_env_present: capiEnvPresent(),
        google_ads_env_present: googleAdsEnvPresent(),
      })
    }

    const data = row as unknown as {
      meta_pixel_id: string | null
      meta_dataset_id: string | null
      meta_access_token_encrypted: string | null
      meta_test_event_code: string | null
      gtm_container_id: string | null
      ga4_measurement_id: string | null
      google_ads_conversion_id: string | null
      google_ads_conversion_label: string | null
      hotjar_site_id: string | null
      updated_at: string
    }

    return NextResponse.json({
      configured: true,
      meta_pixel_id: data.meta_pixel_id,
      meta_dataset_id: data.meta_dataset_id,
      // El token NUNCA sale del servidor — ni enmascarado.
      has_meta_access_token: Boolean(data.meta_access_token_encrypted),
      meta_test_event_code: data.meta_test_event_code,
      gtm_container_id: data.gtm_container_id,
      ga4_measurement_id: data.ga4_measurement_id,
      google_ads_conversion_id: data.google_ads_conversion_id,
      google_ads_conversion_label: data.google_ads_conversion_label,
      hotjar_site_id: data.hotjar_site_id,
      // Lo que el navegador NO puede averiguar por sí mismo (§8.4).
      capi_env_present: capiEnvPresent(),
      google_ads_env_present: googleAdsEnvPresent(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const TEXT_FIELDS = [
  'meta_pixel_id',
  'meta_dataset_id',
  'meta_test_event_code',
  'gtm_container_id',
  'ga4_measurement_id',
  'google_ads_conversion_id',
  'google_ads_conversion_label',
  'hotjar_site_id',
] as const

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('owner')

    const limit = checkRateLimit(`tracking-config:${ctx.userId}`, RATE_LIMITS.adminAction)
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
      .from('tracking_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    // Solo se tocan los campos PRESENTES en el body (§8.8-7): un POST
    // parcial nunca borra lo no enviado. Sin regex de formato (§8.9-7): los
    // formatos de los proveedores cambian sin avisar; recortar y guardar.
    const payload: Record<string, unknown> = {}
    for (const field of TEXT_FIELDS) {
      if (field in body) payload[field] = str(field) || null
    }
    const hasToken = 'meta_access_token' in body
    if (hasToken) {
      const token = str('meta_access_token')
      // Un POST con el campo del token VACÍO lo vacía explícitamente (decisión
      // del usuario); un POST sin el campo no lo toca.
      payload.meta_access_token_encrypted = token ? encrypt(token) : null
    }

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ error: 'nothing to save' }, { status: 400 })
    }

    const { error } = existing
      ? await ctx.supabase.from('tracking_config').update(payload).eq('account_id', ctx.accountId)
      : await ctx.supabase
          .from('tracking_config')
          .insert({ ...payload, account_id: ctx.accountId })

    if (error) {
      console.error('[tracking:config] save failed:', error.message)
      return NextResponse.json({ error: 'could not save tracking config' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, token_updated: hasToken })
  } catch (err) {
    return toErrorResponse(err)
  }
}
