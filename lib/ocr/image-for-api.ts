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
 * 8000×8000). Pomiar 13.11.2026 dla PNG 16383×16383 (największy, jaki przepuszcza
 * domyślny limit pikseli): szczyt pamięci procesu 523 MB z optymalizacją,
 * 161 MB bez niej, a kopia większa tylko o kilka procent.
 */
const JPEG_OPTIMISE_CODING = false;

/**
 * Komunikat dla klienta (zadanie OCR, powiadomienie ucina do 80 znaków).
 * Wyjście: mniejsze zdjęcie albo PDF; oryginał zostaje w archiwum, a karta
 * „nie odczytałem” prowadzi do ponownego wgrania.
 */
export const IMAGE_TOO_LARGE_MESSAGE = 'Za duże zdjęcie do odczytu (ponad 8000 px). Wgraj mniejsze zdjęcie albo PDF.';

export interface ApiImage {
  data: string;
  mediaType: Base64ImageSource['media_type'];
}

/**
 * Biblioteka natywna ładowana przy pierwszym obrazie, nie przy starcie:
 * `process-ocr` importuje się z resztą handlerów workera, więc brak binarki
 * dla platformy przy imporcie statycznym zatrzymałby wszystkie joby.
 */
async function loadSharp(): Promise<SharpFactory> {
  return (await import('sharp')).default;
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
 * jak przed tą zmianą. Gdy obrazu ponad 8000 px nie da się zmniejszyć,
 * rzuca błąd z `IMAGE_TOO_LARGE_MESSAGE`: bez płatnego wywołania, które API
 * i tak by odrzuciło. Funkcja czysta (bez zapisu i efektów zewnętrznych),
 * więc ponowienie joba po prostu liczy kopię jeszcze raz.
 */
export async function fitImageForApi(
  imageBase64: string,
  mediaType: Base64ImageSource['media_type'],
  { maxBase64Bytes = API_IMAGE_MAX_BASE64_BYTES }: { maxBase64Bytes?: number } = {},
): Promise<ApiImage> {
  const input = Buffer.from(imageBase64, 'base64');

  let sharp: SharpFactory;
  let longEdge: number;
  try {
    sharp = await loadSharp();
    // Sam nagłówek, bez dekodowania pikseli, więc bez limitu pikseli: obraz
    // ponad ten limit ma dostać komunikat niżej, a nie przejść bez zmian.
    const { width, height } = await sharp(input, { limitInputPixels: false }).metadata();
    longEdge = Math.max(width, height);
  } catch (e) {
    // Awaria biblioteki nie może zatrzymać odczytu zwykłych zdjęć.
    console.warn(`[ocr] nie odczytano wymiarów obrazu ${mediaType}, idzie bez zmian: ${errorText(e)}`);
    return { data: imageBase64, mediaType };
  }
  if (!Number.isFinite(longEdge) || longEdge <= API_IMAGE_MAX_EDGE_PX) {
    return { data: imageBase64, mediaType };
  }

  for (const edge of EDGE_STEPS_PX) {
    let output: Buffer;
    try {
      // Domyślny limit pikseli sharp (16383×16383) odrzuca bomby dekompresyjne.
      output = await sharp(input, { autoOrient: true })
        .resize({ width: edge, height: edge, fit: 'inside' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY, optimiseCoding: JPEG_OPTIMISE_CODING })
        .toBuffer();
    } catch (e) {
      console.warn(`[ocr] nie zmniejszono obrazu ${mediaType} (${longEdge} px): ${errorText(e)}`);
      throw new Error(IMAGE_TOO_LARGE_MESSAGE, { cause: e });
    }
    const data = output.toString('base64');
    if (data.length <= maxBase64Bytes) return { data, mediaType: 'image/jpeg' };
  }
  console.warn(`[ocr] kopia obrazu ${mediaType} (${longEdge} px) ponad ${maxBase64Bytes} B nawet przy ${EDGE_STEPS_PX.at(-1)} px`);
  throw new Error(IMAGE_TOO_LARGE_MESSAGE);
}
