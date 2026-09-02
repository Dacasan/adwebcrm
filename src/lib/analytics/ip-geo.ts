// ============================================================
// ip-geo.ts — IP → { city, region, postal, country } para enriquecer
// el user_data de Meta (ct/st/zp/country) y los campos personalizados.
//
// Reglas del contrato (PLAN §3.2):
//  1. Preferir las cabeceras de la plataforma si existen — coste cero,
//     latencia cero, sin terceros, y no las bloquean los adblockers.
//     Nombres verificados contra la documentación oficial:
//       · Vercel: x-vercel-ip-city (URL-encoded, RFC3986), x-vercel-ip-country,
//         x-vercel-ip-country-region, x-vercel-ip-postal-code.
//       · Cloudflare (Managed Transform "Add visitor location headers"):
//         cf-ipcity, cf-ipcountry, cf-region-code, cf-postal-code.
//  2. Proveedor configurable por env: IPGEO_URL (plantilla con {ip}) e
//     IPGEO_KEY opcional (Bearer). Respuesta JSON {city, region, postal,
//     country} — agnóstico del proveedor a propósito. Verifica los
//     términos y límites del proveedor que elijas antes de fijarlo:
//     varios servicios gratuitos son solo HTTP o prohíben uso comercial.
//  3. Timeout de 2 s con AbortSignal.timeout(2000). Si expira → {}.
//  4. IPs privadas o de bucle → {} sin llamar a nadie.
//  5. Sin IPGEO_URL configurado → {} y NI UN log de error: es el modo
//     por defecto y es legítimo.
//
// Nunca lanza. Fail-open (guardrail 9 del MVP): un fallo de geo jamás
// puede impedir que el lead se cree.
// ============================================================

export interface IpGeo {
  city?: string
  region?: string // código de 2 letras cuando el proveedor lo dé
  postal?: string
  country?: string // ISO alpha-2
}

/**
 * IPs para las que no tiene sentido geolocalizar (y para las que el
 * fallback 'unknown' de getClientIp NO debe disparar una llamada). Cubre
 * 127.*, 10.*, 192.168.*, 172.16-31.*, ::1 y fc00::/7 (que incluye fd00::/8).
 */
function isPrivateOrLoopback(ip: string): boolean {
  const v = ip.trim().toLowerCase()
  if (!v || v === 'unknown') return true
  if (v === '::1' || v === '::') return true
  if (v.startsWith('fc') || v.startsWith('fd')) return true // fc00::/7
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v)
}

const PICK = (v: string | null): string | undefined =>
  v && v.trim() !== '' ? v.trim() : undefined

/**
 * Geo desde las cabeceras que la plataforma ya inyecta. Pura y síncrona:
 * sin red, sin tercero. Devuelve {} si ninguna está presente.
 */
export function geoFromPlatformHeaders(headers: Headers): IpGeo {
  const out: IpGeo = {}

  // Vercel. La city viaja URL-encoded para soportar multi-byte.
  const vercelCity = PICK(headers.get('x-vercel-ip-city'))
  if (vercelCity) {
    try {
      out.city = decodeURIComponent(vercelCity)
    } catch {
      out.city = vercelCity
    }
  }
  out.country ??= PICK(headers.get('x-vercel-ip-country'))
  out.region ??= PICK(headers.get('x-vercel-ip-country-region'))
  out.postal ??= PICK(headers.get('x-vercel-ip-postal-code'))

  // Cloudflare. cf-ipcountry usa XX (sin datos) y T1 (Tor) como
  // especiales — no son ISO alpha-2, se descartan. La comparación es
  // case-insensitive: Cloudflare las envía en MAYÚSCULAS.
  out.city ??= PICK(headers.get('cf-ipcity'))
  out.postal ??= PICK(headers.get('cf-postal-code'))
  out.region ??= PICK(headers.get('cf-region-code'))
  const cfCountry = PICK(headers.get('cf-ipcountry'))
  const cfLower = cfCountry?.toLowerCase()
  if (cfLower && cfLower !== 'xx' && cfLower !== 't1') {
    out.country ??= cfCountry
  }

  return out
}

/**
 * Proveedor HTTP genérico. IPGEO_URL es una plantilla donde {ip} se
 * sustituye por la IP codificada; IPGEO_KEY viaja como Bearer si existe.
 * La respuesta esperada es JSON con las claves city/region/postal/country
 * — las claves ausentes o vacías se omiten.
 */
export async function lookupIpGeo(ip: string | null): Promise<IpGeo> {
  const urlTemplate = process.env.IPGEO_URL
  if (!urlTemplate || !ip || isPrivateOrLoopback(ip)) return {}

  const url = urlTemplate.replace('{ip}', encodeURIComponent(ip.trim()))
  const headers: Record<string, string> = { Accept: 'application/json' }
  const key = process.env.IPGEO_KEY
  if (key) headers.Authorization = `Bearer ${key}`

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return {}
    const json: unknown = await res.json().catch(() => null)
    if (!json || typeof json !== 'object') return {}
    const rec = json as Record<string, unknown>
    const pick = (k: string): string | undefined => {
      const v = rec[k]
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    }
    return {
      city: pick('city'),
      region: pick('region'),
      postal: pick('postal'),
      country: pick('country'),
    }
  } catch {
    // Timeout, red caída, JSON inválido… {} y seguir. Sin PII en el log:
    // no se registra la IP ni el contenido.
    return {}
  }
}
