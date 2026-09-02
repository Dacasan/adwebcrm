import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Test de la rama form_submit de /api/events (Fase 2 del MVP):
//   · DEF-3 — el tracking_event del lead persiste ip (columna) y
//     payload.user_agent (del SERVIDOR, no del cliente).
//   · Guardrail 9 — un fallo de geo NO impide crear el lead: el
//     try/catch de la proyección es la frontera fail-open.
//   · §3.3.3 — la geo viaja a los campos personalizados
//     City/State/Zip/Country vía projectGeoToCustomFields.
// ============================================================

const h = vi.hoisted(() => ({
  ops: [] as { table: string; type: string; payload: unknown }[],
}))

vi.mock('@/lib/automations/admin-client', () => {
  // Builder genérico de la query de supabase. La operación primaria
  // (insert/upsert/update) se fija una vez y los select() posteriores
  // NO la resetean (es el postInsertSelect de la cadena real). Para
  // inserts de custom_fields devuelve ids sintéticos derivados del
  // field_name (ensureGeoFields los necesita para proyectar).
  function builder(table: string) {
    const ctx: { op?: 'insert' | 'upsert' | 'update'; payload: unknown } = {
      payload: undefined,
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => {
        ctx.op = 'insert'
        ctx.payload = p
        return b
      },
      upsert: (p: unknown) => {
        ctx.op = 'upsert'
        ctx.payload = p
        return b
      },
      update: (p: unknown) => {
        ctx.op = 'update'
        ctx.payload = p
        return b
      },
      eq: () => b,
      neq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(res()),
      single: () => Promise.resolve(res()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(res()).then(onF, onR),
    }
    function res() {
      h.ops.push({ table, type: ctx.op ?? 'select', payload: ctx.payload })
      if (
        (ctx.op === 'insert' || ctx.op === 'upsert') &&
        Array.isArray(ctx.payload) &&
        table === 'custom_fields'
      ) {
        return Promise.resolve({
          data: (ctx.payload as Record<string, unknown>[]).map((r) => ({
            id: `cf-${r.field_name}`,
            field_name: r.field_name,
          })),
          error: null,
        })
      }
      return Promise.resolve({ data: [], error: null })
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }
})

vi.mock('@/lib/analytics/landing-account', () => ({
  resolveLandingAccountId: vi.fn(async () => 'acct-1'),
}))

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c-1' })),
  resolveAuditUserId: vi.fn(async () => 'u-1'),
}))

vi.mock('@/lib/cors', () => ({
  withCors: (r: Response) => r,
  handlePreflight: () => new Response(null, { status: 204 }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, resetMs: 1000 }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { trackingPublic: {}, trackingFormSubmit: {} },
}))

vi.mock('@/lib/analytics/ip-geo', () => ({
  geoFromPlatformHeaders: () => ({}),
  lookupIpGeo: vi.fn(async () => ({})),
}))

import { POST } from './route'
import { lookupIpGeo } from '@/lib/analytics/ip-geo'

function makeFormSubmitReq(): Request {
  return new Request('http://localhost/api/events', {
    method: 'POST',
    headers: { 'user-agent': 'UA-Test', 'x-forwarded-for': '8.8.8.8' },
    body: JSON.stringify({
      event_id: 'evt-abc123',
      event_type: 'form_submit',
      payload: { phone: '+5299812345678', name: 'Juan', email: 'x@y.com' },
    }),
  })
}

beforeEach(() => {
  h.ops = []
  vi.mocked(lookupIpGeo).mockReset()
  vi.mocked(lookupIpGeo).mockImplementation(async () => ({}))
})

describe('POST /api/events form_submit — geo + señales del servidor', () => {
  it('un fallo de geo NO impide crear el lead (fail-open, guardrail 9)', async () => {
    vi.mocked(lookupIpGeo).mockRejectedValueOnce(new Error('geo down'))
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    // el tracking_event del lead SÍ se intentó insertar
    expect(
      h.ops.some((o) => o.table === 'tracking_events' && o.type === 'upsert')
    ).toBe(true)
  })

  it('DEF-3: persiste ip (columna) y payload.user_agent del SERVIDOR', async () => {
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    const lead = h.ops.find(
      (o) => o.table === 'tracking_events' && o.type === 'upsert'
    )?.payload as { ip?: string; payload?: Record<string, unknown>; event_id?: string }
    expect(lead.ip).toBe('8.8.8.8')
    expect(lead.payload?.user_agent).toBe('UA-Test')
    expect(lead.event_id).toBe('lead_evt-abc123')
  })

  it('IP "unknown" → columna ip null (no ruido en la tabla)', async () => {
    const req = new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'user-agent': 'UA-Test' }, // sin x-forwarded-for ni x-real-ip
      body: JSON.stringify({
        event_id: 'evt-abc124',
        event_type: 'form_submit',
        payload: { phone: '+5299812345678' },
      }),
    })
    await POST(req as never)
    const lead = h.ops.find(
      (o) => o.table === 'tracking_events' && o.type === 'upsert'
    )?.payload as { ip?: string | null }
    expect(lead.ip).toBeNull()
  })

  it('geo con contenido → se proyecta a City/Country en contact_custom_values', async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({ city: 'Cancún', country: 'mx' })
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    const projection = h.ops.find(
      (o) => o.table === 'contact_custom_values' && o.type === 'upsert'
    )?.payload as { contact_id: string; custom_field_id: string; value: string }[]
    expect(projection).toBeTruthy()
    expect(projection).toContainEqual({
      contact_id: 'c-1',
      custom_field_id: 'cf-City',
      value: 'Cancún',
    })
    expect(projection).toContainEqual({
      contact_id: 'c-1',
      custom_field_id: 'cf-Country',
      value: 'mx',
    })
    // las filas NO llevan account_id: contact_custom_values no tiene esa
    // columna (corrección de auditoría — la tenencia es por contacto)
    for (const row of projection) {
      expect(row).not.toHaveProperty('account_id')
    }
  })
})
