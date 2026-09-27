import { describe, expect, it } from 'vitest';

import { parseUrlParams, buildAttribution } from './attribution';
import { attributionFieldValues } from './attribution-fields';

// El tracking template real, a nivel de cuenta en Google Ads:
// {lpurl}?utm_source=Google&utm_medium={network}&utm_campaign={_campaign}&
//   utm_content={_adgroup}/{_adname}&utm_term={keyword}&matchtype={matchtype}&
//   campaign_id={campaignid}&ad_group_id={adgroupid}&ad_id={creative}&
//   location={_location}
describe('parseUrlParams — params ad-level del tracking template de Google Ads', () => {
  it('captura el grupo ad completo cuando los custom parameters están definidos', () => {
    const out = parseUrlParams(
      '?utm_source=Google&utm_medium=cpc&utm_campaign=AllOn4-Search' +
      '&utm_content=implantes-costo/anuncio-1&utm_term=all on 4 cost' +
      '&matchtype=e&campaign_id=21949058731&ad_group_id=167045928312' +
      '&ad_id=701283456219&location=Mexico&gclid=Cj0KCQ'
    );
    expect(out.ad).toEqual({
      matchtype: 'e',
      campaign_id: '21949058731',
      ad_group_id: '167045928312',
      ad_id: '701283456219',
      location: 'Mexico',
    });
    expect(out.utm).toEqual({
      source: 'Google',
      medium: 'cpc',
      campaign: 'AllOn4-Search',
      content: 'implantes-costo/anuncio-1',
      term: 'all on 4 cost',
    });
    expect(out.click_ids).toEqual({ gclid: 'Cj0KCQ' });
  });

  it('custom parameters sin definir → string vacía (doc ValueTrack) → no se guardan', () => {
    // {_campaign}, {_adgroup}, {_adname} y {_location} sin definir: la URL
    // llega con utm_campaign=, utm_content=/ (dos vacíos + barra) y location=.
    const out = parseUrlParams('?utm_source=Google&utm_medium=g&utm_campaign=&utm_content=/&matchtype=b&location=');
    expect(out.utm?.campaign).toBeUndefined();
    expect(out.utm?.content).toBeUndefined();
    expect(out.ad).toEqual({ matchtype: 'b' });
  });

  it('el compuesto utm_content parcialmente expandido se guarda tal cual (es dato real)', () => {
    const out = parseUrlParams('?utm_content=implantes-costo/');
    expect(out.utm?.content).toBe('implantes-costo/');
  });

  it('descarta placeholders literales sin expandir (defensa — la doc dice vacío, no literal)', () => {
    const out = parseUrlParams('?utm_campaign={_campaign}&location={_location}&matchtype=p&campaign_id=123');
    expect(out.utm).toBeUndefined();
    expect(out.ad).toEqual({ matchtype: 'p', campaign_id: '123' });
  });

  it('sin nada ad-level, out no trae la clave ad', () => {
    const out = parseUrlParams('?utm_source=google&utm_medium=organic');
    expect(out.ad).toBeUndefined();
    expect(out.utm).toEqual({ source: 'google', medium: 'organic' });
  });
});

describe('buildAttribution — ad fluye hasta la atribución canónica', () => {
  it('preserva ad cuando la URL la trae y no toca canal/medio inferidos', () => {
    const attr = buildAttribution({
      search: '?matchtype=p&campaign_id=123&gclid=Cj0KCQ',
      referrer: '',
      landingPath: '/all-on-4-dental-implants-cancun-cost/',
    });
    expect(attr.ad).toEqual({ matchtype: 'p', campaign_id: '123' });
    expect(attr.click_ids.gclid).toBe('Cj0KCQ');
    expect(attr.channel).toBe('google');
    expect(attr.medium).toBe('cpc');
  });

  it('sin ad en la URL la salida NO trae la clave (las comparaciones estrictas existentes no se mueven)', () => {
    const attr = buildAttribution({ search: '', referrer: '', landingPath: '/' });
    expect('ad' in attr).toBe(false);
  });
});

describe('attributionFieldValues — los campos ad llegan a la ficha del lead', () => {
  it('proyecta matchtype/campaign_id/ad_group_id/ad_id/ad_location', () => {
    const out = attributionFieldValues({
      ad: { matchtype: 'b', campaign_id: '123', ad_group_id: '456', ad_id: '789', location: 'Mexico' },
      click_ids: { gclid: 'x' },
      landing_slug: '/l/',
    });
    expect(out.matchtype).toBe('b');
    expect(out.campaign_id).toBe('123');
    expect(out.ad_group_id).toBe('456');
    expect(out.ad_id).toBe('789');
    expect(out.ad_location).toBe('Mexico');
    expect(out.click_id).toBe('gclid:x');
  });

  it('sin ad la proyección queda como antes (sin filas vacías en la ficha)', () => {
    const out = attributionFieldValues({ click_ids: { gclid: 'x' }, landing_slug: '/l/' });
    expect(Object.keys(out).sort()).toEqual(['click_id', 'landing']);
  });
});
