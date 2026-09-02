import { NextResponse, type NextRequest } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { stageDelta } from '@/lib/pipelines/stage-delta'

// ============================================================
// POST /api/deals/[id]/transition — mover un deal de etapa CON
// despacho de automatizaciones (`deal_stage_changed` cuando el deal se
// mueve, y `deal_won` / `deal_lost` cuando además se cierra; un mismo
// movimiento a una etapa terminal despacha los dos, ver §El cierre).
//
// Por qué existe: hasta ahora el kanban llamaba `transition_deal`
// directamente desde el navegador (pipelines/page.tsx, deal-form.tsx).
// La RPC es correcta y sigue siéndolo, pero es una función SQL: no
// puede invocar el motor de automatizaciones, que vive en Node. Esta
// ruta es el envoltorio server-side que faltaba — la RPC hace la
// transición, y aquí se lee el "antes" (nombres de etapa, tiempo en
// etapa) y se despacha el evento con ese contexto ya resuelto.
//
// La respuesta es el jsonb de la RPC TAL CUAL — `{ ok, code?, version?,
// status?, priority? }` —, con HTTP 200 incluso cuando `ok:false`. La
// UI ya distingue por `code` (VERSION_CONFLICT / NO_OP) y romper ese
// contrato obligaría a tocar los tres llamantes. Los 4xx quedan
// reservados a auth, tenencia y validación de entrada.
// ============================================================

// QUÉ CLIENTE USA CADA COSA — leer antes de tocar nada.
//
// Lecturas: `supabaseAdmin()` (service role, salta RLS), como el resto
// de rutas de deals. Al saltarse RLS, la tenencia es responsabilidad de
// este fichero: cada consulta va acotada por `account_id` o por un id
// que YA se derivó del deal verificado.
//
// La RPC: `ctx.supabase` (cliente con la sesión del usuario), NUNCA el
// admin. No es estilo, es funcional: `transition_deal` es SECURITY
// DEFINER pero su primera guarda es `is_account_member(account_id,
// 'agent')` (069:76), que resuelve por `auth.uid()`. Con la service-role
// key no hay JWT, `auth.uid()` es NULL y la función lanza SIEMPRE
// 'forbidden'. Si alguien "arregla" ese 403 pasando al admin client,
// además pierde el JOIN de tenencia de la etapa destino (069:92-97).

interface TransitionBody {
  to_stage_id?: unknown
  expected_version?: unknown
  triggered_by?: unknown
  new_status?: unknown
  evidence?: unknown
  override_reason?: unknown
}

/** El jsonb que devuelve `transition_deal` (069:165-170 y las dos salidas suaves). */
interface TransitionResult {
  ok?: boolean
  code?: string
  version?: number
  status?: string
  priority?: string
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

// La ruta usa la service-role key y espera al fan-out de automatizaciones
// (que manda WhatsApp/SMS/email en serie), así que necesita runtime de Node
// y un techo de ejecución holgado — mismo criterio que las otras rutas con
// fan-out saliente (whatsapp/webhook:24, telnyx/webhook:43).
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params

    let body: TransitionBody
    try {
      body = (await req.json()) as TransitionBody
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
    }

    const toStageId = typeof body.to_stage_id === 'string' ? body.to_stage_id.trim() : ''
    if (!toStageId) {
      return NextResponse.json({ error: 'to_stage_id is required' }, { status: 400 })
    }

    const newStatus = typeof body.new_status === 'string' ? body.new_status : null
    if (newStatus !== null && !['open', 'won', 'lost'].includes(newStatus)) {
      // La RPC también lo valida, pero allí es un `raise` que aquí se
      // colapsaría a 500 genérico. Un status mal escrito es entrada
      // inválida del cliente: 400 y con el motivo.
      return NextResponse.json(
        { error: 'new_status must be open, won or lost' },
        { status: 400 },
      )
    }
    const expectedVersion =
      typeof body.expected_version === 'number' ? body.expected_version : null
    const triggeredBy = typeof body.triggered_by === 'string' ? body.triggered_by : 'agent'
    const overrideReason =
      typeof body.override_reason === 'string' ? body.override_reason : null

    const admin = supabaseAdmin()

    // ── El "antes" ──────────────────────────────────────────
    // `title` y `value` son los nombres reales de las columnas (001:273);
    // `name`/`amount` no existen en `deals`.
    const { data: deal, error: dealError } = await admin
      .from('deals')
      .select(
        'id, account_id, contact_id, pipeline_id, stage_id, title, value, status, version, created_at',
      )
      .eq('id', id)
      .maybeSingle()
    if (dealError || !deal) {
      return NextResponse.json({ error: 'deal not found' }, { status: 404 })
    }
    if (deal.account_id !== ctx.accountId) {
      // 404, no 403: distinguir "existe pero es de otra cuenta" de "no
      // existe" convierte la ruta en un verificador de UUIDs de deals
      // ajenos. La respuesta es idéntica a la de arriba a propósito.
      return NextResponse.json({ error: 'deal not found' }, { status: 404 })
    }

    // Etapas: origen (la actual) y destino, en una sola consulta.
    // `pipeline_stages` NO tiene `account_id` (cuelga de `pipelines` por
    // `pipeline_id`, migración 017), así que la tenencia se hereda del
    // `pipeline_id` del deal, que ya está verificado contra la cuenta.
    // De paso esto valida el destino: si `to_stage_id` no sale de aquí,
    // o es de otro pipeline o es de otra cuenta.
    const { data: stageRows, error: stageError } = await admin
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', deal.pipeline_id)
      .in('id', [deal.stage_id, toStageId])
    if (stageError) {
      console.error('[deals/transition] stage lookup failed:', stageError)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const stages = (stageRows ?? []) as Array<{ id: string; name: string }>
    const toStage = stages.find((s) => s.id === toStageId)
    if (!toStage) {
      return NextResponse.json(
        { error: 'to_stage_id does not belong to the deal pipeline' },
        { status: 400 },
      )
    }
    // La etapa origen puede no aparecer si la fila se borró bajo los
    // pies; el nombre es solo para el texto de la automatización.
    const fromStage = stages.find((s) => s.id === deal.stage_id) ?? null

    const { data: pipeline } = await admin
      .from('pipelines')
      .select('id, name')
      .eq('id', deal.pipeline_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    // Tiempo en etapa ANTES de mover — después de la RPC la vista ya
    // apunta a la etapa nueva y el dato se habría perdido. Se lee solo
    // `stage_entered_at`: la columna hermana `time_in_stage` es un
    // `interval` que PostgREST serializa como texto de formato variable.
    const { data: timeRow } = await admin
      .from('deal_time_in_stage')
      .select('stage_entered_at')
      .eq('deal_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const stageEnteredAt = (timeRow?.stage_entered_at as string | null) ?? null
    const delta = stageDelta(stageEnteredAt, Date.now())
    // Edad del trato con la misma aritmética, renombrada: es otro reloj.
    const age = stageDelta((deal.created_at as string | null) ?? null, Date.now())
    const dealAge = {
      deal_age_hours: age.time_in_stage_hours,
      deal_age_days: age.time_in_stage_days,
    }

    // ── La transición ───────────────────────────────────────
    // Con el cliente de sesión, obligatoriamente (ver cabecera).
    const { data: rpcData, error: rpcError } = await ctx.supabase.rpc('transition_deal', {
      p_deal_id: id,
      p_to_stage_id: toStageId,
      p_new_status: newStatus,
      p_triggered_by: triggeredBy,
      p_evidence: body.evidence ?? null,
      p_override_reason: overrideReason,
      p_expected_version: expectedVersion,
    })

    if (rpcError) {
      // Los `raise` de la RPC llevan el id en el texto ('deal % no
      // existe', 'stage % no existe en esta cuenta'): no se reenvían al
      // cliente. Se registran y se colapsan a genéricos.
      console.error('[deals/transition] transition_deal failed:', rpcError)
      const message = rpcError.message ?? ''
      if (message.includes('forbidden')) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const result = (rpcData ?? {}) as TransitionResult

    // ── El despacho ─────────────────────────────────────────
    // Las vars son las MISMAS para los tres disparadores de esta ruta
    // (`deal_stage_changed`, `deal_won`, `deal_lost`): describen el deal y
    // el momento, no el evento. Se construyen una sola vez, antes de
    // decidir qué se despacha.
    //
    // DOS relojes distintos, y confundirlos hace mentir a una plantilla:
    //
    //  · `time_in_stage_*` es lo que el trato llevaba EN SU ÚLTIMA ETAPA,
    //    medido antes de la RPC (después ya se habría reiniciado).
    //  · `deal_age_*` es lo que lleva vivo desde que se creó. Es la que
    //    responde «cuánto tardó en cerrarse»: un trato de tres meses que
    //    pasó los dos últimos días en Negociación cierra con
    //    time_in_stage_days = 2 y deal_age_days = 91.
    //
    // `from_stage_name` es útil en el movimiento y redundante en un cierre
    // sin movimiento (es la misma etapa); se deja igualmente, porque una
    // var de más no rompe nada y quitarla obligaría a mantener dos objetos.
    const contactId = (deal.contact_id as string | null) ?? null
    const pipelineId = deal.pipeline_id as string
    const vars = {
      deal_id: id,
      deal_name: deal.title as string,
      deal_value: toNumber(deal.value),
      pipeline_name: pipeline?.name ?? null,
      from_stage_name: fromStage?.name ?? null,
      to_stage_name: toStage.name,
      deal_status: result.status ?? (deal.status as string),
      stage_entered_at: stageEnteredAt,
      ...delta,
      created_at: (deal.created_at as string | null) ?? null,
      ...dealAge,
    }

    // Dos condiciones, y la segunda no es redundante:
    //
    //  · `ok:true` descarta VERSION_CONFLICT y NO_OP, que no cambian nada.
    //  · La etapa tiene que cambiar DE VERDAD. Los botones ganado/perdido/
    //    reabrir (deal-form.tsx) llaman aquí con `to_stage_id` igual a la
    //    etapa actual y solo `new_status`: la guarda NO_OP de la RPC no
    //    salta —el status sí cambia— y sin esta comprobación un trigger
    //    llamado «cambio de etapa» dispararía sin que el deal se moviera,
    //    con un texto que diría «pasó de Negociación a Negociación» y
    //    mensajes reales al contacto. La misma regla usa la vista
    //    `deal_time_in_stage` (063), que ignora los `state_changed` con
    //    `from_stage = to_stage` precisamente por esto.
    //
    // El ganado/perdido es otro evento y tiene su propio trigger, justo
    // debajo.
    if (result.ok === true && toStageId !== deal.stage_id) {
      await dispatchStageChanged({
        accountId: ctx.accountId,
        contactId,
        dealId: id,
        pipelineId,
        fromStageId: (deal.stage_id as string | null) ?? null,
        toStageId,
        vars,
      })
    }

    // ── El cierre: `deal_won` / `deal_lost` ─────────────────
    // `result.status` es el status NUEVO —la RPC lo calcula como
    // `coalesce(p_new_status, stage.stage_status, deal.status)` (069:100) y
    // lo devuelve en el jsonb de éxito (069:165-170)—, mientras que
    // `deal.status` es el ANTES, leído antes de la RPC. La condición es el
    // CAMBIO de status, no el status a secas: reabrir un ganado y volver a
    // moverlo dentro de `won` no vuelve a cerrar nada.
    //
    // Ojo con el `stage_status` de la etapa destino (058): arrastrar en el
    // kanban a una etapa marcada `won` cierra el trato SIN que el cliente
    // mande `new_status`. Por eso se mira el resultado de la RPC y no el
    // body.
    //
    // ESTO ES INDEPENDIENTE DEL BLOQUE DE ARRIBA, Y ES DELIBERADO: mover un
    // trato a una etapa terminal es a la vez un movimiento y un cierre, así
    // que despacha los DOS disparadores. Parece un bug —«se ha enviado dos
    // veces»— y no lo es: son dos hechos distintos y cada automatización
    // decide a cuál se suscribe. El orden de los `await` es el orden en que
    // salen los mensajes: primero el movimiento, después el cierre.
    //
    // Diferencia consciente con la RPC: ella deduplica la conversión
    // `deal_won` de `tracking_events` con un `event_id` determinístico
    // (069:142-157), así que won→open→won inserta una sola conversión. El
    // disparador NO comparte esa dedup — es un evento de negocio que vuelve
    // a ocurrir, y silenciarlo dejaría un ganado sin seguimiento.
    const previousStatus = deal.status as string
    const nextStatus = result.status ?? null
    if (
      result.ok === true &&
      (nextStatus === 'won' || nextStatus === 'lost') &&
      nextStatus !== previousStatus
    ) {
      await dispatchDealOutcome({
        triggerType: nextStatus === 'won' ? 'deal_won' : 'deal_lost',
        accountId: ctx.accountId,
        contactId,
        dealId: id,
        pipelineId,
        toStageId,
        vars,
      })
    }

    // El jsonb de la RPC tal cual, siempre 200. La UI decide por `code`.
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ------------------------------------------------------------
// Despacho a Automation — vale para los dos helpers de abajo.
//
// Se ESPERA (no es una promesa suelta) y se envuelve en su propio
// try/catch. Dejarla flotando parece más rápido, pero en un runtime
// serverless la respuesta cierra la invocación y el fan-out se queda a
// medias — con un WhatsApp enviado y el siguiente no. El motor ya es
// fire-and-forget por dentro y nunca lanza (engine.ts:140-142); el
// try/catch de aquí es el cinturón para que un fallo de import o de red
// tampoco pueda convertir una transición YA COMMITEADA en un 500.
//
// Mismo modelo que `dispatchAppointmentEvent` (appointments/queries.ts).
// Las vars son escalares planos a propósito: `interpolateMessage` solo
// resuelve un nivel de punto, así que `{{vars.deal.stage}}` no existiría.
// ------------------------------------------------------------
async function dispatchStageChanged(args: {
  accountId: string
  contactId: string | null
  dealId: string
  pipelineId: string
  fromStageId: string | null
  toStageId: string
  vars: Record<string, unknown>
}): Promise<void> {
  try {
    await runAutomationsForTrigger({
      accountId: args.accountId,
      triggerType: 'deal_stage_changed',
      contactId: args.contactId,
      context: {
        deal_id: args.dealId,
        pipeline_id: args.pipelineId,
        from_stage_id: args.fromStageId,
        to_stage_id: args.toStageId,
        vars: args.vars,
      },
    })
  } catch (err) {
    console.error('[deals/transition] deal_stage_changed dispatch failed:', err)
  }
}

/**
 * Cierre del trato — `deal_won` / `deal_lost`. Mismo contrato que
 * `dispatchStageChanged` (awaited, try/catch propio, nunca tumba la
 * respuesta) y por las mismas razones; lo que cambia es el contexto.
 *
 * No manda `from_stage_id`: un cierre no describe un movimiento, y estos
 * disparadores solo filtran por `pipeline_id` (`DealTriggerConfig`).
 * `to_stage_id` va porque es la etapa en la que QUEDA el trato y sale
 * gratis del contexto que ya se tiene.
 */
async function dispatchDealOutcome(args: {
  triggerType: 'deal_won' | 'deal_lost'
  accountId: string
  contactId: string | null
  dealId: string
  pipelineId: string
  toStageId: string
  vars: Record<string, unknown>
}): Promise<void> {
  try {
    await runAutomationsForTrigger({
      accountId: args.accountId,
      triggerType: args.triggerType,
      contactId: args.contactId,
      context: {
        deal_id: args.dealId,
        pipeline_id: args.pipelineId,
        to_stage_id: args.toStageId,
        vars: args.vars,
      },
    })
  } catch (err) {
    console.error(`[deals/transition] ${args.triggerType} dispatch failed:`, err)
  }
}
