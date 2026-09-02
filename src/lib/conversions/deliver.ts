// ============================================================
// conversion/deliver.ts — drain de conversiones sobre la cola única
//
// Punto 1 de la consolidación (070): conversion_deliveries se fusionó
// con message_queue. Las conversiones viven en `message_queue` con
// channel='conversion' y el payload lleva `platform` (google_ads /
// meta_capi) + `conversion_event_id` (uuid del tracking_event).
//
// El cron /api/conversions/cron reclama filas de message_queue
// (channel='conversion', status pending/failed → claimed) y las envía
// al adapter de la plataforma correspondiente. El dedup hard lo da el
// índice único parcial idx_message_queue_conversion_dedup
// (payload->>'conversion_event_id', payload->>'platform') → cada
// conversión se envía a cada plataforma UNA vez.
//
// Backoff: tras un fallo, `due_at` se pospone exponencialmente
// (2^attempts minutos, tope 6h). Tras MAX_ATTEMPTS fallos → permanent
// (se abandona, queda auditado en last_error).
//
// Fail-open: si no hay credenciales para una plataforma, sus filas se
// quedan pending sin procesar (el cron no las reclama) — el sistema
// nunca rompe por reporting.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadGoogleAdsCreds, sendOfflineConversion } from '@/lib/analytics/google-ads'
import { loadCapiCreds, dispatchWebsiteConversion } from '@/lib/analytics/meta-capi'
import type { MetaUserDataInput } from '@/lib/analytics/meta-user-data'

// Eventos de conversión del catálogo canónico (los que reportamos a las
// plataformas). Viven aquí, no en track-event-schema: ese enum cubre solo
// los 6 tipos de la API pública anónima; los de conversión los emiten
// RPC/trigger/server con service role.
export type ConversionEventName =
  | 'lead'
  | 'qualified_lead'
  | 'appointment_booked'
  | 'appointment_showed'
  | 'deal_won'
  | 'purchase'

const MAX_ATTEMPTS = 5
const BATCH = 50

export interface DeliveryRow {
  id: string
  account_id: string
  contact_id: string | null
  channel: string
  payload: {
    platform: 'google_ads' | 'meta_capi'
    event_name: ConversionEventName
    event_id: string
    conversion_event_id: string
    contact_id?: string
    value?: number
    currency?: string
    created_at?: string
    attribution?: {
      click_ids?: { gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string }
      fbc?: string
      fbp?: string
    }
  }
  attempts: number
}

/**
 * Claim filas due de conversión: channel='conversion' con status
 * pending|failed y due_at <= now → claimed.
 *
 * SOLO reclama plataformas con credenciales disponibles. Sin este filtro,
 * una plataforma sin credenciales hace que cada fila queme un intento en
 * `markFailed('delivery failed')` y muera en `permanent` a los 5 — el
 * header documentaba "fail-open: las filas se quedan pending", pero el
 * código la convertía en fail-PERMANENT. Ahora las filas sin credenciales
 * quedan pending intactas hasta que se configuren (fail-open real).
 */
async function claimDue(): Promise<DeliveryRow[]> {
  const db = supabaseAdmin()

  const platforms: DeliveryRow['payload']['platform'][] = []
  if (loadGoogleAdsCreds()) platforms.push('google_ads')
  if (loadCapiCreds()) platforms.push('meta_capi')
  if (platforms.length === 0) return [] // sin creds → no se reclama nada

  const { data: rows } = await db
    .from('message_queue')
    .select('*')
    .eq('channel', 'conversion')
    .in('status', ['pending', 'failed'])
    .lte('due_at', new Date().toISOString())
    .order('due_at', { ascending: true })
    .limit(BATCH)

  if (!rows || rows.length === 0) return []

  const claimed: DeliveryRow[] = []
  for (const row of rows) {
    const payload = (row.payload ?? {}) as DeliveryRow['payload']
    if (!payload.platform || !platforms.includes(payload.platform)) continue

    const { data: claim } = await db
      .from('message_queue')
      .update({ status: 'claimed' })
      .eq('id', row.id)
      .in('status', ['pending', 'failed'])
      .select('id')
      .maybeSingle()
    if (claim) claimed.push(row as unknown as DeliveryRow)
  }
  return claimed
}

/** Marca una entrega como enviada. */
async function markSent(id: string): Promise<void> {
  await supabaseAdmin()
    .from('message_queue')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id)
}

/** Marca un fallo con backoff exponencial; abandona tras MAX_ATTEMPTS. */
async function markFailed(id: string, attempts: number, reason: string): Promise<void> {
  const nextAttempts = attempts + 1
  const permanent = nextAttempts >= MAX_ATTEMPTS
  const delayMinutes = permanent ? 0 : Math.min(2 ** nextAttempts, 360)
  await supabaseAdmin()
    .from('message_queue')
    .update({
      status: permanent ? 'permanent' : 'failed',
      attempts: nextAttempts,
      last_error: reason.slice(0, 1000),
      due_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
    })
    .eq('id', id)
}

/**
 * Ubicación derivada de la IP (§3.3): se proyectó a los campos
 * personalizados City/State/Zip/Country al crear el lead y aquí se lee
 * de vuelta para el user_data de Meta (DEF-2).
 *
 * Tenencia (verificada contra el esquema): `contact_custom_values` NO
 * tiene columna account_id — el JOIN con `custom_fields` (que SÍ la
 * tiene, NOT NULL desde 017) es lo que acota por cuenta.
 */
async function loadContactGeo(
  accountId: string,
  contactId: string
): Promise<{ city?: string; state?: string; postal?: string; country?: string }> {
  const { data, error } = await supabaseAdmin()
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', contactId)
    .eq('custom_fields.account_id', accountId)
  if (error || !data) return {}
  const out: { city?: string; state?: string; postal?: string; country?: string } = {}
  // El tipo generado de supabase modela el embed `custom_fields(...)` como
  // array; PostgREST lo devuelve como objeto para una relación N→1. Se
  // aceptan ambas formas en runtime — no se confía en el cast.
  for (const row of data as unknown as {
    value: unknown
    custom_fields: { field_name: string } | { field_name: string }[] | null
  }[]) {
    const cf = row.custom_fields
    const fieldName = Array.isArray(cf) ? cf[0]?.field_name : cf?.field_name
    const value = typeof row.value === 'string' ? row.value.trim() : ''
    if (!fieldName || !value) continue
    if (fieldName === 'City') out.city ??= value
    else if (fieldName === 'State') out.state ??= value
    else if (fieldName === 'Zip') out.postal ??= value
    else if (fieldName === 'Country') out.country ??= value
  }
  return out
}

/**
 * Carga los datos del contacto para el user_data de Meta (DEF-2):
 * email, phone, external_id (= contacts.id), fn/ln (de contacts.name
 * partido por el primer espacio — mismo criterio que contact-text.ts)
 * y la ubicación derivada de la IP. El hashing NO ocurre aquí: el
 * adaptador de Meta lo hace con sus reglas propias.
 */
async function loadContactUserData(
  accountId: string,
  contactId: string | undefined,
): Promise<MetaUserDataInput | undefined> {
  if (!contactId) return undefined
  const { data } = await supabaseAdmin()
    .from('contacts')
    .select('id, name, email, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) return undefined
  const out: MetaUserDataInput = {}
  if (typeof data.email === 'string' && data.email) out.email = data.email
  if (typeof data.phone === 'string' && data.phone) out.phone = data.phone
  if (typeof data.id === 'string' && data.id) out.externalId = data.id
  if (typeof data.name === 'string' && data.name.trim()) {
    const name = data.name.trim()
    const idx = name.indexOf(' ')
    if (idx === -1) {
      out.firstName = name
    } else {
      out.firstName = name.slice(0, idx) || undefined
      out.lastName = name.slice(idx + 1) || undefined
    }
  }
  const geo = await loadContactGeo(accountId, contactId)
  if (geo.city) out.city = geo.city
  if (geo.state) out.state = geo.state
  if (geo.postal) out.zip = geo.postal
  if (geo.country) out.country = geo.country
  return Object.keys(out).length ? out : undefined
}

/**
 * Relee el tracking_event de ORIGEN por `payload.conversion_event_id`
 * (ya viaja en la cola) para recuperar las señales del navegador que no
 * van en el payload de la cola: ip, payload.user_agent y landing_slug
 * (DEF-3). UNA consulta: no se añaden columnas al payload de la cola ni
 * se toca `_conversion_enqueue`.
 */
async function loadOriginEvent(
  conversionEventId: string | undefined
): Promise<{ ip?: string; userAgent?: string; landingSlug?: string } | undefined> {
  if (!conversionEventId) return undefined
  const { data } = await supabaseAdmin()
    .from('tracking_events')
    .select('ip, payload, landing_slug')
    .eq('id', conversionEventId)
    .maybeSingle()
  if (!data) return undefined
  const payload = (data.payload ?? {}) as Record<string, unknown>
  const ua = payload.user_agent
  return {
    ip: typeof data.ip === 'string' && data.ip ? data.ip : undefined,
    userAgent: typeof ua === 'string' && ua ? ua.slice(0, 500) : undefined,
    landingSlug:
      typeof data.landing_slug === 'string' && data.landing_slug
        ? data.landing_slug
        : undefined,
  }
}

/**
 * Compone la URL del landing para event_source_url de Meta. La base es
 * LANDING_SITE_URL (el dominio del sitio, sin barra final); sin ella no
 * hay URL válida que enviar — se omite en vez de mandar una malformada.
 */
function buildEventSourceUrl(landingSlug: string | undefined): string | undefined {
  const base = process.env.LANDING_SITE_URL?.replace(/\/+$/, '')
  if (!base || !landingSlug) return undefined
  return `${base}/${landingSlug.replace(/^\/+/, '')}`
}

/**
 * `fbc` real si existe; si no, derivado de fbclid. undefined si no hay
 * ninguno (DEF-6: sin píxel, la cookie _fbc no existe y la única señal
 * Meta que puede viajar es el fbclid de la URL, que el CRM ya persiste).
 *
 * Formato oficial de Meta: fb.<subdomain_index>.<creation_time_ms>.<fbclid>
 * — subdomain_index 1 (cookie en dominio raíz), creation_time en
 * milisegundos tomado del created_at del tracking_event (lo más cercano
 * al momento del clic que conocemos).
 *
 * Un fbc real SIEMPRE gana: el día que se instale el píxel, el valor de
 * la cookie es la verdad y este derivado se aparta solo.
 */
function resolveFbc(
  attr: { fbc?: string; click_ids?: { fbclid?: string } },
  createdAtMs: number,
): string | undefined {
  if (attr.fbc) return attr.fbc
  const id = attr.click_ids?.fbclid
  return id ? `fb.1.${createdAtMs}.${id}` : undefined
}

/** Entrega una fila a la plataforma que corresponde. */
async function deliverRow(row: DeliveryRow): Promise<boolean> {
  const payload = row.payload
  const attr = payload.attribution
  const clickIds = attr?.click_ids

  // El event_id determinístico es el dedup: Google lo usa como
  // transactionId y Meta como event_id (navegador + servidor).
  const eventTime = payload.created_at ? Date.parse(payload.created_at) : Date.now()

  if (payload.platform === 'google_ads') {
    const creds = loadGoogleAdsCreds()
    // La fila solo se reclama si hay credenciales (claimDue filtra por
    // plataforma), así que este guard es defensivo — nunca quema intentos.
    if (!creds) return true // no-op: sin credenciales no se marca fallo
    const contact = await loadContactUserData(row.account_id, payload.contact_id as string)
    // Google solo consume email/phone (su normalización es distinta: E.164
    // con '+' y hashes en mayúsculas — user-hash.ts). Se le pasa SOLO eso,
    // aunque el shape del contacto sea el completo de Meta.
    const googleUserData =
      contact?.email || contact?.phone
        ? { email: contact?.email, phone: contact?.phone }
        : undefined
    const res = await sendOfflineConversion(
      {
        event_name: mapEventName(payload.event_name),
        event_id: payload.event_id,
        event_time: eventTime,
        value: payload.value,
        currency: payload.currency,
        click_ids: { gclid: clickIds?.gclid, gbraid: clickIds?.gbraid, wbraid: clickIds?.wbraid },
        user_data: googleUserData,
      },
      creds,
    )
    return res.ok
  }

  // meta_capi
  const creds = loadCapiCreds()
  if (!creds) return true // no-op defensivo (claimDue ya filtró por plataforma)
  const contact = await loadContactUserData(row.account_id, payload.contact_id as string)
  const origin = await loadOriginEvent(payload.conversion_event_id)
  const res = await dispatchWebsiteConversion(
    {
      event_name: mapMetaEventName(payload.event_name),
      event_id: payload.event_id,
      event_time: eventTime,
      value: payload.value,
      currency: payload.currency,
      fbc: resolveFbc(attr ?? {}, eventTime),
      fbp: attr?.fbp,
      event_source_url: buildEventSourceUrl(origin?.landingSlug),
      user_data: {
        ...contact,
        clientIpAddress: origin?.ip,
        clientUserAgent: origin?.userAgent,
      },
    },
    creds,
  )
  return res.ok
}

/** Mapea nuestro event_type → nombre de evento Google (purchase para deal_won). */
function mapEventName(name: ConversionEventName): ConversionEventName {
  // deal_won == purchase en WACRM: un trato ganado ES la compra.
  if (name === 'deal_won') return 'deal_won'
  return name
}

/** Mapea nuestro event_type → nombre de evento Meta (PascalCase). */
function mapMetaEventName(name: ConversionEventName): 'Lead' | 'QualifiedLead' | 'AppointmentBooked' | 'AppointmentShowed' | 'Purchase' {
  switch (name) {
    case 'lead':
      return 'Lead'
    case 'qualified_lead':
      return 'QualifiedLead'
    case 'appointment_booked':
      return 'AppointmentBooked'
    case 'appointment_showed':
      return 'AppointmentShowed'
    case 'deal_won':
      return 'Purchase' // deal_won == purchase
    case 'purchase':
      return 'Purchase'
  }
}

/** Drain principal del cron. Devuelve cuántas entregas se procesaron. */
export async function drainDeliveries(): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = await claimDue()
  let sent = 0
  let failed = 0
  for (const row of rows) {
    const ok = await deliverRow(row)
    if (ok) {
      await markSent(row.id)
      sent++
    } else {
      await markFailed(row.id, row.attempts, 'delivery failed (see adapter)')
      failed++
    }
  }
  return { processed: rows.length, sent, failed }
}