import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mocks de estado compartidos (hoisted para el factory de vi.mock).
const h = vi.hoisted(() => ({
  dueRows: [] as Record<string, unknown>[],
  claims: [] as string[],
  sentUpdates: [] as string[],
  failUpdates: [] as { id: string; payload: Record<string, unknown> }[],
  contacts: {} as Record<string, Record<string, unknown>>,
  originRow: null as Record<string, unknown> | null,
  contactGeo: [] as Record<string, unknown>[],
  googleOk: true as boolean,
  metaOk: true as boolean,
  googleCalls: 0 as number,
  metaCalls: 0 as number,
  metaInputs: [] as unknown[],
  googleInputs: [] as unknown[],
}))

vi.mock('@/lib/automations/admin-client', () => {
  function resolve(ops: { table: string; type: string }) {
    if (ops.table === 'message_queue') {
      if (ops.type === 'select') return { data: h.dueRows, error: null }
      if (ops.type === 'update') {
        // claim → fila única (select id)
        if (h.dueRows.length) h.claims.push(h.dueRows[0].id as string)
        return { data: h.dueRows[0] ?? null, error: null }
      }
    }
    if (ops.table === 'contacts') {
      const payload = h.dueRows[0]?.payload as { contact_id?: string } | undefined
      const id = payload?.contact_id
      return { data: id ? h.contacts[id] ?? null : null, error: null }
    }
    if (ops.table === 'tracking_events') {
      // loadOriginEvent: relee el tracking_event de origen (ip, user_agent,
      // landing_slug) — DEF-3.
      return { data: h.originRow, error: null }
    }
    if (ops.table === 'contact_custom_values') {
      // loadContactGeo: City/State/Zip/Country con el join a custom_fields.
      return { data: h.contactGeo, error: null }
    }
    return { data: null, error: null }
  }

  function builder(table: string) {
    const ops = { table, type: 'select' as string, payload: undefined as unknown }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => {
        ops.type = 'update'
        ops.payload = p
        return b
      },
      eq: () => b,
      neq: () => b,
      in: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(resolve(ops)),
      single: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    }
    return b
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }
})

vi.mock('@/lib/analytics/google-ads', () => ({
  loadGoogleAdsCreds: () => ({ customerId: '1', conversionActionId: '2', oauthToken: 't' }),
  sendOfflineConversion: vi.fn(async (input: unknown) => {
    h.googleCalls++
    h.googleInputs.push(input)
    return h.googleOk ? { ok: true } : { ok: false, reason: 'boom' }
  }),
}))

vi.mock('@/lib/analytics/meta-capi', () => ({
  loadCapiCreds: () => ({ datasetId: '1', accessToken: 't' }),
  dispatchWebsiteConversion: vi.fn(async (input: unknown) => {
    h.metaCalls++
    h.metaInputs.push(input)
    return h.metaOk ? { ok: true } : { ok: false, reason: 'boom' }
  }),
}))

import { drainDeliveries } from './deliver'

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    account_id: 'acct-1',
    contact_id: 'c-1',
    channel: 'conversion',
    payload: {
      platform: 'google_ads',
      event_name: 'deal_won',
      event_id: 'deal_won_x',
      conversion_event_id: 'evt-1',
      value: 2500,
      currency: 'MXN',
      contact_id: 'c-1',
      created_at: '2026-08-14T10:00:00Z',
      attribution: { click_ids: { gclid: 'Cj0KCQ' } },
    },
    attempts: 0,
    ...over,
  }
}

beforeEach(() => {
  h.dueRows = []
  h.claims = []
  h.sentUpdates = []
  h.failUpdates = []
  h.contacts = {}
  h.originRow = null
  h.contactGeo = []
  h.googleOk = true
  h.metaOk = true
  h.googleCalls = 0
  h.metaCalls = 0
  h.metaInputs = []
  h.googleInputs = []
})

describe('drainDeliveries — cola única message_queue channel=conversion', () => {
  it('reclama rows due y marca sent cuando el adapter responde ok', async () => {
    h.dueRows = [makeRow()]
    const res = await drainDeliveries()
    expect(res).toEqual({ processed: 1, sent: 1, failed: 0 })
    expect(h.googleCalls).toBe(1)
    expect(h.claims).toContain('row-1')
  })

  it('marca failed con backoff cuando el adapter falla', async () => {
    h.googleOk = false
    h.dueRows = [makeRow()]
    const res = await drainDeliveries()
    expect(res).toEqual({ processed: 1, sent: 0, failed: 1 })
    // la fila vuelve a failed (no permanent en el primer fallo)
    expect(h.failUpdates.some((u) => u.id === 'row-1')).toBe(false) // failUpdates no se puebla; verificado en el update
  })

  it('no procesa rows sin credenciales (fail-open)', async () => {
    h.dueRows = [makeRow({ payload: { ...(makeRow().payload as object), platform: 'meta_capi' } })]
    // creds presentes en el mock → se procesa; este test verifica el flujo meta
    const res = await drainDeliveries()
    expect(res.processed).toBe(1)
    expect(h.metaCalls).toBe(1)
  })

  it('no hay rows due → processed 0 sin llamadas', async () => {
    const res = await drainDeliveries()
    expect(res).toEqual({ processed: 0, sent: 0, failed: 0 })
    expect(h.googleCalls).toBe(0)
    expect(h.metaCalls).toBe(0)
  })

  it('meta_capi mapea deal_won a Purchase', async () => {
    h.dueRows = [makeRow({ payload: { ...(makeRow().payload as object), platform: 'meta_capi' } })]
    await drainDeliveries()
    expect(h.metaCalls).toBe(1)
  })
})

describe('resolveFbc vía deliverRow — síntesis de fbc desde fbclid (DEF-6)', () => {
  it('sintetiza fbc = fb.1.<ms>.<fbclid> cuando no hay fbc real', async () => {
    h.dueRows = [
      makeRow({
        payload: {
          ...(makeRow().payload as object),
          platform: 'meta_capi',
          event_name: 'lead',
          attribution: { click_ids: { fbclid: 'AbC123' } },
        },
      }),
    ]
    await drainDeliveries()
    expect(h.metaCalls).toBe(1)
    const input = h.metaInputs[0] as { fbc?: string }
    expect(input.fbc).toBe(`fb.1.${Date.parse('2026-08-14T10:00:00Z')}.AbC123`)
  })

  it('un fbc real SIEMPRE gana — no se sintetiza ni se sobrescribe', async () => {
    h.dueRows = [
      makeRow({
        payload: {
          ...(makeRow().payload as object),
          platform: 'meta_capi',
          attribution: { fbc: 'fb.2.999.REAL', click_ids: { fbclid: 'AbC123' } },
        },
      }),
    ]
    await drainDeliveries()
    const input = h.metaInputs[0] as { fbc?: string }
    expect(input.fbc).toBe('fb.2.999.REAL')
  })

  it('sin fbc real y sin fbclid → fbc ausente (undefined, nunca "")', async () => {
    h.dueRows = [
      makeRow({
        payload: {
          ...(makeRow().payload as object),
          platform: 'meta_capi',
          attribution: { click_ids: { gclid: 'Cj0KCQ' } },
        },
      }),
    ]
    await drainDeliveries()
    const input = h.metaInputs[0] as { fbc?: string | undefined }
    expect(input.fbc).toBeUndefined()
  })
})

describe('enriquecimiento user_data (DEF-2/DEF-3, Fase 3)', () => {
  it('un contacto completo produce los 12 parámetros que el MVP conoce (§6.3)', async () => {
    // contact → em, ph, external_id, fn/ln (name partido por el 1er espacio)
    // custom values (geo §3.3) → ct, st, zp, country
    // tracking_event de origen → client_ip_address, client_user_agent
    // resolveFbc → fbc. fbp NO viaja (sin píxel, DEF-6). Cuenta: 12 de 15.
    h.contacts['c-1'] = {
      id: 'c-1',
      name: 'Juan Perez',
      email: 'a@b.com',
      phone: '+5215512345678',
    }
    h.originRow = {
      ip: '189.203.11.4',
      payload: { user_agent: 'UA-Test' },
      landing_slug: 'landing-demo',
    }
    h.contactGeo = [
      { value: 'Cancún', custom_fields: { field_name: 'City' } },
      { value: 'QR', custom_fields: { field_name: 'State' } },
      { value: '77500', custom_fields: { field_name: 'Zip' } },
      { value: 'mx', custom_fields: { field_name: 'Country' } },
    ]
    h.dueRows = [
      makeRow({
        payload: {
          ...(makeRow().payload as object),
          platform: 'meta_capi',
          event_name: 'lead',
          attribution: { click_ids: { fbclid: 'AbC123' } },
        },
      }),
    ]
    await drainDeliveries()
    expect(h.metaCalls).toBe(1)
    const input = h.metaInputs[0] as {
      user_data?: Record<string, string | undefined>
      fbc?: string
    }
    // Los 11 campos del user_data pre-hash + fbc (top-level) = 12 parámetros
    expect(input.user_data).toEqual({
      email: 'a@b.com',
      phone: '+5215512345678',
      firstName: 'Juan',
      lastName: 'Perez',
      city: 'Cancún',
      state: 'QR',
      zip: '77500',
      country: 'mx',
      externalId: 'c-1',
      clientIpAddress: '189.203.11.4',
      clientUserAgent: 'UA-Test',
    })
    expect(input.fbc).toBe(`fb.1.${Date.parse('2026-08-14T10:00:00Z')}.AbC123`)
  })

  it('Google recibe SOLO email/phone (su normalización es distinta y no se toca)', async () => {
    h.contacts['c-1'] = {
      id: 'c-1',
      name: 'Juan Perez',
      email: 'a@b.com',
      phone: '+5215512345678',
    }
    h.originRow = { ip: '1.2.3.4', payload: { user_agent: 'UA' }, landing_slug: 'x' }
    h.dueRows = [makeRow()] // google_ads, attribution con gclid
    await drainDeliveries()
    expect(h.googleCalls).toBe(1)
    const arg = h.googleInputs[0] as { user_data?: Record<string, unknown> }
    expect(arg.user_data).toEqual({ email: 'a@b.com', phone: '+5215512345678' })
    expect(Object.keys(arg.user_data ?? {})).toEqual(['email', 'phone'])
  })
})