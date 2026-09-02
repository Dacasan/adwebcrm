# adwebcrm — base de verdad

> **Verificado el 2026-09-01** leyendo el código y consultando el esquema real
> de producción (PostgREST de Supabase). Incluye el MVP de Meta CAPI (Parte A +
> Parte B T1). No está derivado de ningún otro documento.
>
> **Sin sello de commit, a propósito.** Este repo todavía no tiene historia: se
> publica con un commit único (`docs/ARQUITECTURA.md` §5 del workspace de
> agencia). El sello anterior apuntaba a `d0fd1fa`, del monorepo archivado, un
> hash que este repositorio no contiene. Cuando exista el primer commit
> público, séllalo aquí con **ese** hash y esta fecha.

## Cómo se usa este documento

**Regla 1 — el código manda.** Si el código y este documento discrepan, el
documento está mal: arréglalo en el mismo cambio. Cada sección trae el comando
con el que se volvió a derivar; ejecútalo antes de fiarte de un dato viejo.

**Regla 2 — los comentarios del repo NO son verdad.** Han derivado del código
en varios sitios. Caso real de esta semana: `validate.ts` justificaba una regla
diciendo que `transition_deal` devuelve `NO_OP` cuando origen y destino son la
misma etapa — es falso cuando además cambia el status, y esa creencia dejó
pasar un bug que mandaba correos diciendo «pasó de Negociación a Negociación».
Un comentario es una hipótesis a verificar.

**Regla 3 — en `docs/` de este repo solo hay un fichero: este.**

Este repositorio es **público**. Lo que viaja con él es la descripción del
sistema; los planes internos no. Si buscas un `PLAN-*.md`, no está aquí y no
debe estar: vive en el workspace privado de agencia, en `agenciaweb/docs/`.

| Documento | Dónde | Qué es |
|---|---|---|
| `docs/CRM.md` | **aquí** | Este. La descripción del sistema tal y como está |
| `ARQUITECTURA.md` | agencia | Qué repo es cada cosa y dónde vive cada documento |
| `PLAN-META-CAPI-MVP.md` | agencia | Plan del MVP de Meta CAPI. **Parte A (fases 0–4) y Parte B T1 (vista Tracking) implementadas el 2026-09-01**; quedan T2 (que el envío lea de `tracking_config`) y la verificación manual en Events Manager |
| `MARCA-NUEVA.md` | agencia | Alta de una marca nueva |

Los doce documentos que había aquí (planes viejos, runbooks y referencia
desfasada) se retiraron el 2026-08-31 justo porque una IA los leía y construía
sobre cosas que no existen. Siguen en el archivo privado del monorepo.

**Regla 4 — no sobre-ingeniería: reutiliza la primitiva que ya existe.** Antes
de escribir una función nueva, busca en §4. Este sistema ya tiene resolución de
proveedor, ingesta entrante, interpolación, tenencia, rate limit, cola,
firma de webhooks y subida de media. Duplicar cualquiera de esas es el error
más caro que se puede cometer aquí, porque las copias divergen en silencio.

**Regla 5 — tres idiomas o ninguno.** Todo texto de UI vive en
`messages/{en,es,ko}.json` con la misma ruta de clave. Hay dos tests que lo
vigilan (`src/i18n/messages.test.ts`, `src/i18n/icu-safety.test.ts`).

**Regla 6 — son dos repositorios. Lee uno.** El sistema son dos proyectos con
despliegues separados:

- **`adwebcrm`** — este. Lo describe este documento.
- **`sitio-<cliente>`** — el sitio público en Astro, uno por cliente, todos
  construidos sobre el paquete compartido `web-kit`. Lo describe **`SITIO.md`**,
  en el workspace de agencia (`agenciaweb/docs/sitio/SITIO.md`, destinado a
  `web-kit/docs/` cuando el kit exista).

**Son repositorios distintos, no carpetas hermanas.** Ninguna ruta relativa
llega del uno al otro; refiérete a ellos por nombre de repo. Un cambio que cruce
la frontera necesita dos PRs, uno en cada lado.

**Por defecto trabajas solo con este.** No abras el otro documento «por
contexto»: no lo necesitas para la bandeja, los pipelines, las
automatizaciones, las campañas, la voz, los ajustes ni la base de datos — el
90 % de lo que se toca aquí.

**Toda la frontera entre los dos está en esta tabla.** Si tu tarea no cruza
ninguna de estas seis líneas, no hay nada que consultar al otro lado:

| Qué cruza | Dirección | Anclaje |
|---|---|---|
| `god.js` | CRM → sitio | Se compila **aquí** (`pnpm build:god`: esbuild `src/lib/analytics/god.ts` → `public/god.js`) y el sitio lo carga con `<script src="{CRM_URL}/god.js">` (`web-kit` · `layouts/BaseLayout.astro:102`) |
| `window.__WACRM_API_URL__` | sitio → navegador | Lo inyecta `web-kit` · `components/SeoHead.astro:132`; lo lee `getApiBase()` (`web-kit` · `lib/api-base.ts:20`) |
| `POST /api/events` | sitio → CRM | Alta de leads (`web-kit` · `scripts/lead-form.ts`) y las páginas de gracias |
| `GET/POST /api/track` | sitio → CRM | Beacons anónimos que emite `god.js` |
| `POST /api/uploads` | sitio → CRM | Subida de casos (`sitio-<cliente>` · `src/data/site.ts`) |
| Los `name` de los campos ocultos del formulario | **Contrato compartido** | `web-kit` · `components/ContactFields.astro` los declara · `god.js` los rellena · `lead-form.ts` los lee y los manda en `attribution` |

> **Esta tabla es idéntica byte a byte a la de `SITIO.md`.** Un `diff` de estas
> seis filas es lo que detecta que los dos lados se han desincronizado. Si
> editas una fila aquí, edítala allí en el mismo cambio.

**Nota de la reestructura del 2026-09-01:** cinco de las seis anclas apuntan
ahora a **`web-kit`**, no al repo del cliente. Los componentes, el layout, los
scripts y la librería son del paquete compartido; el repo del cliente solo pone
páginas, `site.ts`, `public/` y su marca. Un arreglo en el contrato se hace una
vez en el kit y llega a todos los sitios con la siguiente versión — que es
justo el motivo de haberlo extraído.

**Abre `SITIO.md` solo si:** tocas el formulario de captación o sus campos
ocultos · tocas `god.ts` · cambias el contrato de `/api/events`, `/api/track` o
`/api/uploads` · investigas por qué un lead llega sin atribución.

> ⚠️ **La asimetría que ya causó un fallo.** `god.ts` vive en este repo pero
> **se ejecuta en el sitio**, y se sirve desde el CRM: al desplegar el CRM, el
> sitio empieza a ejecutar el nuevo `god.js` **sin que nadie despliegue el
> sitio**. Pero los campos ocultos que `god.js` rellena están declarados en el
> repo del sitio. Si añades aquí un campo que allí no existe,
> `fillHiddenInputs` hace `if (input && v)` y **no falla: no hace nada, en
> silencio**.
>
> **DEF-5 está cerrado (verificado 2026-09-01).** El contrato de tres puntas
> está completo: `ContactFields.astro:132-133` declara `fbc` y `fbp`,
> `god.ts:121-122` los rellena, `lead-form.ts:181-182` los lee. Ya no es el
> caso que «nunca hayan viajado».
>
> **Pero siguen llegando vacíos, y no por este motivo.** El comentario de
> `ContactFields.astro:129-131` lo dice: no hay píxel de Meta plantando las
> cookies `_fbc`/`_fbp`, así que no hay nada que copiar (**DEF-6, abierto**).
> El servidor sintetiza `fbc` desde `fbclid` cuando la cookie no existe, que es
> lo que hoy salva el caso. **No confundas los dos defectos:** DEF-5 era un
> campo que no existía; DEF-6 es un campo que existe y está vacío. Un
> diagnóstico que los mezcle te manda a arreglar HTML que ya está bien.
>
> La regla que dejó el incidente sigue viva aunque el caso esté cerrado: un
> cambio en este lado de la frontera exige comprobar el otro lado, aunque
> compile y aunque los tests pasen.

---

## 1. Qué es y de qué está hecho

CRM multicanal para una clínica: bandeja compartida (WhatsApp, SMS, email),
contactos, pipelines de tratos, automatizaciones, campañas, voz y atribución de
marketing. Multi-tenant por **cuenta**.

| Pieza | Versión real (`package.json`) |
|---|---|
| Next.js | 16.2.12 — App Router |
| React | 19.2.4 |
| Supabase JS | ^2.107.0 (Postgres + Auth + Realtime + Storage) |
| next-intl | ^4.13.5 — en / es / ko |
| Base UI | ^1.6.0 — primitivas de `src/components/ui` |
| Tailwind | v4 |
| Vitest | ^4.1.10 |

**Tamaño:** 594 ficheros `.ts/.tsx`, 139 de test, 102 rutas de API,
79 migraciones, 54 tablas y vistas en producción, 31 funciones SQL expuestas.

> ⚠️ El Next.js de este repo tiene APIs distintas a las que la mayoría de
> modelos tienen memorizadas. Antes de tocar un route handler o algo del App
> Router, lee la guía correspondiente en `node_modules/next/dist/docs/`.

```bash
# Re-derivar
find src -name "*.ts" -o -name "*.tsx" | wc -l; find src/app/api -name route.ts | wc -l
```

---

## 2. El modelo mental: la cuenta lo es todo

Cada fila del sistema pertenece a una **cuenta** (`accounts`). El aislamiento
entre clínicas es `account_id`, no `user_id` — `user_id` sobrevive en muchas
tablas como dato de auditoría de quién creó la fila, y **no sirve para aislar**.

**Roles** (`src/lib/auth/roles.ts`, espejo del enum de la migración 017):

| Rol | Rango | Puede |
|---|---:|---|
| `owner` | 4 | Todo, incluida la transferencia de la cuenta |
| `admin` | 3 | Ajustes, miembros, configuración de proveedores |
| `agent` | 2 | Operar: mandar mensajes, mover tratos, crear contactos |
| `viewer` | 1 | Solo lectura |

Los predicados (`canManageMembers`, `canEditSettings`…) están en ese fichero y
son la única fuente: no escribas comparaciones de rol a mano.

**Doble barrera de tenencia.** Toda ruta comprueba el rol en servidor
(`requireRole`) *y* la base de datos vuelve a comprobar con RLS a través de
`is_account_member(account_id, min_role)`. Las dos hablan el mismo idioma
porque `roleRank()` replica el `CASE` de esa función SQL.

**Los tres clientes de Supabase, y cuándo usar cada uno:**

| Cliente | Fichero | Cuándo |
|---|---|---|
| Navegador | `src/lib/supabase/client.ts` | Componentes cliente. Singleton: crear más provoca peleas por el lock de auth |
| Servidor con sesión | `src/lib/supabase/server.ts` | Rutas y server components. **Respeta RLS**: es el que debe hacer casi todo |
| Service role | `src/lib/supabase/admin.ts` | Webhooks, crons y motores sin sesión. **Salta RLS**: cada consulta acota por `account_id` a mano o abres un agujero entre clínicas |

`src/lib/automations/admin-client.ts` y `src/lib/telnyx/admin-client.ts` son
re-exports del mismo cliente service-role. No hay tres, hay uno.

**Regla que ya costó un incidente:** algunas funciones SQL son
`SECURITY DEFINER` pero su primera guarda es `is_account_member`, que resuelve
por `auth.uid()`. Llamarlas con la service-role key devuelve `forbidden`
siempre, porque ahí no hay JWT. `transition_deal` es el ejemplo vivo: la ruta
`api/deals/[id]/transition` lee con el cliente admin y **llama a la RPC con el
cliente de sesión**.

```bash
grep -n "export function roleRank" -A 12 src/lib/auth/roles.ts
grep -rn "supabaseAdmin()" src/app/api | wc -l
```

---

## 3. Base de datos

53 tablas y vistas. Agrupadas por dominio, con lo que hay que saber de cada
una. Las columnas completas se sacan del esquema vivo con el comando del final.

### Núcleo
| Tabla | Para qué | Nota que importa |
|---|---|---|
| `accounts` | El tenant | `owner_user_id`, `default_currency` |
| `profiles` | Usuario ↔ cuenta ↔ rol | `account_role` es el rol efectivo |
| `account_invitations` | Alta de miembros por token | El token se guarda hasheado |
| `api_keys` | API pública v1 | Hash + prefijo + scopes; nunca la clave en claro |
| `member_presence` | Quién está conectado | La escribe la RPC `touch_presence` |
| `notifications` | Campana del dashboard | |

### Conversaciones y mensajes
| Tabla | Para qué | Nota que importa |
|---|---|---|
| `contacts` | Personas | `phone_normalized` es columna generada con UNIQUE por cuenta: el antiduplicados vive ahí |
| `conversations` | Un hilo por (cuenta, contacto) | **No tiene columna de canal** |
| `messages` | Todo lo que entra y sale | `channel ∈ whatsapp\|sms\|email`; `sender_type ∈ customer\|agent\|bot`; `content_type ∈ text\|image\|document\|audio\|video\|location\|template\|interactive` |
| `message_reactions`, `quick_replies`, `contact_notes`, `contact_tags`, `tags`, `custom_fields`, `contact_custom_values` | Alrededor del hilo | |

**El canal vive en el mensaje, no en la conversación.** Un hilo "es de SMS"
porque su último mensaje lo es. Cualquier UI que necesite el canal lo deriva;
no inventes una columna.

### Pipelines
| Tabla | Para qué | Nota que importa |
|---|---|---|
| `pipelines`, `pipeline_stages` | Embudos y etapas | `stage_status ∈ open\|won\|lost` — de ahí deriva el cierre; `checklist` para el modal de transición |
| `deals` | Tratos | `version` para bloqueo optimista; `title` y `value` (no `name`/`amount`) |
| `deal_time_in_stage` | **Vista**, no tabla | `stage_entered_at` + `time_in_stage`, derivados de `tracking_events` |

### Automatizaciones y flujos
`automations`, `automation_steps`, `automation_logs`,
`automation_pending_executions` (los `wait`), `flows`, `flow_nodes`,
`flow_runs`, `flow_run_events`, `message_queue` (cola única: mensajes aplazados
por cuota **y** conversiones salientes, discriminados por `channel`),
`frequency_rules` (topes por canal).

### Canales y proveedores
`whatsapp_config`, `message_templates` (plantillas de Meta con su ciclo de
aprobación), `broadcasts`, `broadcast_recipients`, `telnyx_config`,
`twilio_config`, `calls`, `email_config`, `sendgrid_config`, `email_templates`,
`email_campaigns`, `email_campaign_recipients`, `email_sends`,
`provider_routing` (qué proveedor usa esta cuenta para voz, SMS y email).

### IA y marketing
`ai_configs`, `ai_knowledge_documents`, `ai_knowledge_chunks` (con `embedding`
y `fts`: búsqueda semántica y por texto), `ai_usage_log`, `tracking_events`
(el registro de atribución y de eventos internos; columnas `ip`, `value`,
`currency` y `payload.user_agent` alimentan el user_data de Meta),
`landing_pages`,
`webhook_endpoints` (webhooks salientes hacia sistemas del cliente),
`tracking_config` (**nueva, migración 079 aplicada el 2026-09-01**: los
identificadores de medición por cuenta — 1:1 con `accounts`, owner-only,
token de la CAPI encriptado; guardar aquí no activa nada, §9).

### Funciones SQL que importan
De las 31 expuestas, estas son las que se llaman desde el código (el resto
llevan `_` delante: son internas de triggers):

| Función | Qué hace |
|---|---|
| `transition_deal` | **La única vía** para mover un trato de etapa o cambiar su estado. Bloqueo optimista, deriva el status de `stage_status`, escribe `state_changed` |
| `is_account_member(account_id, rol)` | El guardián de toda la RLS |
| `bump_conversation_on_inbound` | Actualiza último mensaje y no leídos al entrar algo |
| `create_broadcast_with_recipients`, `recompute_broadcast_counts` | Difusiones |
| `recompute_email_campaign_counts` | Campañas de email |
| `match_ai_knowledge_semantic`, `match_ai_knowledge_fts` | RAG del agente IA |
| `claim_ai_reply_slot` | Evita que dos respuestas automáticas salgan a la vez |
| `merge_duplicate_contacts`, `merge_duplicate_conversations` | Deduplicación |
| `redeem_invitation`, `peek_invitation`, `set_member_role`, `remove_account_member`, `transfer_account_ownership` | Miembros |
| `filter_contacts_by_tags`, `set_deal_tags`, `touch_presence` | Utilidades |

```bash
# Esquema vivo (tablas + columnas) y funciones, desde producción:
node -e "const fs=require('fs');const e=Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));fetch(e.NEXT_PUBLIC_SUPABASE_URL+'/rest/v1/',{headers:{apikey:e.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+e.SUPABASE_SERVICE_ROLE_KEY}}).then(r=>r.json()).then(s=>{for(const[n,d]of Object.entries(s.definitions))console.log(n,'::',Object.keys(d.properties||{}).join(', '))})"
```

---

## 4. Primitivas — lo que NO se vuelve a escribir

Esta es la sección que hay que leer antes de escribir código nuevo.

### Tenencia y acceso
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `requireRole(min)` | `lib/auth/account.ts` | Devuelve `{ accountId, userId, role, supabase }` o lanza. **Toda ruta de dashboard empieza aquí** |
| `toErrorResponse(err)` | `lib/auth/account.ts` | Convierte los errores de auth en 401/403 sin filtrar detalles |
| `roleRank`, `canEditSettings`… | `lib/auth/roles.ts` | Política de roles, una sola vez |
| `requireApiKey` | `lib/auth/api-context.ts` | Lo mismo para la API pública v1 con API key y scopes |
| `checkRateLimit` + `RATE_LIMITS` | `lib/rate-limit.ts` | Cubos con nombre por ruta. No inventes contadores |

### Contactos y conversaciones
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `findOrCreateContactByPhone`, `findOrCreateContactByEmail`, `findOrCreateConversation`, `findContactByPhone` | `lib/inbound/resolve.ts` | El alta idempotente al recibir algo. Un contacto por teléfono y cuenta |
| `ingestInboundSms` | `lib/inbound/sms-ingest.ts` | SMS entrante → contacto + conversación + mensaje, con dedupe |
| `ingestInboundEmail` | `lib/inbound/email-ingest.ts` | Lo mismo para email |
| `normalizePhone`, `isValidE164` | `lib/whatsapp/phone-utils.ts` | E.164. Los proveedores exigen el `+` |
| `addContactTagAndDispatch` | `lib/contacts/tag-events.ts` | Poner etiqueta **y** disparar `tag_added`, con tope de cadena para no entrar en bucle |

### Envío
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `resolveSmsProvider` / `resolveVoiceProvider` / `resolveEmailProvider` | `lib/providers/registry.ts` | Qué proveedor usa esta cuenta. **Nunca importes el SDK de Twilio o Telnyx directamente** |
| `deliverSms`, `assertSmsNotSuppressed` | `lib/sms/deliver.ts` | Resolver proveedor → enviar → persistir → actualizar hilo |
| `deliverAutomationEmail` + `assertNotUnsubscribed` | `lib/automations/send-email-step.ts` | Lo mismo para email, con respeto a la baja. El transporte crudo es `sendEmail` en `lib/email/send.ts` |
| `sendMessageToConversation`, `validateSendMessageParams` | `lib/whatsapp/send-message.ts` (+ `meta-api.ts`) | Salida por Meta |
| `countSmsSegments`, `smsEncodingOf` | `lib/sms/segments.ts` | Caracteres → segmentos facturables (GSM-7 160 / UCS-2 70) |

### Plantillas y variables
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `contactText(texto, variables, contacto)` | `lib/automations/contact-text.ts` | Sustituye `{{name}}`, `{{first_name}}`, `{{last_name}}`, `{{phone}}`, `{{email}}`, `{{company}}` |
| `interpolateMessage` | `lib/templates/interpolate.ts` | Resuelve `{{vars.*}}` y `{{message.text}}` |
| Validadores de plantilla de Meta | `lib/whatsapp/template-validators.ts` | Límites y variables contiguas |

> **Contrato de variables, y es un filo.** `contactText` sustituye por **cadena
> vacía** cualquier `{{loquesea}}` que no conozca. Un correo con
> `{{surgery_date}}` sale con un hueco y sin aviso. `{{vars.*}}` solo lo
> resuelve el motor de automatizaciones: en campañas de email y en el envío
> manual **se queda literal en el mensaje**.

### UI
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `TemplateFormDialog`, `TemplateField`, `TemplateFieldGrid`, `TemplateFormNotice` | `components/ui/template-form.tsx` | La forma de los diálogos de plantilla (WhatsApp y email usan las mismas) |
| `components/ui/*` | 24 ficheros sobre Base UI | Botones, diálogos, selects, tabs… |
| `uploadAccountMedia` | `lib/storage/upload-media.ts` | Subida con límites por tipo |

### Infraestructura
| Primitiva | Fichero | Qué resuelve |
|---|---|---|
| `encrypt` / `decrypt` | `lib/whatsapp/encryption.ts` | Todo secreto de proveedor se guarda cifrado |
| `verifyMetaWebhookSignature`, `verifyTelnyxWebhook`, `verifyTwilioSignature`, `verifySendGridSignature`, `verifyResendWebhook` | `lib/*/webhook-signature.ts`, `lib/email/send.ts` | Ninguna entrada de webhook se procesa sin verificar |
| `buildSignatureHeader`, `dispatchWebhookEvent`, `isDeliverableUrl` | `lib/webhooks/{sign,deliver,ssrf}.ts` | Webhooks salientes firmados y sin SSRF |
| `checkFrequencyOrEnqueue`, `drainMessageQueue` | `lib/automations/queue.ts` | Cuota diaria por canal → cola, y el drenaje que la vacía |
| `buildUserData` | `lib/analytics/meta-user-data.ts` | Normalización + hashing de `user_data` para **Meta** (teléfono sin `+`, SHA-256 en minúsculas). Reglas PROPIAS: no reutilices `user-hash.ts` (Google Ads, E.164 con `+`, hashes en mayúsculas) |
| `lookupIpGeo` / `geoFromPlatformHeaders` | `lib/analytics/ip-geo.ts` | IP → ciudad/región/CP/país. Cabeceras de plataforma primero; proveedor opcional con timeout de 2 s, fail-open |
| `getClientIp` | `lib/analytics/client-ip.ts` | La extracción de IP del cliente, UNA vez (`/api/track` y `/api/events` la importan) |
| `resolveFbc` | `lib/conversions/deliver.ts` | `fbc` real si existe; si no, sintetizado desde `fbclid` (`fb.1.<ms>.<fbclid>`). El real SIEMPRE gana |

```bash
find src/lib -name "*.ts" ! -name "*.test.ts" | sort
```

---

## 5. Superficie HTTP — 102 rutas

Cuatro familias, cada una con su forma de autenticar. **Saber cuál es cuál
evita el error clásico de proteger una ruta con el guardián equivocado.**

| Familia | Cómo se autentica | Ejemplos |
|---|---|---|
| Dashboard | `requireRole(...)` sobre la sesión | `api/automations`, `api/deals/[id]/transition`, `api/sms/send`, `api/email/templates`, `api/tracking/config` |
| API pública `v1` | API key con scopes (`getApiContext`) | `api/v1/contacts`, `api/v1/messages`, `api/v1/webhooks` |
| Webhooks entrantes | Firma del proveedor, y token en la ruta cuando el proveedor no firma por cuenta | `whatsapp/webhook` (firma Meta + `hub.verify_token`), `telnyx/webhook` (Ed25519), `twilio/[token]/…` (firma + token), `sendgrid/[token]/webhook`, `email/webhook` e `email/inbound` (Resend) |
| Crons | Cabecera `x-cron-secret` = `AUTOMATION_CRON_SECRET` | `automations/cron`, `flows/cron`, `conversions/cron` |

Fuera de esas cuatro hay dos públicas a propósito: `api/track` (beacon anónimo
de la landing, sin PII) y `api/events` (form_submit y compañía, con dedupe por
`event_id` único).

### La API pública `v1` y el servidor MCP

Es un contrato con consumidores externos, así que se documenta aquí: al borrar
`public-api.md` este pasó a ser el único sitio donde vive.

Se autentica con **API key** (`Authorization: Bearer …`) y cada endpoint exige
un **scope** concreto. Las claves se crean desde Ajustes; en la base de datos
solo queda el hash y un prefijo.

| Endpoint | Scope |
|---|---|
| `GET/POST /api/v1/contacts` | `contacts:read` / `contacts:write` |
| `GET/PATCH /api/v1/contacts/{id}` | `contacts:read` / `contacts:write` |
| `GET /api/v1/conversations` y `/{id}` | `conversations:read` |
| `GET /api/v1/conversations/{id}/messages` | `messages:read` |
| `POST /api/v1/messages` | `messages:send` |
| `POST /api/v1/broadcasts` y `GET /{id}` | `broadcasts:send` |
| `GET/POST/PATCH/DELETE /api/v1/webhooks` y `/{id}` | `webhooks:manage` |
| `GET /api/v1/me` | ninguno: identifica la clave |

**`mcp-server/` es un consumidor de primera clase de esa API**, no un
experimento: un servidor MCP publicable (hoy `wacrm-mcp` en su `package.json`,
**pendiente de renombrar a `adwebcrm-mcp`** junto con su descripción, que
todavía dice «WhatsApp CRM») que expone diez
herramientas —`list_contacts`, `get_contact`, `create_contact`,
`update_contact`, `list_conversations`, `get_conversation`, `list_messages`,
`send_message`, `get_broadcast`, `send_broadcast`— sobre `v1` con una API key.
Si cambias la forma de un endpoint de `v1`, se rompe ahí: `mcp-server/src/`
tiene su propio `tsconfig` y su `pnpm typecheck`.

**Los tres crons no son opcionales:**
- `automations/cron` — drena `automation_pending_executions` (los pasos `wait`).
- `flows/cron` — cierra flujos abandonados; sin él, el índice único de "un flujo
  activo por contacto" bloquea a ese contacto para siempre.
- `conversions/cron` — envía las conversiones pendientes de `message_queue`.

```bash
cd src/app/api && for f in $(find . -name route.ts|sort); do echo "$f: $(grep -oE 'export async function (GET|POST|PATCH|PUT|DELETE)' $f|sed 's/.*function //'|tr '\n' ',')"; done
```

---

## 6. Canales

| Canal | Entrada | Salida manual | Salida automática | Estado de entrega |
|---|---|---|---|---|
| **WhatsApp** | `whatsapp/webhook` | `api/whatsapp/send` | pasos `send_message`, `send_template`, `send_buttons`, `send_list` | Webhook de Meta → `messages.status` |
| **SMS** | `telnyx/webhook`, `twilio/[token]/sms/inbound` → `ingestInboundSms` | `api/sms/send` | paso `send_sms` | `twilio/[token]/sms/status` y el de Telnyx |
| **Email** | `email/inbound` (Resend) → `ingestInboundEmail` | `api/email/send`, campañas | paso `send_email` | `email/webhook`, `sendgrid/[token]/webhook` |
| **Voz** | `telnyx/webhook`, `twilio/[token]/voice/*` | `api/calls/dial` | — | `calls` |

Los tres primeros escriben en la **misma** tabla `messages` y aparecen en el
mismo inbox. Lo único que los distingue es `channel`.

**Cosas específicas de WhatsApp que no aplican a los demás:** ventana de 24 h,
plantillas aprobadas por Meta, mensajes interactivos. El compositor las esconde
cuando el hilo no es de WhatsApp.

---

## 7. Automatizaciones

**22 disparadores**, y lo que de verdad hace falta saber es **quién despacha
cada uno** (si nadie lo despacha, el disparador es decorativo):

| Disparador | Lo despacha |
|---|---|
| `new_message_received`, `first_inbound_message`, `keyword_match`, `interactive_reply`, `message_read` | Webhook de WhatsApp |
| `message_delivered`, `message_failed` | Webhooks de SMS (Telnyx/Twilio) |
| `missed_call` | Webhook de voz al colgar sin contestar |
| `new_contact_created`, `conversation_assigned` | Alta y asignación |
| `tag_added` | `addContactTagAndDispatch` |
| `time_based` | Cron |
| `appointment_created/updated/rescheduled/cancelled/completed/no_show` | API de citas |
| `deal_created` | `POST /api/deals` |
| `deal_stage_changed`, `deal_won`, `deal_lost` | `POST /api/deals/[id]/transition` |

**16 pasos:** `send_message`, `send_buttons`, `send_list`, `send_template`,
`send_sms`, `send_email`, `send_webhook`, `add_tag`, `remove_tag`,
`assign_conversation`, `update_contact_field`, `create_deal`,
`close_conversation`, `wait`, `condition`, `emit_conversion`.

> **`emit_conversion`** (MVP Meta CAPI): inserta un `tracking_event` del
> catálogo canónico con `event_id` determinístico
> (`${event_name}_${contact_id}` — el UNIQUE absorbe re-ejecuciones y Meta
> recibe un solo evento). MVP: solo `qualified_lead`. **No llama a la CAPI**:
> el trigger `_conversion_enqueue` encola y `conversions/cron` entrega.

**Cómo se ejecuta:** `runAutomationsForTrigger` (`lib/automations/engine.ts`)
carga las automatizaciones activas de la cuenta, filtra con `triggerMatches`
—que compara la configuración del disparador contra el contexto— y ejecuta los
pasos en orden. Nunca lanza: los fallos se registran en `automation_logs`. Un
paso `wait` corta la ejecución y escribe una fila en
`automation_pending_executions` que el cron reanuda después.

**Añadir un disparador nuevo son siete sitios**, y saltarse uno lo deja
invisible o peligroso:

1. `src/types/index.ts` — la unión `AutomationTriggerType` y su config
2. `src/lib/automations/trigger-meta.ts` — etiqueta y color (`Record` exhaustivo: si falta, no compila)
3. `src/lib/automations/validate.ts` — validación al activar
4. `src/lib/automations/engine.ts` — rama en `triggerMatches` (sin ella cae en el `return true` final y **dispara siempre**)
5. El sitio que lo despacha (ruta o webhook), con el contexto completo
6. `src/components/automations/automation-builder.tsx` — `TRIGGER_OPTIONS` y su UI de configuración
7. `messages/{en,es,ko}.json`

**Precedente vivo:** `message_read` estuvo implementado de punta a punta
durante meses y era inelegible porque faltaba el paso 6.

```bash
grep -n "AutomationTriggerType" -A 70 src/types/index.ts | grep "  | '"
```

---

## 8. Pipelines

**`transition_deal` es la única vía** para cambiar la etapa o el estado de un
trato. Un `update` directo de `stage_id` no emite `state_changed` y rompe el
cálculo de tiempo en etapa. El formulario sí actualiza por su cuenta los campos
planos (título, valor, notas) y sí borra: eso está bien.

Desde 2026-08-29 esa RPC no se llama desde el navegador: la envuelve
`POST /api/deals/[id]/transition`, que además

1. lee el "antes" (nombres de etapa y `stage_entered_at`) **antes** de mover,
   porque después el contador ya se ha reiniciado;
2. llama a la RPC con el cliente de **sesión** (ver §2);
3. despacha `deal_stage_changed` solo si la etapa cambió de verdad, y
   `deal_won`/`deal_lost` si el estado entró en ganado o perdido.

Mover un trato a una etapa terminal despacha **dos** disparadores (el
movimiento y el cierre). Es deliberado.

El contexto que reciben las automatizaciones incluye
`{{vars.time_in_stage_days}}`, `{{vars.time_in_stage_hours}}`,
`{{vars.from_stage_name}}`, `{{vars.to_stage_name}}`, `{{vars.deal_name}}`,
`{{vars.deal_value}}`, `{{vars.pipeline_name}}` y `{{vars.deal_status}}`.

---

## 9. Atribución y conversiones

`god.js` (compilado desde `src/lib/analytics/god.ts` con esbuild, ver
`pnpm build:god`) vive en la landing de Astro y manda:

- `sendBeacon` → `GET /api/track` para comportamiento anónimo (clics a
  WhatsApp y teléfono, scroll).
- `POST /api/events` para `form_submit` y `ctwa_lead`, que **crean el lead**
  reutilizando la ingesta existente con service role — la API key nunca llega
  al navegador. La rama `form_submit` persiste además la IP (columna `ip`)
  y el `user_agent` del **servidor** (cabecera, recortada a 500), y proyecta
  la geolocalización por IP a los campos personalizados
  `City/State/Zip/Country` — fail-open: un fallo de geo nunca tumba el alta.

Todo aterriza en `tracking_events`, con `event_id` único como antiduplicados.
Las conversiones salientes (Meta CAPI, Google Ads) se encolan en
`message_queue` con `channel='conversion'` y las drena `conversions/cron`.

**El `user_data` que viaja a Meta** (MVP 2026-09-01): 12 de los 15
parámetros — `em/ph/fn/ln` (contacto), `ct/st/zp/country` (de los campos
personalizados de geo), `external_id` (= `contacts.id`),
`client_ip_address`/`client_user_agent` (del tracking_event de origen) y
`fbc` (real de cookie si existe; si no, sintetizado desde `fbclid` por
`resolveFbc`). Faltan `fbp` (solo lo planta el píxel de Meta — es la
palanca más grande que queda), `db` y `ge` (no derivables; decisión de
negocio). Las reglas de normalización viven en `meta-user-data.ts` y son
PROPIAS de Meta: no se toca `user-hash.ts` (Google Ads exige E.164 con `+`).

**La vista de Tracking** (Settings → Tracking, owner-only) guarda los
identificadores de medición en `tracking_config` y muestra diagnóstico
real (eventos registrados vs entregas a plataformas) calculado en
`tracking-diagnostics.ts`. **Guardar un ID ahí no activa nada**: el píxel,
GTM, GA4 y Hotjar viven en el sitio Astro, y el envío del CRM sigue
leyendo `META_CAPI_*` / `GOOGLE_ADS_*` del entorno hasta la fase T2.

---

## 10. Frontend

**Rutas del dashboard** (`src/app/(dashboard)/`): `dashboard`, `inbox`,
`contacts`, `pipelines`, `automations` (+ `new`, `[id]/edit`, `[id]/logs`),
`flows` (+ `[id]`, `[id]/runs`), `broadcasts` (+ `new`, `[id]`), `email`
(+ `new`, `[id]`), `calls`, `appointments`, `agents`, `media`, `reports`,
`notifications`, `settings`.

**Componentes por dominio:** `settings` 29 · `ui` 24 · `inbox` 13 ·
`dashboard` 10 · `flows` 9 · `voice` 8 · `pipelines` 6 · `email` 5 ·
`broadcasts` 4 · `contacts` 4 · `layout` 4 · resto 1–2.

**Hooks que hay que conocer antes de escribir uno:** `use-auth` (cuenta y rol),
`use-can` (permisos en la UI), `use-realtime` (suscripción a `messages`,
`conversations` y `calls`), `use-presence`, `use-total-unread`,
`use-voice`/`use-twilio-voice`/`use-telnyx` (softphone),
`use-broadcast-sending` y `use-email-campaign-sending` (los envíos por lotes),
`use-theme`.

**Realtime** solo escucha esas tres tablas. Lo demás se refresca a mano tras la
mutación.

---

## 11. Guardrails — la checklist antes de dar algo por bueno

1. **¿Existe ya la primitiva?** (§4) Si duplicas, las dos copias divergen.
2. **¿La ruta acota por `account_id`?** Con service role, RLS no te salva.
3. **¿Rol correcto?** `viewer` no puede provocar un envío facturable.
4. **¿Toca `messages`?** Entonces `channel`, `sender_type`, `provider` y
   `provider_message_id` deben ir como los escribe el resto: los webhooks de
   estado buscan la fila por esas claves.
5. **¿Toca la etapa o el estado de un trato?** Solo por `transition_deal`.
6. **¿Texto nuevo en la UI?** Tres idiomas, misma ruta de clave, y comprueba
   que los placeholders ICU coinciden con lo que pasa el componente.
7. **¿Disparador nuevo?** Los siete sitios de §7.
8. **¿Variable nueva en una plantilla?** Si `contactText` no la conoce, sale
   vacía en el correo del paciente.
9. **Gate:** `pnpm typecheck && pnpm lint && pnpm test` en verde antes de
   commitear. Hoy son 1346 tests en 139 ficheros.
10. **¿Un comentario te dijo algo?** Verifícalo (Regla 2).

---

## 12. Deuda conocida y verificada

- **`create_deal` no despacha `deal_created`** a propósito: una automatización
  que crea tratos encadenaría otra automatización.
- **El envío manual de SMS no pasa por la cuota diaria**, igual que el paso del
  engine. Sí cuenta para el total del día.
- **No hay detección de `STOP`** en los SMS entrantes: la baja solo se marca
  hoy desde el enlace de los correos, y el tag `Unsubscribed` bloquea los dos
  canales a la vez.
- **Las etiquetas de `trigger-meta.ts` están en inglés y fuera de i18n**: la
  píldora de la lista de automatizaciones no se traduce, aunque el constructor
  sí.
- **`deal_stuck`** (llevar X días parado) no existe: necesita un barrido
  programado, no un evento.
