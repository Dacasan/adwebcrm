// ============================================================
// Default stages for a newly created pipeline.
//
// They used to live as a constant inside `pipelines/page.tsx` —a
// client component is not the place for product definition— and they were
// four generic names with no rules. Here they are twelve stages with their
// terminal status and their confirmation checklist.
//
// Stages remain user-editable: this is the starting point, not a cage.
// ============================================================

export interface DefaultStage {
  name: string;
  color: string;
  position: number;
  /** Deal status when entering the stage. Consumed by `transition_deal`. */
  stage_status: 'open' | 'won' | 'lost';
  /** Human confirmation checklist before moving to this stage (067). */
  checklist: { id: string; text: string; position: number }[];
}

/**
 * The checklist is a CONFIRMATION list, not a wall: the agent reviews it
 * before moving the deal and proceeds anyway. A CRM that blocks the seller
 * gets abandoned within a week.
 *
 * Each item carries a DETERMINISTIC `id` (stable across deploys, so the
 * transition modal can toggle by id without the "mark one → marks all"
 * bug that `{ text }`-only seeds caused) and its `position` in the list.
 */
export function checklistItem(text: string, position: number): { id: string; text: string; position: number } {
  return { id: `chk-${hashText(text)}`, text, position };
}

/** FNV-1a 32-bit → hex. Collision-safe enough for a checklist id. */
function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const DEFAULT_STAGES: readonly DefaultStage[] = [
  {
    name: 'Lead created',
    color: '#94a3b8',
    position: 0,
    stage_status: 'open',
    checklist: [
      checklistItem('Contact date and time confirmed', 0),
      checklistItem('Contact reason of interest noted', 1),
      checklistItem('Preferred channel recorded', 2),
    ],
  },
  {
    name: 'Contact attempted',
    color: '#64748b',
    position: 1,
    stage_status: 'open',
    checklist: [
      checklistItem('Contact attempt recorded', 0),
      checklistItem('Method and time noted', 1),
    ],
  },
  {
    name: 'Contacted',
    color: '#3b82f6',
    position: 2,
    stage_status: 'open',
    checklist: [
      checklistItem('Conversation held with the contact', 0),
      checklistItem('Contact response recorded', 1),
    ],
  },
  {
    name: 'Interest confirmed',
    color: '#0ea5e9',
    position: 3,
    stage_status: 'open',
    checklist: [
      checklistItem('Interest confirmed by the contact', 0),
      checklistItem('Main need identified', 1),
      checklistItem('Next step agreed', 2),
    ],
  },
  {
    name: 'Qualified',
    color: '#eab308',
    position: 4,
    stage_status: 'open',
    checklist: [
      checklistItem('Approximate budget known', 0),
      checklistItem('Decision maker identified', 1),
      checklistItem('Purchase timeline estimated', 2),
    ],
  },
  {
    name: 'Proposal accepted',
    color: '#f97316',
    position: 5,
    stage_status: 'open',
    checklist: [
      checklistItem('Proposal sent to the contact', 0),
      checklistItem('Pricing and scope accepted', 1),
    ],
  },
  {
    name: 'Booking confirmed',
    color: '#a855f7',
    position: 6,
    stage_status: 'open',
    checklist: [
      checklistItem('Booking date and time confirmed', 0),
      checklistItem('Reminder scheduled', 1),
    ],
  },
  {
    name: 'Service started',
    color: '#8b5cf6',
    position: 7,
    stage_status: 'open',
    checklist: [
      checklistItem('Service started on the agreed date', 0),
      checklistItem('Contact point assigned', 1),
    ],
  },
  {
    name: 'Service completed',
    color: '#22c55e',
    position: 8,
    stage_status: 'won',
    checklist: [
      checklistItem('Service fully delivered', 0),
      checklistItem('Payment processed', 1),
      checklistItem('Client feedback collected', 2),
    ],
  },
  // ── Three terminal branches, deliberately different ──
  // `No answer` is RECOVERABLE: it deserves reactivation.
  // `Long term` is an open stage, NOT lost (product spec): the prospect is
  // still in the funnel, just with a longer purchase timeline.
  // `Withdrew` is not recoverable: if they said no, they said no, and
  // insisting burns the list.
  {
    name: 'No answer',
    color: '#f43f5e',
    position: 9,
    stage_status: 'lost',
    checklist: [
      checklistItem('Contact attempted via at least 2 channels', 0),
      checklistItem('Follow-up message left', 1),
      checklistItem('Retry scheduled', 2),
    ],
  },
  {
    name: 'Long term',
    color: '#fb923c',
    position: 10,
    stage_status: 'open',
    checklist: [
      checklistItem('Future purchase timeline noted', 0),
      checklistItem('Long-term follow-up scheduled', 1),
    ],
  },
  {
    name: 'Withdrew',
    color: '#ef4444',
    position: 11,
    stage_status: 'lost',
    checklist: [
      checklistItem('Reason for withdrawing recorded', 0),
      checklistItem('Re-engagement opportunity evaluated', 1),
    ],
  },
] as const;

/** The only terminal lost branch that admits reactivation. */
export const RECOVERABLE_LOST_STAGES = ['No answer'] as const;

/** The terminal branch that is NOT reactivated. */
export const FINAL_LOST_STAGE = 'Withdrew';

/** Rows ready to insert into `pipeline_stages`. */
export function defaultStageRows(pipelineId: string) {
  return DEFAULT_STAGES.map((s) => ({
    pipeline_id: pipelineId,
    name: s.name,
    color: s.color,
    position: s.position,
    stage_status: s.stage_status,
    checklist: s.checklist,
  }));
}

/** PostgREST code for "that column does not exist". */
const UNDEFINED_COLUMN = '42703';

/**
 * Inserts the default stages of a newly created pipeline.
 *
 * `stage_status` was added by migration 058 and `checklist` by 067. If one of
 * those migrations has not been applied yet, the whole insert would fail with
 * 42703 and **creating a pipeline would stop working**. Rather than breaking
 * something that works today, it retries without those columns in cascade:
 * the pipeline is born with its twelve stages and only loses what the
 * migration does not provide yet.
 */
export async function insertDefaultStages(
  supabase: {
    from: (table: string) => {
      insert: (rows: unknown[]) => PromiseLike<{ error: { code?: string } | null }>;
    };
  },
  pipelineId: string
): Promise<void> {
  const rows = defaultStageRows(pipelineId);
  const { error } = await supabase.from('pipeline_stages').insert(rows);
  if (!error) return;

  if (error.code === UNDEFINED_COLUMN) {
    console.warn(
      '[pipelines] `stage_status` or `checklist` do not exist yet — apply ' +
        'migrations 058 and 067. Stages are created without automatic terminal ' +
        'status or checklist.'
    );
    const legacy = rows.map(
      ({ stage_status: _ignored, checklist: _ignored2, ...rest }) => rest
    );
    await supabase.from('pipeline_stages').insert(legacy);
    return;
  }

  console.error('[pipelines] could not create the default stages:', error);
}