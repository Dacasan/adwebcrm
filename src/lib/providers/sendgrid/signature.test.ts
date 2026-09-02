import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { verifySendGridSignature } from './signature'

// ============================================================
// ECDSA P-256 sobre `timestamp + rawBody`.
//
// El detalle que se lleva por delante a quien copia el verificador de
// Telnyx: el timestamp de SendGrid viene en SEGUNDOS y el de Telnyx en
// MILISEGUNDOS. Con la comparación equivocada la ventana anti-replay
// pasa a ser de cinco milisegundos y el webhook rechaza absolutamente
// todo.
// ============================================================

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PUBLIC_KEY_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

const BODY = JSON.stringify([{ event: 'delivered', sg_message_id: 'abc.recvd-1' }])

function sign(timestamp: string, body: string): string {
  const signer = createSign('sha256')
  signer.update(timestamp + body)
  signer.end()
  return signer.sign(privateKey).toString('base64')
}

const NOW_SECONDS = 1_800_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_SECONDS * 1000)
})
afterEach(() => vi.useRealTimers())

describe('verifySendGridSignature', () => {
  it('acepta una firma válida y reciente', () => {
    const ts = String(NOW_SECONDS)
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: sign(ts, BODY),
        timestamp: ts,
        rawBody: BODY,
      }),
    ).toEqual({ ok: true })
  })

  it('rechaza si el cuerpo cambió aunque sea un byte', () => {
    const ts = String(NOW_SECONDS)
    const result = verifySendGridSignature({
      publicKeyB64: PUBLIC_KEY_B64,
      signatureB64: sign(ts, BODY),
      timestamp: ts,
      rawBody: BODY.replace('delivered', 'bounce'),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature mismatch')
  })

  it('rechaza sin clave pública configurada (fail-closed → 503 en la ruta)', () => {
    const ts = String(NOW_SECONDS)
    const result = verifySendGridSignature({
      publicKeyB64: null,
      signatureB64: sign(ts, BODY),
      timestamp: ts,
      rawBody: BODY,
    })
    expect(result).toEqual({ ok: false, reason: 'public key not configured' })
  })

  it('rechaza sin cabeceras', () => {
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: null,
        timestamp: String(NOW_SECONDS),
        rawBody: BODY,
      }).reason,
    ).toBe('missing headers')
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: 'x',
        timestamp: null,
        rawBody: BODY,
      }).reason,
    ).toBe('missing headers')
  })

  it('acepta dentro de la ventana de 5 min y rechaza fuera — leyendo SEGUNDOS', () => {
    const inside = String(NOW_SECONDS - 240)
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: sign(inside, BODY),
        timestamp: inside,
        rawBody: BODY,
      }).ok,
    ).toBe(true)

    const outside = String(NOW_SECONDS - 600)
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: sign(outside, BODY),
        timestamp: outside,
        rawBody: BODY,
      }),
    ).toEqual({ ok: false, reason: 'stale timestamp' })
  })

  it('un timestamp en milisegundos (el error clásico de copiar Telnyx) se detecta como stale', () => {
    const asMillis = String(NOW_SECONDS * 1000)
    expect(
      verifySendGridSignature({
        publicKeyB64: PUBLIC_KEY_B64,
        signatureB64: sign(asMillis, BODY),
        timestamp: asMillis,
        rawBody: BODY,
      }).reason,
    ).toBe('stale timestamp')
  })

  it('una clave pública corrupta no revienta: devuelve ok:false', () => {
    const ts = String(NOW_SECONDS)
    expect(
      verifySendGridSignature({
        publicKeyB64: 'bm90LWEta2V5',
        signatureB64: sign(ts, BODY),
        timestamp: ts,
        rawBody: BODY,
      }).ok,
    ).toBe(false)
  })
})
