import { mapTwilioError, twilioForAccount } from './client'
import { twilioWebhookUrl } from './config'

// ============================================================
// Compra y búsqueda de números.
//
// El número recién comprado se apunta a los webhooks de ESTA cuenta en
// el mismo POST: si se dejara para un segundo paso, un fallo intermedio
// dejaría un número facturándose y sin ruta de entrada.
// ============================================================

export interface AvailableNumber {
  phoneNumber: string
  friendlyName: string
  locality: string | null
  region: string | null
  isoCountry: string
  capabilities: { voice: boolean; sms: boolean; mms: boolean }
}

export async function listAvailableNumbers(
  accountId: string,
  args: { country: string; areaCode?: number; contains?: string; limit?: number },
): Promise<AvailableNumber[]> {
  const { client } = await twilioForAccount(accountId)
  try {
    const list = await client
      .availablePhoneNumbers(args.country)
      .local.list({
        ...(args.areaCode ? { areaCode: args.areaCode } : {}),
        ...(args.contains ? { contains: args.contains } : {}),
        limit: args.limit ?? 20,
      })
    return list.map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality ?? null,
      region: n.region ?? null,
      isoCountry: n.isoCountry,
      capabilities: {
        voice: Boolean(n.capabilities?.voice),
        sms: Boolean(n.capabilities?.sms),
        mms: Boolean(n.capabilities?.mms),
      },
    }))
  } catch (err) {
    throw mapTwilioError(err, 'availablePhoneNumbers.local.list', args.country)
  }
}

export interface PurchasedNumber {
  sid: string
  phoneNumber: string
  voiceUrl: string
  smsUrl: string
}

export async function buyNumber(
  accountId: string,
  e164: string,
  country?: string | null,
): Promise<PurchasedNumber> {
  const { client, cfg } = await twilioForAccount(accountId)

  const voiceUrl = twilioWebhookUrl(cfg.webhookToken, '/voice')
  const smsUrl = twilioWebhookUrl(cfg.webhookToken, '/sms/inbound')

  try {
    const bought = await client.incomingPhoneNumbers.create({
      phoneNumber: e164,
      voiceUrl,
      voiceMethod: 'POST',
      smsUrl,
      smsMethod: 'POST',
      // España, México y buena parte de LATAM exigen bundle + dirección.
      // Se mandan cuando la cuenta los tiene; su ausencia se traduce a un
      // 409 accionable en `mapTwilioError`, no a un 500.
      ...(cfg.regulatoryBundleSid ? { bundleSid: cfg.regulatoryBundleSid } : {}),
      ...(cfg.addressSid ? { addressSid: cfg.addressSid } : {}),
    })
    return {
      sid: bought.sid,
      phoneNumber: bought.phoneNumber,
      voiceUrl,
      smsUrl,
    }
  } catch (err) {
    throw mapTwilioError(err, 'incomingPhoneNumbers.create', country ?? null)
  }
}
