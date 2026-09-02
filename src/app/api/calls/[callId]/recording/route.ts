import { type NextRequest } from 'next/server'

import { handleRecording } from '@/lib/api/calls/recording'

// GET /api/calls/[callId]/recording — grabación de cualquier proveedor.
// La implementación es compartida: ver `@/lib/api/calls/recording`.

export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ callId: string }> },
) {
  return handleRecording(req, context)
}
