import { describe, expect, it } from 'vitest'
import { buildUserData, sha256Hex } from './meta-user-data'

// ============================================================
// Vectores oficiales de la documentación de Meta (customer
// information parameters). Si un hash no reproduce, la
// normalización está mal — no el vector (PLAN §6.1).
//
// El vector `db` (2/16/1997 → 19970216 → 01acdb…) NO se prueba:
// la fecha de nacimiento está excluida del MVP por decisión de
// negocio (PLAN §0/§6.3) y el tipo no la acepta — añadir un
// normalizador de fechas sin llamador sería código muerto.
// ============================================================

const VECTOR_EM = '62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f'
const VECTOR_PH = 'e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176'
const VECTOR_FN = '6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec'
const VECTOR_COUNTRY = '79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621'

describe('buildUserData — vectores oficiales de Meta', () => {
  it('em: John_Smith@gmail.com → john_smith@gmail.com', async () => {
    const out = await buildUserData({ email: 'John_Smith@gmail.com' })
    expect(out.em).toBe(VECTOR_EM)
  })

  it('ph: 1(650)555-1212 → 16505551212, SIN + y sin ceros a la izquierda (DEF-1)', async () => {
    // La doc de Meta usa esta entrada CON el country code: la
    // normalización quita símbolos y ceros, NUNCA inventa el código de
    // país (por eso el plan §6.1 sin el "1" no puede reproducir el vector).
    const out = await buildUserData({ phone: '1(650)555-1212' })
    expect(out.ph).toBe(VECTOR_PH)
  })

  it('ph: un número sin country code se normaliza sin inventarlo', async () => {
    const out = await buildUserData({ phone: '(650)555-1212' })
    expect(out.ph).toBe(await sha256Hex('6505551212'))
  })

  it('ph: el formato E.164 con + produce el MISMO hash que sin él', async () => {
    const a = await buildUserData({ phone: '+16505551212' })
    const b = await buildUserData({ phone: '1 (650) 555-1212' })
    expect(a.ph).toBe(VECTOR_PH)
    expect(b.ph).toBe(VECTOR_PH)
  })

  it('fn: Mary → mary', async () => {
    const out = await buildUserData({ firstName: 'Mary' })
    expect(out.fn).toBe(VECTOR_FN)
  })

  it('country: United States → us', async () => {
    const out = await buildUserData({ country: 'United States' })
    expect(out.country).toBe(VECTOR_COUNTRY)
  })

  it('country: alpha-2 ya normalizado pasa tal cual (caso real del pipeline geo)', async () => {
    const out = await buildUserData({ country: 'MX' })
    expect(out.country).toBe(await sha256Hex('mx'))
  })
})

describe('buildUserData — invariantes', () => {
  it('un campo vacío, en blanco o ausente se OMITE (nunca "" ni hash de "")', async () => {
    const out = await buildUserData({
      email: '   ',
      phone: '',
      firstName: undefined,
      fbc: '',
      clientIpAddress: '',
    })
    expect(out).toEqual({})
  })

  it('campos en claro viajan sin hash y con su nombre de parámetro Meta', async () => {
    const out = await buildUserData({
      fbc: 'fb.1.1554763741205.AbCd',
      fbp: 'fb.1.1596403881668.1116446470',
      clientIpAddress: '189.203.11.4',
      clientUserAgent: 'Mozilla/5.0 Test',
    })
    expect(out).toEqual({
      fbc: 'fb.1.1554763741205.AbCd',
      fbp: 'fb.1.1596403881668.1116446470',
      client_ip_address: '189.203.11.4',
      client_user_agent: 'Mozilla/5.0 Test',
    })
  })

  it('fn/ln: sin dígitos ni puntuación, conserva espacios internos', async () => {
    const out = await buildUserData({ firstName: 'Mary-Jane 2nd', lastName: "O'Neil" })
    expect(out.fn).toBe(await sha256Hex('maryjane nd'))
    expect(out.ln).toBe(await sha256Hex('oneil'))
  })

  it('ct: sin acentos, espacios ni puntuación (Cancún → cancun)', async () => {
    const out = await buildUserData({ city: 'Cancún' })
    expect(out.ct).toBe(await sha256Hex('cancun'))
  })

  it('ct/st: New York → newyork (sin espacios)', async () => {
    const out = await buildUserData({ city: 'New York', state: 'N.Y.' })
    expect(out.ct).toBe(await sha256Hex('newyork'))
    expect(out.st).toBe(await sha256Hex('ny'))
  })

  it('zp: en EE. UU. solo los 5 primeros dígitos', async () => {
    const us = await buildUserData({ zip: '94105-1234', country: 'us' })
    expect(us.zp).toBe(await sha256Hex('94105'))
  })

  it('external_id se hashea', async () => {
    const out = await buildUserData({ externalId: '8f3c-contact-id' })
    expect(out.external_id).toBe(await sha256Hex('8f3c-contact-id'))
  })

  it('un contacto completo produce exactamente los 13 parámetros del MVP', async () => {
    const out = await buildUserData({
      email: 'juan@correo.com',
      phone: '+52 998 123 4567',
      firstName: 'Juan',
      lastName: 'Perez',
      city: 'Cancún',
      state: 'QR',
      zip: '77500',
      country: 'mx',
      externalId: 'contact-1',
      fbc: 'fb.1.1755165600000.AbC123',
      clientIpAddress: '189.203.11.4',
      clientUserAgent: 'Mozilla/5.0',
    })
    expect(Object.keys(out).sort()).toEqual(
      [
        'client_ip_address',
        'client_user_agent',
        'country',
        'ct',
        'em',
        'external_id',
        'fbc',
        'fn',
        'ln',
        'ph',
        'st',
        'zp',
      ].sort(),
    )
    expect(Object.keys(out).length).toBe(12)
  })
})
