import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET/POST /api/tracking/config — owner-only, LA ÚNICA ruta de la vista de
// Tracking (§8.4). Cubre los adversariales §8.9-3 y §8.9-4:
//   · el token NUNCA sale del servidor (ni enmascarado con longitud real);
//   · un POST parcial no borra lo no enviado (guardar Hotjar no vacía CAPI).

let callerRole = 'owner'
let existingRow: Record<string, unknown> | null = null
const updates: Record<string, unknown>[] = []
const inserts: Record<string, unknown>[] = []

function makeSupabaseMock() {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq']) b[m] = vi.fn(chain)
    b.maybeSingle = vi.fn(async () => ({ data: existingRow, error: null }))
    // update/insert SÍNCRONOS que devuelven el builder: la ruta encadena
    // .update(payload).eq(...) y el await final resuelve por `then`.
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'tracking_config') updates.push(payload)
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'tracking_config') inserts.push(payload)
      return b
    })
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(onF, onR)
    return b
  }
  return { from: vi.fn((table: string) => builder(table)) }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = (await importOriginal()) as { ForbiddenError: new (m: string) => Error }
  const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 }
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (RANK[callerRole] < RANK[min]) throw new actual.ForbiddenError(`requires ${min}`)
      return {
        accountId: 'acct-1',
        userId: 'u-1',
        role: callerRole,
        account: { id: 'acct-1', name: 'Acme' },
        supabase: supabaseMock,
      }
    }),
  }
})

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn(() => 'ENC-TOKEN'),
  decrypt: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, resetMs: 1000 }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

import { GET, POST } from './route'

function post(body: unknown) {
  const req = new Request('http://localhost/api/tracking/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req as unknown as Parameters<typeof POST>[0])
}

const FULL_ROW = {
  meta_pixel_id: '1234567890',
  meta_dataset_id: '1234567890',
  meta_access_token_encrypted: 'ENC-TOKEN',
  meta_test_event_code: 'TEST1',
  gtm_container_id: null,
  ga4_measurement_id: null,
  google_ads_conversion_id: null,
  google_ads_conversion_label: null,
  hotjar_site_id: null,
  updated_at: '2026-09-01T00:00:00Z',
}

beforeEach(() => {
  callerRole = 'owner'
  existingRow = null
  updates.length = 0
  inserts.length = 0
  supabaseMock = makeSupabaseMock()
  vi.unstubAllEnvs()
})

describe('GET /api/tracking/config', () => {
  it('sin fila → configured false, sin token, con banderas del entorno', async () => {
    vi.stubEnv('META_CAPI_DATASET_ID', 'ds')
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'tok')
    const res = await GET()
    const json = (await res.json()) as Record<string, unknown>
    expect(json.configured).toBe(false)
    expect(json.has_meta_access_token).toBe(false)
    expect(json.capi_env_present).toBe(true)
    expect(json.google_ads_env_present).toBe(false)
  })

  it('§8.9-3 — la respuesta NO contiene ninguna clave cuyo valor derive del token', async () => {
    existingRow = FULL_ROW
    const res = await GET()
    const json = (await res.json()) as Record<string, unknown>
    expect(json.has_meta_access_token).toBe(true)
    const raw = JSON.stringify(json)
    // ni el token, ni su encriptación, ni una máscara de longitud fija
    expect(raw).not.toContain('ENC-TOKEN')
    expect(raw).not.toContain('meta_access_token_encrypted')
    expect(raw).not.toContain('•••')
  })

  it('no-owner → 403 (viewer < owner)', async () => {
    callerRole = 'viewer'
    const res = await GET()
    expect(res.status).toBe(403)
  })
})

describe('POST /api/tracking/config', () => {
  it('§8.9-4 — POST solo con hotjar NO toca el token guardado', async () => {
    existingRow = { id: 'row-1' }
    const res = await post({ hotjar_site_id: '123456' })
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ hotjar_site_id: '123456' })
    expect(updates[0]).not.toHaveProperty('meta_access_token_encrypted')
  })

  it('POST con token → encripta; token vacío EXPLÍCITO → null', async () => {
    existingRow = { id: 'row-1' }
    await post({ meta_access_token: 'EAAT-super-secret' })
    expect(updates[0]).toEqual({ meta_access_token_encrypted: 'ENC-TOKEN' })

    updates.length = 0
    await post({ meta_access_token: '' })
    expect(updates[0]).toEqual({ meta_access_token_encrypted: null })
  })

  it('fila nueva → insert con account_id; sin campos → 400', async () => {
    const res = await post({ meta_pixel_id: '1234567890' })
    expect(res.status).toBe(200)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ account_id: 'acct-1', meta_pixel_id: '1234567890' })

    const bad = await post({})
    expect(bad.status).toBe(400)
  })

  it('recorta espacios y NO valida formato con regex (§8.9-7)', async () => {
    existingRow = { id: 'row-1' }
    const res = await post({ gtm_container_id: '  GTM-AB12CD3  ' })
    expect(res.status).toBe(200)
    expect(updates[0]).toEqual({ gtm_container_id: 'GTM-AB12CD3' })
  })
})
