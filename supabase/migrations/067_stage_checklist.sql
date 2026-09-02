-- ============================================================
-- 067_stage_checklist.sql
--
-- Checklist de confirmación por etapa (DAD §7.1 — reemplazo del sistema
-- de evidencia no-bloqueante).
--
-- El sistema viejo (058) usaba `guard_rules.required_evidence` como lista
-- de verificación opcional: la RPC la evaluaba contra `calls`/`messages`/
-- `tracking_events` y devolvía GUARDS_MISSING con override + razón. En la
-- práctica el UI solo mostraba un `window.prompt` y el override quedaba
-- a medias (el formulario del deal ni siquiera lo ofrecía).
--
-- Este cambio lo reemplaza por algo más simple y más útil: una lista de
-- confirmación humana (`checklist jsonb`) que el agente revisa ANTES de
-- mover el trato. La columna es aditiva y no-bloqueante por diseño — el
-- checklist NUNCA viaja a la RPC ni condiciona la transición. `transition_deal`
-- sigue siendo la ÚNICA vía de escritura de stage/status y queda intacta.
--
-- Pasos:
--   1. Columna `checklist` (jsonb, default '[]', aditiva).
--   2. Neutralizar `guard_rules.required_evidence` en TODAS las etapas
--      (no solo las 3 del seed) — la rama de la RPC queda inerte sola.
--   3. Backfill de los 12 checklists por nombre exacto, solo donde la
--      columna sigue vacía (patrón conservador de 058: no adivinar).
--
-- Idempotente.
-- ============================================================

-- ============================================================
-- 1. Columna checklist
-- ============================================================
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS checklist jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN pipeline_stages.checklist IS
  'Lista de confirmación humana antes de mover un trato a esta etapa. '
  'jsonb array de { id text, text text, position int }. No-bloqueante: '
  'transition_deal no la lee; el UI la muestra como confirmación previa.';

-- ============================================================
-- 2. Neutralizar el sistema de evidencia (058)
-- ============================================================
-- Global: cualquier etapa con required_evidence la pierde. La rama
-- `if v_guards ? 'required_evidence'` de transition_deal queda inerte.
UPDATE pipeline_stages
   SET guard_rules = NULL
 WHERE guard_rules IS NOT NULL
   AND guard_rules ? 'required_evidence';

-- ============================================================
-- 3. Backfill de los 12 checklists por nombre exacto
-- ============================================================
UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Fecha y hora de contacto confirmadas', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Motivo de interés del contacto anotado', 'position', 1),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Canal preferido registrado', 'position', 2)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'lead creado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Intento de contacto registrado', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Método y hora anotados', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'contacto intentado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Conversación entablada con el contacto', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Respuesta del contacto registrada', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'contactado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Interés confirmado por el contacto', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Necesidad principal identificada', 'position', 1),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Siguiente paso acordado', 'position', 2)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'interés confirmado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Presupuesto aproximado conocido', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Decisor identificado', 'position', 1),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Timeline de compra estimado', 'position', 2)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'calificado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Propuesta enviada al contacto', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Precios y alcance aceptados', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'propuesta aceptada';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Fecha y hora de reserva confirmadas', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Recordatorio programado', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'reserva confirmada';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Servicio iniciado en la fecha acordada', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Punto de contacto asignado', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'servicio iniciado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Servicio entregado completo', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Cobro procesado', 'position', 1),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Feedback del cliente recogido', 'position', 2)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'servicio completado';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Contacto intentado por al menos 2 canales', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Mensaje de seguimiento dejado', 'position', 1),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Reintento programado', 'position', 2)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'no contestó';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Timeline de compra futuro anotado', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Seguimiento de largo plazo programado', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'largo plazo';

UPDATE pipeline_stages
   SET checklist = jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Motivo de desistimiento registrado', 'position', 0),
         jsonb_build_object('id', gen_random_uuid()::text, 'text', 'Oportunidad de re-enganche evaluada', 'position', 1)
       )
 WHERE checklist = '[]'::jsonb AND lower(name) = 'desistió';