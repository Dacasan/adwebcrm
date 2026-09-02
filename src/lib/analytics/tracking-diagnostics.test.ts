import { describe, expect, it } from 'vitest'
import {
  computeTrackingDiagnostics,
  type ConversionQueueRow,
  type TrackingEventRow,
} from './tracking-diagnostics'

const NOW = Date.parse('2026-09-01T12:00:00Z')

function lead(over: Partial<TrackingEventRow> = {}): TrackingEventRow {
  return {
    event_type: 'lead',
    created_at: '2026-09-01T10:00:00Z',
    attribution: {},
    ip: '1.2.3.4',
    ...over,
  }
}

function queue(over: Partial<ConversionQueueRow> = {}): ConversionQueueRow {
  return {
    status: 'sent',
    payload: { platform: 'meta_capi' },
    last_error: null,
    due_at: '2026-09-01T11:00:00Z',
    ...over,
  }
}

const EMPTY_FLAGS = {
  capi_env_present: true,
  google_ads_env_present: true,
  saved: {
    meta_dataset_id: 'ds',
    meta_access_token_saved: true,
    gtm_container_id: 'GTM-1',
    ga4_measurement_id: null,
    google_ads_conversion_id: 'AW-1',
    google_ads_conversion_label: 'label',
    hotjar_site_id: 'hj',
  },
}

function codes(ds: ReturnType<typeof computeTrackingDiagnostics>): string[] {
  return ds.map((d) => d.code)
}

describe('computeTrackingDiagnostics — los 8 diagnósticos (§8.5)', () => {
  it('meta_no_signal: leads sin fbclid/fbc/fbp → error con recuento', () => {
    const ds = computeTrackingDiagnostics(
      [lead(), lead({ attribution: { click_ids: { fbclid: 'AbC' } } })],
      [],
      EMPTY_FLAGS,
      NOW
    )
    const d = ds.find((x) => x.code === 'meta_no_signal')
    expect(d).toBeDefined()
    expect(d?.level).toBe('error')
    expect(d?.detail).toMatchObject({ total: 2, affected: 1 })
  })

  it('meta_weak_match: con fbclid pero sin fbc/fbp → warn', () => {
    const ds = computeTrackingDiagnostics(
      [lead({ attribution: { click_ids: { fbclid: 'AbC' } } })],
      [],
      EMPTY_FLAGS,
      NOW
    )
    const d = ds.find((x) => x.code === 'meta_weak_match')
    expect(d?.level).toBe('warn')
    expect(d?.detail).toMatchObject({ affected: 1 })
  })

  it('delivery_permanent: abandonaadas por plataforma con su último error', () => {
    const ds = computeTrackingDiagnostics(
      [],
      [
        queue({ status: 'permanent', last_error: 'HTTP 403' }),
        queue({ status: 'permanent', payload: { platform: 'google_ads' } }),
        queue({ status: 'sent' }),
      ],
      EMPTY_FLAGS,
      NOW
    )
    const d = ds.find((x) => x.code === 'delivery_permanent')
    expect(d?.level).toBe('error')
    expect(d?.detail).toMatchObject({
      total: 2,
      by_platform: { meta_capi: 1, google_ads: 1 },
    })
  })

  it('delivery_stuck: pending con due_at vencido hace > 1h → el cron no corre', () => {
    const stuck = queue({
      status: 'pending',
      due_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    })
    const fresh = queue({
      status: 'pending',
      due_at: new Date(NOW - 10 * 60 * 1000).toISOString(), // 10 min: NO stuck
    })
    const ds = computeTrackingDiagnostics([], [stuck, fresh], EMPTY_FLAGS, NOW)
    const d = ds.find((x) => x.code === 'delivery_stuck')
    expect(d?.level).toBe('error')
    expect(d?.detail).toMatchObject({ total: 1 })
  })

  it('events_without_ip: eventos de conversión sin ip → warn', () => {
    const ds = computeTrackingDiagnostics(
      [lead({ ip: null }), lead(), lead({ event_type: 'page_view', ip: null })],
      [],
      EMPTY_FLAGS,
      NOW
    )
    const d = ds.find((x) => x.code === 'events_without_ip')
    // page_view no es evento de conversión — no cuenta
    expect(d?.detail).toMatchObject({ total: 2, affected: 1 })
  })

  it('config_incomplete: faltan campos de una plataforma', () => {
    const ds = computeTrackingDiagnostics([], [], {
      ...EMPTY_FLAGS,
      saved: { ...EMPTY_FLAGS.saved, meta_access_token_saved: false },
    }, NOW)
    const d = ds.find((x) => x.code === 'config_incomplete')
    expect(d?.level).toBe('warn')
    expect(d?.detail).toMatchObject({ missing: { meta: ['meta_access_token'] } })
  })

  it('§8.9-5 — tabla llena + entorno VACÍO ⇒ capi_env_only en warn, no en ok', () => {
    const ds = computeTrackingDiagnostics([], [], {
      ...EMPTY_FLAGS,
      capi_env_present: false,
      google_ads_env_present: false,
    }, NOW)
    const d = ds.find((x) => x.code === 'capi_env_only')
    expect(d?.level).toBe('warn')
    expect(d?.detail).toMatchObject({ saved_in_table: true, env_present: false })
  })

  it('sample_truncated: la muestra alcanzó el limit → warn', () => {
    const ds = computeTrackingDiagnostics([], [], EMPTY_FLAGS, NOW, true)
    expect(codes(ds)).toContain('sample_truncated')
  })

  it('todo en verde → sin diagnósticos', () => {
    const ds = computeTrackingDiagnostics(
      [lead({ attribution: { fbc: 'fb.1.1.x' } })],
      [queue()],
      EMPTY_FLAGS,
      NOW
    )
    expect(ds).toEqual([])
  })
})
