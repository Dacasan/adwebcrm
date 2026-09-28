<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Antes de tocar este repo: lee la documentación

Vive fuera de este repositorio, en **https://docs.adwebcrm.com** (fuente:
repositorio `sitio-docs`). Cubre el CRM y el kit de sitios juntos, y ninguno de
los dos la posee. Las páginas del CRM son
[Architecture](https://docs.adwebcrm.com/crm/architecture/),
[Data model](https://docs.adwebcrm.com/crm/data-model/),
[Primitives](https://docs.adwebcrm.com/crm/primitives/),
[Channels](https://docs.adwebcrm.com/crm/channels/),
[Automations](https://docs.adwebcrm.com/crm/automations/),
[Pipelines](https://docs.adwebcrm.com/crm/pipelines/),
[Attribution](https://docs.adwebcrm.com/crm/attribution/) y
[Public API](https://docs.adwebcrm.com/crm/public-api/).

Cuatro reglas que salen de ahí y que aquí se repiten porque cuestan dinero:

1. **Este repo no lleva documentación propia.** Ni `docs/`, ni planes internos
   de la agencia. Un documento dentro del repo se convierte en una segunda
   fuente de verdad que diverge en la primera semana: ya pasó con `docs/CRM.md`
   y con la copia de `architecture.md`, retiradas el 2026-09-02. Si una
   instrucción te manda a un `docs/*.md` o a un `PLAN-*.md` de este repo, ese
   fichero no existe y no debe volver a existir.
2. **Los comentarios del código no son verdad.** Han derivado en varios sitios.
   Trátalos como hipótesis: verifica contra el código antes de apoyarte en uno.
3. **No sobre-ingeniería.** Antes de escribir una función, busca la primitiva
   en [Primitives](https://docs.adwebcrm.com/crm/primitives/). Duplicar
   tenencia, envío, ingesta o interpolación es el error más caro de este repo.
4. **Este repo es público y descendiente de wacrm (MIT).** `LICENSE` conserva
   `Copyright (c) 2026 Arnas Donauskas`, literal. Se añade, nunca se
   sustituye. Y no comitees secretos: `.env*` está ignorado, y la
   configuración de proveedor se guarda cifrada en la base de datos, no en el
   código.

**pnpm siempre.** Nunca npm ni bun. Antes de dar un cambio por bueno:
`pnpm typecheck && pnpm lint && pnpm test`.

**Medición y conversiones (2026-09-28).** El bucle completo vive en
`src/lib/analytics/` + `src/lib/conversions/` y está documentado en
[Attribution](https://docs.adwebcrm.com/crm/attribution/) — no lo dupliques,
pero estas fronteras cuestan dinero:

- **El contrato de hidden inputs es two-PR:** `ContactFields.astro` (web-kit)
  y `fillHiddenInputs` en `god.ts` van SIEMPRE juntos. Los campos ad-level
  de Google Ads usan prefijo `gads_` (matchtype/campaign_id/ad_group_id/
  ad_id/location → `attribution.ad`). Añadir de un solo lado = pérdida
  silenciosa de datos.
- **Funnel de conversiones:** todas las etapas se entregan a ambas
  plataformas (`lead` con valor menor/secondary, `qualified_lead`,
  `better_lead`, `appointment_booked`, `appointment_showed`, `deal_won`).
  `lead` y `better_lead` nacen por tag del comercial vía acción
  `emit_conversion` (event_id determinístico, dedup por UNIQUE). El trigger
  `_conversion_enqueue` (migración 081) encola; `/api/conversions/cron`
  entrega.
- **Una conversion action por etapa:** `resolveConversionActionId` mapea
  `event_name → GOOGLE_ADS_CONVERSION_ACTION_<LEAD|QUALIFIED|BETTER|BOOKED|
  SHOWED|WON>` con fallback al env único. Los IDs son el número, nunca
  `AW-…/label`.
- **Hashes NO compartibles:** Google Data Manager = SHA-256 HEX MAYÚSCULAS,
  teléfono E.164 CON `+` (`user-hash.ts`); Meta CAPI = hex minúsculas,
  teléfono solo dígitos (`meta-user-data.ts`). Los tests usan los vectores
  oficiales de Meta — no "unifiques" los normalizadores.
- **Creds CAPI:** env primero, fallback `tracking_config` (token cifrado
  AES-256-GCM). Graph API v25.0. `deal_won` → `action_source:
  system_generated` (nace en el CRM); el resto → `website`.
- **Sin integración de conversión nueva debe tocar `conversion_deliveries`**
  — esa tabla ya no existe (070): la cola es `message_queue` channel=
  'conversion'.

Si cambias el comportamiento que la documentación describe, abre el cambio
correspondiente en `sitio-docs` a la vez. Cada página lleva un bloque
**Verify this page** con los comandos exactos que la comprueban contra este
código: si tu cambio los altera, la página está desactualizada.

---

**El sitio es otro repositorio.** `sitio-<cliente>`, construido sobre el paquete
`web-kit`. Ninguna ruta relativa llega de aquí a allá. La frontera completa está
en [Boundary with the CRM](https://docs.adwebcrm.com/web-kit/architecture/#boundary-with-the-crm);
un cambio que la cruce necesita dos PRs, uno en cada repo.
