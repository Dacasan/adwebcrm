import { describe, expect, it } from 'vitest'

import {
  hangupTwiML,
  inboundToClientsTwiML,
  inboundToNumberTwiML,
  outboundTwiML,
  voicemailTwiML,
} from './twiml'

// ============================================================
// Funciones puras: aquí no hay un solo mock, y por eso es donde está el
// valor de esta capa.
// ============================================================

const URLS = {
  actionUrl: 'https://crm.example/api/twilio/tok/voice/action',
  statusCallbackUrl: 'https://crm.example/api/twilio/tok/voice/status',
  recordingCallbackUrl: 'https://crm.example/api/twilio/tok/voice/recording',
}

describe('inboundToClientsTwiML', () => {
  it('mete un <Client> por identidad dentro de un solo <Dial>', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      callerId: '+34910000000',
      identities: ['u_a', 'u_b', 'u_c'],
    })
    expect(xml.match(/<Client/g)).toHaveLength(3)
    expect(xml.match(/<Dial/g)).toHaveLength(1)
    expect(xml).toContain('>u_a</Client>')
    expect(xml).toContain('>u_c</Client>')
  })

  it('sin recordingCallbackUrl no pone `record` — la grabación es opt-in', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      recordingCallbackUrl: null,
      callerId: '+34910000000',
      identities: ['u_a'],
    })
    expect(xml).not.toContain('record=')
    expect(xml).not.toContain('recordingStatusCallback')
  })

  it('con grabación activada usa record-from-answer', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      callerId: '+34910000000',
      identities: ['u_a'],
    })
    expect(xml).toContain('record="record-from-answer"')
    expect(xml).toContain(URLS.recordingCallbackUrl)
  })

  it('dualChannel pide canales separados (QA)', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      callerId: '+34910000000',
      identities: ['u_a'],
      dualChannel: true,
    })
    expect(xml).toContain('record="record-from-answer-dual"')
  })

  it('escapa el callerId: un & no puede romper el documento', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      callerId: 'Clínica Ruiz & Hijos',
      identities: ['u_a'],
    })
    expect(xml).toContain('Clínica Ruiz &amp; Hijos')
    expect(xml).not.toContain('Ruiz & Hijos')
  })

  it('escapa también el contenido del <Client>', () => {
    const xml = inboundToClientsTwiML({
      ...URLS,
      callerId: '+34910000000',
      identities: ['<script>alert(1)</script>'],
    })
    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;script&gt;')
  })
})

describe('inboundToNumberTwiML / outboundTwiML', () => {
  it('desvía a un <Number> con el caller id de la cuenta', () => {
    const xml = inboundToNumberTwiML({ ...URLS, callerId: '+34910000000', to: '+34600111222' })
    expect(xml).toContain('callerId="+34910000000"')
    expect(xml).toContain('>+34600111222</Number>')
  })

  it('la saliente del navegador comparte forma con el desvío', () => {
    const a = outboundTwiML({ ...URLS, callerId: '+34910000000', to: '+34600111222' })
    const b = inboundToNumberTwiML({ ...URLS, callerId: '+34910000000', to: '+34600111222' })
    expect(a).toBe(b)
  })

  it('respeta un timeout explícito', () => {
    const xml = inboundToNumberTwiML({
      ...URLS,
      callerId: '+34910000000',
      to: '+34600111222',
      timeoutSecs: 12,
    })
    expect(xml).toContain('timeout="12"')
  })
})

describe('voicemailTwiML', () => {
  it('avisa, graba y cuelga', () => {
    const xml = voicemailTwiML({
      message: 'No podemos atenderte',
      recordingCallbackUrl: URLS.recordingCallbackUrl,
    })
    expect(xml).toContain('<Say')
    expect(xml).toContain('No podemos atenderte')
    expect(xml).toContain('<Record')
    expect(xml).toContain('<Hangup/>')
  })

  it('sin grabación permitida, avisa y cuelga sin <Record>', () => {
    const xml = voicemailTwiML({ message: 'Hola', recordingCallbackUrl: null })
    expect(xml).toContain('<Say')
    expect(xml).not.toContain('<Record')
    expect(xml).toContain('<Hangup/>')
  })

  it('escapa el mensaje', () => {
    const xml = voicemailTwiML({ message: 'Ruiz & Hijos <clínica>', recordingCallbackUrl: null })
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;clínica&gt;')
  })
})

describe('hangupTwiML', () => {
  it('es un documento válido con solo <Hangup/>', () => {
    const xml = hangupTwiML()
    expect(xml).toContain('<Response>')
    expect(xml).toContain('<Hangup/>')
    expect(xml).not.toContain('<Dial')
  })
})
