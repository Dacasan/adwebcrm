import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The modal reads translations via next-intl's useTranslations hook, which
// requires a provider at runtime. In the node test environment we stub it
// with the keypath itself so assertions are language-agnostic.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// The real Dialog (base-ui) renders its popup through a portal, which
// mounts nothing under renderToStaticMarkup (node env, no DOM). We stub the
// primitives to render their children so the modal's own logic — checklist
// rendering, confirm availability, stage names — is what gets pinned.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-desc">{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
}))

import { StageTransitionModal } from './stage-transition-modal'
import type { PipelineStage } from '@/types'

function makeStage(overrides: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 'stage-1',
    pipeline_id: 'pipeline-1',
    name: 'Contactado',
    position: 2,
    color: '#3b82f6',
    stage_status: 'open',
    checklist: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const fromStage = makeStage({ id: 'from-1', name: 'Lead creado', position: 0 })

function renderModal(overrides: Partial<React.ComponentProps<typeof StageTransitionModal>> = {}) {
  return renderToStaticMarkup(
    React.createElement(StageTransitionModal, {
      open: true,
      onOpenChange: () => {},
      fromStage,
      toStage: makeStage(),
      onConfirm: () => {},
      ...overrides,
    }),
  )
}

describe('StageTransitionModal', () => {
  it('renders without crashing', () => {
    expect(() => renderModal()).not.toThrow()
  })

  it('renders the checklist items of the destination stage', () => {
    const toStage = makeStage({
      id: 'to-1',
      name: 'Calificado',
      checklist: [
        { id: 'c1', text: 'Presupuesto aproximado conocido', position: 0 },
        { id: 'c2', text: 'Decisor identificado', position: 1 },
      ],
    })
    const html = renderModal({ toStage })
    expect(html).toContain('Presupuesto aproximado conocido')
    expect(html).toContain('Decisor identificado')
  })

  it('shows the stage transition (from → to) in the description', () => {
    const toStage = makeStage({
      id: 'to-1',
      name: 'Calificado',
      checklist: [{ id: 'c1', text: 'Presupuesto aproximado conocido', position: 0 }],
    })
    const html = renderModal({ toStage })
    expect(html).toContain('Lead creado')
    expect(html).toContain('Calificado')
  })

  it('renders a confirm button that is always available (non-blocking)', () => {
    const toStage = makeStage({
      checklist: [
        { id: 'c1', text: 'Presupuesto aproximado conocido', position: 0 },
        { id: 'c2', text: 'Decisor identificado', position: 1 },
      ],
    })
    const html = renderModal({ toStage })
    // The confirm button is rendered unconditionally — the checklist is a
    // review aid, never a blocker (migration 067 removes the guards system).
    expect(html).toContain('confirmAndMove')
  })

  it('handles a stage without a checklist gracefully', () => {
    const html = renderModal({ toStage: makeStage({ checklist: [] }) })
    expect(html).toContain('noChecklistRequired')
  })

  it('renders a cancel button', () => {
    const html = renderModal()
    expect(html).toContain('cancel')
  })
})