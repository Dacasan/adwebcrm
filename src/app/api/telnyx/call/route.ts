import { type NextRequest } from 'next/server'

import { handleDial } from '@/lib/api/calls/dial'

// ============================================================
// Ruta histórica. El marcado saliente es agnóstico de proveedor desde el
// plan Twilio/SendGrid y su implementación vive en
// `@/lib/api/calls/dial`; esta ruta se conserva porque
// `today-queue.tsx` y `contact-sidebar.tsx` la llaman por su nombre
// viejo, y el contrato de respuesta no ha cambiado.
// ============================================================

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return handleDial(req)
}
