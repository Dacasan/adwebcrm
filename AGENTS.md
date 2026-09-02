<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Antes de tocar este repo: lee `docs/CRM.md`

Es la **única base de verdad** del CRM: arquitectura, primitivas, base de datos,
rutas, canales, automatizaciones y las reglas de este código. Está derivada del
código y del esquema real de producción, no de otros documentos.

Cuatro reglas que salen de ahí y que aquí se repiten porque cuestan dinero:

1. **`docs/CRM.md` es el único documento de este repo.** Es público a
   propósito: los planes internos de la agencia no viajan aquí. Si una
   instrucción te manda a un `PLAN-*.md`, ese fichero no está en este clon y no
   debe estarlo.
2. **Los comentarios del código no son verdad.** Han derivado en varios sitios.
   Trátalos como hipótesis: verifica contra el código antes de apoyarte en uno.
3. **No sobre-ingeniería.** Antes de escribir una función, busca la primitiva
   en `docs/CRM.md` §4. Duplicar tenencia, envío, ingesta o interpolación es el
   error más caro de este repo.
4. **Este repo es público y descendiente de wacrm (MIT).** `LICENSE` conserva
   `Copyright (c) 2026 Arnas Donauskas`, literal. Se añade, nunca se
   sustituye. Y no comitees secretos: `.env*` está ignorado, y la
   configuración de proveedor se guarda cifrada en la base de datos, no en el
   código.

**pnpm siempre.** Nunca npm ni bun. Antes de dar un cambio por bueno:
`pnpm typecheck && pnpm lint && pnpm test`.

Si cambias el comportamiento que `docs/CRM.md` describe, actualiza el documento
en el mismo cambio.

---

**El sitio es otro repositorio.** `sitio-<cliente>`, construido sobre el paquete
`web-kit`. Ninguna ruta relativa llega de aquí a allá. La frontera completa —
seis líneas — está en `docs/CRM.md` §Regla 6; un cambio que la cruce necesita
dos PRs, uno en cada repo.
