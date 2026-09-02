/**
 * Contador de caracteres y segmentos de un SMS.
 *
 * Un SMS no se factura por mensaje sino por SEGMENTO, y cuántos caben
 * depende del alfabeto que obligue el texto:
 *
 *  - GSM-7 (el alfabeto de GSM 03.38): 7 bits por carácter → 160 en un
 *    mensaje suelto. Si hay que trocear, cada segmento pierde 7 septetos
 *    con la cabecera de concatenación (UDH de 6 bytes) → 153.
 *  - UCS-2 (UTF-16): 16 bits por unidad → 70 sueltos, 67 al concatenar.
 *
 * Basta UN carácter fuera de GSM-7 para que TODO el mensaje pase a UCS-2
 * y su capacidad caiga a menos de la mitad. Por eso el compositor enseña
 * el contador: un emoji de más duplica la factura sin avisar.
 *
 * Trampa para el copy en español: la ñ, la é/à/ù, la ü y los signos ¿¡
 * SÍ están en GSM-7, pero á, í, ó, ú NO. Un "gracias" está bien y un
 * "cita confirmada, ¡hasta el sábado!" también, pero "acción" ya fuerza
 * UCS-2. Lo cuenta este helper, no hace falta saberlo de memoria.
 *
 * Módulo PURO a propósito: sin React ni Supabase, para poder testearlo
 * solo y reusarlo desde el servidor si algún día hace falta estimar coste.
 */

/** Alfabeto que el operador usará para codificar el mensaje. */
export type SmsEncoding = "gsm7" | "ucs2";

/** Septetos que caben en un SMS GSM-7 sin trocear. */
export const GSM7_SINGLE = 160;
/** Septetos por segmento cuando el mensaje se trocea (7 se los come el UDH). */
export const GSM7_CONCAT = 153;
/** Unidades UTF-16 que caben en un SMS UCS-2 sin trocear. */
export const UCS2_SINGLE = 70;
/** Unidades UTF-16 por segmento al trocear. */
export const UCS2_CONCAT = 67;

// Alfabeto básico de GSM 03.38 (posiciones 0x00-0x7F de la tabla), con el
// salto de línea y el retorno de carro incluidos. El orden da igual: solo
// se consulta la pertenencia.
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);

// Tabla de extensión: se codifican como ESC + símbolo, o sea DOS septetos
// cada uno. El euro es el caso que más duele en precios.
const GSM7_EXTENDED = new Set("^{}\\[~]|€\f");

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /**
   * Longitud facturable en las unidades del alfabeto: septetos en GSM-7
   * (los de la tabla de extensión valen 2) y unidades UTF-16 en UCS-2
   * (un emoji fuera del BMP vale 2).
   */
  length: number;
  /** Segmentos que costará el envío. 0 cuando no hay nada que mandar. */
  segments: number;
  /** Capacidad de cada segmento con la partición ya decidida (160/153/70/67). */
  segmentSize: number;
  /** Hueco libre en el último segmento, en unidades de `length`. */
  remaining: number;
  /** Caracteres visibles (puntos de código) — lo que el agente cree escribir. */
  characters: number;
}

/**
 * ¿Cabe el texto entero en GSM-7? Un solo carácter fuera basta para
 * arrastrar todo el mensaje a UCS-2.
 */
export function smsEncodingOf(text: string): SmsEncoding {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return "ucs2";
  }
  return "gsm7";
}

/**
 * Cuenta lo que costará mandar `text` como SMS.
 *
 * El texto vacío devuelve 0 segmentos (no hay nada que facturar) pero
 * con la capacidad de un mensaje suelto en `remaining`, para que el
 * contador de la UI arranque en "160 libres" y no en cero.
 */
export function countSmsSegments(text: string): SmsSegmentInfo {
  const chars = [...text];
  if (chars.length === 0) {
    return {
      encoding: "gsm7",
      length: 0,
      segments: 0,
      segmentSize: GSM7_SINGLE,
      remaining: GSM7_SINGLE,
      characters: 0,
    };
  }

  const encoding = smsEncodingOf(text);
  // Coste unitario de cada carácter: en GSM-7 los de la tabla de extensión
  // van con ESC delante; en UCS-2 lo que está fuera del BMP (emoji) ocupa
  // un par suplente.
  const costs =
    encoding === "gsm7"
      ? chars.map((ch) => (GSM7_EXTENDED.has(ch) ? 2 : 1))
      : chars.map((ch) => ((ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1));
  const length = costs.reduce((sum, cost) => sum + cost, 0);

  const single = encoding === "gsm7" ? GSM7_SINGLE : UCS2_SINGLE;
  const concat = encoding === "gsm7" ? GSM7_CONCAT : UCS2_CONCAT;

  if (length <= single) {
    return {
      encoding,
      length,
      segments: 1,
      segmentSize: single,
      remaining: single - length,
      characters: chars.length,
    };
  }

  // Troceado real, no una división: ningún carácter puede partirse entre
  // dos segmentos — ni el par ESC+símbolo de GSM-7 ni el par suplente de
  // UTF-16. Cuando el siguiente no cabe se abre segmento nuevo aunque
  // quede un hueco de una unidad, así que el total puede salir mayor que
  // ceil(length / concat).
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > concat) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }

  return {
    encoding,
    length,
    segments,
    segmentSize: concat,
    remaining: concat - used,
    characters: chars.length,
  };
}
