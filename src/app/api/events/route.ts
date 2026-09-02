// ============================================================
// POST /api/events — enrutador de eventos de tracking (REDUCIDO v8).
//
// Acepta solo eventos SIN hogar (DAD §4): form_submit, ctwa_lead,
// page_view, whatsapp_click, phone_click, scroll_depth. Los eventos
// nativos viven en sus tablas; los internos (state_changed/
// score_changed) solo los escribe RPC/trigger. La lista viva, con quién
// produce cada tipo, está en EVENT_TYPES (track-event-schema.ts).
//
// form_submit crea el lead reutilizando el ingest existente
// (findOrCreateContact — DAD §3.2 "reutilizar el ingest existente"),
// PERO server-side con service role: la API key de /api/v1/contacts
// NUNCA se expone al navegador. El contact lleva la atribución del
// evento (hidden fields rellenados por god.js).
//
// Dedup hard: event_id es UNIQUE → ON CONFLICT DO NOTHING; reintentos
// con el mismo event_id devuelven 202 idempotente sin duplicar.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';
import { trackEventSchema } from '@/lib/analytics/track-event-schema';
import { getClientIp } from '@/lib/analytics/client-ip';
import { geoFromPlatformHeaders, lookupIpGeo } from '@/lib/analytics/ip-geo';
import { projectGeoToCustomFields } from '@/lib/analytics/attribution-fields';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveLandingAccountId } from '@/lib/analytics/landing-account';
import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts';
import { withCors, handlePreflight } from '@/lib/cors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export function OPTIONS(req: NextRequest) {
  // Preflight CORS: el sitio web del cliente (dominio separado) llama a
  // /api/events; sin esto el navegador bloquea el POST.
  return handlePreflight(req);
}

export async function POST(req: NextRequest) {
  // Rate-limit por IP ANTES de tocar la BD: pincha bots que spamean
  // leads falsos vía service-role (P0-2, auditoría fork).
  const ip = getClientIp(req);
  const beaconLimit = checkRateLimit(
    `events:${ip}`,
    RATE_LIMITS.trackingPublic
  );
  if (!beaconLimit.success) return withCors(rateLimitResponse(beaconLimit), req);

  const body = await req.json().catch(() => null);
  const parsed = trackEventSchema.safeParse(body);
  if (!parsed.success) {
    return withCors(
      NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      ),
      req
    );
  }
  const { event_id, event_type, attribution, payload, ref_code, landing_slug } =
    parsed.data;

  const account_id = await resolveLandingAccountId();
  if (!account_id) {
    return withCors(NextResponse.json({ error: 'no account' }, { status: 500 }), req);
  }

  // form_submit → find-or-create lead (reutiliza el ingest de /api/v1/contacts,
  // server-side con service role; la atribución viaja en el payload/attribution).
  if (event_type === 'form_submit') {
    // Bucket más estrecho: cada hit crea un lead + puede disparar
    // automatizaciones de WhatsApp pagadas.
    const formLimit = checkRateLimit(
      `events:${ip}:form`,
      RATE_LIMITS.trackingFormSubmit
    );
    if (!formLimit.success) return withCors(rateLimitResponse(formLimit), req);

    const phone =
      typeof payload?.phone === 'string' ? payload.phone.trim() : '';
    if (!phone) {
      return withCors(
        NextResponse.json(
          { error: "'payload.phone' is required for form_submit" },
          { status: 400 }
        ),
        req
      );
    }
    const admin = supabaseAdmin();
    const auditUserId = await resolveAuditUserId(admin, account_id);
    try {
      const contact = await findOrCreateContact(admin, account_id, auditUserId, {
        phone,
        name: typeof payload?.name === 'string' ? payload.name : undefined,
        email: typeof payload?.email === 'string' ? payload.email : undefined,
        // El eslabón que faltaba: la atribución ya estaba aquí y solo se
        // escribía en `tracking_events`, así que el contacto nacía sin origen
        // y los informes de adquisición agregaban sobre NULL. Se escribe solo
        // al crear (primer contacto gana); si el contacto ya existía,
        // findOrCreateContact la ignora.
        attribution: attribution ?? null,
      });

      // Loop de conversiones: el form_submit ES el lead. Se emite el evento
      // canónico `lead` con el contact_id recién resuelto y un event_id
      // DETERMINÍSTICO derivado del form_submit (`lead_<event_id>`): el mismo
      // formulario reenviado (retry de red, doble clic) produce el mismo
      // event_id → el UNIQUE de tracking_events lo descarta → Google/Meta
      // reciben una sola conversión. Sin esto, cada reintento del navegador
      // reportaría un lead nuevo.
      //
      // DEF-3: se persisten la IP (columna ip; 'unknown' del fallback → null,
      // es ruido en la tabla) y el user agent del SERVIDOR (cabecera
      // user-agent, recortada a 500) — son client_ip_address y
      // client_user_agent del user_data de Meta. Nunca se toman del payload
      // del cliente: el payload es free-form y un cliente podría mentir.
      const leadEventId = `lead_${event_id}`;
      const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 500);
      const { error: leadErr } = await supabaseAdmin()
        .from('tracking_events')
        .upsert(
          {
            account_id,
            contact_id: contact.id,
            event_id: leadEventId,
            event_type: 'lead',
            attribution: attribution ?? null,
            payload: {
              source_event_id: event_id,
              ...(userAgent ? { user_agent: userAgent } : {}),
            },
            ref_code: ref_code ?? null,
            landing_slug: landing_slug ?? null,
            ip: ip === 'unknown' ? null : ip,
          },
          { onConflict: 'event_id', ignoreDuplicates: true }
        );
      if (leadErr) {
        console.error('[api/events] lead event error:', leadErr);
      }

      // Geo por IP (DEF-2/DEF-3, PLAN §3.2): cabeceras de plataforma primero
      // (coste cero, sin terceros); el proveedor HTTP solo rellena los huecos
      // y solo si hay IPGEO_URL. El resultado se proyecta a los campos
      // personalizados City/State/Zip/Country, de donde loadContactUserData
      // los lee al armar el user_data de Meta.
      //
      // Fail-open absoluto (guardrail 9): este try/catch es la frontera. Un
      // fallo o timeout de geo JAMÁS impide que el lead exista ni tumba el
      // alta: el lead ya está creado y el tracking_event ya se insertó.
      try {
        const headerGeo = geoFromPlatformHeaders(req.headers);
        const geo =
          headerGeo.city && headerGeo.country
            ? headerGeo
            : { ...(await lookupIpGeo(ip)), ...headerGeo };
        if (Object.keys(geo).length > 0) {
          await projectGeoToCustomFields(
            admin,
            account_id,
            auditUserId,
            contact.id,
            geo
          );
        }
      } catch (geoErr) {
        console.warn(
          '[api/events] geo projection failed (fail-open):',
          geoErr instanceof Error ? geoErr.message : geoErr
        );
      }
    } catch (err) {
      console.error('[api/events] findOrCreateContact error:', err);
      return withCors(NextResponse.json({ error: 'lead_failed' }, { status: 500 }), req);
    }
  }

  const { error } = await supabaseAdmin()
    .from('tracking_events')
    .upsert(
      {
        account_id,
        event_id,
        event_type,
        attribution: attribution ?? null,
        payload: payload ?? null,
        ref_code: ref_code ?? null,
        landing_slug: landing_slug ?? null,
      },
      // Dedup hard: event_id UNIQUE → los reintentos con el mismo id no duplican
      { onConflict: 'event_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('[api/events] insert error:', error);
    return withCors(NextResponse.json({ error: 'internal' }, { status: 500 }), req);
  }

  return withCors(NextResponse.json({ ok: true }, { status: 202 }), req);
}
