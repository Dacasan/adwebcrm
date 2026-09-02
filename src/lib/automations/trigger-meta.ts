import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    label: 'Button / List Reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },
  missed_call: {
    label: 'Missed Call',
    pillClass: 'border-red-500/30 bg-red-500/10 text-red-300',
  },
  message_read: {
    label: 'Message Read',
    pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  message_delivered: {
    label: 'SMS Delivered',
    pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  message_failed: {
    label: 'SMS Failed',
    pillClass: 'border-red-500/30 bg-red-500/10 text-red-300',
  },
  // ── Appointment (agenda interna) ────────────────────────────
  appointment_created: {
    label: 'Appointment Created',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  appointment_updated: {
    label: 'Appointment Updated',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  appointment_rescheduled: {
    label: 'Appointment Rescheduled',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  appointment_cancelled: {
    label: 'Appointment Cancelled',
    pillClass: 'border-red-500/30 bg-red-500/10 text-red-300',
  },
  appointment_completed: {
    label: 'Appointment Completed',
    pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  appointment_no_show: {
    label: 'Appointment No-Show',
    pillClass: 'border-red-500/30 bg-red-500/10 text-red-300',
  },
  // ── Deals (pipeline) ────────────────────────────────────────
  // Índigo: los colores ya en uso están tomados por canales de entrada
  // (blue/teal/purple/cyan/pink) o por semántica de resultado
  // (emerald = éxito, red = fallo, amber = cambio), y el pipeline no es
  // ninguna de las dos cosas.
  deal_stage_changed: {
    label: 'Deal Stage Changed',
    pillClass: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  },
  // Violeta para el alta: vecina del índigo, así el ojo lee de un vistazo
  // que las dos píldoras son del mismo dominio (pipeline) sin confundirlas
  // con los canales de entrada (blue/teal/purple/cyan/pink).
  deal_created: {
    label: 'Deal Created',
    pillClass: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  },
  // El cierre sí es semántica de resultado, pero se usan verde y rosa en
  // vez del emerald/red de mensajes y citas: un trato ganado no es "una
  // entrega correcta" ni un trato perdido "un fallo del sistema", y
  // mezclarlos en la lista haría creer que algo se rompió.
  deal_won: {
    label: 'Deal Won',
    pillClass: 'border-green-500/30 bg-green-500/10 text-green-300',
  },
  deal_lost: {
    label: 'Deal Lost',
    pillClass: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
