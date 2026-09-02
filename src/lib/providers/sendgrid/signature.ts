import { createPublicKey, createVerify } from 'node:crypto'

// ============================================================
// Firma del Signed Event Webhook de SendGrid: ECDSA P-256 sobre
// `timestamp + rawBody`. Espeja el estilo de
// `src/lib/telnyx/webhook-signature.ts`, con una diferencia que hay que
// mirar dos veces:
//
//   el timestamp de SendGrid está en SEGUNDOS,
//   el de Telnyx en MILISEGUNDOS.
//
// Copiar la comparación del otro archivo sin ajustar da una ventana
// anti-replay de cinco milisegundos — es decir, rechaza todo.
// ============================================================

const MAX_TIMESTAMP_DRIFT_MS = 300_000

export interface SignatureCheck {
  ok: boolean
  reason?: string
}

export function verifySendGridSignature(args: {
  publicKeyB64: string | null
  /** Header `X-Twilio-Email-Event-Webhook-Signature`. */
  signatureB64: string | null
  /** Header `X-Twilio-Email-Event-Webhook-Timestamp` (segundos Unix). */
  timestamp: string | null
  rawBody: string
}): SignatureCheck {
  if (!args.publicKeyB64) return { ok: false, reason: 'public key not configured' }
  if (!args.signatureB64 || !args.timestamp) return { ok: false, reason: 'missing headers' }

  const ts = Number(args.timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > MAX_TIMESTAMP_DRIFT_MS) {
    return { ok: false, reason: 'stale timestamp' }
  }

  try {
    const key = createPublicKey({
      key: Buffer.from(args.publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    const verifier = createVerify('sha256')
    verifier.update(args.timestamp + args.rawBody)
    verifier.end()
    const ok = verifier.verify(key, Buffer.from(args.signatureB64, 'base64'))
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' }
  } catch {
    return { ok: false, reason: 'verification failed' }
  }
}
