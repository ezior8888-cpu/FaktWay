import { deflateSync, inflateSync } from 'node:zlib';

import { formatUploadSize, LOGO_FILE_LIMIT_BYTES, LOGO_FILE_LIMIT_LABEL } from '@/lib/upload-limit';

/**
 * Logo firmy na wydruku (plan kompletnej aplikacji, krok 2.2, część 1):
 * sprawdzenie pliku z ustawień firmy i przygotowanie go do zapisu.
 *
 * Tylko PNG i JPEG, rozpoznane po sygnaturze z bajtów (nie po rozszerzeniu
 * ani nagłówku przeglądarki); SVG i inne formaty odpadają z komunikatem.
 * Wymiary są sprawdzane z nagłówka, zanim cokolwiek zostanie rozpakowane.
 *
 * Dlaczego PNG jest rozpakowany i zapisany od nowa. pdfkit dekoduje PNG
 * z przezroczystością asynchronicznie (`png-js`, `zlib.inflate` z wywołaniem
 * zwrotnym): błąd danych w tym miejscu (zły strumień, nieznany filtr wiersza)
 * nie odrzuca obietnicy wydruku, tylko leci jako nieobsłużony wyjątek procesu,
 * a PDF nigdy się nie kończy. Paleta poniżej 8 bitów z przezroczystością
 * (typowy zapis optymalizatorów PNG) wywraca go zawsze. Dlatego zapisane logo
 * to zawsze PNG 8 bit RGB (bez przezroczystości, pdfkit osadza je bez
 * dekodowania) albo RGBA, bez przeplotu i bez metadanych, zmniejszone do
 * wielkości wydruku (`LOGO_STORED_MAX_*`).
 *
 * JPEG pdfkit osadza bez dekodowania (filtr DCTDecode), więc wystarczy
 * sprawdzić budowę pliku. Z pliku znikają metadane: EXIF (aparat, GPS), XMP,
 * IPTC, komentarze i dane po końcu obrazu; zostaje profil koloru ICC,
 * znacznik Adobe (CMYK) i sama orientacja w minimalnym EXIF, bo logo trafia
 * do każdego nabywcy razem z fakturą.
 *
 * Przy wydruku `checkStoredLogo` sprawdza zapisany plik jeszcze raz, ale
 * przyjmuje tylko postać po przygotowaniu.
 */

export type LogoFormat = 'png' | 'jpeg';

/** Najmniejszy bok wgrywanego logo w pikselach. */
export const LOGO_MIN_SIDE_PX = 16;
/** Największy bok wgrywanego logo w pikselach. */
export const LOGO_MAX_SIDE_PX = 4000;
/**
 * Najwięcej pikseli razem. PNG jest rozpakowywany w pamięci procesu web
 * (RGBA: 4 bajty na piksel, 16 bit: do 8), więc 5 mln to ok. 20-40 MB.
 */
export const LOGO_MAX_PIXELS = 5_000_000;
/** Zapisane PNG: najwyżej tyle pikseli wysokości (40 pt wydruku to ok. 700 dpi). */
export const LOGO_STORED_MAX_HEIGHT_PX = 400;
/** Zapisane PNG: najwyżej tyle pikseli szerokości (200 pt wydruku). */
export const LOGO_STORED_MAX_WIDTH_PX = 2000;
/** Największy zapisany plik (trafia do każdego PDF). */
export const LOGO_STORED_MAX_BYTES = LOGO_FILE_LIMIT_BYTES;

declare const SPRAWDZONE: unique symbol;

/**
 * Logo po sprawdzeniu: z `prepareLogoUpload` albo `checkStoredLogo`, nigdy
 * złożone ręcznie. `width` i `height` to wymiary na wydruku w pikselach
 * (JPEG po obrocie z EXIF).
 */
export interface PreparedLogo {
  readonly format: LogoFormat;
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly [SPRAWDZONE]: true;
}

export type LogoRejectionReason = 'empty' | 'too_large' | 'not_image' | 'svg' | 'unsupported' | 'corrupt' | 'dimensions';

export type LogoCheck =
  | { ok: true; logo: PreparedLogo }
  | { ok: false; reason: LogoRejectionReason; error: string };

const PRZYKLAD_BOKU = Math.floor(Math.sqrt(LOGO_MAX_PIXELS) / 100) * 100;

export const LOGO_TEXTS = {
  empty: 'Plik jest pusty. Wybierz logo w PNG albo JPEG.',
  tooLarge: (bytes: number) =>
    `Plik ma ${formatUploadSize(bytes)}, a logo może mieć najwyżej ${LOGO_FILE_LIMIT_LABEL}. Zmniejsz obraz i wgraj go ponownie.`,
  notImage: 'To nie jest plik PNG ani JPEG. Zapisz logo jako PNG albo JPEG i wgraj ponownie.',
  svg: 'Logo w SVG nie jest obsługiwane. Zapisz je jako PNG albo JPEG i wgraj ponownie.',
  corrupt: 'Plik logo jest uszkodzony albo niepełny. Zapisz go ponownie jako PNG albo JPEG i wgraj jeszcze raz.',
  unsupported: 'Ten rodzaj zapisu obrazu nie jest obsługiwany. Zapisz logo jako zwykły PNG albo JPEG i wgraj ponownie.',
  tooManyPixels: (width: number, height: number) =>
    `Logo ma ${width} × ${height} pikseli, a może mieć najwyżej ${LOGO_MAX_SIDE_PX} pikseli z każdej strony i ${LOGO_MAX_PIXELS / 1_000_000} mln pikseli razem (np. ${PRZYKLAD_BOKU} × ${PRZYKLAD_BOKU}). Zmniejsz obraz i wgraj go ponownie.`,
  tooFewPixels: (width: number, height: number) =>
    `Logo ma ${width} × ${height} pikseli, a potrzeba co najmniej ${LOGO_MIN_SIDE_PX} pikseli z każdej strony. Wgraj większy obraz.`,
  storedTooLarge: 'Logo po przygotowaniu do wydruku jest za duże. Zapisz je jako JPEG albo uprość obraz i wgraj ponownie.',
} as const;

function reject(reason: LogoRejectionReason, error?: string): LogoCheck {
  const fallback: Record<LogoRejectionReason, string> = {
    empty: LOGO_TEXTS.empty,
    too_large: LOGO_TEXTS.storedTooLarge,
    not_image: LOGO_TEXTS.notImage,
    svg: LOGO_TEXTS.svg,
    unsupported: LOGO_TEXTS.unsupported,
    corrupt: LOGO_TEXTS.corrupt,
    dimensions: LOGO_TEXTS.unsupported,
  };
  return { ok: false, reason, error: error ?? fallback[reason] };
}

function sprawdzone(format: LogoFormat, data: Buffer, width: number, height: number): PreparedLogo {
  return { format, data, width, height } as PreparedLogo;
}

function asBuffer(input: Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

// ---------------------------------------------------------------------------
// Sygnatury

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Typ pliku z pierwszych bajtów: PNG, JPEG albo `null` (każdy inny plik). */
export function detectLogoFormat(bytes: Uint8Array): LogoFormat | null {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/** SVG albo inny XML z elementem `<svg`: tylko do komunikatu, odmowa i tak by była. */
function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<') && head.includes('<svg');
}

function inputSizeProblem(width: number, height: number): LogoCheck | null {
  if (width > LOGO_MAX_SIDE_PX || height > LOGO_MAX_SIDE_PX || width * height > LOGO_MAX_PIXELS) {
    return reject('dimensions', LOGO_TEXTS.tooManyPixels(width, height));
  }
  if (width < LOGO_MIN_SIDE_PX || height < LOGO_MIN_SIDE_PX) {
    return reject('dimensions', LOGO_TEXTS.tooFewPixels(width, height));
  }
  return null;
}

function storedSizeOk(width: number, height: number): boolean {
  return width >= 1 && height >= 1 && width <= LOGO_MAX_SIDE_PX && height <= LOGO_MAX_SIDE_PX && width * height <= LOGO_MAX_PIXELS;
}

// ---------------------------------------------------------------------------
// Wejście

/**
 * Sprawdza wgrany plik i przygotowuje go do zapisu: PNG rozpakowany,
 * zmniejszony do wielkości wydruku i zapisany od nowa; JPEG bez metadanych.
 * Odmowa ma powód i komunikat dla klienta z tym, co zrobić.
 */
export function prepareLogoUpload(input: Uint8Array): LogoCheck {
  const bytes = asBuffer(input);
  if (bytes.length === 0) return reject('empty');
  if (bytes.length > LOGO_FILE_LIMIT_BYTES) return reject('too_large', LOGO_TEXTS.tooLarge(bytes.length));
  const format = detectLogoFormat(bytes);
  if (format === 'png') return preparePng(bytes);
  if (format === 'jpeg') return prepareJpeg(bytes);
  return looksLikeSvg(bytes) ? reject('svg') : reject('not_image');
}

/**
 * Zapisane logo przed wydrukiem: tylko postać z `prepareLogoUpload` (PNG
 * 8 bit RGB albo RGBA bez przeplotu, JPEG o sprawdzonej budowie, z którego
 * znów znikają metadane). Inny albo uszkodzony plik: `null`, czyli wydruk
 * bez logo.
 */
export function checkStoredLogo(input: Uint8Array): PreparedLogo | null {
  const bytes = asBuffer(input);
  if (bytes.length === 0 || bytes.length > LOGO_STORED_MAX_BYTES) return null;
  const format = detectLogoFormat(bytes);
  if (format === 'png') {
    const png = readPng(bytes);
    if (typeof png === 'string') return null;
    const normalized = png.bitDepth === 8 && (png.colorType === 2 || png.colorType === 6) && png.interlace === 0;
    if (!normalized || png.palette || png.transparency) return null;
    if (!storedSizeOk(png.width, png.height) || !inflate(png)) return null;
    return sprawdzone('png', bytes, png.width, png.height);
  }
  if (format === 'jpeg') {
    const jpeg = cleanJpeg(bytes);
    if (typeof jpeg === 'string' || !storedSizeOk(jpeg.width, jpeg.height)) return null;
    const rotated = jpeg.orientation >= 5;
    return sprawdzone('jpeg', jpeg.data, rotated ? jpeg.height : jpeg.width, rotated ? jpeg.width : jpeg.height);
  }
  return null;
}

// ---------------------------------------------------------------------------
// PNG

const TABELA_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Dozwolone głębie dla typów koloru (specyfikacja PNG, tabela 11.1). */
const GLEBIE: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const KANALY: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
type Przebieg = readonly [x0: number, y0: number, dx: number, dy: number];
const JEDEN_PRZEBIEG: readonly Przebieg[] = [[0, 0, 1, 1]];
const ADAM7: readonly Przebieg[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface Png {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette: Buffer | null;
  transparency: Buffer | null;
  idat: Buffer;
}

/** Budowa pliku: fragmenty, sumy kontrolne, nagłówek, paleta i przezroczystość. */
function readPng(bytes: Buffer): Png | 'corrupt' | 'unsupported' {
  let pos = PNG_SIGNATURE.length;
  let header: Omit<Png, 'palette' | 'transparency' | 'idat'> | null = null;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  for (;;) {
    if (pos + 12 > bytes.length) return 'corrupt';
    const length = bytes.readUInt32BE(pos);
    if (length > bytes.length - pos - 12) return 'corrupt';
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return 'corrupt';
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== bytes.readUInt32BE(pos + 8 + length)) return 'corrupt';
    pos += 12 + length;

    if (!header) {
      if (type !== 'IHDR' || length !== 13) return 'corrupt';
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8]!, colorType: data[9]!, interlace: data[12]! };
      const valid =
        header.width > 0 && header.height > 0 && header.width <= 0x7fffffff && header.height <= 0x7fffffff &&
        GLEBIE[header.colorType]?.includes(header.bitDepth) === true && data[10] === 0 && data[11] === 0 && header.interlace <= 1;
      if (!valid) return 'corrupt';
      continue;
    }
    if (type === 'IEND') break;
    if (type === 'IHDR') return 'corrupt';
    if (type === 'PLTE') {
      if (palette || idat.length > 0 || length === 0 || length % 3 !== 0 || length > 768) return 'corrupt';
      palette = data;
    } else if (type === 'tRNS') {
      if (transparency || idat.length > 0) return 'corrupt';
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type.charCodeAt(0) <= 0x5a) {
      // Wielka pierwsza litera: fragment krytyczny, którego nie znamy.
      return 'unsupported';
    }
  }
  if (!header || idat.length === 0) return 'corrupt';

  const { colorType, bitDepth } = header;
  if (colorType === 3) {
    if (!palette || palette.length / 3 > 2 ** bitDepth) return 'corrupt';
    if (transparency && transparency.length > palette.length / 3) return 'corrupt';
  } else if ((colorType === 0 || colorType === 4) && palette) {
    return 'corrupt';
  }
  if (transparency) {
    if (colorType === 4 || colorType === 6) return 'corrupt';
    if (colorType === 0 && transparency.length !== 2) return 'corrupt';
    if (colorType === 2 && transparency.length !== 6) return 'corrupt';
  }
  return { ...header, palette, transparency, idat: Buffer.concat(idat) };
}

interface Uklad {
  passes: readonly Przebieg[];
  channels: number;
  bitsPerPixel: number;
  /** Bajty piksela do filtrów (co najmniej 1). */
  filterBytes: number;
  expected: number;
}

function uklad(png: Png): Uklad {
  const channels = KANALY[png.colorType]!;
  const bitsPerPixel = channels * png.bitDepth;
  const passes = png.interlace === 1 ? ADAM7 : JEDEN_PRZEBIEG;
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((png.width - x0) / dx);
    const ph = Math.ceil((png.height - y0) / dy);
    if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  return { passes, channels, bitsPerPixel, filterBytes: Math.max(1, bitsPerPixel >> 3), expected };
}

/**
 * Rozpakowane dane dokładnie tej długości, którą wyznacza nagłówek (bomba
 * zlib kończy się na limicie), i każdy wiersz ze znanym filtrem 0-4: tak
 * `png-js` w pdfkit przejdzie bez wyjątku.
 */
function inflate(png: Png): Buffer | null {
  const { passes, bitsPerPixel, expected } = uklad(png);
  let raw: Buffer;
  try {
    raw = inflateSync(png.idat, { maxOutputLength: expected + 1 });
  } catch {
    return null;
  }
  if (raw.length !== expected) return null;
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((png.width - x0) / dx);
    const ph = Math.ceil((png.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    for (let row = 0; row < ph; row++) {
      if (raw[offset]! > 4) return null;
      offset += 1 + rowBytes;
    }
  }
  return raw;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Odwraca filtr wiersza w miejscu (specyfikacja PNG, rozdział 9). */
function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  if (filter === 0) return;
  for (let i = 0; i < line.length; i++) {
    const left = i >= bpp ? line[i - bpp]! : 0;
    const up = prev[i]!;
    const prediction =
      filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, i >= bpp ? prev[i - bpp]! : 0);
    line[i] = (line[i]! + prediction) & 0xff;
  }
}

function sample(line: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return line[index]!;
  if (depth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!;
  const bit = index * depth;
  return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

/** Piksele RGBA 8 bit z każdego typu koloru, głębi i przeplotu; `null` przy uszkodzonych danych. */
function decodePng(png: Png): Uint8Array | null {
  const raw = inflate(png);
  if (!raw) return null;
  const { passes, channels, bitsPerPixel, filterBytes } = uklad(png);
  const { width, bitDepth, colorType } = png;
  const max = 2 ** bitDepth - 1;
  const to8 = (v: number) => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : (v * 255) / max);
  const paletteEntries = png.palette ? png.palette.length / 3 : 0;
  const trnsGray = colorType === 0 && png.transparency ? png.transparency.readUInt16BE(0) : -1;
  const trnsRgb = colorType === 2 && png.transparency
    ? [png.transparency.readUInt16BE(0), png.transparency.readUInt16BE(2), png.transparency.readUInt16BE(4)]
    : null;
  const out = new Uint8Array(png.width * png.height * 4);
  const s = new Array<number>(channels).fill(0);

  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((png.width - x0) / dx);
    const ph = Math.ceil((png.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev: Uint8Array = new Uint8Array(rowBytes);
    for (let row = 0; row < ph; row++) {
      const line = raw.subarray(offset + 1, offset + 1 + rowBytes);
      unfilter(raw[offset]!, line, prev, filterBytes);
      const y = y0 + row * dy;
      for (let i = 0; i < pw; i++) {
        for (let c = 0; c < channels; c++) s[c] = sample(line, i * channels + c, bitDepth);
        const o = (y * width + x0 + i * dx) * 4;
        if (colorType === 3) {
          const index = s[0]!;
          if (index >= paletteEntries) return null;
          out[o] = png.palette![index * 3]!;
          out[o + 1] = png.palette![index * 3 + 1]!;
          out[o + 2] = png.palette![index * 3 + 2]!;
          out[o + 3] = png.transparency && index < png.transparency.length ? png.transparency[index]! : 255;
        } else if (colorType === 0 || colorType === 4) {
          const v = to8(s[0]!);
          out[o] = v;
          out[o + 1] = v;
          out[o + 2] = v;
          out[o + 3] = colorType === 4 ? to8(s[1]!) : s[0] === trnsGray ? 0 : 255;
        } else {
          out[o] = to8(s[0]!);
          out[o + 1] = to8(s[1]!);
          out[o + 2] = to8(s[2]!);
          out[o + 3] = colorType === 6
            ? to8(s[3]!)
            : trnsRgb && s[0] === trnsRgb[0] && s[1] === trnsRgb[1] && s[2] === trnsRgb[2] ? 0 : 255;
        }
      }
      prev = line;
      offset += 1 + rowBytes;
    }
  }
  return out;
}

/**
 * Zmniejszenie średnią z pikseli źródła pod każdym pikselem wyniku, z wagą
 * krycia (kolor przezroczystego tła nie przyciemnia brzegów logo).
 */
function downscale(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const xs = Array.from({ length: dw + 1 }, (_, x) => Math.floor((x * sw) / dw));
  const ys = Array.from({ length: dh + 1 }, (_, y) => Math.floor((y * sh) / dh));
  for (let dy = 0; dy < dh; dy++) {
    const y0 = ys[dy]!;
    const y1 = Math.max(ys[dy + 1]!, y0 + 1);
    for (let dx = 0; dx < dw; dx++) {
      const x0 = xs[dx]!;
      const x1 = Math.max(xs[dx + 1]!, x0 + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const alpha = src[i + 3]!;
          r += src[i]! * alpha;
          g += src[i + 1]! * alpha;
          b += src[i + 2]! * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG 8 bit: RGB, gdy każdy piksel jest kryjący, inaczej RGBA; filtr wiersza o najmniejszym koszcie. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    for (let x = 0, s = y * width * 4, d = 0; x < width; x++, s += 4) {
      cur[d++] = rgba[s]!;
      cur[d++] = rgba[s + 1]!;
      cur[d++] = rgba[s + 2]!;
      if (!opaque) cur[d++] = rgba[s + 3]!;
    }
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let filter = 0; filter < 5; filter++) {
      const target = candidates[filter]!;
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? cur[i - channels]! : 0;
        const up = prev[i]!;
        const prediction =
          filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, i >= channels ? prev[i - channels]! : 0);
        const v = (cur[i]! - prediction) & 0xff;
        target[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = filter;
      }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(candidates[best]!, o + 1);
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function preparePng(bytes: Buffer): LogoCheck {
  const png = readPng(bytes);
  if (typeof png === 'string') return reject(png);
  const sizeProblem = inputSizeProblem(png.width, png.height);
  if (sizeProblem) return sizeProblem;
  const rgba = decodePng(png);
  if (!rgba) return reject('corrupt');
  const scale = Math.min(1, LOGO_STORED_MAX_HEIGHT_PX / png.height, LOGO_STORED_MAX_WIDTH_PX / png.width);
  const width = Math.max(1, Math.round(png.width * scale));
  const height = Math.max(1, Math.round(png.height * scale));
  const pixels = width === png.width && height === png.height ? rgba : downscale(rgba, png.width, png.height, width, height);
  const data = encodePng(pixels, width, height);
  if (data.length > LOGO_STORED_MAX_BYTES) return reject('too_large', LOGO_TEXTS.storedTooLarge);
  return { ok: true, logo: sprawdzone('png', data, width, height) };
}

// ---------------------------------------------------------------------------
// JPEG

/** Ramki, które pdfkit osadza i przeglądarki PDF czytają: podstawowa, rozszerzona, progresywna (Huffman). */
const SOF_OBSLUGIWANE = new Set([0xc0, 0xc1, 0xc2]);
/** Bezstratna, hierarchiczna i arytmetyczna: poza zakresem. */
const SOF_INNE = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Tabele Huffmana i kwantyzacji, interwał RST, początek skanu: zostają. */
const TABELE = new Set([0xc4, 0xdb, 0xdd, 0xda]);
const EOI = Buffer.from([0xff, 0xd9]);

interface Jpeg {
  data: Buffer;
  width: number;
  height: number;
  orientation: number;
}

function isMetadata(code: number): boolean {
  return (code >= 0xe0 && code <= 0xef) || code === 0xfe;
}

function startsWith(payload: Buffer, text: string): boolean {
  return payload.length >= text.length && payload.toString('latin1', 0, text.length) === text;
}

function segment(code: number, payloadWithLength: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, code]), payloadWithLength]);
}

/** Orientacja z EXIF (znacznik 0x0112 w IFD0), 1-8; inaczej `null`. */
function exifOrientation(payload: Buffer): number | null {
  if (!startsWith(payload, 'Exif\0\0')) return null;
  const tiff = payload.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o: number) => (o >= 0 && o + 2 <= tiff.length ? (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o >= 0 && o + 4 <= tiff.length ? (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : -1);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const count = u16(ifd);
  if (ifd < 8 || count < 0) return null;
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** EXIF z samą orientacją (IFD0 z jednym wpisem), żeby pdfkit i przeglądarka obróciły logo. */
function minimalExif(orientation: number): Buffer {
  const seg = Buffer.alloc(36);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(seg.length - 2, 2);
  seg.write('Exif\0\0', 4, 'latin1');
  seg.write('MM', 10, 'latin1');
  seg.writeUInt16BE(42, 12);
  seg.writeUInt32BE(8, 14);
  seg.writeUInt16BE(1, 18);
  seg.writeUInt16BE(0x0112, 20);
  seg.writeUInt16BE(3, 22);
  seg.writeUInt32BE(1, 24);
  seg.writeUInt16BE(orientation, 28);
  return seg;
}

/** Znacznik od `pos` (z bajtami wypełnienia 0xFF przed kodem): kod i pozycja za nim. */
function readMarker(bytes: Buffer, pos: number): { code: number; next: number } | null {
  if (pos >= bytes.length || bytes[pos] !== 0xff) return null;
  let i = pos;
  while (i < bytes.length && bytes[i] === 0xff) i++;
  return i < bytes.length ? { code: bytes[i]!, next: i + 1 } : null;
}

/**
 * Budowa JPEG i ten sam obraz bez metadanych: segmenty do pierwszego skanu,
 * dane skanów z tabelami między nimi (JPEG progresywny), koniec na EOI.
 */
function cleanJpeg(bytes: Buffer): Jpeg | 'corrupt' | 'unsupported' {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 'corrupt';
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  let exifAt = 1;
  let frame: { width: number; height: number } | null = null;
  let orientation = 1;
  let pos = 2;

  for (;;) {
    const marker = readMarker(bytes, pos);
    if (!marker) return 'corrupt';
    const { code } = marker;
    if (code === 0x00 || code === 0x01 || code === 0xd8 || code === 0xd9 || (code >= 0xd0 && code <= 0xd7)) return 'corrupt';
    pos = marker.next;
    if (pos + 2 > bytes.length) return 'corrupt';
    const length = bytes.readUInt16BE(pos);
    if (length < 2 || pos + length > bytes.length) return 'corrupt';
    const withLength = bytes.subarray(pos, pos + length);
    const payload = withLength.subarray(2);
    pos += length;

    if (SOF_OBSLUGIWANE.has(code)) {
      if (frame || payload.length < 6) return 'corrupt';
      const components = payload[5]!;
      if (payload.length !== 6 + 3 * components) return 'corrupt';
      const height = payload.readUInt16BE(1);
      const width = payload.readUInt16BE(3);
      if (payload[0] !== 8 || ![1, 3, 4].includes(components) || width === 0 || height === 0) return 'unsupported';
      frame = { width, height };
      parts.push(segment(code, withLength));
    } else if (SOF_INNE.has(code)) {
      return 'unsupported';
    } else if (code === 0xda) {
      if (!frame) return 'corrupt';
      parts.push(segment(code, withLength));
      break;
    } else if (TABELE.has(code)) {
      parts.push(segment(code, withLength));
    } else if (code === 0xe0 && startsWith(payload, 'JFIF\0') && payload.length >= 14) {
      // Nagłówek JFIF bez miniatury (gęstość zostaje).
      const jfif = Buffer.from(payload.subarray(0, 14));
      jfif[12] = 0;
      jfif[13] = 0;
      parts.push(segment(code, Buffer.concat([Buffer.from([0, 16]), jfif])));
      exifAt = parts.length;
    } else if (code === 0xe1) {
      orientation = exifOrientation(payload) ?? orientation;
    } else if ((code === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) || (code === 0xee && startsWith(payload, 'Adobe'))) {
      parts.push(segment(code, withLength));
    } else if (!isMetadata(code)) {
      return 'unsupported';
    }
  }

  // Dane skanu: 0xFF zawsze z 0x00 albo jako RST; inny znacznik kończy skan.
  let start = pos;
  for (let i = pos; ; ) {
    if (i >= bytes.length) return 'corrupt';
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j++;
    if (j >= bytes.length) return 'corrupt';
    const code = bytes[j]!;
    if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
      i = j + 1;
      continue;
    }
    parts.push(bytes.subarray(start, i));
    if (code === 0xd9) {
      parts.push(EOI);
      break;
    }
    if (j + 3 > bytes.length) return 'corrupt';
    const length = bytes.readUInt16BE(j + 1);
    if (length < 2 || j + 1 + length > bytes.length) return 'corrupt';
    if (TABELE.has(code)) parts.push(segment(code, bytes.subarray(j + 1, j + 1 + length)));
    else if (!isMetadata(code)) return 'unsupported';
    start = j + 1 + length;
    i = start;
  }

  if (!frame) return 'corrupt';
  if (orientation !== 1) parts.splice(exifAt, 0, minimalExif(orientation));
  return { data: Buffer.concat(parts), width: frame.width, height: frame.height, orientation };
}

function prepareJpeg(bytes: Buffer): LogoCheck {
  const jpeg = cleanJpeg(bytes);
  if (typeof jpeg === 'string') return reject(jpeg);
  const sizeProblem = inputSizeProblem(jpeg.width, jpeg.height);
  if (sizeProblem) return sizeProblem;
  if (jpeg.data.length > LOGO_STORED_MAX_BYTES) return reject('too_large', LOGO_TEXTS.storedTooLarge);
  const rotated = jpeg.orientation >= 5;
  return { ok: true, logo: sprawdzone('jpeg', jpeg.data, rotated ? jpeg.height : jpeg.width, rotated ? jpeg.width : jpeg.height) };
}
