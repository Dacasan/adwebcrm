import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { geoFromPlatformHeaders, lookupIpGeo } from './ip-geo'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('lookupIpGeo — IPs privadas/bucle: {} sin llamar a nadie', () => {
  const privadas = [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '::1',
    'fc00::1234',
    'fd12::abcd',
  ]

  it.each(privadas)('%s → {} y cero llamadas de red', async (ip) => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    const out = await lookupIpGeo(ip)
    expect(out).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("'unknown' (fallback de getClientIp) y null → {} sin red", async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    expect(await lookupIpGeo('unknown')).toEqual({})
    expect(await lookupIpGeo(null)).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('lookupIpGeo — modo por defecto y fallos: {} y silencio', () => {
  it('sin IPGEO_URL configurado → {} sin red y NI UN log', async () => {
    const out = await lookupIpGeo('189.203.11.4')
    expect(out).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('timeout/red caída → {} sin lanzar', async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    fetchMock.mockRejectedValue(new Error('network down'))
    const out = await lookupIpGeo('189.203.11.4')
    expect(out).toEqual({})
  })

  it('proveedor responde 500 → {}', async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    const out = await lookupIpGeo('189.203.11.4')
    expect(out).toEqual({})
  })

  it('respuesta no-JSON → {}', async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    const out = await lookupIpGeo('189.203.11.4')
    expect(out).toEqual({})
  })
})

describe('lookupIpGeo — proveedor configurado', () => {
  it('mapea city/region/postal/country y sustituye {ip} en la plantilla', async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ city: 'Cancún', region: 'QR', postal: '77500', country: 'mx' }),
        { status: 200 }
      )
    )
    const out = await lookupIpGeo('189.203.11.4')
    expect(out).toEqual({ city: 'Cancún', region: 'QR', postal: '77500', country: 'mx' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://geo.example.test/lookup?ip=189.203.11.4')
    expect((init as RequestInit).signal).toBeDefined()
  })

  it('IPGEO_KEY viaja como Bearer; claves vacías se omiten', async () => {
    vi.stubEnv('IPGEO_URL', 'https://geo.example.test/lookup?ip={ip}')
    vi.stubEnv('IPGEO_KEY', 'sekret')
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ city: 'X', postal: '', country: 'us' }), { status: 200 })
    )
    const out = await lookupIpGeo('1.2.3.4')
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sekret' })
    // postal vacío → omitido (no se proyecta un campo en blanco)
    expect(out).toEqual({ city: 'X', country: 'us' })
  })
})

describe('geoFromPlatformHeaders — cabeceras de plataforma (coste cero)', () => {
  it('Vercel: city URL-encoded se decodifica; country/region/postal', () => {
    const h = new Headers({
      'x-vercel-ip-city': 'Canc%C3%BAn',
      'x-vercel-ip-country': 'MX',
      'x-vercel-ip-country-region': 'QR',
      'x-vercel-ip-postal-code': '77500',
    })
    expect(geoFromPlatformHeaders(h)).toEqual({
      city: 'Cancún',
      country: 'MX',
      region: 'QR',
      postal: '77500',
    })
  })

  it('Cloudflare: cf-ip* mapeados; XX y T1 (especiales, no ISO) se descartan', () => {
    const h = new Headers({
      'cf-ipcity': 'New York',
      'cf-ipcountry': 'XX',
      'cf-region-code': 'NY',
      'cf-postal-code': '10001',
    })
    expect(geoFromPlatformHeaders(h)).toEqual({
      city: 'New York',
      region: 'NY',
      postal: '10001',
    })

    const tor = new Headers({ 'cf-ipcountry': 'T1' })
    expect(geoFromPlatformHeaders(tor).country).toBeUndefined()
  })

  it('sin cabeceras geo → {}', () => {
    expect(geoFromPlatformHeaders(new Headers())).toEqual({})
  })
})
