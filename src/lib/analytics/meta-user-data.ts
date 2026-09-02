// ============================================================
// meta-user-data.ts — normalización + hashing de user_data para la
// Meta Conversions API (DEF-1 / DEF-2 del MVP).
//
// Módulo PURO: sin BD, sin red, sin imports del resto del repo. Las
// reglas de normalización están copiadas literalmente de la tabla
// oficial de Meta (customer information parameters) y los tests
// reproducen los hashes que Meta publica como vectores oficiales.
//
// Diferencias INTENCIONALES con otros adaptadores — no unificar:
//   * user-hash.ts (Google Ads) devuelve el teléfono E.164 CON '+', y
//     Google quiere los hashes en MAYÚSCULAS. Meta exige el teléfono
//     sin '+', sin ceros a la izquierda, y el SHA-256 en hex MINÚSCULAS.
//     Este módulo no importa nada de user-hash.ts a propósito: DEF-1
//     era exactamente hashear la salida de ese normalizador compartido.
//   * Un campo vacío, en blanco o no normalizable con certeza SE OMITE:
//     nunca se envía "" ni el hash de la cadena vacía (contaría como
//     parámetro presente y no emparejado, bajando la puntuación).
// ============================================================

export interface MetaUserDataInput {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  city?: string
  state?: string
  zip?: string
  country?: string
  externalId?: string // contacts.id
  // Sin hash — viajan en claro (no son PII por sí mismos):
  fbc?: string
  fbp?: string
  clientIpAddress?: string
  clientUserAgent?: string
}

export type MetaUserData = Record<string, string>

/** SHA-256 en hex minúsculas (el formato que Meta espera). */
export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** email: trim() + toLowerCase(). */
function normalizeEmail(v: string): string {
  return v.trim().toLowerCase()
}

/** phone: solo dígitos, sin ceros a la izquierda, SIN '+'. */
function normalizePhone(v: string): string {
  return v
    .replace(/\D/g, '')
    .replace(/^0+/, '')
}

/** Nombres: minúsculas, sin dígitos ni puntuación; conserva espacios
 *  internos de nombres compuestos. Unicode-safe (UTF-8). */
function normalizeName(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, '')
    .trim()
}

/** Quita acentos: cancún → cancun. */
function stripAccents(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** city / state: minúsculas, sin acentos, sin espacios, sin puntuación
 *  (newyork, cancun, qr). */
function normalizePlace(v: string): string {
  return stripAccents(v)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * country: ISO 3166-1 alpha-2 en minúsculas. En este CRM el valor real
 * SIEMPRE llega como alpha-2 del proveedor de geo (ip-geo.ts); la
 * mini-tabla de alias es defensa para entradas en prosa y NO es una
 * tabla de países. Un valor no reconocido se omite: mejor un parámetro
 * menos que un hash de un código inválido.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  us: 'us',
  usa: 'us',
  'united states': 'us',
  'united states of america': 'us',
  'estados unidos': 'us',
  mx: 'mx',
  mexico: 'mx',
  'méxico': 'mx',
}

function normalizeCountry(v: string): string | undefined {
  const key = stripAccents(v).trim().toLowerCase()
  if (/^[a-z]{2}$/.test(key)) return key
  return COUNTRY_ALIASES[key]
}

/** zip: minúsculas, sin espacios ni guiones; en EE. UU. solo los 5
 *  primeros dígitos. */
function normalizeZip(v: string, country?: string): string {
  if ((country ?? '').toLowerCase() === 'us') {
    return v.replace(/\D/g, '').slice(0, 5)
  }
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Compone el user_data de Meta: los campos personales hasheados
 * (SHA-256 lowercase hex) y las señales técnicas en claro. Omite todo
 * lo que llegue vacío, en blanco o no normalizable.
 */
export async function buildUserData(input: MetaUserDataInput): Promise<MetaUserData> {
  const out: MetaUserData = {}

  // — Campos con hash —
  const em = input.email ? normalizeEmail(input.email) : undefined
  if (em) out.em = await sha256Hex(em)

  const ph = input.phone ? normalizePhone(input.phone) : undefined
  if (ph) out.ph = await sha256Hex(ph)

  const fn = input.firstName ? normalizeName(input.firstName) : undefined
  if (fn) out.fn = await sha256Hex(fn)

  const ln = input.lastName ? normalizeName(input.lastName) : undefined
  if (ln) out.ln = await sha256Hex(ln)

  const ct = input.city ? normalizePlace(input.city) : undefined
  if (ct) out.ct = await sha256Hex(ct)

  const st = input.state ? normalizePlace(input.state) : undefined
  if (st) out.st = await sha256Hex(st)

  const zp = input.zip ? normalizeZip(input.zip, input.country) : undefined
  if (zp) out.zp = await sha256Hex(zp)

  const country = input.country ? normalizeCountry(input.country) : undefined
  if (country) out.country = await sha256Hex(country)

  if (input.externalId) out.external_id = await sha256Hex(input.externalId)

  // — Campos en claro (sin hash) —
  if (input.fbc) out.fbc = input.fbc
  if (input.fbp) out.fbp = input.fbp
  if (input.clientIpAddress) out.client_ip_address = input.clientIpAddress
  if (input.clientUserAgent) out.client_user_agent = input.clientUserAgent

  return out
}
