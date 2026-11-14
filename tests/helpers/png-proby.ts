import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

/**
 * Pliki PNG do testów logo firmy (krok 2.2 planu kompletnej aplikacji),
 * kodowane tutaj, niezależnie od `lib/pdf/logo-obraz.ts`: każdy typ koloru
 * i głębia ze specyfikacji PNG, przeplot Adam7, przezroczystość tRNS i każdy
 * filtr wiersza. Wynik aplikacji czyta dekoder z pdfkit (`png-js`), czyli
 * ten, który potem rysuje logo na PDF.
 */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Proby(bajty: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bajty) c = TABELA_CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function fragmentPng(typ: string, dane: Uint8Array = new Uint8Array(0)): Buffer {
  const naglowek = Buffer.alloc(8);
  naglowek.writeUInt32BE(dane.length, 0);
  naglowek.write(typ, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Proby(Buffer.concat([naglowek.subarray(4), dane])), 0);
  return Buffer.concat([naglowek, dane, crc]);
}

export const SYGNATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KANALY: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

export interface ProbaPng {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 1 | 2 | 4 | 8 | 16;
  interlace?: 0 | 1;
  /** Próbki piksela: indeks palety (typ 3) albo kanały w zakresie 0..2^głębia-1. */
  probki: (x: number, y: number) => number[];
  paleta?: Array<[number, number, number]>;
  trns?: Uint8Array;
  /** Filtr wiersza 0-4: stały albo zależny od numeru wiersza w przebiegu. */
  filtr?: number | ((wiersz: number) => number);
  /** Fragmenty dopisane przed IDAT (np. tEXt z danymi aparatu). */
  dodatkowe?: Array<[string, Uint8Array]>;
  /** Długość jednego fragmentu IDAT (dane dzielone na kilka). */
  podzialIdat?: number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function filtruj(typ: number, wiersz: Uint8Array, poprzedni: Uint8Array, bpp: number): Uint8Array {
  const wynik = new Uint8Array(wiersz.length);
  for (let i = 0; i < wiersz.length; i++) {
    const lewy = i >= bpp ? wiersz[i - bpp]! : 0;
    const gora = poprzedni[i]!;
    const goraLewy = i >= bpp ? poprzedni[i - bpp]! : 0;
    const przewidziany = typ === 0 ? 0 : typ === 1 ? lewy : typ === 2 ? gora : typ === 3 ? (lewy + gora) >> 1 : paeth(lewy, gora, goraLewy);
    wynik[i] = (wiersz[i]! - przewidziany) & 0xff;
  }
  return wynik;
}

/** Surowe dane IDAT (przed kompresją) dla podanego pliku próbnego. */
export function surowePng(p: ProbaPng): Buffer {
  const kanaly = KANALY[p.colorType]!;
  const bitow = kanaly * p.bitDepth;
  const bpp = Math.max(1, bitow >> 3);
  const przebiegi = p.interlace === 1 ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const czesci: Buffer[] = [];
  for (const [x0, y0, dx, dy] of przebiegi) {
    const pw = Math.ceil((p.width - x0) / dx);
    const ph = Math.ceil((p.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const dlugosc = Math.ceil((pw * bitow) / 8);
    let poprzedni = new Uint8Array(dlugosc);
    for (let r = 0; r < ph; r++) {
      const wiersz = new Uint8Array(dlugosc);
      let bit = 0;
      for (let i = 0; i < pw; i++) {
        for (const probka of p.probki(x0 + i * dx, y0 + r * dy)) {
          if (p.bitDepth === 16) {
            wiersz[bit >> 3] = probka >> 8;
            wiersz[(bit >> 3) + 1] = probka & 0xff;
          } else if (p.bitDepth === 8) {
            wiersz[bit >> 3] = probka;
          } else {
            wiersz[bit >> 3]! |= probka << (8 - p.bitDepth - (bit & 7));
          }
          bit += p.bitDepth;
        }
      }
      const typ = typeof p.filtr === 'function' ? p.filtr(r) : (p.filtr ?? 0);
      czesci.push(Buffer.from([typ]), Buffer.from(filtruj(typ, wiersz, poprzedni, bpp)));
      poprzedni = wiersz;
    }
  }
  return Buffer.concat(czesci);
}

export function kodujPng(p: ProbaPng, surowe: Buffer = surowePng(p)): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0);
  ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = p.bitDepth;
  ihdr[9] = p.colorType;
  ihdr[12] = p.interlace ?? 0;
  const fragmenty: Buffer[] = [SYGNATURA_PNG, fragmentPng('IHDR', ihdr)];
  for (const [typ, dane] of p.dodatkowe ?? []) fragmenty.push(fragmentPng(typ, dane));
  if (p.paleta) fragmenty.push(fragmentPng('PLTE', Buffer.from(p.paleta.flat())));
  if (p.trns) fragmenty.push(fragmentPng('tRNS', p.trns));
  const idat = deflateSync(surowe);
  const krok = p.podzialIdat ?? idat.length;
  for (let od = 0; od < idat.length; od += krok) fragmenty.push(fragmentPng('IDAT', idat.subarray(od, od + krok)));
  fragmenty.push(fragmentPng('IEND'));
  return Buffer.concat(fragmenty);
}

/** Proste logo RGBA 8 bit: lewa połowa czerwona i pełna, prawa niebieska w połowie przezroczysta. */
export function logoRgba(width: number, height: number): Buffer {
  return kodujPng({
    width,
    height,
    colorType: 6,
    bitDepth: 8,
    probki: (x) => (x < width / 2 ? [220, 20, 20, 255] : [20, 40, 220, 128]),
  });
}

/** Dekoder PNG z pdfkit (`png-js`): ten sam, który rysuje logo na PDF. Zwraca piksele RGBA. */
export async function dekodujPngJakPdfkit(plik: Buffer): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const zPdfkit = createRequire(createRequire(import.meta.url).resolve('pdfkit'));
  const PNG = zPdfkit('png-js') as new (dane: Buffer) => {
    width: number;
    height: number;
    decode: (gotowe: (piksele: Uint8Array) => void) => void;
  };
  const obraz = new PNG(plik);
  const rgba = await new Promise<Uint8Array>((ok) => obraz.decode(ok));
  return { width: obraz.width, height: obraz.height, rgba };
}
