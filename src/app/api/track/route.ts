// ============================================================
// GET /api/track — beacon de atribución anónimo (DAD §2.2/§6).
//
// Lo dispara god.js con navigator.sendBeacon desde clicks a
// wa.me/tel: y scroll depth en la landing. Sin auth (anónimo):
// solo datos de comportamiento + ref_code opaco, nunca PII
// (DAD §9.4 — sin PII en URLs; el ref_code no contiene teléfono).
//
// Inserta un tracking_events con event_type whatsapp_click/
// phone_click/scroll_depth y el account_id resuelto server-side.
// Dedup por event_id cuando lo provee god.js.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';
import { beaconSchema } from '@/lib/analytics/track-event-schema';
import { getClientIp } from '@/lib/analytics/client-ip';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveLandingAccountId } from '@/lib/analytics/landing-account';
import { withCors, handlePreflight } from '@/lib/cors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export function OPTIONS(req: NextRequest) {
  // Preflight CORS: el sitio web del cliente (dominio separado) dispara
  // beacons a /api/track; sin esto el navegador bloquea la petición.
  return handlePreflight(req);
}

export async function GET(req: NextRequest) {
  // Rate-limit por IP (P0-2, auditoría fork): antes esto era un endpoint
  // anónimo con service-role y sin tope → abuso de costos/almacenamiento.
  const ip = getClientIp(req);
  const limit = checkRateLimit(`track:${ip}`, RATE_LIMITS.trackingPublic);
  if (!limit.success) return withCors(rateLimitResponse(limit), req);

  const url = new URL(req.url);
  const parsed = beaconSchema.safeParse({
    type: url.searchParams.get('type') ?? undefined,
    ref: url.searchParams.get('ref') ?? undefined,
    landing: url.searchParams.get('landing') ?? undefined,
    event_id: url.searchParams.get('event_id') ?? undefined,
    href: url.searchParams.get('href') ?? undefined,
    scrollPercent: url.searchParams.get('scrollPercent')
      ? Number(url.searchParams.get('scrollPercent'))
      : undefined,
  });
  if (!parsed.success) {
    return withCors(NextResponse.json({ error: 'invalid' }, { status: 400 }), req);
  }
  const { type, ref, landing, event_id, href, scrollPercent } = parsed.data;

  const account_id = await resolveLandingAccountId();
  if (!account_id) {
    return withCors(NextResponse.json({ error: 'no account' }, { status: 500 }), req);
  }

  const eventType =
    type === 'whatsapp'
      ? 'whatsapp_click'
      : type === 'phone'
        ? 'phone_click'
        : 'scroll_depth';

  const payload =
    type === 'scroll' ? { scrollPercent } : href ? { href } : null;

  const { error } = await supabaseAdmin()
    .from('tracking_events')
    .upsert(
      {
        account_id,
        event_type: eventType,
        event_id: event_id || undefined,
        ref_code: ref || null,
        landing_slug: landing || null,
        payload,
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      },
      // Dedup hard: event_id UNIQUE → los reintentos con el mismo id no duplican
      { onConflict: 'event_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('[api/track] insert error:', error);
    return withCors(NextResponse.json({ error: 'internal' }, { status: 500 }), req);
  }

  return withCors(NextResponse.json({ ok: true }, { status: 202 }), req);
}

// navigator.sendBeacon SIEMPRE emite POST — no hay forma de pedirle un GET.
// Como god.js dispara este endpoint por beacon, sin este alias cada clic a
// wa.me/tel: se quedaba en 405 Method Not Allowed y no se registraba ninguno.
// El handler no lee el cuerpo: todo viaja en la query, así que el mismo
// código sirve tal cual para los dos métodos.
export const POST = GET;
