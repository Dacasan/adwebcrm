import { supabaseAdmin } from '@/lib/supabase/admin'
import { encrypt } from '@/lib/whatsapp/encryption'
import { ProviderError } from '../errors'
import { createTwilioClient, mapTwilioError } from './client'
import { loadTwilioConfig, twilioWebhookUrl, type TwilioConfig } from './config'

// ============================================================
// Aprovisionamiento automático. Espeja `ensureWebrtcCredential` de
// Telnyx: el usuario pega Account SID + Auth Token y el resto se crea
// solo. Cada `ensure*` es idempotente y persiste lo que crea.
// ============================================================

/**
 * API Key (SKxxx) para firmar los Access Token del softphone.
 *
 * El secreto de una API Key **solo se devuelve en la creación**. Si se
 * pierde no hay forma de recuperarlo y hay que crear otra clave, así que
 * se persiste encriptado en la MISMA operación que lo crea: entre el
 * `create` y el `update` no puede haber ningún `await` que pueda fallar
 * y dejar una clave viva en Twilio que nosotros no sabemos usar.
 */
export async function ensureApiKey(
  accountId: string,
  cfg?: TwilioConfig,
): Promise<{ sid: string; secret: string }> {
  const config = cfg ?? (await loadTwilioConfig(accountId))
  if (config.apiKeySid && config.apiKeySecret) {
    return { sid: config.apiKeySid, secret: config.apiKeySecret }
  }

  const client = createTwilioClient(config.accountSid, config.authToken)
  let created: { sid: string; secret: string }
  try {
    const key = await client.newKeys.create({
      friendlyName: `wacrm-${accountId.slice(0, 8)}`,
    })
    created = { sid: key.sid, secret: key.secret }
  } catch (err) {
    throw mapTwilioError(err, 'newKeys.create')
  }

  if (!created.secret) {
    throw new ProviderError('Twilio returned an API key without a secret', 'twilio')
  }

  const { error } = await supabaseAdmin()
    .from('twilio_config')
    .update({
      api_key_sid: created.sid,
      api_key_secret_encrypted: encrypt(created.secret),
    })
    .eq('account_id', accountId)

  if (error) {
    // La clave existe en Twilio pero no la hemos podido guardar. Se avisa
    // fuerte: es el único caso en que hay que ir a borrarla a mano.
    console.error(
      `[twilio:provision] API key ${created.sid} created but NOT persisted (${error.message}) — revoke it in the Twilio console`,
    )
    throw new ProviderError('could not persist Twilio API key', 'twilio')
  }

  return created
}

/**
 * TwiML App (APxxx). Su `voiceUrl` es el destino de `device.connect()`
 * del softphone: sin ella, la saliente desde el navegador no sabe a dónde
 * ir. Si el SID guardado ya no existe en Twilio (alguien la borró en la
 * consola), se recrea en vez de fallar para siempre.
 */
export async function ensureTwiMLApp(accountId: string, cfg?: TwilioConfig): Promise<string> {
  const config = cfg ?? (await loadTwilioConfig(accountId))
  const client = createTwilioClient(config.accountSid, config.authToken)
  const voiceUrl = twilioWebhookUrl(config.webhookToken, '/voice')

  if (config.twimlAppSid) {
    try {
      const app = await client.applications(config.twimlAppSid).fetch()
      // La base pública puede haber cambiado (dominio nuevo, http→https).
      // Re-apuntarla es barato y evita un 403 de firma imposible de
      // diagnosticar desde el navegador.
      if (app.voiceUrl !== voiceUrl) {
        await client.applications(config.twimlAppSid).update({ voiceUrl, voiceMethod: 'POST' })
      }
      return config.twimlAppSid
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status !== 404) throw mapTwilioError(err, 'applications.fetch')
      console.warn(
        `[twilio:provision] TwiML app ${config.twimlAppSid} is gone from Twilio, recreating`,
      )
    }
  }

  let sid: string
  try {
    const app = await client.applications.create({
      friendlyName: `wacrm-${accountId.slice(0, 8)}`,
      voiceUrl,
      voiceMethod: 'POST',
    })
    sid = app.sid
  } catch (err) {
    throw mapTwilioError(err, 'applications.create')
  }

  const { error } = await supabaseAdmin()
    .from('twilio_config')
    .update({ twiml_app_sid: sid })
    .eq('account_id', accountId)
  if (error) {
    console.error(`[twilio:provision] TwiML app ${sid} created but NOT persisted (${error.message})`)
    throw new ProviderError('could not persist Twilio TwiML app', 'twilio')
  }

  return sid
}
