import { Resend } from 'resend'

import { loadEmailConfig } from '@/lib/email/send'

// ============================================================
// Reenvío opcional de cada correo entrante a una bandeja externa.
//
// Lo dispara el webhook `email.received` (/api/email/inbound) DESPUÉS de
// una ingesta exitosa (`result.status === 'stored'`): el dedupe por
// `provider_message_id` de email-ingest.ts garantiza que cada correo se
// reenvíe a lo sumo una vez, aunque Resend reentregue el webhook.
//
// Config: EMAIL_FORWARD_TO — lista separada por comas. Vacía o ausente
// = apagado (el repo es público: ningún destino hardcodeado).
//
// API verificada contra el SDK instalado (resend@6.18.1):
//   node_modules/resend/dist/index.d.mts:1782
//   `emails.receiving.forward({ emailId, to, from, passthrough? })`
//   `passthrough` es el comportamiento por defecto: conserva el contenido
//   y los adjuntos originales del correo entrante.
//
// Fail-open: nunca lanza. La ruta siempre puede ackear 200 aunque el
// reenvío falle — la ingesta ya se hizo y un 500 haría que Resend
// reintentara (duplicando ingesta y reenvíos).
// ============================================================

export type ForwardStatus = 'forwarded' | 'skipped' | 'failed'

export interface ForwardResult {
  status: ForwardStatus
  /** Motivo del skip/fallo, o el id del reenvío cuando fue `forwarded`. */
  detail?: string
}

/**
 * Destinos de EMAIL_FORWARD_TO: separados por comas, recortados, sin
 * vacíos ni duplicados. Vacío → el reenvío está apagado.
 */
export function forwardTargets(): string[] {
  const raw = process.env.EMAIL_FORWARD_TO ?? ''
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(list)]
}

/**
 * Reenvía el correo `emailId` (ya ingestado) a todos los destinos de
 * EMAIL_FORWARD_TO, con `from` = bandeja receptora de la cuenta
 * (`email_config.from_email`) para que el DKIM cuadre y no caiga en spam.
 *
 * La key es la misma que usa el envío saliente: está encriptada en
 * `email_config` y tiene permiso de envío (`loadEmailConfig` → `decrypt`).
 * Nunca lanza.
 */
export async function forwardReceivedEmail(
  accountId: string,
  emailId: string,
): Promise<ForwardResult> {
  const to = forwardTargets()
  if (to.length === 0) {
    return { status: 'skipped', detail: 'EMAIL_FORWARD_TO sin configurar' }
  }

  try {
    const { apiKey, fromEmail } = await loadEmailConfig(accountId)
    const resend = new Resend(apiKey)
    const { data, error } = await resend.emails.receiving.forward({
      emailId,
      to,
      from: fromEmail,
    })
    if (error) return { status: 'failed', detail: error.message }
    return { status: 'forwarded', detail: data?.id }
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
