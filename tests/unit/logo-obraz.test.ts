import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';

import {
  LOGO_MAX_PIXELS,
  LOGO_MAX_SIDE_PX,
  LOGO_STORED_MAX_HEIGHT_PX,
  checkStoredLogo,
  detectLogoFormat,
  prepareLogoUpload,
} from '@/lib/pdf/logo-obraz';

import {
  SYGNATURA_PNG,
  dekodujPngJakPdfkit,
  fragmentPng,
  kodujPng,
  logoRgba,
  surowePng,
  type ProbaPng,
} from '../helpers/png-proby';

/**
 * Logo firmy na wydruku (plan kompletnej aplikacji, krok 2.2, część 1):
 * plik z ustawień firmy trafia do PDF każdej faktury, proformy i oferty.
 *
 * Zasady sprawdzane tutaj:
 *  - typ pliku po sygnaturze z bajtów, nie po rozszerzeniu ani nagłówku
 *    przeglądarki; tylko PNG i JPEG, bez SVG;
 *  - limit wymiarów przed dekodowaniem (pamięć procesu web);
 *  - PNG sprawdzony w całości: pdfkit dekoduje PNG z przezroczystością
 *    asynchronicznie (`png-js`), a błąd danych w tym miejscu nie wraca do
 *    obietnicy wydruku, tylko wywraca proces; paleta poniżej 8 bitów
 *    z przezroczystością (zapis z optymalizatorów PNG) wywraca go zawsze;
 *  - zapisane logo to zawsze PNG 8 bit RGB albo RGBA bez przeplotu
 *    (zmniejszone do wysokości wydruku) albo JPEG bez metadanych
 *    (EXIF z GPS, komentarze, dane po końcu pliku), z samą orientacją.
 */

const LOGO_FAKTWAY = readFileSync('docs/brand/logo/zestaw/png/faktway-logo-1200.png');
const LOGO_FAKTWAY_2400 = readFileSync('docs/brand/logo/zestaw/png/faktway-logo-2400.png');
const JPEG_PROGRESYWNY = readFileSync('public/marketing/hero.jpg');

function przygotowane(bajty: Uint8Array) {
  const wynik = prepareLogoUpload(bajty);
  if (!wynik.ok) throw new Error(`odrzucone: ${wynik.reason} ${wynik.error}`);
  return wynik.logo;
}

function odrzucenie(bajty: Uint8Array) {
  const wynik = prepareLogoUpload(bajty);
  if (wynik.ok) throw new Error('plik przeszedł, a miał być odrzucony');
  return wynik;
}

function piksel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!];
}

function ihdr(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bitDepth: png[24], colorType: png[25], interlace: png[28] };
}

function fragmentyPng(png: Buffer): string[] {
  const typy: string[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const dlugosc = png.readUInt32BE(pos);
    typy.push(png.toString('latin1', pos + 4, pos + 8));
    pos += 12 + dlugosc;
  }
  return typy;
}

/** Segmenty JPEG przed SOS: [znacznik, treść]. */
function segmentyJpeg(jpeg: Buffer): Array<[number, Buffer]> {
  const wynik: Array<[number, Buffer]> = [];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const znacznik = jpeg[pos + 1]!;
    const dlugosc = jpeg.readUInt16BE(pos + 2);
    wynik.push([znacznik, jpeg.subarray(pos + 4, pos + 2 + dlugosc)]);
    if (znacznik === 0xda) break;
    pos += 2 + dlugosc;
  }
  return wynik;
}

function segment(znacznik: number, tresc: Buffer): Buffer {
  const naglowek = Buffer.from([0xff, znacznik, 0, 0]);
  naglowek.writeUInt16BE(tresc.length + 2, 2);
  return Buffer.concat([naglowek, tresc]);
}

/** EXIF z orientacją, marką aparatu i znacznikiem GPS (dane, których nabywca nie powinien dostać). */
function exifAparatu(orientacja: number): Buffer {
  const marka = Buffer.from('Apple iPhone 15 Pro\0', 'latin1');
  const tiff = Buffer.alloc(8 + 2 + 3 * 12 + 4 + marka.length);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(3, 8);
  const wpis = (n: number, tag: number, typ: number, liczba: number, wartosc: number) => {
    const o = 10 + n * 12;
    tiff.writeUInt16BE(tag, o);
    tiff.writeUInt16BE(typ, o + 2);
    tiff.writeUInt32BE(liczba, o + 4);
    if (typ === 3) tiff.writeUInt16BE(wartosc, o + 8);
    else tiff.writeUInt32BE(wartosc, o + 8);
  };
  const przesuniecieMarki = 10 + 3 * 12 + 4;
  wpis(0, 0x010f, 2, marka.length, przesuniecieMarki); // Make
  wpis(1, 0x0112, 3, 1, orientacja); // Orientation
  wpis(2, 0x8825, 4, 1, 0); // GPSInfo (wskaźnik)
  marka.copy(tiff, przesuniecieMarki);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPSLatitude 52.2297', 'latin1')]);
}

/** Prawdziwy JPEG z dopisanymi metadanymi aparatu, komentarzem, IPTC i drugim obrazem po końcu pliku. */
function jpegZMetadanymi(orientacja: number): Buffer {
  const app0 = segmentyJpeg(JPEG_PROGRESYWNY)[0]!;
  const reszta = JPEG_PROGRESYWNY.subarray(2 + 4 + app0[1].length);
  return Buffer.concat([
    JPEG_PROGRESYWNY.subarray(0, 2 + 4 + app0[1].length),
    segment(0xe1, exifAparatu(orientacja)),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Jan Kowalski</x:xmpmeta>', 'latin1')),
    segment(0xed, Buffer.from('Photoshop 3.0\x008BIM tajny opis', 'latin1')),
    segment(0xfe, Buffer.from('komentarz z adresem Kowalskiego', 'latin1')),
    reszta,
    Buffer.from('MPF druga klatka po końcu pliku', 'latin1'),
  ]);
}

/** Najprostszy JPEG o zadanej ramce: tylko struktura znaczników (pdfkit nie dekoduje JPEG). */
function jpegRamka(opcje: { sof?: number; precyzja?: number; width?: number; height?: number; skladowe?: number; bezEoi?: boolean; bezSof?: boolean }): Buffer {
  const skladowe = opcje.skladowe ?? 3;
  const ramka = Buffer.alloc(6 + 3 * skladowe);
  ramka[0] = opcje.precyzja ?? 8;
  ramka.writeUInt16BE(opcje.height ?? 32, 1);
  ramka.writeUInt16BE(opcje.width ?? 64, 3);
  ramka[5] = skladowe;
  for (let i = 0; i < skladowe; i++) ramka.set([i + 1, 0x11, 0], 6 + 3 * i);
  const sos = Buffer.alloc(1 + 2 * skladowe + 3);
  sos[0] = skladowe;
  for (let i = 0; i < skladowe; i++) sos.set([i + 1, 0], 1 + 2 * i);
  sos.set([0, 63, 0], 1 + 2 * skladowe);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, Buffer.alloc(65)),
    ...(opcje.bezSof ? [] : [segment(opcje.sof ?? 0xc0, ramka)]),
    segment(0xc4, Buffer.alloc(29)),
    segment(0xda, sos),
    // Dane skanu: bajt 0xFF zawsze z wypełnieniem 0x00 albo jako znacznik RST.
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    ...(opcje.bezEoi ? [] : [Buffer.from([0xff, 0xd9])]),
  ]);
}

describe('typ pliku po sygnaturze', () => {
  it('PNG i JPEG po pierwszych bajtach, bez względu na nazwę i nagłówek przeglądarki', () => {
    expect(detectLogoFormat(LOGO_FAKTWAY)).toBe('png');
    expect(detectLogoFormat(JPEG_PROGRESYWNY)).toBe('jpeg');
    expect(detectLogoFormat(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBeNull();
    expect(detectLogoFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBeNull();
    expect(detectLogoFormat(Buffer.from('%PDF-1.7\n', 'latin1'))).toBeNull();
    expect(detectLogoFormat(Buffer.from('\0\0\0\x18ftypheic', 'latin1'))).toBeNull();
    expect(detectLogoFormat(SYGNATURA_PNG.subarray(0, 7))).toBeNull();
  });

  it.each([
    ['samo <svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],
    ['XML z deklaracją i BOM', '﻿<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"></svg>'],
    ['SVG z odstępem na początku', '\n  <SVG></SVG>'],
  ])('SVG odrzucony z nazwą formatu w komunikacie: %s', (_opis, tekst) => {
    const wynik = odrzucenie(Buffer.from(tekst, 'utf8'));
    expect(wynik.reason).toBe('svg');
    expect(wynik.error).toMatch(/SVG/);
    expect(wynik.error).toMatch(/PNG albo JPEG/);
  });

  it('inny format i pusty plik: odmowa z komunikatem, co zrobić', () => {
    expect(odrzucenie(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toMatchObject({ reason: 'not_image', error: expect.stringMatching(/PNG albo JPEG/) });
    expect(odrzucenie(new Uint8Array(0))).toMatchObject({ reason: 'empty' });
  });
});

describe('PNG: sprawdzenie całego pliku', () => {
  const prosty: ProbaPng = { width: 20, height: 20, colorType: 6, bitDepth: 8, probki: () => [10, 20, 30, 255] };

  it('ucięty plik, zła suma kontrolna i IHDR nie na początku: uszkodzony', () => {
    const plik = kodujPng(prosty);
    expect(odrzucenie(plik.subarray(0, plik.length - 12)).reason).toBe('corrupt');
    const zlaSuma = Buffer.from(plik);
    zlaSuma[29] ^= 0xff; // CRC IHDR
    expect(odrzucenie(zlaSuma).reason).toBe('corrupt');
    const bezIhdr = Buffer.concat([SYGNATURA_PNG, fragmentPng('tEXt', Buffer.from('a\0b')), plik.subarray(8)]);
    expect(odrzucenie(bezIhdr).reason).toBe('corrupt');
  });

  it('długość fragmentu poza plikiem (png-js kręci się wtedy w pętli): uszkodzony', () => {
    const plik = kodujPng(prosty);
    const zly = Buffer.from(plik);
    zly.writeUInt32BE(0xfffffff0, 33); // długość fragmentu po IHDR
    expect(odrzucenie(zly).reason).toBe('corrupt');
  });

  it('dane IDAT, które nie są strumieniem zlib (png-js rzuca wtedy poza obietnicą): uszkodzony', () => {
    const smieci = Buffer.concat([
      SYGNATURA_PNG,
      kodujPng(prosty).subarray(8, 33),
      fragmentPng('IDAT', Buffer.from('to nie jest zlib, tylko tekst')),
      fragmentPng('IEND'),
    ]);
    expect(odrzucenie(smieci)).toMatchObject({ reason: 'corrupt', error: expect.stringMatching(/uszkodzony/) });
  });

  it('nieznany filtr wiersza (png-js: „Invalid filter algorithm” poza obietnicą): uszkodzony', () => {
    const surowe = surowePng(prosty);
    surowe[0] = 7;
    expect(odrzucenie(kodujPng(prosty, surowe)).reason).toBe('corrupt');
  });

  it('za mało i za dużo danych po rozpakowaniu (także „bomba”): uszkodzony', () => {
    const surowe = surowePng(prosty);
    expect(odrzucenie(kodujPng(prosty, surowe.subarray(0, surowe.length - 1))).reason).toBe('corrupt');
    expect(odrzucenie(kodujPng(prosty, Buffer.concat([surowe, Buffer.alloc(5_000_000)]))).reason).toBe('corrupt');
  });

  it('zła para typu koloru i głębi, indeks spoza palety, nieznany fragment krytyczny', () => {
    const zlaGlebia = kodujPng({ ...prosty, colorType: 2, bitDepth: 4 as 8, probki: () => [1, 2, 3] });
    expect(odrzucenie(zlaGlebia).reason).toBe('corrupt');
    const zaKrotkaPaleta = kodujPng({ width: 16, height: 16, colorType: 3, bitDepth: 8, paleta: [[0, 0, 0], [255, 255, 255]], probki: () => [5] });
    expect(odrzucenie(zaKrotkaPaleta).reason).toBe('corrupt');
    const krytyczny = kodujPng({ ...prosty, dodatkowe: [['ZZZZ', Buffer.from('x')]] });
    expect(odrzucenie(krytyczny).reason).toBe('unsupported');
  });

  it('wymiary z nagłówka przed rozpakowaniem: za duże z każdej strony i razem, za małe', () => {
    const wymiar = (width: number, height: number) => {
      const plik = Buffer.from(kodujPng(prosty));
      plik.writeUInt32BE(width, 16);
      plik.writeUInt32BE(height, 20);
      // Poprawna suma IHDR po zmianie wymiarów: liczy ją pomocnik testu.
      return Buffer.concat([SYGNATURA_PNG, fragmentPng('IHDR', plik.subarray(16, 29)), plik.subarray(33)]);
    };
    const bok = odrzucenie(wymiar(LOGO_MAX_SIDE_PX + 1, 20));
    expect(bok).toMatchObject({ reason: 'dimensions', error: expect.stringContaining(`${LOGO_MAX_SIDE_PX + 1} × 20`) });
    const razem = Math.ceil(Math.sqrt(LOGO_MAX_PIXELS)) + 1;
    expect(odrzucenie(wymiar(razem, razem)).reason).toBe('dimensions');
    expect(odrzucenie(wymiar(15, 300))).toMatchObject({ reason: 'dimensions', error: expect.stringMatching(/co najmniej 16/) });
  });
});

describe('PNG: zapisane logo to 8 bit RGB albo RGBA, które pdfkit czyta bez niespodzianek', () => {
  it('RGBA 8 bit: te same piksele, bez zmniejszania', async () => {
    const logo = przygotowane(logoRgba(40, 20));
    expect(logo).toMatchObject({ format: 'png', width: 40, height: 20 });
    expect(ihdr(logo.data)).toMatchObject({ width: 40, height: 20, bitDepth: 8, colorType: 6, interlace: 0 });
    const { rgba } = await dekodujPngJakPdfkit(logo.data);
    expect(piksel(rgba, 40, 0, 0)).toEqual([220, 20, 20, 255]);
    expect(piksel(rgba, 40, 39, 19)).toEqual([20, 40, 220, 128]);
  });

  it('logo bez przezroczystości zapisuje się jako RGB (pdfkit osadza je bez dekodowania)', async () => {
    const plik = kodujPng({ width: 30, height: 18, colorType: 6, bitDepth: 8, probki: (x, y) => [x * 8, y * 10, 99, 255] });
    const logo = przygotowane(plik);
    expect(ihdr(logo.data).colorType).toBe(2);
    const { rgba } = await dekodujPngJakPdfkit(logo.data);
    expect(piksel(rgba, 30, 29, 17)).toEqual([232, 170, 99, 255]);
  });

  it('paleta 4 bit z przezroczystością tRNS (zapis optymalizatorów PNG): RGBA z kanałem alfa', async () => {
    const paleta: Array<[number, number, number]> = [[255, 255, 255], [0, 80, 200], [200, 30, 30]];
    const plik = kodujPng({
      width: 21, height: 17, colorType: 3, bitDepth: 4, paleta, trns: Buffer.from([0, 255]),
      probki: (x, y) => [(x + y) % 3],
    });
    const logo = przygotowane(plik);
    expect(ihdr(logo.data)).toMatchObject({ bitDepth: 8, colorType: 6, interlace: 0 });
    const { rgba } = await dekodujPngJakPdfkit(logo.data);
    expect(piksel(rgba, 21, 0, 0)).toEqual([255, 255, 255, 0]);
    expect(piksel(rgba, 21, 1, 0)).toEqual([0, 80, 200, 255]);
    expect(piksel(rgba, 21, 2, 0)).toEqual([200, 30, 30, 255]);
    expect(piksel(rgba, 21, 20, 16)).toEqual([255, 255, 255, 0]); // (20 + 16) % 3 = 0
  });

  it('szarość 1 bit, szarość 16 bit z tRNS i szarość z alfą', async () => {
    const czarnoBiale = przygotowane(kodujPng({ width: 19, height: 16, colorType: 0, bitDepth: 1, probki: (x) => [x % 2] }));
    let { rgba } = await dekodujPngJakPdfkit(czarnoBiale.data);
    expect([piksel(rgba, 19, 0, 0), piksel(rgba, 19, 1, 0), piksel(rgba, 19, 18, 15)]).toEqual([[0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]);

    const gleboka = przygotowane(kodujPng({
      width: 16, height: 16, colorType: 0, bitDepth: 16, trns: Buffer.from([0x12, 0x34]),
      probki: (x) => [x < 8 ? 0x1234 : 0xabcd],
    }));
    ({ rgba } = await dekodujPngJakPdfkit(gleboka.data));
    expect(piksel(rgba, 16, 0, 0)[3]).toBe(0);
    expect(piksel(rgba, 16, 15, 0)).toEqual([0xab, 0xab, 0xab, 255]);

    const zAlfa = przygotowane(kodujPng({ width: 16, height: 16, colorType: 4, bitDepth: 8, probki: () => [77, 200] }));
    ({ rgba } = await dekodujPngJakPdfkit(zAlfa.data));
    expect(piksel(rgba, 16, 5, 5)).toEqual([77, 77, 77, 200]);
  });

  it('RGBA 16 bit, przeplot Adam7 i wszystkie filtry wierszy dają te same piksele', async () => {
    const wzor = (x: number, y: number) => [(x * 37 + y) % 256, (y * 11) % 256, (x ^ y) % 256, 255 - ((x + y) % 64)];
    const oczekiwane = przygotowane(kodujPng({ width: 37, height: 21, colorType: 6, bitDepth: 8, probki: wzor }));
    const warianty: ProbaPng[] = [
      { width: 37, height: 21, colorType: 6, bitDepth: 16, probki: (x, y) => wzor(x, y).map((v) => v * 257) },
      { width: 37, height: 21, colorType: 6, bitDepth: 8, interlace: 1, probki: wzor, filtr: (r) => r % 5 },
      { width: 37, height: 21, colorType: 6, bitDepth: 8, probki: wzor, filtr: (r) => r % 5, podzialIdat: 50 },
    ];
    for (const wariant of warianty) {
      const logo = przygotowane(kodujPng(wariant));
      expect(logo.data.equals(oczekiwane.data)).toBe(true);
    }
  });

  it('metadane (tekst, EXIF, profil) nie przechodzą do zapisanego logo', () => {
    const plik = kodujPng({
      ...{ width: 16, height: 16, colorType: 6, bitDepth: 8 as const, probki: () => [1, 2, 3, 255] },
      dodatkowe: [
        ['tEXt', Buffer.from('Author\0Jan Kowalski, GPS 52.2297', 'latin1')],
        ['eXIf', Buffer.from('MM\0*\0\0\0\x08GPSLatitude', 'latin1')],
      ],
    });
    const logo = przygotowane(plik);
    expect(fragmentyPng(logo.data)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(logo.data.toString('latin1')).not.toMatch(/Kowalski|GPS/);
  });

  it('duże logo zmniejszone do wysokości wydruku z zachowaniem proporcji', async () => {
    const zrodlo = ihdr(LOGO_FAKTWAY_2400);
    expect(zrodlo.height).toBeGreaterThan(LOGO_STORED_MAX_HEIGHT_PX);
    const logo = przygotowane(LOGO_FAKTWAY_2400);
    expect(logo.height).toBe(LOGO_STORED_MAX_HEIGHT_PX);
    expect(logo.width).toBe(Math.round((zrodlo.width * LOGO_STORED_MAX_HEIGHT_PX) / zrodlo.height));
    const odczyt = await dekodujPngJakPdfkit(logo.data);
    expect([odczyt.width, odczyt.height]).toEqual([logo.width, logo.height]);
  });

  it('zmniejszanie liczy kolor z wagą krycia: brzeg przy przezroczystym tle nie ciemnieje', async () => {
    // 800 × 800 → 400 × 400: co drugi piksel czerwony kryjący, co drugi całkiem przezroczysty (czarny).
    const plik = kodujPng({ width: 800, height: 800, colorType: 6, bitDepth: 8, probki: (x) => (x % 2 ? [0, 0, 0, 0] : [255, 0, 0, 255]) });
    const logo = przygotowane(plik);
    expect([logo.width, logo.height]).toEqual([LOGO_STORED_MAX_HEIGHT_PX, LOGO_STORED_MAX_HEIGHT_PX]);
    const { rgba } = await dekodujPngJakPdfkit(logo.data);
    const [r, g, b, a] = piksel(rgba, logo.width, 7, 7);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(155);
  });

  it('prawdziwe logo z pliku graficznego: 1200 × 266 RGBA bez zmian wymiarów; wynik powtarzalny', () => {
    const logo = przygotowane(LOGO_FAKTWAY);
    expect(logo).toMatchObject({ format: 'png', width: 1200, height: 266 });
    expect(przygotowane(LOGO_FAKTWAY).data.equals(logo.data)).toBe(true);
  });
});

describe('JPEG: struktura, bez metadanych, z orientacją', () => {
  it('prawdziwy JPEG progresywny z profilem ICC przechodzi; wynik zaczyna się SOI i kończy EOI', () => {
    const logo = przygotowane(JPEG_PROGRESYWNY);
    expect(logo).toMatchObject({ format: 'jpeg', width: 1400, height: 803 });
    expect(logo.data.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(logo.data.subarray(-2).toString('hex')).toBe('ffd9');
    expect(segmentyJpeg(logo.data).map(([m]) => m)).toEqual(segmentyJpeg(JPEG_PROGRESYWNY).map(([m]) => m));
  });

  it('EXIF z aparatu, XMP, IPTC, komentarz i druga klatka po końcu pliku znikają; orientacja zostaje', () => {
    const logo = przygotowane(jpegZMetadanymi(6));
    const tekst = logo.data.toString('latin1');
    expect(tekst).not.toMatch(/iPhone 15|GPSLatitude|Kowalsk|Photoshop 3|tajny opis|druga klatka/);
    expect(logo.data.subarray(-2).toString('hex')).toBe('ffd9');
    // Orientacja 6 (obrót o 90°): wymiary wydruku zamienione, a pdfkit czyta orientację z pliku.
    expect([logo.width, logo.height]).toEqual([803, 1400]);
    const doc = new PDFDocument() as unknown as { openImage: (src: Buffer) => { orientation: number; width: number; height: number } };
    expect(doc.openImage(logo.data)).toMatchObject({ orientation: 6, width: 1400, height: 803 });
  });

  it('orientacja 1 (zwykła): bez żadnego segmentu EXIF', () => {
    const logo = przygotowane(jpegZMetadanymi(1));
    expect(segmentyJpeg(logo.data).some(([m]) => m === 0xe1)).toBe(false);
    expect([logo.width, logo.height]).toEqual([1400, 803]);
  });

  it.each([
    ['12 bitów na próbkę', { precyzja: 12 }],
    ['kodowanie arytmetyczne (SOF9)', { sof: 0xc9 }],
    ['bezstratny (SOF3)', { sof: 0xc3 }],
    ['dwie składowe koloru', { skladowe: 2 }],
  ])('nieobsługiwany zapis: %s', (_opis, opcje) => {
    expect(odrzucenie(jpegRamka(opcje)).reason).toBe('unsupported');
  });

  it('ramka po SOS albo jej brak, ucięty plik, segment poza plikiem: uszkodzony', () => {
    expect(odrzucenie(jpegRamka({ bezSof: true })).reason).toBe('corrupt');
    expect(odrzucenie(jpegRamka({ bezEoi: true })).reason).toBe('corrupt');
    const poza = Buffer.from(jpegRamka({}));
    poza.writeUInt16BE(0xfff0, 4);
    expect(odrzucenie(poza).reason).toBe('corrupt');
  });

  it('wymiary z ramki: za szeroki odrzucony, prosty JPEG przechodzi bez zmian struktury', () => {
    expect(odrzucenie(jpegRamka({ width: LOGO_MAX_SIDE_PX + 1 })).reason).toBe('dimensions');
    const prosty = jpegRamka({ width: 120, height: 40 });
    const logo = przygotowane(prosty);
    expect(logo).toMatchObject({ format: 'jpeg', width: 120, height: 40 });
    expect(logo.data.equals(prosty)).toBe(true);
  });
});

describe('zapisane logo przy wydruku', () => {
  it('przygotowany PNG i JPEG przechodzą sprawdzenie przed wydrukiem z tymi samymi wymiarami', () => {
    const png = przygotowane(LOGO_FAKTWAY);
    expect(checkStoredLogo(png.data)).toMatchObject({ format: 'png', width: 1200, height: 266 });
    const jpeg = przygotowane(jpegZMetadanymi(8));
    expect(checkStoredLogo(jpeg.data)).toMatchObject({ format: 'jpeg', width: 803, height: 1400 });
  });

  it('plik spoza przygotowania (paleta, przeplot, śmieci, SVG) nie trafia na wydruk', () => {
    const paleta = kodujPng({ width: 16, height: 16, colorType: 3, bitDepth: 4, paleta: [[0, 0, 0]], trns: Buffer.from([0]), probki: () => [0] });
    expect(checkStoredLogo(paleta)).toBeNull();
    expect(checkStoredLogo(kodujPng({ width: 16, height: 16, colorType: 6, bitDepth: 8, interlace: 1, probki: () => [1, 2, 3, 4] }))).toBeNull();
    expect(checkStoredLogo(Buffer.from('<svg/>'))).toBeNull();
    expect(checkStoredLogo(Buffer.concat([SYGNATURA_PNG, deflateSync(Buffer.from('x'))]))).toBeNull();
  });
});
