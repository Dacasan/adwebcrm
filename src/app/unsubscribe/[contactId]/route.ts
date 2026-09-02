import { supabaseAdmin } from '@/lib/supabase/admin'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { UNSUBSCRIBED_TAG } from '@/lib/email/unsubscribe-url'

// ============================================================
// GET /unsubscribe/[contactId] — baja pública de emails, sin auth.
//
// Primitivo puro: NO inventa estado. Añade el tag "Unsubscribed" al
// contacto con la MISMA primitiva que usa el engine
// (`addContactTagIfAbsent`), que a su vez dispara los automatismos
// `tag_added` ya configurados en la cuenta. Idempotente: re-clicar el
// link no duplica el tag (unique contact_id+tag_id).
// ============================================================

function page(status: number, title: string, message: string, accountName?: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#EEF4F3;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="min-height:70vh;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:100%;background:#FFFFFF;border:1px solid #DCE7E6;border-radius:10px;">
          <tr><td style="background:#0E3D3C;padding:28px 36px;border-radius:10px 10px 0 0;">
            <div style="color:#DDF1F0;font-size:13px;font-weight:700;letter-spacing:1px;">${accountName ?? 'UNSUBSCRIBE'}</div>
          </td></tr>
          <tr><td style="padding:36px;">
            <h1 style="margin:0 0 14px 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:32px;color:#0E3D3C;">${title}</h1>
            <p style="margin:0;font-size:15px;line-height:24px;color:#3D3D3D;">${message}</p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ contactId: string }> },
) {
  const { contactId } = await context.params
  const admin = supabaseAdmin()

  const { data: contact } = await admin
    .from('contacts')
    .select('id, account_id')
    .eq('id', contactId)
    .maybeSingle()

  if (!contact) {
    // Mismo copy para "no existe": no filtramos si el id es real.
    return page(
      404,
      'This link is not valid',
      'The unsubscribe link you followed is not valid or has expired. If you keep receiving our emails, just reply to any of them and ask to be removed.',
    )
  }

  // Find-or-create del tag, scoped a la cuenta del contacto. El INSERT
  // necesita user_id (NOT NULL desde 001): usamos el owner de la cuenta.
  // `name` alimenta la cabecera de la página de baja: cada desuscripción
  // muestra el nombre de SU clínica, no un literal de otra.
  const { data: account } = await admin
    .from('accounts')
    .select('owner_user_id, name')
    .eq('id', contact.account_id)
    .single()

  let { data: tag } = await admin
    .from('tags')
    .select('id')
    .eq('account_id', contact.account_id)
    .ilike('name', UNSUBSCRIBED_TAG)
    .maybeSingle()

  if (!tag && account?.owner_user_id) {
    const { data: created } = await admin
      .from('tags')
      .insert({
        account_id: contact.account_id,
        user_id: account.owner_user_id,
        name: UNSUBSCRIBED_TAG,
      })
      .select('id')
      .single()
    tag = created
  }

  if (!tag) {
    console.error('[unsubscribe] could not resolve tag', { contactId })
    return page(
      500,
      'Something went wrong',
      'We could not process your request right now. Please try again later, or simply reply to the email you received and ask to be removed.',
    )
  }

  // La primitiva del engine — dispara los `tag_added` automáticamente.
  await addContactTagIfAbsent(admin, {
    accountId: contact.account_id,
    contactId: contact.id,
    tagId: tag.id,
  })

  return page(
    200,
    'You are unsubscribed',
    'Your email address has been added to our do-not-send list. You will not receive further emails from us. If you change your mind, just contact us at any time.',
    account?.name,
  )
}
