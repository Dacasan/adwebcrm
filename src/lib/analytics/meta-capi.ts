// ============================================================
// Meta Conversions API — dispatchConversion (Item 16, DAD §8.1/§8.3)
//
// Dos vías:
//
//   CTWA (loop Click-to-WhatsApp): cuando un lead llega por un anuncio
//     CTWA, el webhook captura `referral.ctwa_clid` y se reporta con
//     action_source business_messaging para que Meta optimice.
//
//   WEBSITE (loop de conversiones del core): cada evento de negocio
//     del catálogo canónico (lead, qualified_lead, appointment_booked,
//     appointment_showed, deal_won, purchase) se reporta con
//     action_source website, `event_id` (dedup browser+server, pilar
//     del prompt de conversiones), `user_data` con em/ph hasheados y
//     fbc/fbp para emparejar el navegador, y custom_data con el valor.
//
// Endpoint y body verificados en context7 (developers.facebook.com):
//   POST /<API_VERSION>/<DATASET_ID>/events
//
// Credenciales por env (multi-account: futura tabla analytics_config):
//   META_CAPI_DATASET_ID   — ID del dataset (Pixel) de Meta
//   META_CAPI_ACCESS_TOKEN — token de acceso con permiso de reporting
//   META_CAPI_TEST_EVENT_CODE — opcional: Events Manager "Eventos de prueba"
// Fallback a tracking_config (Settings → Tracking, token cifrado) si no
// hay envs. Sin ninguna de las dos → no-op con log (fail-open: nunca
// rompe el webhook).
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

const GRAPH_VERSION = 'v25.0'
// v21.0→v25.0 (2026-09-28): v25.0 es la versión vigente (release feb 2026).
// El payload del endpoint /<dataset>/events no cambió entre v21 y v25 —
// los deprecates de v22-v25 afectan Instagram Insights/Pages/métricas, no
// CAPI (Graph API changelog, developers.facebook.com). v24 muere 2026-10-06;
// v21 expira ~2027 bajo la regla de 2 años tras el release siguiente.

/** Evento CTWA (Click-to-WhatsApp) — action_source business_messaging. */
export interface ConversionEventInput {
  event_name: 'LeadSubmitted' | 'Purchase'
  event_time: number
  ctwa_clid: string
  currency?: string
  value?: number
}

/** Evento website del loop de conversiones del core. */
export interface WebsiteConversionEventInput {
  event_name:
    | 'Lead'
    | 'QualifiedLead'
    | 'BetterLead'
    | 'AppointmentBooked'
    | 'AppointmentShowed'
    | 'Purchase' // deal_won == purchase
  event_id: string
  event_time: number
  value?: number
  currency?: string
  fbc?: string
  fbp?: string
  user_data?: MetaUserDataInput
  event_source_url?: string
  /** Default 'website'. 'system_generated' para eventos nacidos en el
   *  CRM/backend (deal_won): la vía recomendada tras la retirada de la
   *  Offline Conversions API (mayo 2025). */
  action_source?: 'website' | 'system_generated'
  /**
   * Pestaña "Eventos de prueba" de Events Manager (DEF-4). Va en la RAÍZ
   * del cuerpo, hermano de `data` — nunca dentro del evento.
   */
  test_event_code?: string
}

/** Alias de compatibilidad: hoy el user_data de Meta es el contrato completo. */
export type UserDataToHash = MetaUserDataInput

/** Normaliza email para hashing: minúsculas y sin espacios. */
import { normalizeEmail, normalizePhone } from './user-hash'
export { normalizeEmail, normalizePhone }

// Normalización + hashing de user_data (DEF-1/DEF-2). Vive en su módulo
// PURO meta-user-data.ts a propósito: las reglas de Meta NO son las de
// Google Ads (teléfono sin '+', sin ceros a la izquierda; SHA-256 en hex
// MINÚSCULAS). No se toca user-hash.ts, que es de Google.
import {
  buildUserData,
  sha256Hex,
  type MetaUserData,
  type MetaUserDataInput,
} from './meta-user-data'
export { sha256Hex }

/**
 * Envoltorio delgado sobre buildUserData (meta-user-data.ts) para no
 * romper a quien importe buildMetaUserData. Devuelve undefined si no hay
 * nada que enviar — nunca un objeto vacío.
 */
export async function buildMetaUserData(
  user?: MetaUserDataInput,
): Promise<MetaUserData | undefined> {
  if (!user) return undefined
  const out = await buildUserData(user)
  return Object.keys(out).length ? out : undefined
}

export interface CapiCreds {
  datasetId: string
  accessToken: string
  /** Pestaña "Eventos de prueba" de Events Manager. Si viaja, Meta NO
   *  registra los eventos como reales — QUITARLO tras probar. */
  testEventCode?: string
}

/**
 * Lee las credenciales CAPI: primero del entorno, luego de tracking_config
 * (Settings → Tracking, token guardado cifrado con AES-256-GCM desde la
 * 079). Fase T2 cerrada para CAPI: configurar en la UI YA activa el envío
 * cuando no hay envs — el env manda si existe (misma precedencia que
 * crm-url.ts). Sin ninguna de las dos → null (fail-open).
 *
 * Async porque el fallback lee DB. Los tests con env no la tocan.
 * Account: LANDING_ACCOUNT_ID si está definida; si no, la única fila
 * (despliegue single-tenant de una marca).
 */
export async function loadCapiCreds(): Promise<CapiCreds | null> {
  const envDataset = process.env.META_CAPI_DATASET_ID
  const envToken = process.env.META_CAPI_ACCESS_TOKEN
  if (envDataset && envToken) {
    return {
      datasetId: envDataset,
      accessToken: envToken,
      ...(process.env.META_CAPI_TEST_EVENT_CODE
        ? { testEventCode: process.env.META_CAPI_TEST_EVENT_CODE }
        : {}),
    }
  }
  try {
    const db = supabaseAdmin()
    let query = db
      .from('tracking_config')
      .select('meta_dataset_id, meta_access_token_encrypted, meta_test_event_code')
      .not('meta_access_token_encrypted', 'is', null)
      .limit(1)
    if (process.env.LANDING_ACCOUNT_ID) {
      query = query.eq('account_id', process.env.LANDING_ACCOUNT_ID)
    }
    const { data, error } = await query.maybeSingle()
    if (error || !data?.meta_dataset_id || !data.meta_access_token_encrypted) return null
    return {
      datasetId: data.meta_dataset_id,
      accessToken: decrypt(data.meta_access_token_encrypted),
      ...(data.meta_test_event_code
        ? { testEventCode: data.meta_test_event_code as string }
        : {}),
    }
  } catch {
    return null
  }
}

/**
 * Reporta un evento a la Meta Conversions API (action_source
 * business_messaging, channel whatsapp). Idempotente por construcción:
 * el caller decide el event_name y el clid; Meta dedupica por
 * (event_name, event_time, user_data).
 *
 * Devuelve { ok } o { ok: false, reason } — nunca lanza, para que el
 * webhook de WhatsApp no se caiga por un fallo de reporting.
 */
export async function dispatchConversion(input: ConversionEventInput, creds: CapiCreds): Promise<{ ok: boolean; reason?: string }> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${creds.datasetId}/events`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify({
        data: [
          {
            event_name: input.event_name,
            event_time: input.event_time,
            action_source: 'business_messaging',
            messaging_channel: 'whatsapp',
            user_data: {
              ctwa_clid: input.ctwa_clid,
            },
            ...(input.event_name === 'Purchase' && input.currency && input.value !== undefined
              ? { custom_data: { currency: input.currency, value: input.value } }
              : {}),
            messaging_outcome_data: {
              outcome_type: 'automatic_events',
            },
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'fetch failed' }
  }
}

/**
 * Reporta un evento de negocio del loop de conversiones a la CAPI con
 * action_source website. Idempotente por `event_id` (pilar del prompt:
 * el mismo event_id en navegador y servidor → Meta dedupica).
 *
 * user_data em/ph se hashean (SHA-256 lowercase hex) antes de enviar.
 * fbc/fbp se pasan tal cual si vienen capturados.
 * Devuelve { ok } o { ok: false, reason } — nunca lanza.
 */
export async function dispatchWebsiteConversion(
  input: WebsiteConversionEventInput,
  creds: CapiCreds,
): Promise<{ ok: boolean; reason?: string }> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${creds.datasetId}/events`
  const userData = await buildMetaUserData(input.user_data)
  // Combina user_data (em/ph hasheados) con fbc/fbp en UN solo objeto:
  // varios spreads de la clave user_data se pisarían entre sí.
  const combinedUserData = {
    ...(userData ?? {}),
    ...(input.fbc ? { fbc: input.fbc } : {}),
    ...(input.fbp ? { fbp: input.fbp } : {}),
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify({
        // DEF-4: test_event_code va en la RAÍZ del cuerpo (hermano de
        // data) — dentro del evento Meta lo ignora.
        ...(input.test_event_code
          ? { test_event_code: input.test_event_code }
          : {}),
        data: [
          {
            event_name: input.event_name,
            event_time: Math.floor(input.event_time / 1000),
            event_id: input.event_id,
            action_source: input.action_source ?? 'website',
            ...(Object.keys(combinedUserData).length
              ? { user_data: combinedUserData }
              : {}),
            ...(input.event_source_url
              ? { event_source_url: input.event_source_url }
              : {}),
            ...(input.event_name === 'Purchase' &&
            input.value !== undefined &&
            input.currency
              ? { custom_data: { currency: input.currency, value: input.value } }
              : {}),
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'fetch failed' }
  }
}
