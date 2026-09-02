#!/usr/bin/env node
// ============================================================
// Importa la secuencia de correos de ../mails a `email_templates`.
//
// Origen: `mails/manifest.csv` (id, bloque, título, asuntos) + un HTML
// completo por fila. Destino: una plantilla por fila en el CRM, editable
// en Email > Templates.
//
// La transformación NO es copiar y pegar — el HTML de origen trae
// marcadores de autor que no se pueden enviar tal cual:
//
//   1. El logo es un placeholder `[VERIFY: host logo-a4-dark.png…]`.
//      Se sustituye por la URL pública, y la banda de cabecera pasa de
//      blanca a verde oscuro: `logo-a4-dark.png` es la versión con el
//      texto en blanco, invisible sobre fondo blanco.
//   2. `{{coordinator_name}}` / `{{coordinator_email}}` no son campos del
//      CRM (que solo resuelve name/first_name/last_name/phone/email/
//      company). Se fijan al coordinador real: cualquier `{{…}}` que el
//      CRM no conozca se sustituye por CADENA VACÍA en el envío.
//   3. La dirección del pie es requisito CAN-SPAM y estaba sin rellenar.
//      Se toma de `sitio-web/src/data/site.ts`, la misma que publica el
//      JSON-LD del sitio.
//
// El resto de `[VERIFY: …]` (enlaces de reserva, fotos de pacientes,
// citas textuales, unsubscribe) se deja intacto A PROPÓSITO: son
// decisiones editoriales, y el sitio para tomarlas es el editor del CRM.
//
// Idempotente: upsert por (account_id, name), así que re-ejecutarlo
// sobrescribe la plantilla con el HTML de origen. Si ya la editaste en el
// CRM, tu edición se PIERDE — de ahí el --dry-run por defecto en la duda.
//
// Uso:
//   node scripts/import-email-templates.mjs --dry-run
//   node scripts/import-email-templates.mjs --out /tmp/preview
//   node scripts/import-email-templates.mjs            # escribe en la BD
//
// Flags: --dry-run · --out <dir> · --dir <mails> · --account <uuid>
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Datos del despliegue, no del repo: este script importa plantillas para
// UNA cuenta concreta y no debe llevar la marca de ningún cliente dentro.
const LOGO_URL = process.env.TEMPLATE_LOGO_URL || 'https://example.com/logo.png'
const COORDINATOR_NAME = process.env.TEMPLATE_COORDINATOR_NAME || 'Your coordinator'
const COORDINATOR_EMAIL = process.env.TEMPLATE_COORDINATOR_EMAIL || 'hello@example.com'
const CLINIC_ADDRESS = process.env.TEMPLATE_CLINIC_ADDRESS || 'Your business address'

/** Nombre de plantilla por id del manifest. Prefijo numérico = orden del
 *  embudo (la lista del CRM ordena por nombre); luego bloque y tema. */
const NAMES = {
  '01': '01_lead_request_received',
  '02': '02_lead_case_sounds_familiar',
  '03': '03_lead_one_question',
  '04': '04_story_reminded_me_of_a_patient',
  '05': '05_story_why_patients_come',
  '06': '06_story_same_question',
  '07': '07_doctor_meet_dr_lugo',
  '08': '08_doctor_not_a_walk_in',
  '09': '09_doctor_why_a_specialty_center',
  10: '10_safety_not_on_your_own',
  11: '11_safety_transportation_included',
  12: '12_safety_clinic_feels_like_a_clinic',
  13: '13_records_send_your_xray',
  14: '14_records_three_things_i_need',
  15: '15_records_case_to_the_doctor',
  16: '16_complexity_straightforward_or_planning',
  17: '17_complexity_prices_start_from',
  18: '18_complexity_no_surprise_numbers',
  19: '19_estimate_your_treatment_estimate',
  20: '20_estimate_whats_included',
  21: '21_estimate_compare_whats_behind',
  22: '22_objection_how_are_you_feeling',
  23: '23_objection_one_thing_still_thinking',
  24: '24_objection_hard_part_done',
  25: '25_proof_look_what_happened',
  26: '26_proof_she_traveled_alone',
  27: '27_proof_what_patients_say',
  28: '28_proof_real_case_looks_like',
  29: '29_book_patients_already_booking',
  30: '30_book_your_treatment_date',
  31: '31_book_reserve_appointment',
  32: '32_book_hold_your_date',
  33: '33_flight_lock_everything_in',
  34: '34_flight_book_and_we_schedule',
  35: '35_flight_missing_piece',
  36: '36_confirm_officially_booked',
  37: '37_confirm_treatment_plan',
  38: '38_confirm_airport_hotel_clinic',
  39: '39_pretravel30_thirty_days',
  40: '40_pretravel30_getting_close',
  41: '41_pretravel15_fifteen_days',
  42: '42_pretravel15_case_in_motion',
  43: '43_pretravel05_five_days',
  44: '44_pretravel05_arrival_plan',
  45: '45_pretravel01_tomorrow',
  46: '46_noanswer_tried_calling',
  47: '47_noanswer_still_looking',
  48: '48_noanswer_no_spam',
  49: '49_noanswer_we_stop_calling',
  50: '50_noanswer_last_shot',
  51: '51_noshow_we_missed_each_other',
  52: '52_noshow_still_interested',
  53: '53_noshow_last_followup',
  54: '54_nurture_patients_traveling_now',
  55: '55_nurture_vacation_package',
  56: '56_nurture_treatment_credit',
  57: '57_nurture_no_rush',
  58: '58_post_thank_you',
  59: '59_post_how_was_your_experience',
  60: '60_post_your_story_could_help',
  C1: 'c1_complex_needs_detailed_plan',
  C2: 'c2_complex_complex_is_okay',
  F1: 'f1_free_i_read_your_story',
  F2: 'f2_free_cant_promise_free',
  F3: 'f3_free_no_false_hope',
  L1: 'l1_local_already_in_cancun',
  L2: 'l2_local_lets_get_started',
  L3: 'l3_local_riviera_maya',
  L4: 'l4_local_come_in_this_week',
  L5: 'l5_localdoubt_see_for_yourself',
  L6: 'l6_localdoubt_meet_the_doctor',
}

// ── CSV (RFC 4180: comillas dobles y comas dentro de campo) ──
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...body] = rows.filter((r) => r.length > 1)
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

function readEnv() {
  const raw = readFileSync(join(REPO, '.env.local'), 'utf8')
  const env = {}
  for (const line of raw.split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return env
}

// ── Transformación de un HTML de origen ──
const HEADER_WHITE =
  'style="background:#FFFFFF;padding:30px 48px 18px 48px;text-align:center;border-bottom:1px solid #DCE7E6;"'
const HEADER_DARK = 'style="background:#0E3D3C;padding:28px 48px;text-align:center;"'
const LOGO_PLACEHOLDER = '[VERIFY: host logo-a4-dark.png and paste its public URL here]'
const ADDRESS_PLACEHOLDER = 'Av. [VERIFY: clinic address], Canc&uacute;n, Quintana Roo, M&eacute;xico'

function transform(html, id) {
  const problems = []
  const replaceAll = (s, from, to, { required = true, label } = {}) => {
    const count = s.split(from).length - 1
    if (required && count === 0) problems.push(`${id}: no se encontró ${label}`)
    return s.split(from).join(to)
  }

  let out = html
  out = replaceAll(out, LOGO_PLACEHOLDER, LOGO_URL, { label: 'el placeholder del logo' })
  out = replaceAll(out, HEADER_WHITE, HEADER_DARK, { label: 'la banda de cabecera blanca' })
  out = replaceAll(out, ADDRESS_PLACEHOLDER, CLINIC_ADDRESS, { label: 'la dirección del pie' })
  // `{{ coordinator_name }}` con o sin espacios — el generador emite ambas.
  out = out.replace(/\{\{\s*coordinator_name\s*\}\}/g, COORDINATOR_NAME)
  out = out.replace(/\{\{\s*coordinator_email\s*\}\}/g, COORDINATOR_EMAIL)
  return { html: out, problems }
}

/** Marcadores que el CRM NO resuelve y que, si se envían, salen vacíos. */
// `unsubscribe_url` no es un campo del contacto: la resuelve el pipeline
// de envío (lib/email/unsubscribe-url.ts) por destinatario antes de
// entregar al proveedor — igual que {{first_name}} se resuelve con
// contactText. No es "sin resolver".
const CRM_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'email', 'company', 'unsubscribe_url'])
function unresolvedVars(html) {
  const found = new Set()
  for (const m of html.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
    if (!CRM_FIELDS.has(m[1])) found.add(m[1])
  }
  return [...found]
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    return i === -1 ? fallback : argv[i + 1]
  }

  const dryRun = flag('--dry-run')
  const outDir = value('--out', null)
  const mailsDir = resolve(value('--dir', join(REPO, '..', 'mails')))
  const env = readEnv()
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    throw new Error('faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local')
  }
  const api = (path, init = {}) =>
    fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

  // Cuenta destino: la que tiene email configurado, salvo --account.
  let accountId = value('--account', null)
  if (!accountId) {
    const res = await api('email_config?select=account_id,from_email')
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(
        `no puedo deducir la cuenta (${Array.isArray(rows) ? rows.length : '?'} filas en email_config) — pasa --account <uuid>`,
      )
    }
    accountId = rows[0].account_id
    console.log(`Cuenta: ${accountId} (${rows[0].from_email})`)
  }

  const manifest = parseCsv(readFileSync(join(mailsDir, 'manifest.csv'), 'utf8'))
  const rows = []
  const problems = []
  const needsEditing = []

  for (const entry of manifest) {
    const name = NAMES[entry.id]
    if (!name) {
      problems.push(`sin nombre para el id "${entry.id}" — añádelo a NAMES`)
      continue
    }
    const source = readFileSync(join(mailsDir, entry.file), 'utf8')
    const { html, problems: p } = transform(source, entry.id)
    problems.push(...p)
    const subject = entry.subject_a.trim()
    if (!subject) problems.push(`${entry.id}: subject_a vacío`)

    const pending = unresolvedVars(html)
    const verifies = (html.match(/\[VERIFY:/g) ?? []).length
    if (pending.length || verifies) {
      needsEditing.push({ name, vars: pending, verifies })
    }

    rows.push({ account_id: accountId, name, subject, body_html: html })
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `${name}.html`), html)
    }
  }

  console.log(`\n${rows.length} plantillas preparadas desde ${mailsDir}`)
  if (outDir) console.log(`HTML transformado escrito en ${outDir}`)
  if (problems.length) {
    console.error(`\n⚠  ${problems.length} problema(s):`)
    for (const p of problems) console.error(`   - ${p}`)
    throw new Error('abortado: el origen no encaja con lo que espera el script')
  }

  const verifyTotal = needsEditing.reduce((n, e) => n + e.verifies, 0)
  console.log(
    `\nPendiente de editar en el CRM: ${needsEditing.length} plantillas, ` +
      `${verifyTotal} marcadores [VERIFY:]`,
  )
  for (const e of needsEditing.filter((x) => x.vars.length)) {
    console.log(`   ${e.name} — variables sin resolver: ${e.vars.join(', ')}`)
  }

  if (dryRun) {
    console.log('\n--dry-run: no se ha escrito nada en la base de datos.')
    return
  }

  // Upsert en lotes: una request por 10 filas mantiene el cuerpo por
  // debajo de ~100 KB y hace legible qué lote falla si algo peta.
  const CHUNK = 10
  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const res = await api('email_templates?on_conflict=account_id,name', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      throw new Error(`upsert falló en el lote ${i / CHUNK + 1}: ${res.status} ${await res.text()}`)
    }
    written += batch.length
    process.stdout.write(`\r  escritas ${written}/${rows.length}`)
  }
  console.log(`\n✓ ${written} plantillas en email_templates (cuenta ${accountId})`)
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`)
  process.exit(1)
})
