# Diseñar una landing conmigo y llevarla al proyecto

Dos partes: **el prompt con el que arrancas** y **el camino de la maqueta al
build de Astro**.

---

## 1 · El prompt de arranque

Pégalo tal cual y rellena los corchetes. Lo importante son las tres primeras
líneas: sin ellas se inventa un sistema de diseño en vez de usar el tuyo.

```
Vas a diseñar una landing para el sistema WACRM.

REGLAS DEL SISTEMA — no negociables:
- Usa el skill `SKILL-LANDING-ASTRO` (está en docs/ de este repo y del
  sitio). El CSS real está en src/styles/ del sitio web.
- Sin Tailwind, sin React, sin ningún framework de CSS o UI.
- Mobile-first. UN solo breakpoint: @media (min-width: 900px). Cero max-width.
- Sin !important. Sin style="" en el marcado, salvo pasar tokens (--card-ratio).
- Antes de crear una clase, comprueba que no exista:
  grep -n "\.loQueBuscas" src/styles/*.css
- Tema activo: blanco frío #F6F9FC, azul de marca #274C77 (8.33:1),
  Bricolage Grotesque + Onest (self-hosted, sin Google Fonts), radios
  3-4px, sin sombras, filete en vez de relleno. La marca se configura en
  src/data/site.ts (`theme.primary`…), que BaseLayout vuelca en `:root`.

ENTREGA:
Un HTML suelto con mi CSS inline, que yo pueda abrir con doble clic.
Placeholders SVG en data-URI para las imágenes.

LA PÁGINA:
- Cliente: [nombre] · [ciudad]
- Objetivo de conversión: [uno solo]
- Consulta que trae el tráfico: [la búsqueda exacta del anuncio]
- Idioma: [es / en]
- Secciones: [o "decide tú según references/anatomia.md"]
- Longitud: [~900 palabras para SEO / corta y directa]

ANTES DE ENTREGAR, mide y dime el resultado:
- Desbordamiento horizontal a 390px y 1280px (debe ser 0)
- Contraste AA de cada par color/fondo que uses
- Jerarquía: un solo h1, sin saltos de nivel
```

**Por qué el bloque de medición.** Sin él te entrego algo que *parece* bien.
Con él te entrego números. En esta sesión eso destapó que tu `.row` desbordaba
10px en móvil, que tres reglas no pasaban AA y que el royal fallaba como texto
sobre arena — nada de eso se ve mirando.

### Para iterar

Frases que funcionan mejor que "no me gusta":

| En vez de | Di |
|---|---|
| "se ve viejo" | "el fondo tira a cálido, lo quiero azulado" |
| "muy cargado" | "menos rellenos sólidos, más filete" |
| "más moderno" | "menos redondeo" o "menos saturación en el azul" |
| "hazlo bonito" | enséñame una referencia y di qué te gusta de ella |

Las capturas funcionan mejor que las descripciones. Las quince que me pasaste al
principio decidieron la capa de tarjetas entera.

---

## 2 · De la maqueta al proyecto

El HTML suelto **no es el entregable final**: no pasa por tu build, no hereda
los `<style>` con scope de los `.astro` y no se puede editar desde el dashboard.
Cuando una maqueta te convenza, se traduce en dos piezas.

### El tema → `src/data/site.ts` (no un archivo CSS)

No hay archivo de tema (el antiguo `09-theme-steel.css` se eliminó en el
refactor). El color de marca se configura en `src/data/site.ts`:

```ts
theme: {
  primary: "#274C77",
  primaryDark: "#1B3A5C",
  accent: "#274C77",
},
```

`BaseLayout` los vuelca en un `<style>:root{…}</style>` fuera de las
capas (lo no-capado gana siempre a lo capado — mismo mecanismo que los
`<style>` con scope de un `.astro`). La **estructura** (fondo, filete,
radios, sombras) vive en los tokens de `src/styles/02-tokens.css` y es
global: tocar un token repinta todo el sitio, no una página.

### El azul SÍ va en `site.ts`

El `theme.primary` de `site.ts` es la única fuente del color de marca:
título, enlace y botón comparten el mismo azul (`#274C77`, 8.33:1 sobre
blanco). Si cambias un token de color en CSS, revalida contraste AA de
todo lo que vaya encima (ver lecciones de la sección 3).

### El contenido → las páginas `.astro` (no un JSON)

La página va en `src/pages/<slug>.astro` con **props directas**: cada
bloque del catálogo se monta con su configuración, sin JSON intermedio
(se eliminó `src/data/landings/*.json`, `content.config.ts`,
`BlockRenderer.astro` y `[slug].astro`):

```astro
---
import Layout from "../layouts/BaseLayout.astro";
import HeroFakeH1 from "../components/sections/HeroFakeH1.astro";
import Cards from "../components/sections/Cards.astro";
import Faq from "../components/sections/Faq.astro";
---
<Layout title="…" description="…">
  <HeroFakeH1 badge="…" displayTitle="…" />
  <Cards layout="rail" cards={[{ title: "…", href: "…" }, …]} />
  <Faq faq={[{ q: "…", a: "…" }, …]} />
</Layout>
```

Los datos de negocio (teléfono, WhatsApp, precios, FAQ, servicios) se
leen de `src/data/site.ts` — una sola fuente, sin duplicación. No hay
`html-block` (era el "escape hatch" del catálogo; se eliminó con
BlockRenderer): la prosa larga se monta con los bloques de texto del
catálogo (`TextSection`…) o con un componente propio si hace falta.

> Los datos de `site.ts` viven en el código del cliente — nunca los
> metas por URL ni por formulario. Todo lo que entra por red va a
> `/api/events` y pasa por el schema de `track-event-schema.ts`.

### Comprobar antes de publicar

```bash
cd "sitio web" && pnpm build      # astro check && astro build

# El breakpoint sigue siendo uno solo
grep -rn "@media[^{]*max-width" --include="*.css" --include="*.astro" src/   # vacío

# Peso del sistema
cat src/styles/0*.css | gzip -9 | wc -c

# Contraste de la marca del cliente
node contraste.mjs "#274C77" "#F6F9FC"
```

Y la lista completa está en la sección 20 («Lista de comprobación») del skill.

---

## 3 · Lo que conviene que te diga, y no siempre pides

Tres cosas que salieron solas en esta sesión y que valen para las próximas:

**Cambiar el fondo invalida los colores.** El royal `#4169E1` pasaba 4.85:1
sobre blanco y fallaba con 4.38:1 sobre arena. Si cambias `--bg-color`, hay que
revalidar todo lo que va encima. No es opcional.

**Los bordes tienen dos funciones distintas.** Un filete decorativo puede ir a
1.2:1. El borde de un campo de formulario o de una tarjeta clicable **es** un
componente de interfaz y WCAG 1.4.11 le pide 3:1. Por eso el tema trae
`--border-color` y `--border-strong`.

**Recortar es parte del trabajo.** La capa de tarjetas empezó en 42 selectores y
acabó en 18 porque casi todo se componía con utilidades que ya tenías. Si te
entrego algo que parece mucho CSS, pregúntame qué se puede componer en vez de
añadir.

**Dentro de una capa manda la especificidad.** El tema traía
`h1 { color: var(--color-primary) }` y el `h1` seguía saliendo verde. En el
patrón fake-h1 el `h1` real es `.hero-avail-badge` (el titular grande es un
`<p class="t-4xl">`), y `05-components` le pone
`.hero-avail-badge { color: var(--color-success-ink) }`. Misma capa: una clase
(0,1,0) gana a un elemento (0,0,1). Por eso la insignia va listada aparte en el
tema. Las capas ordenan *entre* archivos; dentro de una, la especificidad sigue
mandando.

---

## 4 · Suelto en el repo, sin relación con el tema

Dos cadenas en español en una página en inglés, escritas a mano en el
componente y no cubiertas por `site.ts`:

- `"Escribir por WhatsApp"` — `HeroFakeH1.astro`
- `"Solicitar llamada"` — `ContactLauncher.astro`

Salen en el hero de `index.astro`, que ya es All on 4 Dental Center en
inglés.
