import { type NextRequest } from 'next/server'

import { handleRecording } from '@/lib/api/calls/recording'

// ============================================================
// Ruta histórica. `calls.recording_url` guarda esta URL en las filas
// creadas antes de la unificación, así que no puede desaparecer: el
// handler vive en `@/lib/api/calls/recording` y sirve las grabaciones de
// cualquier proveedor.
// ============================================================

export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ callId: string }> },
) {
  return handleRecording(req, context)
}
