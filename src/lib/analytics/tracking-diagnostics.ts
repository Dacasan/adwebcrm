// ============================================================
// tracking-diagnostics.ts — los 8 diagnósticos de la vista de Tracking
// (PLAN-META-CAPI-MVP §8.5), calculados a partir de datos reales.
//
// PURO: sin BD, sin red, sin React. El componente (settings-tracking.tsx)
// alimenta esta función con las dos consultas del navegador + las banderas
// del GET de config, y pinta el resultado.
//
// Reglas (§8.4-8.5):
//  · Cada diagnóstico se CALCULA; ninguno es texto fijo.
//  · `detail` lleva NÚMEROS, no frases — el texto lo compone la UI con
//    next-intl a partir del `code`.
//  · La cola es UNA: dentro de message_queue conviven WhatsApp, SMS, email
//    y conversiones. El caller DEBE filtrar channel='conversion' antes de
//    llamar aquí (los tests lo demuestran).
// ============================================================

export type DiagnosticLevel = 'ok' | 'warn' | 'error'

export interface Diagnostic {
  level: DiagnosticLevel
  code: string
  detail: Record<string, unknown>
}

/** Fila mínima de tracking_events que la vista necesita. */
export interface TrackingEventRow {
  event_type: string
  created_at: string
  attribution: {
    fbc?: string
    fbp?: string
    click_ids?: { fbclid?: string } | null
  } | null
  ip: string | null
}

/** Fila mínima de message_queue (channel='conversion' ya filtrado). */
export interface ConversionQueueRow {
  status: string
  payload: { platform?: string } | null
  last_error: string | null
  due_at: string
}

/** Banderas que solo el servidor puede saber (GET /api/tracking/config). */
export interface TrackingFlags {
  capi_env_present: boolean
  google_ads_env_present: boolean
  /** Valores guardados en tracking_config (los leídos por el GET). */
  saved: {
    meta_dataset_id: string | null
    meta_access_token_saved: boolean
    gtm_container_id: string | null
    ga4_measurement_id: string | null
    google_ads_conversion_id: string | null
    google_ads_conversion_label: string | null
    hotjar_site_id: string | null
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * Computa los 8 diagnósticos. `nowMs` se inyecta para que los tests no
 * dependan del reloj.
 */
export function computeTrackingDiagnostics(
  events: TrackingEventRow[],
  queue: ConversionQueueRow[],
  flags: TrackingFlags,
  nowMs: number = Date.now(),
  sampleTruncated: boolean = false,
): Diagnostic[] {
  const out: Diagnostic[] = []
  const leads = events.filter((e) => e.event_type === 'lead')

  // 1) meta_no_signal — leads SIN señal Meta: el trigger NO los encola,
  //    nunca llegan a Meta. El agujero más grande.
  const noSignal = leads.filter((e) => {
    const a = e.attribution ?? {}
    return !a.fbc && !a.fbp && !a.click_ids?.fbclid
  })
  if (leads.length > 0 && noSignal.length > 0) {
    out.push({
      level: 'error',
      code: 'meta_no_signal',
      detail: {
        total: leads.length,
        affected: noSignal.length,
        pct: Math.round((noSignal.length / leads.length) * 100),
      },
    })
  }

  // 2) meta_weak_match — leads CON fbclid pero SIN fbc/fbp: llegan a Meta
  //    pero con emparejamiento débil (síntoma de no tener píxel).
  const weakMatch = leads.filter((e) => {
    const a = e.attribution ?? {}
    return a.click_ids?.fbclid && !a.fbc && !a.fbp
  })
  if (weakMatch.length > 0) {
    out.push({
      level: 'warn',
      code: 'meta_weak_match',
      detail: { total: leads.length, affected: weakMatch.length },
    })
  }

  // 3) delivery_permanent — entregas abandonadas tras 5 intentos,
  //    agrupadas por plataforma con su último error.
  const permanent = queue.filter((q) => q.status === 'permanent')
  if (permanent.length > 0) {
    const byPlatform: Record<string, number> = {}
    const errors: string[] = []
    for (const row of permanent) {
      const platform = row.payload?.platform ?? 'unknown'
      byPlatform[platform] = (byPlatform[platform] ?? 0) + 1
      if (row.last_error && !errors.includes(row.last_error)) {
        errors.push(row.last_error.slice(0, 200))
      }
    }
    out.push({
      level: 'error',
      code: 'delivery_permanent',
      detail: { total: permanent.length, by_platform: byPlatform, last_errors: errors.slice(0, 5) },
    })
  }

  // 4) delivery_stuck — filas pending con due_at vencido hace > 1 h:
  //    el cron NO está corriendo. Fallo mudo que sin esto no se ve.
  const stuck = queue.filter(
    (q) =>
      q.status === 'pending' &&
      Date.parse(q.due_at) < nowMs - ONE_HOUR_MS
  )
  if (stuck.length > 0) {
    out.push({
      level: 'error',
      code: 'delivery_stuck',
      detail: { total: stuck.length },
    })
  }

  // 5) events_without_ip — eventos de conversión sin ip: sin
  //    client_ip_address ni geolocalización (DEF-3).
  const convEvents = events.filter((e) =>
    ['lead', 'qualified_lead', 'appointment_booked', 'appointment_showed', 'deal_won', 'purchase'].includes(
      e.event_type
    )
  )
  const withoutIp = convEvents.filter((e) => !e.ip)
  if (convEvents.length > 0 && withoutIp.length > 0) {
    out.push({
      level: 'warn',
      code: 'events_without_ip',
      detail: { total: convEvents.length, affected: withoutIp.length },
    })
  }

  // 6) config_incomplete — por plataforma, qué campos faltan (los valores
  //    guardados en tracking_config).
  const missing: Record<string, string[]> = {}
  if (!flags.saved.meta_dataset_id) {
    missing.meta = ['meta_dataset_id']
  }
  if (!flags.saved.meta_access_token_saved) {
    ;(missing.meta ??= []).push('meta_access_token')
  }
  if (flags.saved.gtm_container_id === null && flags.saved.ga4_measurement_id === null) {
    missing.analytics = ['gtm_container_id | ga4_measurement_id']
  }
  if (
    (flags.saved.google_ads_conversion_id === null) !==
    (flags.saved.google_ads_conversion_label === null)
  ) {
    missing.google_ads = ['id+label deben ir juntos']
  }
  if (flags.saved.hotjar_site_id === null) {
    missing.hotjar = ['hotjar_site_id']
  }
  if (Object.keys(missing).length > 0) {
    out.push({
      level: 'warn',
      code: 'config_incomplete',
      detail: { missing },
    })
  }

  // 7) capi_env_only — el envío real lee el ENTORNO, no esta tabla (§8.6).
  //    Tabla llena + entorno vacío ⇒ "configurado" y aun así no sale nada
  //    (y al revés: entorno presente + tabla vacía es el modo legítimo hoy).
  const savedAny = Boolean(
    flags.saved.meta_dataset_id || flags.saved.meta_access_token_saved
  )
  if (savedAny && !flags.capi_env_present) {
    out.push({
      level: 'warn',
      code: 'capi_env_only',
      detail: {
        saved_in_table: true,
        env_present: false,
        note: 'env_missing',
      },
    })
  } else if (flags.google_ads_env_present === false && flags.saved.google_ads_conversion_id !== null) {
    // El navegador de Google Ads vive en el sitio; el loop de servidor usa
    // el entorno. Guardar el ID aquí no activa nada.
    out.push({
      level: 'warn',
      code: 'capi_env_only',
      detail: {
        saved_in_table: true,
        env_present: false,
        note: 'google_ads_env_missing',
      },
    })
  }

  // 8) sample_truncated — las consultas alcanzaron el limit: el recuento
  //    de la vista es una MUESTRA, no un total (§8.4: un truncado leído
  //    como total es una mentira).
  if (sampleTruncated) {
    out.push({
      level: 'warn',
      code: 'sample_truncated',
      detail: { limit_reached: true },
    })
  }

  return out
}
