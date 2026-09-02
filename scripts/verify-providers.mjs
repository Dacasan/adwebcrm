#!/usr/bin/env node
// ============================================================
// verify-providers.mjs — fitness functions de la capa de proveedores
// (plan Twilio/SendGrid §7.2).
//
// Cuatro reglas. Sin compilar, sin red: solo leer archivos, para que
// pueda correr en cada edit (hook PostToolUse) y en CI.
//
//   R1  Aislamiento de SDK    — quién puede importar `twilio` y amigos.
//   R2  Guardia obligatoria   — ninguna ruta de proveedor sin firma o rol.
//   R3  Sin secretos en claro — lo que se escribe `_encrypted` pasa por encrypt().
//   R4  Migraciones           — aditivas, numeradas, sin DROP destructivo.
//   R5  Frontera cliente      — ningún 'use client' alcanza un módulo de
//                               servidor, ni por una cadena de cuatro saltos.
//
// Salida: código 1 y un mensaje accionable por violación.
// ============================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

/** Primera migración de este plan; las anteriores son historia intocable. */
const FIRST_NEW_MIGRATION = 73

const violations = []
function fail(rule, file, message) {
  violations.push({ rule, file, message })
}

// ------------------------------------------------------------
// Utilidades de recorrido
// ------------------------------------------------------------

function walk(dir, filter, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, filter, out)
    else if (filter(full)) out.push(full)
  }
  return out
}

const isTs = (f) => f.endsWith('.ts') || f.endsWith('.tsx')
/** Ruta relativa al repo con separadores POSIX, para comparar y mostrar. */
const rel = (f) => relative(ROOT, f).split(sep).join('/')

const tsFiles = walk(SRC, isTs)
const fileText = new Map()
for (const f of tsFiles) fileText.set(f, readFileSync(f, 'utf8'))

/**
 * ¿El archivo importa realmente el módulo? Se mira `import ... from 'x'`,
 * `import 'x'`, `import('x')` y `require('x')` — NO una mención suelta en un
 * comentario ni un `vi.doMock('x', …)` de un test, que no mete el SDK en
 * ningún bundle.
 */
function importsModule(text, moduleName) {
  const m = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`from\\s+['"]${m}['"]`),
    new RegExp(`import\\s+['"]${m}['"]`),
    new RegExp(`import\\s*\\(\\s*['"]${m}['"]\\s*\\)`),
    new RegExp(`require\\s*\\(\\s*['"]${m}['"]\\s*\\)`),
  ]
  return patterns.some((re) => re.test(text))
}

// ------------------------------------------------------------
// R1 — Aislamiento de SDK
//
// Por qué: es lo que hace que añadir un tercer proveedor sea barato, y lo
// que impide que `use-voice.ts` (cliente) arrastre un SDK de servidor al
// bundle del navegador.
// ------------------------------------------------------------

const SDK_RULES = [
  { module: 'twilio', allow: (p) => p.startsWith('src/lib/providers/twilio/') },
  { module: '@sendgrid/mail', allow: (p) => p.startsWith('src/lib/providers/sendgrid/') },
  { module: '@sendgrid/client', allow: (p) => p.startsWith('src/lib/providers/sendgrid/') },
  { module: '@twilio/voice-sdk', allow: (p) => p === 'src/hooks/use-twilio-voice.ts' },
  { module: 'resend', allow: (p) => p.startsWith('src/lib/email/') || p.startsWith('src/lib/providers/resend/') },
  { module: '@telnyx/webrtc', allow: (p) => p === 'src/hooks/use-telnyx.ts' },
]

for (const [file, text] of fileText) {
  const p = rel(file)
  for (const rule of SDK_RULES) {
    if (!importsModule(text, rule.module)) continue
    if (rule.allow(p)) continue
    fail(
      'R1',
      p,
      `importa '${rule.module}'. Solo el adaptador de ese proveedor puede hacerlo; ` +
        `pasa por src/lib/providers/{registry,types} en su lugar.`,
    )
  }
}

// ------------------------------------------------------------
// R2 — Guardia obligatoria en las rutas de proveedor
//
// Por qué: un webhook sin verificar es una API pública de ESCRITURA. Es el
// fallo más caro posible y el más fácil de olvidar al añadir una ruta.
//
// Regla efectiva (más estricta que "solo webhooks"): TODA ruta bajo
// /api/twilio o /api/sendgrid está guardada por algo —
//   · con `[token]` en la ruta  → verificación de firma del proveedor
//   · sin `[token]`             → `requireRole` (sesión + rol)
// ------------------------------------------------------------

const ROUTE_GUARDS = [
  { base: 'src/app/api/twilio/', verifier: 'verifyTwilioSignature' },
  { base: 'src/app/api/sendgrid/', verifier: 'verifySendGridSignature' },
]

for (const [file, text] of fileText) {
  const p = rel(file)
  if (!p.endsWith('/route.ts')) continue
  const guard = ROUTE_GUARDS.find((g) => p.startsWith(g.base))
  if (!guard) continue

  if (p.includes('/[token]/')) {
    if (!text.includes(guard.verifier)) {
      fail('R2', p, `webhook público sin \`${guard.verifier}\`. Verifica la firma ANTES de tocar la BD.`)
    }
  } else if (!text.includes('requireRole')) {
    fail('R2', p, 'ruta autenticada sin `requireRole`. Declara el rol mínimo explícitamente.')
  }
}

// ------------------------------------------------------------
// R3 — Sin secretos en claro
//
// Heurística: si un archivo ESCRIBE una columna `*_encrypted`, tiene que
// mencionar `encrypt(` en el mismo archivo. `decrypt(` no cuenta (no
// contiene la subcadena) — leer un secreto es legítimo, escribirlo sin
// cifrar no.
// ------------------------------------------------------------

const ENCRYPTED_COLUMNS = [
  'auth_token_encrypted',
  'api_key_secret_encrypted',
  'api_key_encrypted',
  'resend_api_key_encrypted',
]

for (const [file, text] of fileText) {
  const p = rel(file)
  if (p.endsWith('.test.ts') || p.endsWith('.test.tsx')) continue
  // Solo los archivos que ESCRIBEN en la BD entran en la regla. Uno que se
  // limita a declarar el tipo de la fila o a leerla (config.ts) menciona la
  // columna sin escribirla nunca — marcarlo sería ruido, y el ruido acaba
  // con el guard desactivado.
  const persists = /\.(insert|upsert|update)\s*\(/.test(text)
  if (!persists) continue
  for (const col of ENCRYPTED_COLUMNS) {
    // Escritura = la columna aparece como clave de objeto (`col:` o `'col':`).
    const writes = new RegExp(`['"\`]?${col}['"\`]?\\s*:`).test(text)
    if (!writes) continue
    if (text.includes('encrypt(')) continue
    fail(
      'R3',
      p,
      `escribe ${col} sin llamar a encrypt(). Usa encrypt() de @/lib/whatsapp/encryption.`,
    )
  }
}

// ------------------------------------------------------------
// R5 — La frontera cliente/servidor, de verdad
//
// R1 mira importaciones DIRECTAS y eso no basta: el SDK de Twilio se
// coló en el bundle del navegador por una cadena de cuatro saltos
// (`step3-email-preview` → engine → registry → twilio/voice → 'twilio'),
// y el síntoma fue un `Can't resolve 'fs'` en pleno `next build`, no un
// aviso legible.
//
// Aquí se construye el grafo de imports de `src/` y se recorre desde cada
// archivo `'use client'`. Si alguno alcanza el registry o un adaptador de
// proveedor, se falla con la CADENA COMPLETA, que es lo único que hace
// el fallo accionable.
// ------------------------------------------------------------

/**
 * Módulos que jamás pueden acabar en un bundle de navegador.
 *
 * La lista se limita a la superficie que este plan gobierna (§2.3) más el
 * engine, que es el puente por el que se coló el SDK. El cliente
 * service-role NO está aquí a propósito: hay una fuga preexistente
 * (`reports/page.tsx` → `lib/reporting/acquisition.ts`) ajena a este
 * trabajo, y meterla dejaría el guard rojo desde el primer día — que es
 * la forma más segura de que alguien lo desactive.
 */
const SERVER_ONLY = [
  'src/lib/providers/registry.ts',
  'src/lib/providers/routing.ts',
  'src/lib/providers/twilio/',
  'src/lib/providers/sendgrid/',
  'src/lib/providers/telnyx/',
  'src/lib/providers/resend/',
  'src/lib/telnyx/api.ts',
  'src/lib/email/send.ts',
  'src/lib/automations/engine.ts',
]

const isServerOnly = (p) => SERVER_ONLY.some((s) => (s.endsWith('/') ? p.startsWith(s) : p === s))

/** Resuelve un especificador a una ruta de `src/`, o null si es externo. */
function resolveSpecifier(fromPath, spec) {
  let base
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`
  else if (spec.startsWith('.')) {
    const dir = fromPath.split('/').slice(0, -1)
    const parts = spec.split('/')
    for (const part of parts) {
      if (part === '.') continue
      else if (part === '..') dir.pop()
      else dir.push(part)
    }
    base = dir.join('/')
  } else return null

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (fileText.has(join(ROOT, candidate))) return candidate
  }
  return null
}

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g

const graph = new Map()
const clientRoots = []
for (const [file, text] of fileText) {
  const p = rel(file)
  if (p.endsWith('.test.ts') || p.endsWith('.test.tsx')) continue
  const deps = new Set()
  for (const m of text.matchAll(IMPORT_RE)) {
    // `import type` no emite código: no arrastra nada al bundle.
    const before = text.slice(Math.max(0, m.index - 60), m.index)
    if (/\bimport\s+type\b/.test(before)) continue
    const resolved = resolveSpecifier(p, m[1])
    if (resolved) deps.add(resolved)
  }
  graph.set(p, deps)
  if (/^\s*(?:\/\/[^\n]*\n|\s)*['"]use client['"]/.test(text)) clientRoots.push(p)
}

for (const root of clientRoots) {
  const parent = new Map([[root, null]])
  const queue = [root]
  let hit = null
  while (queue.length > 0 && !hit) {
    const current = queue.shift()
    for (const dep of graph.get(current) ?? []) {
      if (parent.has(dep)) continue
      parent.set(dep, current)
      if (isServerOnly(dep)) {
        hit = dep
        break
      }
      queue.push(dep)
    }
  }
  if (hit) {
    const chain = []
    for (let node = hit; node; node = parent.get(node)) chain.unshift(node)
    fail(
      'R5',
      root,
      `componente de cliente alcanza el módulo de servidor ${hit}.\n        Cadena: ${chain.join(' → ')}`,
    )
  }
}

// ------------------------------------------------------------
// R4 — Migraciones
//
// Aditivas: nada de DROP TABLE / DROP COLUMN / ALTER COLUMN … TYPE en las
// migraciones nuevas. Excepción única (plan §3.5): un DROP CONSTRAINT
// acompañado del ADD CONSTRAINT del MISMO nombre en el MISMO archivo —
// ensanchar un CHECK es aditivo en la práctica.
// ------------------------------------------------------------

const migrationFiles = walk(MIGRATIONS, (f) => f.endsWith('.sql'))
  .map((f) => ({ full: f, name: f.split(sep).pop() }))
  .sort((a, b) => a.name.localeCompare(b.name))

const seen = new Map()
for (const { name } of migrationFiles) {
  const m = /^(\d{3})_/.exec(name)
  if (!m) {
    fail('R4', `supabase/migrations/${name}`, 'nombre sin prefijo NNN_ — la numeración es el orden de aplicación.')
    continue
  }
  const n = Number(m[1])
  if (seen.has(n)) {
    fail('R4', `supabase/migrations/${name}`, `número duplicado ${m[1]} (ya lo usa ${seen.get(n)}).`)
  } else {
    seen.set(n, name)
  }
}

const numbers = [...seen.keys()].sort((a, b) => a - b)
for (let i = 1; i < numbers.length; i++) {
  if (numbers[i] !== numbers[i - 1] + 1) {
    fail(
      'R4',
      'supabase/migrations',
      `hueco en la numeración: ${String(numbers[i - 1]).padStart(3, '0')} → ${String(numbers[i]).padStart(3, '0')}.`,
    )
  }
}

for (const { full, name } of migrationFiles) {
  const n = Number(name.slice(0, 3))
  if (!Number.isFinite(n) || n < FIRST_NEW_MIGRATION) continue
  const sql = readFileSync(full, 'utf8')
  // Los comentarios (-- …) no cuentan: el plan se documenta a sí mismo.
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')

  for (const banned of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i]) {
    if (banned.test(code)) {
      fail('R4', `supabase/migrations/${name}`, `contiene ${banned.source} — las migraciones de este plan son aditivas.`)
    }
  }

  // DROP CONSTRAINT: solo con su ADD CONSTRAINT gemelo en el mismo archivo.
  const dropped = [...code.matchAll(/\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([\w".]+)/gi)].map((m) =>
    m[1].replace(/"/g, ''),
  )
  for (const constraint of dropped) {
    const added = new RegExp(`\\bADD\\s+CONSTRAINT\\s+"?${constraint}"?\\b`, 'i').test(code)
    if (!added) {
      fail(
        'R4',
        `supabase/migrations/${name}`,
        `DROP CONSTRAINT ${constraint} sin su ADD CONSTRAINT ${constraint} en el mismo archivo.`,
      )
    }
  }

  // DROP POLICY / DROP TRIGGER / DROP INDEX son el patrón idempotente del
  // repo (DROP … IF EXISTS + CREATE) y no destruyen datos: permitidos.
}

// ------------------------------------------------------------
// Informe
// ------------------------------------------------------------

if (violations.length === 0) {
  console.log(
    'verify-providers: OK (R1 aislamiento, R2 guardias, R3 secretos, R4 migraciones, R5 frontera cliente)',
  )
  process.exit(0)
}

console.error(`\nverify-providers: ${violations.length} violación(es)\n`)
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}\n        ${v.message}`)
}
console.error('')
process.exit(1)
