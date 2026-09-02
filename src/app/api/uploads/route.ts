// ============================================================
// POST /api/uploads — radiografía y presupuesto del paciente.
//
// Lo llama el sitio web (dominio separado) desde la página de gracias:
// el visitante acaba de dejar sus datos, ya tiene su estimado delante y
// la pregunta pasa de "¿me interesa?" a "¿cuánto en MI caso?". Para
// responder eso hace falta ver la pano.
//
// Contrato (multipart/form-data):
//   email     — REQUERIDO. Es la clave: con él se engancha la subida al
//               contacto que /api/events acaba de crear.
//   files     — repetido, uno por archivo. 1..6, ≤20 MB, tipos de la
//               allowlist.
//   name, package, arches, us_quote — opcionales, contexto para la nota.
//
// TRES DECISIONES QUE NO SON OBVIAS:
//
// 1. El bucket es PRIVADO (migración 072). Son datos clínicos: aquí no
//    se usa getPublicUrl como en `media`, hay que firmar la URL.
//
// 2. Si el email no corresponde a ningún contacto, los archivos SE
//    GUARDAN IGUAL, en `unmatched/`. Un paciente que escribe su otro
//    correo no puede perder su radiografía por un dedazo nuestro, y el
//    coordinador prefiere un archivo sin dueño a un archivo que no
//    existe. La nota en el contacto es lo único que se salta.
//
// 3. NO se emite tracking_event. EVENT_TYPES es un enum cerrado
//    (track-event-schema.ts) y meter 'upload' obligaría a tocar el
//    esquema, el CHECK de la tabla y los informes. El registro que
//    importa —qué subió, cuándo y dónde está— vive en contact_notes,
//    que es lo que el coordinador abre.
//
// Sin auth a propósito, igual que /api/events: el llamante es un
// visitante anónimo. Lo que sostiene esto es el rate-limit por IP, la
// validación de tipo y tamaño, y que el service role escriba SOLO en la
// ruta calculada aquí — nunca en una que venga del cliente.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveLandingAccountId } from '@/lib/analytics/landing-account';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { withCors, handlePreflight } from '@/lib/cors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/** Storage escribe bytes: esta ruta no puede correr en el edge runtime. */
export const runtime = 'nodejs';

const BUCKET = 'patient-files';
const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Allowlist de tipos. La misma que el bucket (072), repetida aquí a
 * propósito: el límite del bucket es la última línea de defensa y
 * devuelve un error de Storage ilegible; esto devuelve un 400 que el
 * sitio web puede enseñarle al paciente.
 */
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/dicom',
]);

/** Extensiones aceptadas cuando el navegador no manda un MIME útil. */
const ALLOWED_EXT = /\.(jpe?g|png|webp|heic|heif|pdf|dcm)$/i;

/**
 * Best-effort client IP (mismo patrón que events/route.ts y
 * invitations/peek). Los reverse proxies (Vercel, Hostinger, Cloudflare)
 * fijan x-forwarded-for; tomamos la entrada más a la izquierda (el
 * cliente original). Fallback constante para dev local → la llave existe
 * y el límite aplica "global".
 */
function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

/**
 * Nombre de objeto seguro. Storage acepta casi cualquier cosa en la
 * clave, y ese "casi" es el problema: una barra convierte el nombre en
 * subcarpeta y saca el archivo de la ruta de la cuenta, que es
 * exactamente lo que separa un tenant de otro en las políticas RLS.
 * Se conserva la extensión porque es lo que hace que el visor del panel
 * sepa si abrir una imagen o un PDF.
 */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(-80);
  return cleaned || 'file';
}

/** Escapa los comodines de LIKE: un email puede llevar `%` o `_`. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (m) => `\\${m}`);
}

function isAllowed(file: File): boolean {
  if (file.type && ALLOWED_TYPES.has(file.type)) return true;
  // Safari en iOS manda a veces type vacío para HEIC, y los .dcm suelen
  // llegar como application/octet-stream. Se cae a la extensión antes de
  // rechazar una radiografía legítima.
  return ALLOWED_EXT.test(file.name);
}

export function OPTIONS(req: NextRequest) {
  // multipart/form-data es un Content-Type de la lista segura de CORS, así
  // que el navegador NO dispara preflight para este POST. El handler está
  // igualmente por si algún día se añade una cabecera propia.
  return handlePreflight(req);
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`uploads:${ip}`, RATE_LIMITS.uploads);
  if (!limit.success) return withCors(rateLimitResponse(limit), req);

  const accountId = await resolveLandingAccountId();
  if (!accountId) {
    return withCors(NextResponse.json({ error: 'no account' }, { status: 500 }), req);
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return withCors(
      NextResponse.json({ error: 'multipart/form-data expected' }, { status: 400 }),
      req
    );
  }

  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 120) {
    return withCors(
      NextResponse.json({ error: "'email' is required" }, { status: 400 }),
      req
    );
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) {
    return withCors(
      NextResponse.json({ error: 'no files' }, { status: 400 }),
      req
    );
  }
  if (files.length > MAX_FILES) {
    return withCors(
      NextResponse.json({ error: `max ${MAX_FILES} files` }, { status: 400 }),
      req
    );
  }
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return withCors(
        NextResponse.json({ error: `"${file.name}" exceeds 20 MB` }, { status: 413 }),
        req
      );
    }
    if (!isAllowed(file)) {
      return withCors(
        NextResponse.json({ error: `"${file.name}" is not an accepted file type` }, { status: 415 }),
        req
      );
    }
  }

  const admin = supabaseAdmin();

  // El email es la clave de enganche. Case-insensitive porque nadie
  // escribe su correo dos veces con las mismas mayúsculas.
  const { data: contact } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .ilike('email', escapeLike(email))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const folder = `account-${accountId}/${contact?.id ?? 'unmatched'}`;
  const stamp = Date.now();
  const stored: string[] = [];

  for (const [i, file] of files.entries()) {
    const path = `${folder}/${stamp}-${i}-${safeName(file.name)}`;
    // ArrayBuffer y no el File directamente: en Node el SDK acepta los dos,
    // pero con el buffer el Content-Type queda bajo nuestro control en vez
    // de depender de lo que dijera el navegador.
    const bytes = await file.arrayBuffer();
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
    if (error) {
      console.error('[api/uploads] storage error:', error.message, path);
      continue;
    }
    stored.push(path);
  }

  if (!stored.length) {
    return withCors(NextResponse.json({ error: 'upload_failed' }, { status: 500 }), req);
  }

  // La nota es lo que el coordinador abre. Sin contacto no hay dónde
  // colgarla: los archivos ya están guardados en `unmatched/` y el aviso
  // queda en el log del server.
  if (contact?.id) {
    const context = ['package', 'arches', 'us_quote']
      .map((k) => {
        const v = String(form.get(k) ?? '').trim();
        return v ? `${k}: ${v}` : '';
      })
      .filter(Boolean)
      .join(' · ');

    const noteText = [
      `📎 Patient uploaded ${stored.length} file${stored.length > 1 ? 's' : ''} from the website:`,
      ...stored.map((p) => `• ${p.split('/').pop()}`),
      context ? `\n${context}` : '',
      `\nBucket: ${BUCKET} (private — sign the URL to view).`,
    ].join('\n');

    try {
      const auditUserId = await resolveAuditUserId(admin, accountId);
      const { error: noteErr } = await admin.from('contact_notes').insert({
        account_id: accountId,
        contact_id: contact.id,
        user_id: auditUserId,
        note_text: noteText,
      });
      if (noteErr) console.error('[api/uploads] note error:', noteErr.message);
    } catch (err) {
      // Los bytes ya están a salvo: una nota que falla no puede convertir
      // una subida correcta en un error para el paciente.
      console.error('[api/uploads] note failed:', err);
    }
  } else {
    console.warn(
      `[api/uploads] no contact for ${email} — ${stored.length} file(s) stored under unmatched/`
    );
  }

  return withCors(
    NextResponse.json({ ok: true, stored: stored.length, matched: Boolean(contact?.id) }, { status: 201 }),
    req
  );
}
