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
// PERMISOS (comprobado en producción 2026-09-26): en el SDK `forward()`
// NO es un endpoint remoto — hace `GET /emails/receiving/{id}` para bajar
// el raw (index.mjs:766-806) y luego `POST /emails` con ese raw. Exige
// entonces una key con FULL ACCESS: con una key `sending_access` (p. ej.
// la de la cuenta, `crm-send`) truena con "This API key is restricted to
// only send emails". Por eso se usa RESEND_INBOUND_API_KEY (key
// `crm-inbound-body`, Full access — la misma que ya baja los cuerpos).
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
 * EMAIL_FORWARD_TO. `from` debe ser la bandeja receptora de la cuenta
 * (`email_config.from_email`) para que el DKIM cuadre y no caiga en spam.
 *
 * Key: RESEND_INBOUND_API_KEY (Full access: lee receiving + envía). Si
 * no estuviera definida se cae a la key encriptada de la cuenta
 * (`loadEmailConfig` → `decrypt`), que sirve solo si esa key también es
 * Full access. Nunca lanza.
 */
export async function forwardReceivedEmail(
  accountId: string,
  emailId: string,
  from: string,
): Promise<ForwardResult> {
  const to = forwardTargets()
  if (to.length === 0) {
    return { status: 'skipped', detail: 'EMAIL_FORWARD_TO sin configurar' }
  }

  try {
    const apiKey =
      process.env.RESEND_INBOUND_API_KEY || (await loadEmailConfig(accountId)).apiKey
    const resend = new Resend(apiKey)
    const { data, error } = await resend.emails.receiving.forward({
      emailId,
      to,
      from,
    })
    if (error) return { status: 'failed', detail: error.message }
    return { status: 'forwarded', detail: data?.id }
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
