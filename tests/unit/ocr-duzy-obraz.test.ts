/**
 * Plan skalowania, sesja 34 (osobne ustalenie z #346): API modelu odrzuca
 * obraz, którego dłuższy bok ma ponad 8000 px, a wgranie sprawdza tylko
 * bajty. Przewijany zrzut ekranu 1080×9600 poniżej 1 MB przechodził wgranie
 * i padał w workerze z angielskim błędem API.
 *
 * Prawdziwa ścieżka: silnik OCR (`extractInvoiceFromImage`, jedyne wywołanie
 * w `lib/jobs/runners/process-ocr.ts`) i SDK Anthropic. Atrapą jest tylko
 * serwer HTTP API na 127.0.0.1 (`ANTHROPIC_BASE_URL`), który sprawdza obraz
 * jak API według dokumentacji „Vision”: dłuższy bok do 8000 px, do 10 MB po
 * zakodowaniu base64 (dziesiętnie, ostrożniejsze z dwóch odczytań) i typ
 * zgodny z zawartością.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

import sharp, { type Metadata, type Sharp } from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtractedInvoice } from '@/lib/ocr/schema';

const LIMIT_BOKU_PX = 8000;
const LIMIT_BASE64_BAJTOW = 10_000_000;
const ZA_DUZE_ZDJECIE = 'Za duże zdjęcie do odczytu (ponad 8000 px). Wgraj mniejsze zdjęcie albo PDF.';

/** Co doszło do atrapy API: blok z pierwszej wiadomości i wymiary odczytane z jego bajtów. */
interface Zapytanie {
  rodzaj: string;
  mediaType: string;
  data: string;
  szerokosc?: number;
  wysokosc?: number;
  format?: string;
}

interface CialoZapytania {
  messages: { content: { type: string; source: { media_type: string; data: string } }[] }[];
}

const ODCZYT: ExtractedInvoice = {
  seller_name: 'Sklep Testowy',
  seller_nip: null,
  seller_address: null,
  document_number: 'PAR/1/2026',
  document_type: 'receipt',
  issue_date: '2026-11-13',
  net_amount: 81.3,
  vat_amount: 18.7,
  gross_amount: 100,
  vat_rate: '23',
  line_items: null,
  ocr_confidence: 0.9,
  notes: null,
};

const WIADOMOSC = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: JSON.stringify(ODCZYT) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1500, output_tokens: 300 },
};

const FORMAT_TYPU: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const zapytania: Zapytanie[] = [];
let serwer: http.Server;
let extractInvoiceFromImage: typeof import('@/lib/ocr/engine').extractInvoiceFromImage;

function bladApi(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', message }, request_id: 'req_test' };
}

function odpowiedz(res: http.ServerResponse, status: number, tresc: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(tresc));
}

/** Atrapa `POST /v1/messages` z kontrolami obrazu, które API robi przed modelem. */
async function obsluz(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    odpowiedz(res, 404, bladApi(`nieznana ścieżka ${req.method} ${req.url}`));
    return;
  }
  const czesci: Buffer[] = [];
  for await (const czesc of req) czesci.push(czesc as Buffer);
  const cialo = JSON.parse(Buffer.concat(czesci).toString('utf8')) as CialoZapytania;
  const blok = cialo.messages[0].content[0];
  const zapytanie: Zapytanie = { rodzaj: blok.type, mediaType: blok.source.media_type, data: blok.source.data };
  zapytania.push(zapytanie);
  if (blok.type !== 'image') {
    odpowiedz(res, 200, WIADOMOSC);
    return;
  }

  let meta: Metadata;
  try {
    meta = await sharp(Buffer.from(blok.source.data, 'base64'), { limitInputPixels: false }).metadata();
  } catch {
    odpowiedz(res, 400, bladApi('messages.0.content.0.image.source.base64: Could not process image'));
    return;
  }
  zapytanie.szerokosc = meta.width;
  zapytanie.wysokosc = meta.height;
  zapytanie.format = meta.format;
  if (Math.max(meta.width, meta.height) > LIMIT_BOKU_PX) {
    odpowiedz(
      res,
      400,
      bladApi(
        `messages.0.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: ${LIMIT_BOKU_PX} pixels`,
      ),
    );
    return;
  }
  if (blok.source.data.length > LIMIT_BASE64_BAJTOW) {
    odpowiedz(res, 400, bladApi('messages.0.content.0.image.source.base64: image exceeds 10 MB maximum'));
    return;
  }
  if (FORMAT_TYPU[blok.source.media_type] !== meta.format) {
    odpowiedz(
      res,
      400,
      bladApi(`messages.0.content.0.image.source.base64: Image does not match the provided media type ${blok.source.media_type}`),
    );
    return;
  }
  odpowiedz(res, 200, WIADOMOSC);
}

beforeAll(async () => {
  serwer = http.createServer((req, res) => {
    obsluz(req, res).catch((e: unknown) => odpowiedz(res, 400, bladApi(`atrapa: ${String(e)}`)));
  });
  await new Promise<void>((gotowe) => serwer.listen(0, '127.0.0.1', gotowe));
  const { port } = serwer.address() as AddressInfo;
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('ANTHROPIC_API_KEY', 'klucz-testowy');
  vi.stubEnv('E2E_MOCK_ANTHROPIC', '0');
  // Klient SDK powstaje przy pierwszym wywołaniu i zostaje w module: świeży
  // moduł gwarantuje, że widzi adres atrapy.
  vi.resetModules();
  ({ extractInvoiceFromImage } = await import('@/lib/ocr/engine'));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  serwer.closeAllConnections();
  await new Promise<void>((gotowe) => serwer.close(() => gotowe()));
});

beforeEach(() => {
  zapytania.length = 0;
});

const bialy = (szerokosc: number, wysokosc: number) =>
  sharp({ create: { width: szerokosc, height: wysokosc, channels: 3, background: '#ffffff' } });

async function base64(obraz: Sharp): Promise<string> {
  return (await obraz.toBuffer()).toString('base64');
}

const szum = (szerokosc: number, wysokosc: number) =>
  sharp({
    create: {
      width: szerokosc,
      height: wysokosc,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  }).jpeg({ quality: 90 });

async function wymiary(data: string): Promise<[number, number]> {
  const meta = await sharp(Buffer.from(data, 'base64')).metadata();
  return [meta.width, meta.height];
}

/** Sam nagłówek PNG: obiecuje 20000×20000 px (400 Mpx), pikseli prawie brak. */
function naglowekBomby(): string {
  const chunk = (typ: string, dane: Buffer) => {
    const dlugosc = Buffer.alloc(4);
    dlugosc.writeUInt32BE(dane.length);
    const tresc = Buffer.concat([Buffer.from(typ, 'ascii'), dane]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(tresc) >>> 0);
    return Buffer.concat([dlugosc, tresc, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20_000, 0);
  ihdr.writeUInt32BE(20_000, 4);
  ihdr[8] = 8; // 8 bitów na kanał
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

describe('OCR: obraz z bokiem ponad 8000 px trafia do API w dopuszczalnym rozmiarze', () => {
  it('JPEG 9000×1200: do API trafia 8000×1067 i odczyt się udaje', async () => {
    const wynik = await extractInvoiceFromImage(await base64(bialy(9000, 1200).jpeg()), 'image/jpeg');

    expect(wynik.error).toBeUndefined();
    expect(wynik.success).toBe(true);
    expect(zapytania).toHaveLength(1);
    expect(zapytania[0]).toMatchObject({ rodzaj: 'image', mediaType: 'image/jpeg', szerokosc: 8000, wysokosc: 1067 });
    expect(zapytania[0].data.length).toBeLessThanOrEqual(LIMIT_BASE64_BAJTOW);
  });

  it('przewijany zrzut 1080×9600 w PNG (przykład z #346) trafia jako 900×8000', async () => {
    const wynik = await extractInvoiceFromImage(await base64(bialy(1080, 9600).png()), 'image/png');

    expect(wynik.error).toBeUndefined();
    expect(wynik.success).toBe(true);
    expect(zapytania).toHaveLength(1);
    expect(zapytania[0]).toMatchObject({ szerokosc: 900, wysokosc: 8000 });
  });

  it('8001 px to już za dużo: obraz trafia do API zmniejszony do 8000 px', async () => {
    const wynik = await extractInvoiceFromImage(await base64(bialy(8001, 50).png()), 'image/png');

    expect(wynik.error).toBeUndefined();
    expect(wynik.success).toBe(true);
    expect(zapytania[0]).toMatchObject({ szerokosc: 8000, wysokosc: 50 });
  });

  it('obrót zapisany w EXIF zostaje: pionowe zdjęcie trafia do API jako 1067×8000', async () => {
    // Zapisane 9000×1200 z orientacją 6, czyli wyświetlane pionowo (1200×9000).
    const zdjecie = await base64(bialy(9000, 1200).jpeg().withMetadata({ orientation: 6 }));

    const wynik = await extractInvoiceFromImage(zdjecie, 'image/jpeg');

    expect(wynik.success).toBe(true);
    expect(zapytania[0]).toMatchObject({ szerokosc: 1067, wysokosc: 8000 });
  });

  it('GIF i WebP ponad 8000 px też trafiają do API w granicach', async () => {
    const gif = await extractInvoiceFromImage(await base64(bialy(9000, 60).gif()), 'image/gif');
    const webp = await extractInvoiceFromImage(await base64(bialy(9000, 60).webp()), 'image/webp');

    expect(gif.error).toBeUndefined();
    expect(webp.error).toBeUndefined();
    expect(zapytania).toHaveLength(2);
    for (const zapytanie of zapytania) {
      expect(zapytanie).toMatchObject({ szerokosc: 8000, wysokosc: 53 });
    }
  });

  it('obraz ponad 8000 px, którego nie da się zmniejszyć: polski komunikat i bez płatnego wywołania API', async () => {
    // Nagłówek mówi 9000×1200, ale dane są ucięte (np. przerwane wgranie).
    const pelny = await szum(9000, 1200).toBuffer();
    const uciety = pelny.subarray(0, Math.floor(pelny.length * 0.6)).toString('base64');

    const wynik = await extractInvoiceFromImage(uciety, 'image/jpeg');

    expect(wynik.success).toBe(false);
    expect(wynik.error).toBe(ZA_DUZE_ZDJECIE);
    expect(zapytania).toHaveLength(0);
  });

  it('nagłówek obiecujący 400 Mpx (bomba dekompresyjna): ten sam komunikat, bez wywołania API', async () => {
    const wynik = await extractInvoiceFromImage(naglowekBomby(), 'image/png');

    expect(wynik.success).toBe(false);
    expect(wynik.error).toBe(ZA_DUZE_ZDJECIE);
    expect(zapytania).toHaveLength(0);
  });

  it('przezroczystość idzie na białe tło, nie na czarne', async () => {
    const przezroczysty = sharp({
      create: { width: 9000, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png();

    const wynik = await extractInvoiceFromImage(await base64(przezroczysty), 'image/png');

    expect(wynik.success).toBe(true);
    expect(zapytania[0]).toMatchObject({ mediaType: 'image/jpeg', szerokosc: 8000 });
    const { channels } = await sharp(Buffer.from(zapytania[0].data, 'base64')).stats();
    expect(channels.map((kanal) => Math.round(kanal.mean))).toEqual([255, 255, 255]);
  });
});

describe('OCR: kopia ponad limit bajtów schodzi do mniejszego boku', () => {
  it('8000 px, potem 4000 px, potem 2576 px, a dalej komunikat dla klienta', async () => {
    const { fitImageForApi, IMAGE_TOO_LARGE_MESSAGE } = await import('@/lib/ocr/image-for-api');
    const zdjecie = await base64(szum(9000, 600));

    const pelna = await fitImageForApi(zdjecie, 'image/jpeg');
    const srednia = await fitImageForApi(zdjecie, 'image/jpeg', { maxBase64Bytes: pelna.data.length - 1 });
    const mala = await fitImageForApi(zdjecie, 'image/jpeg', { maxBase64Bytes: srednia.data.length - 1 });

    expect((await wymiary(pelna.data))[0]).toBe(8000);
    expect((await wymiary(srednia.data))[0]).toBe(4000);
    expect((await wymiary(mala.data))[0]).toBe(2576);
    expect(mala.mediaType).toBe('image/jpeg');
    await expect(
      fitImageForApi(zdjecie, 'image/jpeg', { maxBase64Bytes: mala.data.length - 1 }),
    ).rejects.toThrow(IMAGE_TOO_LARGE_MESSAGE);
    expect(IMAGE_TOO_LARGE_MESSAGE).toBe(ZA_DUZE_ZDJECIE);
    expect(IMAGE_TOO_LARGE_MESSAGE.length).toBeLessThanOrEqual(80);
  });
});

describe('OCR: obraz w granicach API i inne pliki idą bez zmian', () => {
  it('8000 px to jeszcze granica: obraz idzie bajt w bajt', async () => {
    const zdjecie = await base64(bialy(8000, 50).png());

    const wynik = await extractInvoiceFromImage(zdjecie, 'image/png');

    expect(wynik.success).toBe(true);
    expect(zapytania[0]).toMatchObject({ mediaType: 'image/png', szerokosc: 8000, wysokosc: 50 });
    expect(zapytania[0].data).toBe(zdjecie);
  });

  it('zwykłe zdjęcie JPEG i WebP idzie bajt w bajt, z tym samym typem', async () => {
    const jpeg = await base64(bialy(4000, 3000).jpeg());
    const webp = await base64(bialy(1200, 1600).webp());

    await extractInvoiceFromImage(jpeg, 'image/jpeg');
    await extractInvoiceFromImage(webp, 'image/webp');

    expect(zapytania.map((z) => [z.mediaType, z.data])).toEqual([
      ['image/jpeg', jpeg],
      ['image/webp', webp],
    ]);
  });

  it('PDF idzie do API bez zmian', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');

    const wynik = await extractInvoiceFromImage(pdf, 'application/pdf');

    expect(wynik.success).toBe(true);
    expect(zapytania).toEqual([{ rodzaj: 'document', mediaType: 'application/pdf', data: pdf }]);
  });

  it('plik, z którego nie da się odczytać wymiarów, idzie bez zmian: decyduje API', async () => {
    const smieci = Buffer.from('to nie jest obraz').toString('base64');

    const wynik = await extractInvoiceFromImage(smieci, 'image/png');

    expect(wynik.success).toBe(false);
    expect(zapytania).toHaveLength(1);
    expect(zapytania[0].data).toBe(smieci);
  });
});

describe('OCR: awaria biblioteki obrazów nie zatrzymuje zwykłych zdjęć', () => {
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.restoreAllMocks();
  });

  it('bez binarki sharp zwykłe zdjęcie idzie bez zmian, a w logu zostaje ostrzeżenie', async () => {
    const zdjecie = await base64(bialy(4000, 3000).jpeg());
    vi.resetModules();
    vi.doMock('sharp', () => {
      throw new Error('Could not load the "sharp" module using the linux-x64 runtime');
    });
    const ostrzezenia = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { extractInvoiceFromImage: bezBiblioteki } = await import('@/lib/ocr/engine');

    const wynik = await bezBiblioteki(zdjecie, 'image/jpeg');

    expect(wynik.success).toBe(true);
    expect(zapytania).toHaveLength(1);
    expect(zapytania[0].data).toBe(zdjecie);
    expect(ostrzezenia).toHaveBeenCalledWith(expect.stringContaining('idzie bez zmian'));
  });
});
