import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAGES,
  RECOVERABLE_LOST_STAGES,
  FINAL_LOST_STAGE,
  defaultStageRows,
} from './default-stages'

/**
 * Contract of the stages seed (migration 067).
 *
 * The guards system (guard_rules/required_evidence/allow_override) was
 * REMOVED by product decision: a CRM that blocks the seller gets abandoned.
 * Instead each stage carries a human CONFIRMATION `checklist` that the UI
 * shows when moving a deal — it never blocks, it only reminds.
 *
 * All stage names are in English: the product locale is English (see
 * `NEXT_PUBLIC_APP_LOCALE`). Spanish stage names are gone.
 */
describe('DEFAULT_STAGES', () => {
  it('define 12 stages (open → won/lost)', () => {
    expect(DEFAULT_STAGES).toHaveLength(12)
    expect(DEFAULT_STAGES[0].name).toBe('Lead created')
    expect(DEFAULT_STAGES[8].name).toBe('Service completed')
    expect(DEFAULT_STAGES[11].name).toBe('Withdrew')
  })

  it('has NO guard_rules anywhere — the guards system is gone (067)', () => {
    for (const stage of DEFAULT_STAGES) {
      expect(stage).not.toHaveProperty('guard_rules')
      expect(stage).not.toHaveProperty('required_evidence')
    }
  })

  it('gives every stage a non-empty confirmation checklist', () => {
    for (const stage of DEFAULT_STAGES) {
      expect(stage.checklist.length).toBeGreaterThan(0)
      for (const item of stage.checklist) {
        expect(item.text.trim().length).toBeGreaterThan(0)
        // Deterministic ids + position: the transition modal toggles by
        // item.id, so seeds without ids made every item share `undefined`
        // and marking one marked ALL of them.
        expect(typeof item.id).toBe('string')
        expect(item.id.length).toBeGreaterThan(0)
        expect(typeof item.position).toBe('number')
      }
    }
  })

  it('keeps terminal statuses: Service completed = won, Long term = open (spec)', () => {
    const byName = new Map(DEFAULT_STAGES.map((s) => [s.name, s.stage_status]))
    expect(byName.get('Service completed')).toBe('won')
    expect(byName.get('No answer')).toBe('lost')
    expect(byName.get('Long term')).toBe('open') // spec: Long term is NOT lost
    expect(byName.get('Withdrew')).toBe('lost')
    expect(byName.get('Lead created')).toBe('open')
  })

  it('keeps the recoverable/final lost branches contract', () => {
    // Only "No answer" is a recoverable lost branch. "Long term" is open
    // (spec), so it is NOT in the lost-recoverable set anymore.
    expect([...RECOVERABLE_LOST_STAGES]).toEqual(['No answer'])
    expect(FINAL_LOST_STAGE).toBe('Withdrew')
  })

  it('defaultStageRows carries stage_status + checklist for the insert', () => {
    const rows = defaultStageRows('pipeline-1')
    expect(rows).toHaveLength(12)
    for (const row of rows) {
      expect(row.pipeline_id).toBe('pipeline-1')
      expect(row.stage_status).toBeDefined()
      expect(Array.isArray(row.checklist)).toBe(true)
      expect(row.checklist.length).toBeGreaterThan(0)
    }
  })

  it('checklist items carry stable ids + position in the DB rows', () => {
    const rows = defaultStageRows('pipeline-1')
    for (const row of rows) {
      row.checklist.forEach((item: { id: string; text: string; position: number }, i: number) => {
        expect(typeof item.text).toBe('string')
        // Position matches the definition order; ids are unique per item.
        expect(item.position).toBe(i)
        expect(item.id).toBeTruthy()
      })
    }
    // Determinism: seeding twice yields the same ids (no random UUIDs that
    // would break the toggle-by-id contract across reloads).
    const again = defaultStageRows('pipeline-1')
    expect(again[0].checklist.map((c) => c.id)).toEqual(
      rows[0].checklist.map((c) => c.id),
    )
  })
})