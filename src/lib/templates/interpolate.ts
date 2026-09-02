// ============================================================
// templates/interpolate.ts — interpolación compartida de plantillas
//
// Punto 3 de la consolidación (Fase 6): la resolución de `{{vars.*}}`
// vivía duplicada en automations/engine.ts (`interpolate`) y en
// flows/engine.ts (`interpolateVars`), con sintaxis ligeramente
// distinta (con/sin espacios alrededor de la llave). Aquí vive UNA
// implementación, tolerante a espacios, que ambos engines importan.
//
// Contrato de comportamiento (idéntico al histórico de ambos motores):
//   - `{{vars.foo}}` / `{{ vars.foo }}` → valor de la variable; missing
//     o null renderizan cadena vacía (nunca "undefined"/"null").
//   - `{{message.text}}` → texto del mensaje del contexto (solo el
//     motor de automatizaciones lo pasa).
//   - Cualquier otra llave (p.ej. `{{appointment_start_at}}`) la
//     resuelve ANTES `contactText` (campos de contacto / variables de
//     plantilla); si sobrevive hasta aquí, renderiza cadena vacía.
//
// NUNCA evalua código: regex de llaves + lookup en diccionarios.
// ============================================================

/** Resuelve `{{vars.x}}` (con o sin espacios). Missing → ''. */
export function interpolateVars(
  template: string,
  vars: Record<string, unknown>,
): string {
  if (!template) return ''
  return template.replace(/\{\{\s*vars\.([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[String(key)]
    return v === undefined || v === null ? '' : String(v)
  })
}

/**
 * Resuelve `{{vars.*}}` y `{{message.text}}` en una sola pasada.
 * Equivale a `interpolate` (automations/engine.ts): cualquier otra
 * llave renderiza '' (quien llama ya resolvió los campos de contacto
 * con `contactText` antes).
 */
export function interpolateMessage(
  template: string,
  messageText: string | undefined,
  vars?: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(messageText ?? '')
    if (ns === 'vars' && prop) return String(vars?.[prop] ?? '')
    return ''
  })
}