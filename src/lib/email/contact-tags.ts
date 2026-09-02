// ============================================================
// Nombres de tags de contacto, por contact_id — fuente única de la
// variable `{{ tags }}`.
//
// Los tags NO viven en la fila de `contacts`: están en `contact_tags`
// (join) → `tags.name`. `contactText` es puro (sin BD — ver su cabecera),
// así que la consulta vive aquí y cada call-site pasa los nombres como
// `extras` a `contactText` (`{ tags: 'a, b, c' }`).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Devuelve { contact_id -> [nombres de tags] } para los contactId dados
 * (una sola query con `in`). Los tags se ordenan como los devuelve la BD;
 * filas sin tag encajado (FK huérfana) se descartan.
 */
export async function fetchTagNames(
  db: SupabaseClient,
  contactIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  const ids = contactIds.filter(Boolean)
  if (ids.length === 0) return map

  const { data } = await db
    .from('contact_tags')
    .select('contact_id, tags(name)')
    .in('contact_id', ids)

  for (const row of (data ?? []) as {
    contact_id: string
    tags?: { name?: string | null } | null
  }[]) {
    const name = row.tags?.name
    if (!name) continue
    const list = map.get(row.contact_id) ?? []
    list.push(name)
    map.set(row.contact_id, list)
  }
  return map
}

/** Extras de `contactText` con los tags ya unidos (", ") — o sin la clave. */
export function tagsExtra(map: Map<string, string[]>, contactId: string): Record<string, string> {
  const joined = map.get(contactId)?.join(', ') ?? ''
  return joined ? { tags: joined } : {}
}
