// ============================================================
// client-ip.ts — extracción best-effort de la IP del cliente.
//
// UNA sola implementación compartida (PLAN §3.3: "reutiliza la función
// que ya existe en /api/track… No escribas una segunda"). La forma de
// lograrlo es extraerla a lib en vez de exportarla desde el route file:
// Next.js App Router valida los exports de los route handlers y un
// export extra es terreno de build frágil. /api/track y /api/events
// importan ESTA función; ninguna de las dos tiene una copia.
//
// x-forwarded-for lo fija el reverse proxy (Vercel, Hostinger,
// Cloudflare); la entrada más a la izquierda es el cliente original.
// El fallback 'unknown' mantiene la llave de rate limit existente
// (aplica global) y lookupIpGeo lo trata como IP no geolocalizable.
// ============================================================

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}
