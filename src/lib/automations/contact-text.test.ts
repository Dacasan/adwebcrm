import { describe, expect, it } from 'vitest'

import { contactText } from './contact-text'

// Los campos integrados de `contactText` son el contrato que ven TODAS las
// plantillas (email, WhatsApp, broadcasts): lo que no esté aquí se sustituye
// por cadena vacía en el envío. `first_name` / `last_name` se derivan del
// único campo `name` del contacto.

const contact = {
  name: 'John Smith',
  email: 'john@example.com',
  phone: '+15551234567',
  company: 'Acme',
}

describe('contactText — campos integrados', () => {
  it('resuelve name, email, phone y company', () => {
    expect(
      contactText('{{name}} · {{email}} · {{phone}} · {{company}}', undefined, contact),
    ).toBe('John Smith · john@example.com · +15551234567 · Acme')
  })

  it('deriva first_name y last_name del nombre completo', () => {
    expect(contactText('Hi {{first_name}},', undefined, contact)).toBe('Hi John,')
    expect(contactText('{{last_name}}', undefined, contact)).toBe('Smith')
  })

  it('acepta espacios dentro del marcador', () => {
    expect(contactText('Hi {{ first_name }},', undefined, contact)).toBe('Hi John,')
  })

  it('con un nombre de una sola palabra, last_name queda vacío', () => {
    const solo = { ...contact, name: 'Cher' }
    expect(contactText('{{first_name}}|{{last_name}}', undefined, solo)).toBe('Cher|')
  })

  it('con apellidos compuestos, last_name se queda con el resto', () => {
    const compuesto = { ...contact, name: 'María del Carmen Ruiz Pérez' }
    expect(contactText('{{first_name}}|{{last_name}}', undefined, compuesto)).toBe(
      'María|del Carmen Ruiz Pérez',
    )
  })

  it('normaliza espacios sobrantes en el nombre', () => {
    const sucio = { ...contact, name: '  John   Smith  ' }
    expect(contactText('{{first_name}}|{{last_name}}', undefined, sucio)).toBe('John|Smith')
  })

  it('sin contacto, los campos derivados quedan vacíos (no revientan)', () => {
    expect(contactText('Hi {{first_name}}{{last_name}}!', undefined, null)).toBe('Hi !')
  })

  it('el mapa de variables sigue pudiendo sobrescribir un campo integrado', () => {
    expect(
      contactText('Hi {{first_name}},', { first_name: { type: 'static', value: 'Danny' } }, contact),
    ).toBe('Hi Danny,')
  })

  it('un marcador desconocido se sustituye por vacío (comportamiento previo)', () => {
    expect(contactText('Hi {{surgery_date}}!', undefined, contact)).toBe('Hi !')
  })

  it('deja intacto {{vars.*}} para que lo resuelva interpolate', () => {
    expect(contactText('{{vars.city}}', undefined, contact)).toBe('{{vars.city}}')
  })
})
