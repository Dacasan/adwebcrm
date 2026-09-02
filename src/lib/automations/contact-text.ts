import type { Contact } from '@/types'
import { resolveVariables, type VariableMapping } from '@/hooks/use-broadcast-sending'

// ============================================================
// Interpolación de campos de contacto. Vive AQUÍ y no en el engine por
// una razón de bundling, no de estética: `step3-email-preview.tsx` es un
// componente de cliente y necesita `contactText` para la previsualización.
// Importarla del engine arrastraba el engine entero al bundle del
// navegador y, con él, el registry de proveedores y los SDKs de servidor
// de Twilio y SendGrid — que ni siquiera resuelven ahí (`fs` no existe en
// el navegador). El módulo es puro: sin BD, sin red, sin SDKs.
//
// `engine.ts` la reexporta, así que todo lo que ya la importaba de allí
// sigue funcionando.
// ============================================================

/**
 * Ordena claves de variable numéricamente primero, alfabéticamente después.
 *
 * Meta usa marcadores posicionales `{{1}}`, `{{2}}`, … así que los params
 * DEBEN emitirse en orden numérico estricto. El orden lexicográfico de
 * "1", "2", …, "10" da "1", "10", "2", … y descoloca en silencio toda
 * plantilla con ≥10 variables.
 */
export function byVariableKey(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const aNum = Number.isFinite(na)
  const bNum = Number.isFinite(nb)
  if (aNum && bNum) return na - nb
  if (aNum) return -1
  if (bNum) return 1
  return a.localeCompare(b)
}

/**
 * Interpola `{{ field }}` del contacto en `text`, reusando `resolveVariables`
 * (broadcasts) como ÚNICA fuente de campos — no se copia lógica ni se inventa
 * una tercera sintaxis de plantillas (§9.3.1). `{{ vars.* }}` / `{{ message.text }}`
 * los resuelve `interpolate` después.
 */
export function contactText(
  text: string,
  variables: Record<string, VariableMapping> | undefined,
  contact: Pick<Contact, 'name' | 'email' | 'phone' | 'company'> | null,
  extras?: Record<string, string>,
): string {
  const map = new Map<string, string>()
  // El contacto guarda UN campo `name`. `first_name` / `last_name` se
  // derivan de él aquí — no son columnas nuevas ni un segundo modelo de
  // datos: partir por el primer espacio es lo que espera una plantilla
  // que saluda («Hi John,» y no «Hi John Smith,»). Un nombre de una sola
  // palabra deja `last_name` vacío, que es la respuesta correcta.
  const fullName = (contact?.name ?? '').trim()
  const [firstName = '', ...restName] = fullName.split(/\s+/)
  // Campos integrados siempre disponibles (`{{name}}`, `{{phone}}`, `{{email}}`,
  // `{{company}}`) — ÚNICA fuente de campos, sin mapa de variables obligatorio.
  const fields: Record<string, string> = {
    name: contact?.name ?? '',
    first_name: firstName,
    last_name: restName.join(' '),
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
    company: contact?.company ?? '',
  }
  for (const k of Object.keys(fields)) map.set(k, fields[k])

  if (variables && Object.keys(variables).length > 0) {
    const resolved = resolveVariables(variables, contact as Contact, undefined)
    const keys = Object.keys(variables).sort(byVariableKey)
    keys.forEach((k, i) => map.set(String(k), resolved[i] ?? ''))
  }

  // Variables calculadas por el call-site (p.ej. `unsubscribe_url`, que
  // necesita el contactId y la env url — cosas que este módulo puro
  // deliberadamente no conoce).
  if (extras) {
    for (const [k, v] of Object.entries(extras)) map.set(k, v)
  }

  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, k) => map.get(String(k)) ?? '')
}
