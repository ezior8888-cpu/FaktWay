/**
 * Obraz kosztu w granicach API modelu (plan skalowania, sesja 34; ustalenie
 * z #346).
 *
 * API odrzuca obraz, którego dłuższy bok ma ponad 8000 px, a wgranie
 * (`/api/uploads/expense`, `/share-target`) sprawdza tylko bajty. Przewijany
 * zrzut ekranu 1080×9600 poniżej 1 MB przechodził wgranie i padał w workerze
 * z angielskim błędem API. Worker zmniejsza więc taki obraz przed wysłaniem.
 *
 * Obraz do 8000 px idzie bez zmian, bajt w bajt. Plik w archiwum zostaje
 * oryginalny: zmniejszona kopia żyje tylko w pamięci, na czas wywołania API.
 */
import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/messages/messages';
import type sharpFactory from 'sharp';

type SharpFactory = typeof sharpFactory;

/** Najdłuższy bok obrazu, który API przyjmuje (dokumentacja „Vision”, 13.11.2026). */
export const API_IMAGE_MAX_EDGE_PX = 8000;

/**
 * Najwięcej bajtów obrazu po zakodowaniu base64. API podaje „10 MB”; liczymy
 * dziesiętnie, jak `UPLOAD_IMAGE_LIMIT_BYTES`, bo nie wiadomo, czy to MB czy MiB.
 */
export const API_IMAGE_MAX_BASE64_BYTES = 10_000_000;

/**
 * Najwięcej pikseli, które worker dekoduje, żeby zmniejszyć obraz: tyle, ile
 * ma największy obraz przyjmowany przez API (8000×8000). PNG z przeplotem,
 * JPEG progresywny i GIF dekodują się w całości do pamięci, więc bez limitu
 * plik 2 MB o boku 16383 px (domyślny limit sharp) zajmował do 2,3 GB.
 * Pomiar 13.11.2026, jeden wątek libvips jak w workerze: przy tym limicie
 * szczyt procesu to najwyżej ok. 0,66 GB (PNG 16-bit RGBA z przeplotem),
 * a zwykłe zdjęcie JPEG 0,14–0,25 GB. Pełne zdjęcie 50 Mpx z telefonu
 * (8160×6144) mieści się w limicie; obraz ponad limit sharp odrzuca po
 * samym nagłówku, bez dekodowania.
 */
export const IMAGE_MAX_DECODE_PIXELS = API_IMAGE_MAX_EDGE_PX * API_IMAGE_MAX_EDGE_PX;

/**
 * Kolejne próby dłuższego boku, gdy kopia nie mieści się w limicie bajtów.
 * API i tak zmniejsza obraz do 2576 px (modele 4.7 i nowsze) albo 1568 px
 * (pozostałe, w tym model OCR), więc żaden krok nie odbiera modelowi szczegółów.
 */
const EDGE_STEPS_PX = [API_IMAGE_MAX_EDGE_PX, 4000, 2576] as const;

/** Jakość JPEG kopii: tekst paragonu zostaje ostry po zmniejszeniu przez API. */
const JPEG_QUALITY = 85;

/**
 * Bez optymalizacji tablic Huffmana: optymalizacja wymaga dwóch przebiegów,
 * więc koder trzyma współczynniki całej kopii w pamięci (ok. 190 MB przy
 * 8000×8000). Pomiar 13.11.2026 dla PNG bez przeplotu tuż pod limitem pikseli
 * (8001×7999, kopia 8000×7998): szczyt pamięci procesu 492 MB z optymalizacją,
 * 113 MB bez niej, a kopia zdjęcia większa tylko o ok. 3,5%.
 */
const JPEG_OPTIMISE_CODING = false;

/**
 * Komunikat dla klienta, gdy obrazu ponad 8000 px nie da się przygotować dla
 * API: za dużo pikseli, uszkodzony plik albo kopia ponad limit bajtów. Bez
 * trybu rozkazującego (lista kontrolna filtra, pkt 16) i do 80 znaków, bo tyle
 * zostawia powiadomienie. Wyjście: mniejsze zdjęcie albo PDF; oryginał zostaje
 * w archiwum, a karta „nie odczytałem” prowadzi do ponownego wgrania.
 */
export const IMAGE_TOO_LARGE_MESSAGE = 'Zdjęcie ma ponad 8000 px i nie da się go odczytać. Potrzebne mniejsze albo PDF.';

export interface ApiImage {
  data: string;
  mediaType: Base64ImageSource['media_type'];
}

/**
 * Biblioteka natywna ładowana przy pierwszym obrazie, nie przy starcie:
 * `process-ocr` importuje się z resztą handlerów workera, więc brak binarki
 * dla platformy przy imporcie statycznym zatrzymałby wszystkie joby.
 *
 * Bez pamięci podręcznej operacji libvips: każdy obraz przerabiamy raz,
 * a zdekodowany GIF zostawał w niej po każdym odczycie, bo libvips nie liczy
 * jego bufora do limitu pamięci. Pomiar 13.11.2026: cztery GIF-y 10000×6400
 * po kolei to 1,13 GB zajęte w procesie z pamięcią podręczną, ok. 0,1 GB bez niej.
 * Ustawienie jest globalne dla procesu (ten moduł ładuje tylko worker),
 * a każde wejście sharp (CJS, ESM) przy ładowaniu włącza ją z powrotem,
 * więc wyłączamy ją przy każdym obrazie.
 */
async function loadSharp(): Promise<SharpFactory> {
  const sharp = (await import('sharp')).default;
  sharp.cache(false);
  return sharp;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Obraz do wysłania: oryginał, gdy mieści się w 8000 px, a inaczej kopia JPEG
 * zmniejszona do 8000 px na dłuższym boku (mniej, gdy nie mieści się
 * w `maxBase64Bytes`). Obrót z EXIF jest stosowany przed zmniejszeniem, bo
 * kopia traci metadane, a przezroczystość idzie na białe tło.
 *
 * Gdy biblioteka nie odczyta wymiarów, obraz idzie bez zmian i decyduje API,
 * jak przed tą zmianą. Gdy obrazu ponad 8000 px nie da się zmniejszyć (ponad
 * `IMAGE_MAX_DECODE_PIXELS` albo uszkodzony plik), rzuca błąd
 * z `IMAGE_TOO_LARGE_MESSAGE` zamiast wysyłać obraz, który API odrzuciłoby
 * z angielskim błędem. Funkcja czysta (bez zapisu i efektów zewnętrznych),
 * więc ponowienie joba po prostu liczy kopię jeszcze raz.
 */
export async function fitImageForApi(
  imageBase64: string,
  mediaType: Base64ImageSource['media_type'],
  { maxBase64Bytes = API_IMAGE_MAX_BASE64_BYTES }: { maxBase64Bytes?: number } = {},
): Promise<ApiImage> {
  const input = Buffer.from(imageBase64, 'base64');

  let sharp: SharpFactory;
  let width: number;
  let height: number;
  try {
    sharp = await loadSharp();
    // Sam nagłówek, bez dekodowania pikseli, więc bez limitu pikseli: obraz
    // ponad ten limit ma dostać komunikat niżej, a nie przejść bez zmian.
    ({ width, height } = await sharp(input, { limitInputPixels: false }).metadata());
  } catch (e) {
    // Awaria biblioteki nie może zatrzymać odczytu zwykłych zdjęć.
    console.warn(`[ocr] nie odczytano wymiarów obrazu ${mediaType}, idzie bez zmian: ${errorText(e)}`);
    return { data: imageBase64, mediaType };
  }
  const longEdge = Math.max(width, height);
  if (!Number.isFinite(longEdge) || longEdge <= API_IMAGE_MAX_EDGE_PX) {
    return { data: imageBase64, mediaType };
  }

  for (const edge of EDGE_STEPS_PX) {
    let output: Buffer;
    try {
      output = await sharp(input, { autoOrient: true, limitInputPixels: IMAGE_MAX_DECODE_PIXELS })
        .resize({ width: edge, height: edge, fit: 'inside' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY, optimiseCoding: JPEG_OPTIMISE_CODING })
        .toBuffer();
    } catch (e) {
      console.warn(`[ocr] nie zmniejszono obrazu ${mediaType} ${width}×${height} px: ${errorText(e)}`);
      throw new Error(IMAGE_TOO_LARGE_MESSAGE, { cause: e });
    }
    const data = output.toString('base64');
    if (data.length <= maxBase64Bytes) return { data, mediaType: 'image/jpeg' };
  }
  console.warn(
    `[ocr] kopia obrazu ${mediaType} ${width}×${height} px ponad ${maxBase64Bytes} B nawet przy ${EDGE_STEPS_PX.at(-1)} px`,
  );
  throw new Error(IMAGE_TOO_LARGE_MESSAGE);
}
