import { sendEmail } from "@/lib/email/send"
import { forwardTargets } from "@/lib/email/forward"

// ============================================================
// Aviso de lead nuevo a la bandeja externa (EMAIL_FORWARD_TO).
//
// Lo dispara POST /api/events (event_type=form_submit) DESPUÉS de crear
// el contacto: el formulario que entra al CRM también llega por correo
// a quien supervisa la cuenta. Reutiliza los destinos del reenvío de
// correo entrante (forwardTargets — misma variable EMAIL_FORWARD_TO;
// repo público, ningún destino hardcodeado; vacía = apagado) y la
// primitiva de envío sendEmail (config + from_email de la cuenta → el
// DKIM cuadra igual que en el reenvío).
//
// Fail-open: NUNCA lanza (mismo contrato que forwardReceivedEmail). El
// lead ya está creado cuando se llama; un fallo de correo jamás tumba
// el alta ni el 202 del formulario.
// ============================================================

export interface NewLeadInfo {
  /** Nombre del lead (payload del formulario, opcional). */
  name?: string
  email?: string
  phone: string
  consent?: boolean
  refCode?: string | null
  landingSlug?: string | null
  utm?: {
    source?: string
    medium?: string
    campaign?: string
    term?: string
    content?: string
  }
}

export interface LeadNotifyResult {
  status: "sent" | "skipped" | "failed"
  /** Motivo del skip/fallo, o los ids de Resend cuando fue `sent`. */
  detail?: string
}

/** Escapado mínimo de HTML: el payload del formulario es free-form. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Fila de la tabla del correo; sin valor → no se emite. */
function row(label: string, value: string | undefined | null): string {
  if (!value) return ""
  return (
    '<tr><td style="padding:6px 12px;color:#666;border-bottom:1px solid #eee">' +
    esc(label) +
    '</td><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600">' +
    esc(value) +
    "</td></tr>"
  )
}

/**
 * Manda un aviso por cada lead de formulario a todos los destinos de
 * EMAIL_FORWARD_TO. Nunca lanza: los errores vuelven como
 * `status: "failed"` para que la ruta solo loguee.
 */
export async function notifyNewLead(
  accountId: string,
  lead: NewLeadInfo,
): Promise<LeadNotifyResult> {
  const to = forwardTargets()
  if (to.length === 0) {
    return { status: "skipped", detail: "EMAIL_FORWARD_TO sin configurar" }
  }

  try {
    const name = lead.name?.trim()
    // Subject en una línea: el payload es free-form y no debe meter
    // saltos en la cabecera.
    const label = (name || lead.phone).replace(/[\r\n\t]+/g, " ")
    const subject = `Nuevo lead: ${label}`
    const utm = lead.utm
    const html = [
      '<div style="font-family:sans-serif">',
      '<h2 style="margin:0 0 12px">Nuevo lead del formulario</h2>',
      '<table style="border-collapse:collapse">',
      row("Nombre", name),
      row("Email", lead.email),
      row("Teléfono", lead.phone),
      row("Consentimiento", lead.consent === undefined ? undefined : lead.consent ? "sí" : "no"),
      row("Página", lead.landingSlug),
      row("Código", lead.refCode),
      row("UTM source", utm?.source),
      row("UTM medium", utm?.medium),
      row("UTM campaign", utm?.campaign),
      row("UTM term", utm?.term),
      row("UTM content", utm?.content),
      row("Recibido", new Date().toISOString()),
      "</table>",
      "</div>",
    ].join("")

    const ids: string[] = []
    for (const dest of to) {
      const { id } = await sendEmail(accountId, { to: dest, subject, html })
      ids.push(id)
    }
    return { status: "sent", detail: ids.join(",") }
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) }
  }
}
