// ============================================================
// GET /unsubscribe — página informativa (sin id de contacto).
// Es el destino de `{{unsubscribe_url}}` cuando un email se envía
// suelto (sin contacto en la BD). No procesa nada.
// ============================================================

export function GET(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title>
</head>
<body style="margin:0;padding:0;background:#EEF4F3;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="min-height:70vh;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:100%;background:#FFFFFF;border:1px solid #DCE7E6;border-radius:10px;">
          <tr><td style="background:#0E3D3C;padding:28px 36px;border-radius:10px 10px 0 0;">
            <div style="color:#DDF1F0;font-size:13px;font-weight:700;letter-spacing:1px;">UNSUBSCRIBE</div>
          </td></tr>
          <tr><td style="padding:36px;">
            <h1 style="margin:0 0 14px 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:32px;color:#0E3D3C;">Unsubscribe</h1>
            <p style="margin:0;font-size:15px;line-height:24px;color:#3D3D3D;">To stop receiving our emails, please use the unsubscribe link included at the bottom of the email you received &mdash; or simply reply to it and ask to be removed.</p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
