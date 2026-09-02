import { NextResponse, after, type NextRequest } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

// ============================================================
// POST /api/deals — alta de un trato CON despacho de
// automatizaciones (trigger `deal_created`).
//
// Por qué existe: hasta ahora el trato nacía de un `insert` directo
// desde el navegador (deal-form.tsx). El insert era correcto —la RLS
// lo cubre— pero ocurría entera en el cliente: el servidor no se
// enteraba del alta y no había dónde llamar al motor de
// automatizaciones, que vive en Node. Esta ruta es el envoltorio que
// faltaba, exactamente el mismo movimiento que hizo
// POST /api/deals/[id]/transition con la RPC `transition_deal`.
//
// El otro camino que crea tratos, el paso `create_deal` del motor
// (engine.ts:812), NO se toca y NO despacha `deal_created`
// deliberadamente: ese insert ocurre DENTRO de la ejecución de una
// automatización, así que despachar desde ahí encadenaría
// automatización → trato → automatización. El motor no tiene guarda
// de recursión ni de profundidad, y una automatización de
// `deal_created` con un paso `create_deal` (aunque sea a través de
// una tercera) sería un bucle infinito creando tratos y mandando
// WhatsApp reales. `deal_created` significa por tanto "lo creó una
// persona", y esta ruta es su único despachador.
// ============================================================

// QUÉ CLIENTE USA CADA COSA — leer antes de tocar nada.
//
// Validación de referencias: `supabaseAdmin()` (service role, salta
// RLS), como el resto de rutas de deals. Al saltarse RLS la tenencia
// es responsabilidad de este fichero: cada consulta va acotada por
// `account_id`, o por un id que YA se verificó contra la cuenta.
//
// El INSERT: `ctx.supabase` (cliente con la sesión del usuario). Aquí
// sí hay elección real —un insert plano no pasa por ninguna función
// SECURITY DEFINER, así que el admin también funcionaría— y se elige
// la sesión a propósito: la política `deals_insert` (017:443) exige
// `is_account_member(account_id, 'agent')` y actúa de segundo muro
// sobre el `requireRole('agent')` de arriba. Con el admin esa política
// dejaría de evaluarse y la tenencia colgaría de un solo hilo.
//
// `account_id` y `user_id` salen SIEMPRE del contexto, nunca del body:
// aceptarlos del cliente sería dejar que el navegador elija en qué
// cuenta escribe.

interface CreateDealBody {
  title?: unknown
  value?: unknown
  currency?: unknown
  contact_id?: unknown
  pipeline_id?: unknown
  stage_id?: unknown
  assigned_to?: unknown
  notes?: unknown
  expected_close_date?: unknown
}

/** `<input type="date">` y la columna `date` de Postgres: solo YYYY-MM-DD. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Fecha con forma Y con sentido. El regex por sí solo deja pasar
 * `2026-02-30` y `2026-13-01`: llegan al insert y Postgres los rechaza con
 * un error que aquí se colapsaría a un 500 genérico. El round-trip por
 * `Date` los caza — un 30 de febrero se normaliza a marzo y deja de
 * coincidir consigo mismo.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** PostgREST serializa `numeric` como string — normaliza para las vars. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** Campo de texto opcional: string no vacío o `null`. */
function optionalText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

// La ruta usa la service-role key y espera al fan-out de automatizaciones
// (que manda WhatsApp/SMS/email en serie), así que necesita runtime de Node
// y un techo de ejecución holgado — mismo criterio que la ruta de transición
// y que las otras rutas con fan-out saliente.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')

    let body: CreateDealBody
    try {
      body = (await req.json()) as CreateDealBody
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
    }

    // ── Entrada ─────────────────────────────────────────────
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const pipelineId = typeof body.pipeline_id === 'string' ? body.pipeline_id.trim() : ''
    const stageId = typeof body.stage_id === 'string' ? body.stage_id.trim() : ''
    if (!title || !pipelineId || !stageId) {
      return NextResponse.json(
        { error: 'title, pipeline_id and stage_id are required' },
        { status: 400 },
      )
    }

    // `contact_id` es NULLABLE en la tabla (004) y el paso `create_deal` del
    // motor también crea tratos sin contacto, así que la ruta no lo exige:
    // exigirlo sería más estricto que la BD. Quien lo omita se queda sin
    // destinatario para los pasos de envío de la automatización, pero el
    // despacho ocurre igual (un `send_webhook` no necesita contacto).
    const contactId = optionalText(body.contact_id)
    const assignedTo = optionalText(body.assigned_to)
    const notes = optionalText(body.notes)
    const expectedCloseDate = optionalText(body.expected_close_date)
    if (expectedCloseDate && !isCalendarDate(expectedCloseDate)) {
      // Sin esto la fecha malformada llega a Postgres y vuelve como 500
      // genérico; es entrada inválida del cliente y merece su 400 con motivo.
      return NextResponse.json(
        { error: 'expected_close_date must be YYYY-MM-DD' },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()

    // ── Tenencia de las referencias ─────────────────────────
    // El insert va con la sesión, pero estas lecturas van con service
    // role: sin el `.eq('account_id', …)` verían las filas de todas las
    // cuentas. Y sin la comprobación, un body forjado podría colgar un
    // trato de la cuenta propia de un pipeline ajeno (es justo el agujero
    // que engine.ts:812 sigue teniendo abierto).
    //
    // De paso, `pipelines` y `pipeline_stages` traen los nombres que
    // necesitan las vars del disparador: dos lecturas, dos usos.
    const { data: pipeline } = await admin
      .from('pipelines')
      .select('id, name')
      .eq('id', pipelineId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!pipeline) {
      return NextResponse.json(
        { error: 'pipeline_id does not belong to this account' },
        { status: 400 },
      )
    }

    // `pipeline_stages` NO tiene `account_id` (cuelga de `pipelines` por
    // `pipeline_id`, migración 017), así que la tenencia se hereda del
    // pipeline que se acaba de verificar contra la cuenta.
    const { data: stage } = await admin
      .from('pipeline_stages')
      .select('id, name')
      .eq('id', stageId)
      .eq('pipeline_id', pipelineId)
      .maybeSingle()
    if (!stage) {
      return NextResponse.json(
        { error: 'stage_id does not belong to the pipeline' },
        { status: 400 },
      )
    }

    if (contactId) {
      const { data: contact } = await admin
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!contact) {
        return NextResponse.json(
          { error: 'contact_id does not belong to this account' },
          { status: 400 },
        )
      }
    }

    if (assignedTo) {
      // OJO: `deals.assigned_to` referencia `profiles.id` (002:11-12), NO
      // `auth.users.id` ni `profiles.user_id`. Pasar un user_id aquí
      // reventaría la FK con un 500 opaco.
      const { data: assignee } = await admin
        .from('profiles')
        .select('id')
        .eq('id', assignedTo)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!assignee) {
        return NextResponse.json(
          { error: 'assigned_to is not a member of this account' },
          { status: 400 },
        )
      }
    }

    // Moneda: la del body si viene (el formulario la deja elegir), y si no
    // la de la cuenta — no el default estático 'USD' de la columna, que
    // rompería la regla de una moneda por cuenta (issue #218, mismo
    // criterio que el paso `create_deal` del motor).
    let currency = optionalText(body.currency)
    if (!currency) {
      const { data: account } = await admin
        .from('accounts')
        .select('default_currency')
        .eq('id', ctx.accountId)
        .maybeSingle()
      currency = (account?.default_currency as string | null) ?? 'USD'
    }

    // ── El alta ─────────────────────────────────────────────
    // `.select().single()` no es cosmético: sin el id del trato recién
    // creado no hay contexto que mandarle al disparador.
    //
    // `status` se fija a 'open' y NO se acepta del body: un trato que
    // naciera 'won' se saltaría `transition_deal`, y con ella `won_at`, la
    // prioridad derivada, el `state_changed` y el evento de conversión. El
    // cierre tiene su propia vía (la ruta de transición) y su propio
    // disparador (`deal_won` / `deal_lost`).
    const { data: deal, error: insertError } = await ctx.supabase
      .from('deals')
      .insert({
        title,
        value: toNumber(body.value),
        currency,
        contact_id: contactId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        assigned_to: assignedTo,
        notes,
        expected_close_date: expectedCloseDate,
        account_id: ctx.accountId,
        user_id: ctx.userId,
        status: 'open',
      })
      .select('*')
      .single()

    if (insertError || !deal) {
      console.error('[deals] insert failed:', insertError)
      // 42501 = la RLS rechazó la escritura. No debería ocurrir tras
      // `requireRole('agent')`, pero si ocurre es un 403, no un 500.
      if (insertError?.code === '42501') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // El fan-out va DESPUÉS de responder, no antes. Aquí la diferencia no
    // es de latencia: el insert ya está commiteado, así que si el envío de
    // mensajes agota el `maxDuration` el agente ve «no se pudo crear»,
    // vuelve a darle a Guardar y acaba con DOS tratos y dos avisos al
    // paciente. `after` es el mecanismo de Next para esto (no una promesa
    // flotante): la invocación se mantiene viva hasta que el callback
    // termina, con el mismo techo de `maxDuration`.
    after(() =>
      dispatchDealCreated({
        accountId: ctx.accountId,
        contactId,
        dealId: deal.id as string,
        pipelineId,
        stageId,
        vars: {
          deal_id: deal.id as string,
          deal_name: title,
          deal_value: toNumber(deal.value),
          pipeline_name: pipeline.name as string,
          stage_name: stage.name as string,
          deal_status: (deal.status as string | null) ?? 'open',
        },
      }),
    )

    return NextResponse.json({ deal }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ------------------------------------------------------------
// Despacho a Automation
//
// Se programa con `after` y se envuelve en su propio try/catch. No es una
// promesa suelta —eso en serverless deja el fan-out a medias, con un
// WhatsApp enviado y el siguiente no—: `after` mantiene viva la
// invocación hasta terminar, pero DESPUÉS de haber respondido, que es lo
// que evita que un envío lento se convierta en un trato duplicado. El
// motor ya es fire-and-forget por dentro y nunca lanza; el try/catch es
// el cinturón para un fallo de import o de red.
//
// Mismo modelo que `dispatchStageChanged` (deals/[id]/transition) y que
// `dispatchAppointmentEvent` (appointments/queries).
// Las vars son escalares planos a propósito: `interpolateMessage` solo
// resuelve un nivel de punto, así que `{{vars.deal.stage}}` no existiría.
// ------------------------------------------------------------
async function dispatchDealCreated(args: {
  accountId: string
  contactId: string | null
  dealId: string
  pipelineId: string
  stageId: string
  vars: Record<string, unknown>
}): Promise<void> {
  try {
    await runAutomationsForTrigger({
      accountId: args.accountId,
      triggerType: 'deal_created',
      contactId: args.contactId,
      context: {
        deal_id: args.dealId,
        pipeline_id: args.pipelineId,
        // La etapa en la que nace. `deal_created` solo filtra por pipeline,
        // pero el id viaja igual porque alimenta las vars y sale gratis.
        // `from_stage_id` se omite: un alta no describe un movimiento.
        to_stage_id: args.stageId,
        vars: args.vars,
      },
    })
  } catch (err) {
    console.error('[deals] deal_created dispatch failed:', err)
  }
}
