import { describe, expect, it } from 'vitest'

import { agentIdentity, userIdFromIdentity } from './identity'

// ============================================================
// Riesgo #4 del plan: «Identidad con guiones → registro falla EN
// SILENCIO». Twilio no devuelve error al emitir el token; simplemente el
// dispositivo no queda registrado y las entrantes nunca suenan. Por eso
// esto tiene su propio test explícito.
// ============================================================

const UUID = 'a1b2c3d4-e5f6-4788-9abc-def012345678'

describe('agentIdentity', () => {
  it('no deja guiones y respeta el límite de 121 caracteres', () => {
    const identity = agentIdentity(UUID)
    expect(identity).not.toContain('-')
    expect(identity.length).toBeLessThanOrEqual(121)
    expect(identity).toBe('u_a1b2c3d4e5f647889abcdef012345678')
  })

  it('solo usa alfanuméricos y guion bajo (la restricción dura de Twilio)', () => {
    expect(agentIdentity(UUID)).toMatch(/^[A-Za-z0-9_]+$/)
  })

  it('es estable: el mismo usuario da siempre la misma identidad', () => {
    expect(agentIdentity(UUID)).toBe(agentIdentity(UUID))
  })
})

describe('userIdFromIdentity', () => {
  it('es el inverso exacto de agentIdentity', () => {
    expect(userIdFromIdentity(agentIdentity(UUID))).toBe(UUID)
  })

  it('rechaza lo que no sea una identidad nuestra', () => {
    expect(userIdFromIdentity('client:u_abc')).toBeNull()
    expect(userIdFromIdentity('u_notahexstring')).toBeNull()
    expect(userIdFromIdentity('')).toBeNull()
  })
})
