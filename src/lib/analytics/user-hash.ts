// ============================================================
// analytics/user-hash.ts — normalización compartida de user_data
//
// Punto 4 de la consolidación (Fase 6): normalizeEmail/normalizePhone
// estaban copiadas idénticas en google-ads.ts y meta-capi.ts. Viven
// aquí porque ambas plataformas exigen user_data hasheado con el MISMO
// formato: email minúsculas sin espacios, teléfono E.164 (dígitos + '+').
//
// NO mover `sha256Hex` aquí: google-ads devuelve HEX en mayúsculas y
// meta-capi en minúsculas (requisito de cada API) — esa diferencia es
// intencional y vive en cada adapter.
// ============================================================

/** Normaliza un email para hashing: minúsculas y sin espacios. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Normaliza un teléfono a E.164: solo dígitos y el prefijo '+'. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  return digits.startsWith('+') ? digits : `+${digits}`
}