import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/deals/[id]/transition — transición de etapa + despacho del
// trigger `deal_stage_changed`.

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  dispatch: vi.fn(),
  state: {
    deal: null as Record<string, unknown> | null,
    dealError: null as { message: string } | null,
    stages: [] as Array<{ id: string; name: string }>,
    stagesError: null as { message: string } | null,
    pipeline: null as Record<string, unknown> | null,
    timeRow: null as Record<string, unknown> | null,
    /** Cada `.eq()` / `.in()` que se aplica, para afirmar la tenencia. */
    filters: [] as Array<[string, string, unknown]>,
  },
}))

// `toErrorResponse` va como función plana, no como vi.fn: el
// `restoreAllMocks` del afterEach le borraría la implementación y las
// pruebas de auth empezarían a devolver undefined según el orden.
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => Response.json({ error: 'auth failed' }, { status: 403 }),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.dispatch,
}))

// Mock del cliente service-role. `resolve` responde por tabla y el
// builder encadena todo devolviéndose a sí mismo; los terminales son
// `maybeSingle` y `then` (la consulta de etapas se espera sin
// `.single()`, así que el builder tiene que ser thenable).
vi.mock('@/lib/automations/admin-client', () => {
  function resolve(table: string) {
    switch (table) {
      case 'deals':
        return { data: h.state.deal, error: h.state.dealError }
      case 'pipeline_stages':
        return { data: h.state.stages, error: h.state.stagesError }
      case 'pipelines':
        return { data: h.state.pipeline, error: null }
      case 'deal_time_in_stage':
        return { data: h.state.timeRow, error: null }
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
    b.in = vi.fn((key: string, value: unknown) => {
      h.state.filters.push([table, `in:${key}`, value])
      return b
    })
    b.maybeSingle = vi.fn(async () => resolve(table))
    b.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolve(table)).then(onFulfilled)
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

/** `Date.now()` congelado: el delta de tiempo en etapa es aritmética pura. */
const NOW = new Date('2026-08-29T12:00:00.000Z').getTime()

/** El deal nació 20 días antes de NOW: la EDAD del trato, otro reloj. */
const CREATED_AT = '2026-08-09T12:00:00.000Z'

/** El deal entró en la etapa 58 h antes de NOW → 2.4 días. */
const ENTERED_AT = '2026-08-27T02:00:00.000Z'

const rpc = vi.fn()

const context = {
  supabase: { rpc },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
}

const params = { params: Promise.resolve({ id: 'deal-1' }) }

function request(body: unknown) {
  return new Request('http://localhost/api/deals/deal-1/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

/** Filtros aplicados sobre una tabla, como pares `key=value`. */
function filtersOn(table: string) {
  return h.state.filters
    .filter(([t]) => t === table)
    .map(([, key, value]) => `${key}=${JSON.stringify(value)}`)
}

type DispatchArg = {
  accountId: string
  triggerType: string
  contactId: string | null
  context: {
    deal_id?: string
    pipeline_id?: string
    from_stage_id?: string | null
    to_stage_id?: string
    vars: Record<string, unknown>
  }
}

/** Los disparadores despachados, EN ORDEN: una transición puede lanzar
 *  varios (movimiento + cierre) y el orden es el de los mensajes. */
function dispatchedTriggers(): string[] {
  return h.dispatch.mock.calls.map(([arg]) => (arg as DispatchArg).triggerType)
}

/** El despacho de un disparador concreto, o `undefined` si no salió. */
function dispatchOf(triggerType: string): DispatchArg | undefined {
  return h.dispatch.mock.calls
    .map(([arg]) => arg as DispatchArg)
    .find((arg) => arg.triggerType === triggerType)
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)

  h.requireRole.mockReset()
  h.dispatch.mockReset()
  rpc.mockReset()

  h.requireRole.mockResolvedValue(context)
  h.dispatch.mockResolvedValue(undefined)
  rpc.mockResolvedValue({
    data: { ok: true, version: 8, status: 'open', priority: 'warm' },
    error: null,
  })

  h.state.deal = {
    id: 'deal-1',
    account_id: 'account-1',
    contact_id: 'contact-1',
    pipeline_id: 'pipe-1',
    stage_id: 'stage-a',
    title: 'Full arch upper',
    value: '4500.00',
    status: 'open',
    version: 7,
    created_at: CREATED_AT,
  }
  h.state.dealError = null
  h.state.stages = [
    { id: 'stage-a', name: 'Contact attempted' },
    { id: 'stage-b', name: 'Consultation booked' },
  ]
  h.state.stagesError = null
  h.state.pipeline = { id: 'pipe-1', name: 'Main pipeline' }
  h.state.timeRow = { stage_entered_at: ENTERED_AT }
  h.state.filters = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ------------------------------------------------------------

describe('POST /api/deals/[id]/transition', () => {
  it('exige rol agent y no toca nada si la auth falla', async () => {
    h.requireRole.mockRejectedValue(new Error('viewer'))

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(rpc).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('devuelve 404 —no 403— para un deal de otra cuenta, sin llamar a la RPC', async () => {
    h.state.deal = { ...h.state.deal, account_id: 'account-2' }

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    // Mismo cuerpo que "no existe": la ruta no puede ser un oráculo que
    // confirme UUIDs de deals ajenos.
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'deal not found' })
    expect(rpc).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('devuelve el mismo 404 cuando el deal no existe', async () => {
    h.state.deal = null

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'deal not found' })
  })

  it('rechaza con 400 si falta to_stage_id, antes de leer nada', async () => {
    const response = await POST(request({}), params)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'to_stage_id is required' })
    expect(rpc).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('rechaza con 400 una etapa destino que no es del pipeline del deal', async () => {
    // `pipeline_stages` se consulta acotada por el pipeline del deal, así
    // que una etapa de otra cuenta simplemente no vuelve en el resultado.
    const response = await POST(request({ to_stage_id: 'stage-ajena' }), params)

    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('acota por tenencia cada lectura antes de la transición', async () => {
    await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(filtersOn('deals')).toContain('id="deal-1"')
    // pipeline_stages NO tiene account_id: hereda la tenencia del
    // pipeline del deal, ya verificado contra la cuenta.
    expect(filtersOn('pipeline_stages')).toContain('pipeline_id="pipe-1"')
    expect(filtersOn('pipelines')).toContain('account_id="account-1"')
    // La vista es security_invoker, pero aquí se lee con service role:
    // sin este .eq devolvería filas de todas las cuentas.
    expect(filtersOn('deal_time_in_stage')).toContain('account_id="account-1"')
    expect(filtersOn('deal_time_in_stage')).toContain('deal_id="deal-1"')
  })

  it('llama a transition_deal con el cliente de SESIÓN y respeta el optimistic lock', async () => {
    await POST(
      request({ to_stage_id: 'stage-b', expected_version: 7, triggered_by: 'kanban' }),
      params,
    )

    // Con el admin client la RPC lanzaría 'forbidden' siempre
    // (is_account_member resuelve por auth.uid()).
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('transition_deal', {
      p_deal_id: 'deal-1',
      p_to_stage_id: 'stage-b',
      p_new_status: null,
      p_triggered_by: 'kanban',
      p_evidence: null,
      p_override_reason: null,
      p_expected_version: 7,
    })
  })

  it('devuelve el jsonb tal cual con 200 cuando ok:false (VERSION_CONFLICT)', async () => {
    rpc.mockResolvedValue({
      data: { ok: false, code: 'VERSION_CONFLICT', current_version: 9, expected_version: 7 },
      error: null,
    })

    const response = await POST(
      request({ to_stage_id: 'stage-b', expected_version: 7 }),
      params,
    )

    // 200 a propósito: la UI distingue por `code`, igual que hoy con la
    // RPC directa desde el kanban.
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: 'VERSION_CONFLICT',
      current_version: 9,
      expected_version: 7,
    })
    // Nada cambió: no hay evento que anunciar.
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('tampoco despacha en NO_OP', async () => {
    rpc.mockResolvedValue({
      data: { ok: false, code: 'NO_OP', message: 'la transición no cambia nada' },
      error: null,
    })

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(200)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('no despacha deal_stage_changed cuando solo cambia el status y la etapa es la misma', async () => {
    // Los botones ganado/perdido/reabrir (deal-form.tsx) mandan la etapa
    // ACTUAL con `new_status`. La RPC responde ok:true —su guarda NO_OP no
    // salta porque el status sí cambia— pero el deal no se ha movido: un
    // trigger llamado «cambio de etapa» no tiene nada que anunciar, y el
    // texto saldría con la misma etapa de origen y destino. El cierre SÍ
    // se anuncia, pero con su propio disparador (ver el bloque de cierre).
    rpc.mockResolvedValue({
      data: { ok: true, version: 8, status: 'won', priority: 'top' },
      error: null,
    })

    const response = await POST(
      request({ to_stage_id: 'stage-a', new_status: 'won' }),
      params,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(dispatchedTriggers()).not.toContain('deal_stage_changed')
  })

  it('reabrir un deal ganado no despacha nada si no se mueve de etapa', async () => {
    // `open` no es un cierre y la etapa no cambia: ninguno de los tres
    // disparadores de la ruta tiene nada que anunciar.
    h.state.deal = { ...h.state.deal, status: 'won' }
    rpc.mockResolvedValue({
      data: { ok: true, version: 8, status: 'open', priority: 'warm' },
      error: null,
    })

    await POST(request({ to_stage_id: 'stage-a', new_status: 'open' }), params)

    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('despacha deal_stage_changed con el contexto completo cuando ok:true', async () => {
    const response = await POST(
      request({ to_stage_id: 'stage-b', expected_version: 7 }),
      params,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: 8,
      status: 'open',
      priority: 'warm',
    })

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.dispatch).toHaveBeenCalledWith({
      accountId: 'account-1',
      triggerType: 'deal_stage_changed',
      contactId: 'contact-1',
      context: {
        deal_id: 'deal-1',
        pipeline_id: 'pipe-1',
        from_stage_id: 'stage-a',
        to_stage_id: 'stage-b',
        vars: {
          deal_id: 'deal-1',
          deal_name: 'Full arch upper',
          // PostgREST manda numeric como string; llega normalizado.
          deal_value: 4500,
          pipeline_name: 'Main pipeline',
          from_stage_name: 'Contact attempted',
          to_stage_name: 'Consultation booked',
          deal_status: 'open',
          stage_entered_at: ENTERED_AT,
          // 58 h medidas ANTES de mover → 2.4 días.
          time_in_stage_hours: 58,
          time_in_stage_days: 2.4,
          // Otro reloj: el trato lleva 20 días vivo aunque solo 2.4 en
          // esta etapa. Confundirlos hace que una plantilla mienta.
          created_at: CREATED_AT,
          deal_age_hours: 480,
          deal_age_days: 20,
        },
      },
    })
  })

  it('manda el status NUEVO que devuelve la RPC, no el que tenía el deal', async () => {
    rpc.mockResolvedValue({
      data: { ok: true, version: 8, status: 'won', priority: 'warm' },
      error: null,
    })

    await POST(request({ to_stage_id: 'stage-b' }), params)

    // Se busca por triggerType a propósito: este movimiento cierra el trato
    // y despacha además `deal_won`, así que el índice 0 no es un ancla.
    expect(dispatchOf('deal_stage_changed')?.context.vars.deal_status).toBe('won')
  })

  it('despacha con contactId null si el deal no tiene contacto', async () => {
    h.state.deal = { ...h.state.deal, contact_id: null }

    await POST(request({ to_stage_id: 'stage-b' }), params)

    const ctx = h.dispatch.mock.calls[0][0] as { contactId: string | null }
    expect(ctx.contactId).toBeNull()
  })

  it('un despacho que falla no tumba la respuesta: la transición ya está commiteada', async () => {
    h.dispatch.mockRejectedValue(new Error('engine exploded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, version: 8 })
  })

  it('no filtra el mensaje de la RPC al cliente', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'transition_deal: stage 9f3a… no existe en esta cuenta' },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('traduce el forbidden de la RPC a 403 sin repetir su texto', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'transition_deal: forbidden — se requiere rol agent+ de la cuenta' },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await POST(request({ to_stage_id: 'stage-b' }), params)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' })
  })

  it('rechaza un new_status inválido con 400 en vez de dejar que la RPC lance', async () => {
    const response = await POST(
      request({ to_stage_id: 'stage-b', new_status: 'ganado' }),
      params,
    )

    expect(response.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pasa new_status cuando es válido', async () => {
    await POST(request({ to_stage_id: 'stage-b', new_status: 'won' }), params)

    expect(rpc).toHaveBeenCalledWith(
      'transition_deal',
      expect.objectContaining({ p_new_status: 'won' }),
    )
  })

  it('manda ceros de tiempo en etapa si la vista no devuelve fila', async () => {
    h.state.timeRow = null

    await POST(request({ to_stage_id: 'stage-b' }), params)

    const ctx = h.dispatch.mock.calls[0][0] as { context: { vars: Record<string, unknown> } }
    expect(ctx.context.vars.stage_entered_at).toBeNull()
    expect(ctx.context.vars.time_in_stage_hours).toBe(0)
    expect(ctx.context.vars.time_in_stage_days).toBe(0)
  })

  // ----------------------------------------------------------
  // Cierre del trato: `deal_won` / `deal_lost`
  //
  // La condición es el CAMBIO de status, y se lee del jsonb de la RPC
  // (`status` es el NUEVO, 069:100 y 165-170), nunca del body: una etapa
  // con `stage_status` cierra el trato sin que el cliente pida nada.
  // ----------------------------------------------------------
  describe('cierre del trato', () => {
    it('mover a una etapa terminal despacha los DOS: el movimiento y el cierre', async () => {
      // Arrastrar en el kanban a una etapa marcada `won` (stage_status,
      // migración 058) cambia etapa Y status. No es un despacho duplicado:
      // son dos hechos distintos y cada automatización elige el suyo.
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'won', priority: 'top' },
        error: null,
      })

      const response = await POST(request({ to_stage_id: 'stage-b' }), params)

      expect(response.status).toBe(200)
      // El orden importa: es el orden en que salen los mensajes.
      expect(dispatchedTriggers()).toEqual(['deal_stage_changed', 'deal_won'])
    })

    it('marcar ganado sin mover de etapa despacha solo deal_won', async () => {
      // El botón «ganado» de deal-form.tsx: misma etapa, solo new_status.
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'won', priority: 'top' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-a', new_status: 'won' }), params)

      expect(dispatchedTriggers()).toEqual(['deal_won'])
    })

    it('marcar perdido sin mover de etapa despacha solo deal_lost', async () => {
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'lost', priority: 'cold' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-a', new_status: 'lost' }), params)

      expect(dispatchedTriggers()).toEqual(['deal_lost'])
    })

    it('no despacha nada al marcar ganado un deal que YA estaba ganado', async () => {
      // En producción la RPC devolvería NO_OP aquí, pero la guarda de la
      // ruta es independiente de ella: compara el status ANTES (la fila
      // leída) con el DESPUÉS (el jsonb) y no se fía de que la RPC filtre.
      h.state.deal = { ...h.state.deal, status: 'won' }
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'won', priority: 'top' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-a', new_status: 'won' }), params)

      expect(h.dispatch).not.toHaveBeenCalled()
    })

    it('no despacha nada al marcar perdido un deal que YA estaba perdido', async () => {
      h.state.deal = { ...h.state.deal, status: 'lost' }
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'lost', priority: 'cold' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-a', new_status: 'lost' }), params)

      expect(h.dispatch).not.toHaveBeenCalled()
    })

    it('mover un deal YA ganado a otra etapa anuncia el movimiento, no un segundo cierre', async () => {
      // El status no cambia (coalesce cae al del deal), así que no hay
      // cierre nuevo que anunciar aunque el status resultante sea `won`.
      h.state.deal = { ...h.state.deal, status: 'won' }
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'won', priority: 'top' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-b' }), params)

      expect(dispatchedTriggers()).toEqual(['deal_stage_changed'])
    })

    it('el cierre lleva el mismo contexto y las mismas vars, con el tiempo hasta cerrarse', async () => {
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'won', priority: 'top' },
        error: null,
      })

      await POST(request({ to_stage_id: 'stage-a', new_status: 'won' }), params)

      // Sin `from_stage_id`: un cierre no describe un movimiento. Los tres
      // disparadores nuevos solo filtran por pipeline_id.
      expect(dispatchOf('deal_won')).toEqual({
        accountId: 'account-1',
        triggerType: 'deal_won',
        contactId: 'contact-1',
        context: {
          deal_id: 'deal-1',
          pipeline_id: 'pipe-1',
          to_stage_id: 'stage-a',
          vars: {
            deal_id: 'deal-1',
            deal_name: 'Full arch upper',
            deal_value: 4500,
            pipeline_name: 'Main pipeline',
            from_stage_name: 'Contact attempted',
            to_stage_name: 'Contact attempted',
            deal_status: 'won',
            stage_entered_at: ENTERED_AT,
            // 58 h medidas ANTES de la RPC: lo que llevaba en su ÚLTIMA
            // etapa. Lo que tardó en cerrarse es `deal_age_days`: 20 días,
            // no 2.4 — son dos preguntas distintas.
            time_in_stage_hours: 58,
            time_in_stage_days: 2.4,
            created_at: CREATED_AT,
            deal_age_hours: 480,
            deal_age_days: 20,
          },
        },
      })
    })

    it('no despacha el cierre si la RPC no cambió nada (VERSION_CONFLICT)', async () => {
      rpc.mockResolvedValue({
        data: { ok: false, code: 'VERSION_CONFLICT', current_version: 9, expected_version: 7 },
        error: null,
      })

      await POST(
        request({ to_stage_id: 'stage-a', new_status: 'won', expected_version: 7 }),
        params,
      )

      expect(h.dispatch).not.toHaveBeenCalled()
    })

    it('un cierre que falla al despachar no tumba la respuesta', async () => {
      // La transición YA está commiteada: el fan-out no puede convertirla
      // en un 500.
      rpc.mockResolvedValue({
        data: { ok: true, version: 8, status: 'lost', priority: 'cold' },
        error: null,
      })
      h.dispatch.mockRejectedValue(new Error('engine exploded'))
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const response = await POST(
        request({ to_stage_id: 'stage-a', new_status: 'lost' }),
        params,
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ ok: true, version: 8 })
    })
  })
})
