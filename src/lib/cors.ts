// ============================================================
// cors.ts — CORS para los endpoints públicos de tracking.
//
// El sitio web del cliente (Astro standalone, dominio propio) llama a
// /api/events y /api/track del CRM (dominio separado). El navegador exige
// CORS en esas respuestas: POST con Content-Type application/json dispara
// preflight OPTIONS, y sendBeacon/fetch necesitan Access-Control-Allow-Origin.
//
// Política: allowlist estricta. Solo los origins listados en env
// (LANDING_SITE_URL / PUBLIC_SITE_URL / NEXT_PUBLIC_SITE_URL) reciben CORS.
// El mismo-origin (modo embebido actual, landing servida por Next) no
// necesita nada: sin header Origin cruzado, no se añade ni se bloquea nada.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';

/** Origins permitidos para llamadas cross-origin a /api/* (sin barra final). */
const ALLOWED_ORIGINS: string[] = [
  process.env.LANDING_SITE_URL,
  process.env.PUBLIC_SITE_URL,
  process.env.NEXT_PUBLIC_SITE_URL,
  // Dev local: el sitio web (astro preview) corre en http://localhost:4321
  // y el CRM en :3000 — el navegador exige CORS también entre los dos. Solo
  // aplica en la máquina del desarrollador; ningún navegador real envía
  // Origin=localhost.
  'http://localhost:4321',
  'http://127.0.0.1:4321',
]
  .filter((v): v is string => Boolean(v))
  .map((v) => v.replace(/\/+$/, ''));

/** Devuelve los headers CORS si el Origin de la petición está en la allowlist. */
export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    // sendBeacon SIEMPRE va con credenciales, y en modo 'include' el navegador
    // exige este header en el preflight o descarta la respuesta entera. Sin él
    // los beacons cross-origin (page_view de god.js, /api/track de los clics de
    // WhatsApp y teléfono) fallan y no se registra ni una visita del sitio
    // standalone. Es seguro porque Allow-Origin devuelve el origin concreto de
    // la allowlist, nunca '*' — que con credenciales el navegador rechaza.
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** Aplica los headers CORS a una respuesta NextResponse. */
export function withCors<T>(res: NextResponse<T>, req: NextRequest): NextResponse<T> {
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

/** Handler OPTIONS para preflight: 204 con CORS (vacío si no aplica). */
export function handlePreflight(req: NextRequest): NextResponse {
  const headers = corsHeaders(req);
  return new NextResponse(null, {
    status: 204,
    headers: { ...headers, 'Access-Control-Max-Age': '86400' },
  });
}