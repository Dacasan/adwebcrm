// ============================================================
// Identidad del softphone.
//
// RESTRICCIÓN DURA DE TWILIO: la identidad de un Access Token admite
// solo caracteres alfanuméricos y guiones bajos, con un máximo de 121.
// Un UUID con guiones NO da error al emitir el token: el dispositivo
// simplemente no queda registrado, y las entrantes nunca llegan al
// navegador. Es un fallo silencioso, y por eso la normalización vive en
// su propio archivo con su propio test.
//
// `u_` + 32 hex = 34 caracteres. Reversible: el webhook necesita volver
// del `<Client>` al usuario.
// ============================================================

const PREFIX = 'u_'

export function agentIdentity(userId: string): string {
  return `${PREFIX}${userId.replace(/-/g, '')}`
}

/** Inverso de `agentIdentity`: devuelve el UUID con guiones, o null. */
export function userIdFromIdentity(identity: string): string | null {
  if (!identity.startsWith(PREFIX)) return null
  const hex = identity.slice(PREFIX.length)
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
