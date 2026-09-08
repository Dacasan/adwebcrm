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

Si cambias el comportamiento que la documentación describe, abre el cambio
correspondiente en `sitio-docs` a la vez. Cada página lleva un bloque
**Verify this page** con los comandos exactos que la comprueban contra este
código: si tu cambio los altera, la página está desactualizada.

---

**El sitio es otro repositorio.** `sitio-<cliente>`, construido sobre el paquete
`web-kit`. Ninguna ruta relativa llega de aquí a allá. La frontera completa está
en [Boundary with the CRM](https://docs.adwebcrm.com/web-kit/architecture/#boundary-with-the-crm);
un cambio que la cruce necesita dos PRs, uno en cada repo.
