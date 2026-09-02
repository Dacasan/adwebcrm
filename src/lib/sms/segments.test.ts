import { describe, expect, it } from "vitest";

import {
  countSmsSegments,
  smsEncodingOf,
  GSM7_CONCAT,
  GSM7_SINGLE,
  UCS2_CONCAT,
  UCS2_SINGLE,
} from "./segments";

// Lo que se prueba aquí es dinero: cada segmento de más es un SMS más en
// la factura, y el salto de GSM-7 a UCS-2 (que lo dispara UN carácter)
// deja la capacidad en menos de la mitad. Los límites exactos —160/161 y
// 70/71— son los que el agente ve en el contador del compositor.

const a = (n: number) => "a".repeat(n);

describe("smsEncodingOf", () => {
  it("el texto vacío se considera GSM-7", () => {
    expect(smsEncodingOf("")).toBe("gsm7");
  });

  it("ASCII normal es GSM-7", () => {
    expect(smsEncodingOf("Your appointment is confirmed.")).toBe("gsm7");
  });

  it("la eñe, los signos de apertura y varios acentos SÍ están en GSM-7", () => {
    // ñ Ñ é è à ù ì ò ü ä ö ç ¿ ¡ § £ € están todos en la tabla (el € en
    // la de extensión, pero sigue siendo GSM-7).
    expect(smsEncodingOf("¿Mañana a las 9? ¡Perfecto! Café con Ñ y 5€")).toBe("gsm7");
  });

  it("á í ó ú NO están en GSM-7 y arrastran el mensaje a UCS-2", () => {
    // Trampa clásica del copy en español: "acción" cuesta el doble que
    // "mañana" aunque parezcan igual de acentuados.
    expect(smsEncodingOf("acción")).toBe("ucs2");
    expect(smsEncodingOf("Sí")).toBe("ucs2");
    expect(smsEncodingOf("Adiós")).toBe("ucs2");
  });

  it("un solo emoji arrastra todo el mensaje a UCS-2", () => {
    expect(smsEncodingOf(`${a(100)}🙂`)).toBe("ucs2");
  });
});

describe("countSmsSegments — texto vacío", () => {
  it("no cuesta ningún segmento pero anuncia los 160 huecos libres", () => {
    expect(countSmsSegments("")).toEqual({
      encoding: "gsm7",
      length: 0,
      segments: 0,
      segmentSize: GSM7_SINGLE,
      remaining: GSM7_SINGLE,
      characters: 0,
    });
  });
});

describe("countSmsSegments — GSM-7", () => {
  it("un texto corto es un solo segmento y descuenta el hueco restante", () => {
    const info = countSmsSegments("Hola");
    expect(info.encoding).toBe("gsm7");
    expect(info.length).toBe(4);
    expect(info.characters).toBe(4);
    expect(info.segments).toBe(1);
    expect(info.segmentSize).toBe(GSM7_SINGLE);
    expect(info.remaining).toBe(156);
  });

  it("160 caracteres siguen siendo UN segmento, sin hueco libre", () => {
    const info = countSmsSegments(a(160));
    expect(info.segments).toBe(1);
    expect(info.segmentSize).toBe(GSM7_SINGLE);
    expect(info.remaining).toBe(0);
  });

  it("161 caracteres pasan a dos segmentos de 153 (aparece el UDH)", () => {
    const info = countSmsSegments(a(161));
    expect(info.length).toBe(161);
    expect(info.segments).toBe(2);
    expect(info.segmentSize).toBe(GSM7_CONCAT);
    // 161 - 153 = 8 ocupados en el segundo segmento.
    expect(info.remaining).toBe(GSM7_CONCAT - 8);
  });

  it("306 caracteres caben justos en dos segmentos y 307 obligan a un tercero", () => {
    expect(countSmsSegments(a(306)).segments).toBe(2);
    expect(countSmsSegments(a(306)).remaining).toBe(0);
    expect(countSmsSegments(a(307)).segments).toBe(3);
  });

  it("la eñe y los acentos de la tabla ocupan un solo septeto", () => {
    const info = countSmsSegments("mañana Ñ é à ü ¿ ¡");
    expect(info.encoding).toBe("gsm7");
    expect(info.length).toBe(18);
    expect(info.characters).toBe(18);
    expect(info.segments).toBe(1);
  });

  it("los caracteres de la tabla de extensión (€ [ ] { } \\ ~ ^ |) cuentan doble", () => {
    const info = countSmsSegments("€[]{}\\~^|");
    expect(info.encoding).toBe("gsm7");
    expect(info.characters).toBe(9);
    expect(info.length).toBe(18);
  });

  it("un € puede empujar a dos segmentos un texto de 159 caracteres", () => {
    // 159 + 2 = 161 septetos: por un símbolo se paga el doble.
    const info = countSmsSegments(`${a(159)}€`);
    expect(info.characters).toBe(160);
    expect(info.length).toBe(161);
    expect(info.segments).toBe(2);
  });

  it("no parte el par ESC+símbolo entre dos segmentos", () => {
    // 306 unidades en total, pero el € cae justo en el septeto 153 y no
    // se puede trocear: se abre segmento nuevo y salen TRES, no dos.
    const info = countSmsSegments(`${a(152)}€${a(152)}`);
    expect(info.length).toBe(306);
    expect(info.segments).toBe(3);
  });
});

describe("countSmsSegments — UCS-2", () => {
  it("un emoji fuerza UCS-2 y ocupa dos unidades UTF-16", () => {
    const info = countSmsSegments("Hola 🙂");
    expect(info.encoding).toBe("ucs2");
    expect(info.characters).toBe(6);
    expect(info.length).toBe(7);
    expect(info.segments).toBe(1);
    expect(info.segmentSize).toBe(UCS2_SINGLE);
    expect(info.remaining).toBe(UCS2_SINGLE - 7);
  });

  it("70 unidades siguen siendo un segmento y 71 pasan a dos de 67", () => {
    // "á" fuerza UCS-2 sin gastar dos unidades, así que la cuenta de
    // unidades coincide con la de caracteres.
    const single = `á${a(69)}`;
    expect(countSmsSegments(single).length).toBe(70);
    expect(countSmsSegments(single).segments).toBe(1);
    expect(countSmsSegments(single).remaining).toBe(0);

    const over = `á${a(70)}`;
    const info = countSmsSegments(over);
    expect(info.length).toBe(71);
    expect(info.segments).toBe(2);
    expect(info.segmentSize).toBe(UCS2_CONCAT);
    expect(info.remaining).toBe(UCS2_CONCAT - 4);
  });

  it("multi-segmento largo: 134 unidades con emoji son dos segmentos", () => {
    const info = countSmsSegments(`🙂${a(132)}`);
    expect(info.length).toBe(134);
    expect(info.segments).toBe(2);
  });

  it("no parte el par suplente de un emoji entre dos segmentos", () => {
    // 134 unidades, pero el emoji cae sobre la frontera del segmento 67:
    // se empuja entero al siguiente y salen TRES segmentos.
    const info = countSmsSegments(`${a(66)}🙂${a(66)}`);
    expect(info.length).toBe(134);
    expect(info.segments).toBe(3);
  });
});
