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

vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: vi.fn(async () => ({ added: true, dispatched: true })),
}))

vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: vi.fn(async () => ({
    tagIdByKey: new Map([['ai agent', 'tag-ai-1']]),
    skippedNames: [],
  })),
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

vi.mock('@/lib/email/lead-notify', () => ({
  notifyNewLead: vi.fn(async () => ({ status: 'sent' })),
}))

import { POST } from './route'
import { lookupIpGeo } from '@/lib/analytics/ip-geo'
import { notifyNewLead } from '@/lib/email/lead-notify'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags'

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
  vi.mocked(notifyNewLead).mockClear()
  vi.mocked(notifyNewLead).mockResolvedValue({ status: 'sent' })
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

  it('dispara notifyNewLead con los datos del lead (aviso EMAIL_FORWARD_TO)', async () => {
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    expect(notifyNewLead).toHaveBeenCalledTimes(1)
    expect(notifyNewLead).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({
        name: 'Juan',
        email: 'x@y.com',
        phone: '+5299812345678',
      })
    )
  })

  it('un notify que RECHAZA no impide el 202 (fail-open, doble capa)', async () => {
    vi.mocked(notifyNewLead).mockRejectedValueOnce(new Error('correo caído'))
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    // el lead igual se intentó persistir
    expect(
      h.ops.some((o) => o.table === 'tracking_events' && o.type === 'upsert')
    ).toBe(true)
  })
})

// ============================================================
// Separación de leads de agente (WebMCP). Contrato two-PR:
// lead-form.ts (kit) añade payload.webmcp_agent=true cuando el submit
// trae SubmitEvent.agentInvoked; el server separa con tag vía las
// primitivas del ingest (resolveImportTagIds + addContactTagAndDispatch).
// ============================================================
describe('POST /api/events form_submit — tag de agente (WebMCP)', () => {
  it('un submit con webmcp_agent=true taggea el contacto con AI Agent', async () => {
    const req = new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'user-agent': 'UA-Test', 'x-forwarded-for': '8.8.8.8' },
      body: JSON.stringify({
        event_id: 'evt-agent01',
        event_type: 'form_submit',
        payload: {
          phone: '+5299812345678',
          name: 'Juan',
          email: 'x@y.com',
          webmcp_agent: true,
        },
      }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(202)
    expect(resolveImportTagIds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-1', tagNames: ['AI Agent'] })
    )
    expect(addContactTagAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'c-1',
        tagId: 'tag-ai-1',
      })
    )
  })

  it('un submit HUMANO no taggea (sin flag, ni siquiera se resuelve el tag)', async () => {
    const res = await POST(makeFormSubmitReq() as never)
    expect(res.status).toBe(202)
    expect(addContactTagAndDispatch).not.toHaveBeenCalled()
    expect(resolveImportTagIds).not.toHaveBeenCalled()
  })

  it('un tag que RECHAZA no impide el lead (fail-open: 202 + evento insertado)', async () => {
    vi.mocked(resolveImportTagIds).mockRejectedValueOnce(
      new Error('tags caídas')
    )
    const req = new Request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'user-agent': 'UA-Test', 'x-forwarded-for': '8.8.8.8' },
      body: JSON.stringify({
        event_id: 'evt-tagfail',
        event_type: 'form_submit',
        payload: { phone: '+5299812345678', webmcp_agent: true },
      }),
    })
    const res = await POST(req as never)
    expect(res.status).toBe(202)
    expect(
      h.ops.some(
        (o) => o.table === 'tracking_events' && o.type === 'upsert'
      )
    ).toBe(true)
  })
})
