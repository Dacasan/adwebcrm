import { describe, expect, it } from 'vitest'

import { stageDelta } from './stage-delta'

/**
 * Contrato de las vars `time_in_stage_*` que la ruta de transición manda
 * a las automatizaciones: horas ENTERAS, días con UN decimal, y nunca un
 * valor que rompa la serialización a JSON del contexto (NaN, Infinity o
 * un negativo).
 */
const NOW = new Date('2026-08-29T12:00:00.000Z')

describe('stageDelta', () => {
  it('da horas enteras (trunca, no redondea)', () => {
    // 5h 59m → 5 horas cumplidas, no 6.
    const d = stageDelta('2026-08-29T06:01:00.000Z', NOW)
    expect(d.time_in_stage_hours).toBe(5)
  })

  it('cuenta horas completas también cuando pasan de un día', () => {
    // 3 días exactos = 72 h.
    expect(stageDelta('2026-08-26T12:00:00.000Z', NOW).time_in_stage_hours).toBe(72)
  })

  it('da días con un solo decimal', () => {
    // 2 días 10 h = 2.4166… → 2.4
    const d = stageDelta('2026-08-27T02:00:00.000Z', NOW)
    expect(d.time_in_stage_days).toBe(2.4)
    // Un solo decimal de verdad: nada de 2.4000000000000004.
    expect(String(d.time_in_stage_days)).toBe('2.4')
  })

  it('redondea los días al decimal más cercano', () => {
    // 2 días 7 h = 2.2916… → 2.3
    expect(stageDelta('2026-08-27T05:00:00.000Z', NOW).time_in_stage_days).toBe(2.3)
  })

  it('devuelve ceros cuando no hay fecha de entrada', () => {
    expect(stageDelta(null, NOW)).toEqual({
      time_in_stage_hours: 0,
      time_in_stage_days: 0,
    })
    expect(stageDelta(undefined, NOW)).toEqual({
      time_in_stage_hours: 0,
      time_in_stage_days: 0,
    })
    expect(stageDelta('', NOW)).toEqual({
      time_in_stage_hours: 0,
      time_in_stage_days: 0,
    })
  })

  it('devuelve ceros ante una fecha no parseable, nunca NaN', () => {
    const d = stageDelta('no soy una fecha', NOW)
    expect(d).toEqual({ time_in_stage_hours: 0, time_in_stage_days: 0 })
    expect(Number.isNaN(d.time_in_stage_hours)).toBe(false)
    // El contexto se serializa a automation_pending_executions.context:
    // un NaN se convertiría en null al pasar por JSON.
    expect(JSON.parse(JSON.stringify(d))).toEqual(d)
  })

  it('satura a cero una fecha futura (desfase de reloj Postgres/Node)', () => {
    const d = stageDelta('2026-08-30T12:00:00.000Z', NOW)
    expect(d).toEqual({ time_in_stage_hours: 0, time_in_stage_days: 0 })
  })

  it('da cero para una entrada justo ahora, sin negativos por milisegundos', () => {
    expect(stageDelta(NOW.toISOString(), NOW)).toEqual({
      time_in_stage_hours: 0,
      time_in_stage_days: 0,
    })
  })

  it('acepta el "ahora" como epoch en milisegundos', () => {
    expect(stageDelta('2026-08-29T06:00:00.000Z', NOW.getTime())).toEqual(
      stageDelta('2026-08-29T06:00:00.000Z', NOW),
    )
  })

  it('es pura: no depende del reloj real ni muta la entrada', () => {
    const entered = '2026-08-28T12:00:00.000Z'
    const first = stageDelta(entered, NOW)
    const second = stageDelta(entered, NOW)
    expect(first).toEqual(second)
    expect(first).toEqual({ time_in_stage_hours: 24, time_in_stage_days: 1 })
  })
})
