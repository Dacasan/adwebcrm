-- ============================================================
-- 072_patient_files.sql
--
-- Bucket `patient-files`: radiografías panorámicas, fotos intraorales
-- y presupuestos que el paciente sube desde la página de gracias del
-- sitio web (POST /api/uploads).
--
-- LA DIFERENCIA CON LOS DEMÁS BUCKETS: este es PRIVADO.
--
-- media (064), chat-media (023), flow-media (016) y avatars (008) son
-- públicos a propósito — los sirve una landing o un cliente de chat y
-- `getPublicUrl` devuelve bytes sin pasar por RLS. Aquí eso sería un
-- incidente: son datos clínicos identificables de un paciente
-- concreto. Una URL pública de Storage no caduca, no pide sesión y se
-- puede adivinar si alguien conoce la convención de rutas. Con
-- `public = FALSE` la única forma de leer un objeto es una URL firmada
-- que emite el server (createSignedUrl) o un miembro de la cuenta con
-- sesión: dos caminos auditables, los dos con caducidad.
--
-- Consecuencia para quien consuma esto desde el panel: NO usar
-- getPublicUrl con este bucket — devuelve una URL que responde 400.
-- Hay que firmar (`createSignedUrl(path, seconds)`).
--
-- Convención de ruta, igual que el resto:
--   account-<account_id>/<contact_id | unmatched>/<timestamp>-<archivo>
--
-- El segundo segmento agrupa por paciente para que el coordinador vea
-- una carpeta por caso; `unmatched` recoge lo que llega con un email
-- que no corresponde a ningún contacto (ver la nota del endpoint: se
-- guarda igual, nunca se descarta).
--
-- Tipos permitidos: JPEG/PNG/WebP/HEIC (foto de móvil a la pantalla del
-- radiólogo, que es como llega el 90%), PDF (el presupuesto de EE. UU.)
-- y DICOM (la exportación real del CBCT).
--
-- Tope 20 MB por objeto, coherente con UPLOAD.maxSizeMb del sitio web.
-- El límite del bucket es la última línea de defensa: el endpoint ya
-- valida tamaño y tipo antes de escribir.
--
-- Idempotente — seguro de re-ejecutar.
-- ============================================================

-- ============================================================
-- 1. Bucket privado
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'patient-files',
  'patient-files',
  FALSE, -- PRIVADO: datos clínicos, nunca getPublicUrl
  20971520, -- 20 MB
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf',
    'application/dicom'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. RLS — solo miembros de la cuenta, y solo lectura/gestión
--
-- Mismo predicado que 023/054/064: el llamante pertenece a la cuenta
-- cuya carpeta contiene el objeto (`account-<account_id>` como primer
-- segmento de la ruta).
--
-- NO hay política de INSERT: al bucket solo escribe /api/uploads con
-- service role, que salta RLS. Un visitante anónimo del sitio web no
-- tiene sesión en Supabase y no debe poder escribir directamente en
-- Storage — si pudiera, el rate-limit y la validación de tipo del
-- endpoint serían decorativos.
-- ============================================================

DROP POLICY IF EXISTS "Patient files are readable by account members" ON storage.objects;
CREATE POLICY "Patient files are readable by account members"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'patient-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update patient files" ON storage.objects;
CREATE POLICY "Members can update patient files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'patient-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete patient files" ON storage.objects;
CREATE POLICY "Members can delete patient files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'patient-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
