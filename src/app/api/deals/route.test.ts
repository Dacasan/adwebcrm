import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/deals — alta de un trato + despacho del trigger `deal_created`.

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  dispatch: vi.fn(),
  /** Fila que recibe el insert del cliente de SESIÓN, para afirmar tenencia. */
  inserted: null as Record<string, unknown> | null,
  state: {
    pipeline: null as Record<string, unknown> | null,
    stage: null as Record<string, unknown> | null,
    contact: null as Record<string, unknown> | null,
    profile: null as Record<string, unknown> | null,
    account: null as Record<string, unknown> | null,
    /** Lo que devuelve el `.select().single()` del insert. */
    created: null as Record<string, unknown> | null,
    createdError: null as { message: string; code?: string } | null,
    /** Cada `.eq()` que se aplica en las lecturas, para afirmar la tenencia. */
    filters: [] as Array<[string, string, unknown]>,
  },
}))

// `toErrorResponse` va como función plana, no como vi.fn: el
// `restoreAllMocks` del afterEach le borraría la implementación y las
// pruebas de auth empezarían a devolver undefined según el orden.
// `after` solo existe dentro del contexto de petición de Next; fuera de él
// lanza, y aquí el handler se invoca a pelo. El doble ejecuta el callback
// en el acto, que para estas pruebas es lo que interesa: comprobar QUÉ se
// despacha. Que ocurra después de responder lo garantiza Next, no el test.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (fn: () => unknown) => void fn() }
})

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.dispatch,
}))

// Mock del cliente service-role: solo se usa para VALIDAR referencias, y
// todas esas lecturas terminan en `.maybeSingle()` (a diferencia de la
// ruta de transición, que lista etapas y necesita un builder thenable).
// Un `null` por tabla modela exactamente lo que devolvería PostgREST
// cuando el `.eq('account_id', …)` deja fuera la fila: no existe para
// esta cuenta.
vi.mock('@/lib/automations/admin-client', () => {
  function resolve(table: string) {
    switch (table) {
      case 'pipelines':
        return { data: h.state.pipeline, error: null }
      case 'pipeline_stages':
        return { data: h.state.stage, error: null }
      case 'contacts':
        return { data: h.state.contact, error: null }
      case 'profiles':
        return { data: h.state.profile, error: null }
      case 'accounts':
        return { data: h.state.account, error: null }
      default:
        return { data: null, error: null }
    }
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn((key: string, value: unknown) => {
      h.state.filters.push([table, key, value])
      return b
    })
    b.maybeSingle = vi.fn(async () => resolve(table))
    return b
  }

  return {
    supabaseAdmin: () => ({ from: (table: string) => builder(table) }),
  }
})

import { POST } from './route'

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

/** El insert va con el cliente de SESIÓN (RLS `deals_insert`, agent+). */
const insert = vi.fn((row: Record<string, unknown>) => {
  h.inserted = row
  return {
    select: () => ({
      single: async () => ({ data: h.state.created, error: h.state.createdError }),
    }),
  }
})

const sessionClient = {
  from: vi.fn(() => ({ insert })),
}

const context = {
  supabase: sessionClient,
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
}

/** Lo que manda hoy el formulario de alta. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Full arch upper',
    value: 4500,
    currency: 'EUR',
    contact_id: 'contact-1',
    pipeline_id: 'pipe-1',
    stage_id: 'stage-a',
    assigned_to: 'profile-1',
    notes: 'Viene de Instagram',
    expected_close_date: '2026-09-30',
    ...overrides,
  }
}

function request(payload: unknown) {
  return new Request('http://localhost/api/deals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }) as never
}

/** Filtros aplicados sobre una tabla, como pares `key=value`. */
function filtersOn(table: string) {
  return h.state.filters
    .filter(([t]) => t === table)
    .map(([, key, value]) => `${key}=${JSON.stringify(value)}`)
}

beforeEach(() => {
  h.requireRole.mockReset()
  h.dispatch.mockReset()
  insert.mockClear()
  sessionClient.from.mockClear()

  h.requireRole.mockResolvedValue(context)
  h.dispatch.mockResolvedValue(undefined)

  h.inserted = null
  h.state.pipeline = { id: 'pipe-1', name: 'Main pipeline' }
  h.state.stage = { id: 'stage-a', name: 'Contact attempted' }
  h.state.contact = { id: 'contact-1' }
  h.state.profile = { id: 'profile-1' }
  h.state.account = { default_currency: 'USD' }
  h.state.created = {
    id: 'deal-1',
    account_id: 'account-1',
    contact_id: 'contact-1',
    pipeline_id: 'pipe-1',
    stage_id: 'stage-a',
    title: 'Full arch upper',
    // PostgREST devuelve numeric como string.
    value: '4500.00',
    status: 'open',
    version: 1,
  }
  h.state.createdError = null
  h.state.filters = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ------------------------------------------------------------

describe('POST /api/deals', () => {
  it('exige rol agent y no escribe nada si la auth falla', async () => {
    h.requireRole.mockRejectedValue(new Error('viewer'))

    const response = await POST(request(body()))

    expect(response.status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(insert).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rechaza con 400 si falta alguno de los campos mínimos, sin leer nada', async () => {
    for (const missing of ['title', 'pipeline_id', 'stage_id']) {
      h.state.filters = []
      const response = await POST(request(body({ [missing]: '' })))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'title, pipeline_id and stage_id are required',
      })
      expect(h.state.filters).toEqual([])
      expect(insert).not.toHaveBeenCalled()
      expect(h.dispatch).not.toHaveBeenCalled()
    }
  })

  it('rechaza con 400 un pipeline de otra cuenta y no llega a insertar', async () => {
    // El `.eq('account_id', …)` deja la fila fuera: para esta cuenta no existe.
    h.state.pipeline = null

    const response = await POST(request(body()))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'pipeline_id does not belong to this account',
    })
    expect(filtersOn('pipelines')).toContain('account_id="account-1"')
    expect(insert).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rechaza con 400 una etapa que no es del pipeline indicado', async () => {
    // pipeline_stages NO tiene account_id: hereda la tenencia del pipeline,
    // que se acaba de verificar contra la cuenta.
    h.state.stage = null

    const response = await POST(request(body()))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'stage_id does not belong to the pipeline',
    })
    expect(filtersOn('pipeline_stages')).toContain('pipeline_id="pipe-1"')
    expect(insert).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rechaza con 400 un contacto de otra cuenta', async () => {
    h.state.contact = null

    const response = await POST(request(body()))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'contact_id does not belong to this account',
    })
    expect(filtersOn('contacts')).toContain('account_id="account-1"')
    expect(insert).not.toHaveBeenCalled()
  })

  it('rechaza con 400 un responsable que no es miembro de la cuenta', async () => {
    h.state.profile = null

    const response = await POST(request(body()))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'assigned_to is not a member of this account',
    })
    // assigned_to referencia profiles.id (002), no profiles.user_id.
    expect(filtersOn('profiles')).toContain('id="profile-1"')
    expect(filtersOn('profiles')).toContain('account_id="account-1"')
    expect(insert).not.toHaveBeenCalled()
  })

  it('rechaza con 400 una fecha con forma correcta pero inexistente', async () => {
    // `2026-02-30` pasa el regex de forma y solo lo caza el calendario. Sin
    // esta comprobación llega a Postgres y vuelve como 500 genérico, cuando
    // es entrada inválida del cliente.
    for (const fecha of ['2026-02-30', '2026-13-01', '0000-00-00']) {
      const response = await POST(request(body({ expected_close_date: fecha })))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'expected_close_date must be YYYY-MM-DD',
      })
    }
  })

  it('rechaza con 400 una fecha de cierre malformada', async () => {
    const response = await POST(request(body({ expected_close_date: '30/09/2026' })))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'expected_close_date must be YYYY-MM-DD',
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('crea el trato con la tenencia del CONTEXTO y devuelve 201 con el deal', async () => {
    const response = await POST(request(body()))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ deal: h.state.created })

    expect(insert).toHaveBeenCalledTimes(1)
    expect(h.inserted).toEqual({
      title: 'Full arch upper',
      value: 4500,
      currency: 'EUR',
      contact_id: 'contact-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-a',
      assigned_to: 'profile-1',
      notes: 'Viene de Instagram',
      expected_close_date: '2026-09-30',
      account_id: 'account-1',
      user_id: 'user-1',
      status: 'open',
    })
  })

  it('ignora account_id, user_id y status si vienen forjados en el body', async () => {
    await POST(
      request(
        body({ account_id: 'account-2', user_id: 'user-9', status: 'won' }),
      ),
    )

    // La cuenta y el autor salen de la sesión; el status de un alta es
    // siempre 'open' (ganar/perder tiene su propia vía, transition_deal).
    expect(h.inserted).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      status: 'open',
    })
  })

  it('usa la moneda de la cuenta cuando el body no manda ninguna', async () => {
    h.state.account = { default_currency: 'MXN' }

    await POST(request(body({ currency: '' })))

    // No el default estático 'USD' de la columna: una moneda por cuenta (#218).
    expect(h.inserted).toMatchObject({ currency: 'MXN' })
    expect(filtersOn('accounts')).toContain('id="account-1"')
  })

  it('despacha deal_created con el contexto y las vars completas', async () => {
    await POST(request(body()))

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      triggerType: 'deal_created',
      contactId: 'contact-1',
      context: {
        deal_id: 'deal-1',
        pipeline_id: 'pipe-1',
        // La etapa inicial. No hay `from_stage_id`: un alta no es un movimiento.
        to_stage_id: 'stage-a',
        vars: {
          deal_id: 'deal-1',
          deal_name: 'Full arch upper',
          // PostgREST manda numeric como string; llega normalizado.
          deal_value: 4500,
          pipeline_name: 'Main pipeline',
          stage_name: 'Contact attempted',
          deal_status: 'open',
        },
      },
    })
  })

  it('acepta un trato sin contacto y despacha con contactId null', async () => {
    // `deals.contact_id` es nullable (004) y el paso create_deal del motor
    // también crea tratos sin contacto: exigirlo sería más estricto que la BD.
    h.state.created = { ...h.state.created, contact_id: null }

    const response = await POST(request(body({ contact_id: '' })))

    expect(response.status).toBe(201)
    expect(h.inserted).toMatchObject({ contact_id: null })
    // Sin contacto que validar, no se consulta la tabla.
    expect(filtersOn('contacts')).toEqual([])
    const dispatched = h.dispatch.mock.calls[0][0] as { contactId: string | null }
    expect(dispatched.contactId).toBeNull()
  })

  it('un despacho que falla no tumba la respuesta: el trato ya está creado', async () => {
    h.dispatch.mockRejectedValue(new Error('engine exploded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request(body()))

    // Un 500 aquí invitaría al agente a reintentar y a duplicar el trato.
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ deal: h.state.created })
  })

  it('no filtra el error del insert al cliente y no despacha nada', async () => {
    h.state.created = null
    h.state.createdError = {
      message: 'null value in column "account_id" violates not-null constraint',
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request(body()))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('traduce el rechazo de la RLS a 403 en vez de a 500', async () => {
    h.state.created = null
    h.state.createdError = { message: 'new row violates row-level security', code: '42501' }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request(body()))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rechaza con 400 un cuerpo que no es JSON', async () => {
    const bad = new Request('http://localhost/api/deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'no soy json',
    }) as never

    const response = await POST(bad)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid JSON body' })
    expect(insert).not.toHaveBeenCalled()
  })
})
