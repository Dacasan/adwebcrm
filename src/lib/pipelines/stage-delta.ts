// ============================================================
// stage-delta — cuánto llevaba un deal en su etapa, en unidades
// que una automatización pueda escribir en un mensaje.
//
// Vive fuera de la ruta porque es la única parte del despacho de
// `deal_stage_changed` que tiene aritmética propia, y la aritmética
// sin BD se testea sola. La ruta solo la llama.
//
// La entrada es `stage_entered_at` de la vista `deal_time_in_stage`
// (migración 063). La columna hermana `time_in_stage` NO se usa: es
// un `interval` de Postgres y PostgREST lo serializa como texto de
// formato variable ('3 days 04:15:00', '00:20:00'), así que parsearlo
// es frágil. Se recalcula aquí desde el timestamp, igual que hace
// `loadTimeInStage` en src/lib/reporting/queries.ts.
// ============================================================

export interface StageDelta {
  /** Horas COMPLETAS en la etapa. Entero, para leerse en un mensaje. */
  time_in_stage_hours: number
  /** Días en la etapa con un decimal (2.4), no una fracción infinita. */
  time_in_stage_days: number
}

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/**
 * Delta entre la entrada en la etapa y `now`.
 *
 * Ambos valores acaban en `context.vars` y se interpolan como
 * `{{vars.time_in_stage_days}}`, que renderiza con `String(value)`: por
 * eso son números ya redondeados y no fracciones crudas — nadie quiere
 * "lleva 2.4000000000000004 días" en un WhatsApp.
 *
 * Casos degenerados, todos a cero en vez de a NaN/negativo, porque el
 * valor viaja a `automation_pending_executions.context` (se serializa a
 * JSON y sobrevive al paso `wait`) y un NaN allí se convierte en `null`
 * silenciosamente:
 *  - sin fecha (`null`/`undefined`): el deal no tiene `state_changed` ni
 *    `created_at` legible.
 *  - fecha no parseable: dato corrupto.
 *  - fecha futura: reloj desfasado entre Postgres (`now()` de la vista)
 *    y Node. Se satura a 0 — "lleva -3 horas en la etapa" no es un dato,
 *    es un bug enseñado al cliente.
 */
export function stageDelta(
  stageEnteredAt: string | null | undefined,
  now: Date | number,
): StageDelta {
  if (!stageEnteredAt) return { time_in_stage_hours: 0, time_in_stage_days: 0 }

  const entered = new Date(stageEnteredAt).getTime()
  if (Number.isNaN(entered)) return { time_in_stage_hours: 0, time_in_stage_days: 0 }

  const nowMs = now instanceof Date ? now.getTime() : now
  if (Number.isNaN(nowMs)) return { time_in_stage_hours: 0, time_in_stage_days: 0 }

  const elapsed = Math.max(0, nowMs - entered)

  return {
    time_in_stage_hours: Math.floor(elapsed / MS_PER_HOUR),
    time_in_stage_days: Math.round((elapsed / MS_PER_DAY) * 10) / 10,
  }
}
