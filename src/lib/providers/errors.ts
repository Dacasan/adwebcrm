// ============================================================
// Errores de la capa de proveedores.
//
// Existen para que las rutas puedan mapear un `catch` único al status
// correcto sin comparar mensajes por substring — que es lo que hoy hace
// `/api/telnyx/numbers/check` con `msg.includes('config not found')`.
// ============================================================

/** Fallo genérico hablando con un proveedor. `status` es el HTTP del proveedor. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    /** Código propio del proveedor (`21649` de Twilio, p. ej.). */
    readonly code?: string | number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/**
 * La cuenta tiene el proveedor seleccionado pero le falta configuración.
 * Se traduce a 404/400 con instrucción accionable, nunca a un 500.
 */
export class ProviderNotConfiguredError extends ProviderError {
  constructor(message: string, provider = 'unknown') {
    super(message, provider, 404)
    this.name = 'ProviderNotConfiguredError'
  }
}

/**
 * Bloqueo regulatorio: falta un Regulatory Bundle o una dirección para
 * comprar un número en ese país (Twilio `21649` / `21650`). Es un 409 con
 * instrucción, no un fallo del sistema (§Fase 5).
 */
export class RegulatoryBundleRequiredError extends ProviderError {
  constructor(
    message: string,
    readonly country: string | null,
    provider = 'twilio',
  ) {
    super(message, provider, 409, 'regulatory_bundle_required')
    this.name = 'RegulatoryBundleRequiredError'
  }
}
