import { NextResponse, type NextRequest } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/supabase/admin'

// ============================================================
// Proxy autenticado de grabaciones, para CUALQUIER proveedor. Rol: agent.
//
// El handler vive en `lib/` porque lo sirven DOS rutas: la actual y la
// histórica `/api/telnyx/recordings/[callId]`. Next no admite reexportar
// `runtime` de otro route.
//
// Era `/api/telnyx/recordings/[callId]`; la ruta vieja sigue existiendo y
// re-exporta esta, porque hay filas de `calls` con esa URL persistida en
// `recording_url` y romperlas dejaría grabaciones inaccesibles.
//
// El bucket `call-recordings` es el único privado del sistema: no hay
// getPublicUrl. Se lee el path de `calls.recording_storage_path`, se
// firma una URL de 5 min y se redirige (302).
// ============================================================

export async function handleRecording(
  _req: NextRequest,
  context: { params: Promise<{ callId: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole('agent')
    const { callId } = await context.params

    const admin = supabaseAdmin()
    const { data: call } = await admin
      .from('calls')
      .select('recording_storage_path')
      .eq('id', callId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (!call?.recording_storage_path) {
      return NextResponse.json({ error: 'recording not found' }, { status: 404 })
    }

    const { data: signed, error } = await admin.storage
      .from('call-recordings')
      .createSignedUrl(call.recording_storage_path, 300)

    if (error || !signed?.signedUrl) {
      return NextResponse.json({ error: 'recording unavailable' }, { status: 500 })
    }

    return NextResponse.redirect(signed.signedUrl, 302)
  } catch (err) {
    return toErrorResponse(err)
  }
}
