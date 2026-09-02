import { type NextRequest } from 'next/server'

import { handleDial } from '@/lib/api/calls/dial'

// POST /api/calls/dial — marcado saliente por el proveedor activo.
// La implementación es compartida: ver `@/lib/api/calls/dial`.

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return handleDial(req)
}
