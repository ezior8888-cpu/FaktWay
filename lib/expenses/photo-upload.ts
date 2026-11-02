import {
  ACTION_FILE_LIMIT_BYTES,
  ACTION_FILE_LIMIT_LABEL,
  formatUploadSize,
  uploadRejectedMessage,
} from '@/lib/upload-limit';

/**
 * Wysyłka zdjęcia albo PDF-u kosztu z przeglądarki (plan skalowania,
 * sesja 4; EXT-09, HOR-V1, DBC-02, BCK-09).
 *
 * PO CO. Zdjęcie z aparatu telefonu ma 2–5 MB, a Server Action przyjmuje
 * 1 MB (`lib/upload-limit.ts`) — typowe zdjęcie paragonu nie dochodziło do
 * serwera. Do odczytu wystarcza dłuższy bok 2000 px: OCR (Anthropic) i tak
 * skaluje obraz do ok. 1568 px. Mniejszy plik to też mniej miejsca
 * w magazynie plików i kopiach.
 *
 * ZASADY ZMNIEJSZANIA:
 * - PDF bez zmian.
 * - JPEG, PNG, WEBP i GIF, które mieszczą się w limicie, idą bez ponownego
 *   kodowania (nie tracą jakości, długi zrzut ekranu zostaje czytelny).
 * - Reszta obrazów: dekodowanie z orientacją z EXIF (`createImageBitmap`,
 *   zapas `<img>`), dłuższy bok ≤ 2000 px, JPEG 0,8, a gdy dalej ponad
 *   limit — 0,6. Wyjątek: obraz węższy niż 1:2 (zrzut przewijany) zachowuje
 *   krótszy bok ≥ 1000 px przy dłuższym ≤ 4096 px. Pod przezroczystością
 *   PNG białe tło. Animowany GIF daje pierwszą klatkę.
 * - Oryginał zostaje, gdy dekodowanie zawiedzie (np. HEIC poza Safari),
 *   gdy przeglądarka podmienia piksele płótna (ochrona przed
 *   fingerprintingiem w Tor Browser, LibreWolf) albo gdy JPEG nie jest
 *   mniejszy od oryginału w formacie, który serwer przyjmie. HEIC czy AVIF
 *   odkodowany przez przeglądarkę idzie zawsze jako JPEG.
 * - JPEG z płótna nie ma metadanych EXIF (położenia GPS, daty zdjęcia).
 *
 * Tylko API przeglądarki — moduł dla komponentów klienckich.
 */

/** Dłuższy bok zmniejszonego zdjęcia. */
export const PHOTO_MAX_EDGE_PX = 2000;

/** Krótszy bok, poniżej którego nie zwężamy długich zrzutów… */
const TALL_MIN_SHORT_EDGE_PX = 1000;
/** …o ile dłuższy bok nie przekroczy tej wartości. */
const TALL_MAX_EDGE_PX = 4096;

/** Jakość JPEG; druga tylko wtedy, gdy pierwsza nie mieści się w limicie. */
const JPEG_QUALITIES = [0.8, 0.6] as const;

/** Formaty, które serwer przyjmuje (`detectExpensePhotoType`), poza PDF. */
const SERVER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Wzór, który płótno musi oddać bez podmiany: czerwony, zielony, niebieski, czarny. */
const PROBE: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ['#ff0000', [255, 0, 0]],
  ['#00ff00', [0, 255, 0]],
  ['#0000ff', [0, 0, 255]],
  ['#000000', [0, 0, 0]],
];
/** Drobny szum, który dokładają Brave, Safari i Firefox w trybie ochrony, przechodzi. */
const PROBE_TOLERANCE = 24;

/** Wynik akcji wgrania — kształt zwracany przez `uploadExpensePhotoAction`. */
export type ExpenseUploadResult = { success: true; ocrJobId: string } | { success: false; error: string };

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function jpgName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '');
  return `${base || 'paragon'}.jpg`;
}

/** Wymiary po zmniejszeniu (bez powiększania). */
export function shrunkSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  let scale = PHOTO_MAX_EDGE_PX / long;
  if (short * scale < TALL_MIN_SHORT_EDGE_PX) {
    scale = Math.max(scale, Math.min(TALL_MIN_SHORT_EDGE_PX / short, TALL_MAX_EDGE_PX / long));
  }
  scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Czy przeglądarka oddaje prawdziwe piksele płótna. Firefox z pełną
 * ochroną przed fingerprintingiem zwraca zamiast nich szum albo biel — bez
 * tej próby do magazynu trafiłby szum zamiast paragonu.
 */
function canvasReadable(): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = PROBE.length;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  PROBE.forEach(([color], x) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, 0, 1, 1);
  });
  const data = ctx.getImageData(0, 0, PROBE.length, 1).data;
  return PROBE.every(([, rgb], x) => rgb.every((value, c) => Math.abs((data[x * 4 + c] ?? -999) - value) <= PROBE_TOLERANCE));
}

async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Starsza przeglądarka nie zna opcji albo formatu — próbujemy `<img>`,
      // który też obraca obraz według EXIF.
    }
  }

  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const objectUrl = url;
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    if (url) URL.revokeObjectURL(url);
    return null;
  }
}

/** Obraz na płótnie z białym tłem, w wymiarach z `shrunkSize`. */
function drawScaled(image: Decoded): HTMLCanvasElement | null {
  if (!image.width || !image.height) return null;

  const size = shrunkSize(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Co się stało z plikiem — od tego zależy komunikat, gdy dalej nie mieści
 * się w limicie:
 * - `kept`: PDF albo obraz, którego nie trzeba ruszać;
 * - `shrunk`: płótno zadziałało (wynik może być JPEG-iem albo mniejszym
 *   od niego oryginałem);
 * - `blocked`: przeglądarka podmienia piksele płótna;
 * - `failed`: dekodowanie albo kodowanie zawiodło.
 */
export type ShrinkStatus = 'kept' | 'shrunk' | 'blocked' | 'failed';

export interface ShrinkResult {
  file: File;
  status: ShrinkStatus;
}

/**
 * Zmniejszone zdjęcie jako JPEG albo — według zasad z nagłówka — ten sam
 * plik.
 */
export async function shrinkReceiptPhoto(file: File): Promise<ShrinkResult> {
  if (isPdf(file)) return { file, status: 'kept' };
  const accepted = SERVER_IMAGE_TYPES.has(file.type);
  if (accepted && file.size <= ACTION_FILE_LIMIT_BYTES) return { file, status: 'kept' };

  try {
    if (!canvasReadable()) return { file, status: 'blocked' };
    const image = await decode(file);
    if (!image) return { file, status: 'failed' };

    let canvas: HTMLCanvasElement | null;
    try {
      canvas = drawScaled(image);
    } finally {
      // Pełna bitmapa 12 Mpx to ok. 48 MB pamięci — oddajemy ją przed kodowaniem.
      image.release();
    }
    if (!canvas) return { file, status: 'failed' };

    try {
      let blob: Blob | null = null;
      for (const quality of JPEG_QUALITIES) {
        blob = await toJpeg(canvas, quality);
        if (!blob || blob.size <= ACTION_FILE_LIMIT_BYTES) break;
      }
      if (!blob) return { file, status: 'failed' };
      if (accepted && blob.size >= file.size) return { file, status: 'shrunk' };
      const jpeg = new File([blob], jpgName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
      return { file: jpeg, status: 'shrunk' };
    } finally {
      // Safari na iOS zwalnia pamięć płótna dopiero po wyzerowaniu wymiarów.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    return { file, status: 'failed' };
  }
}

/**
 * Komunikat dla pliku, który nie zmieści się w limicie Server Action;
 * `null` = mieści się. Rozmiar w komunikacie to rozmiar pliku wybranego
 * przez klienta, nie wyniku zmniejszania.
 */
export function expenseFileTooLargeMessage(original: File, result: ShrinkResult): string | null {
  if (result.file.size <= ACTION_FILE_LIMIT_BYTES) return null;
  const size = formatUploadSize(original.size);
  const limit = ACTION_FILE_LIMIT_LABEL;
  if (isPdf(original)) {
    return `PDF ma ${size}, a można wgrać najwyżej ${limit}. Zapisz go w niższej rozdzielczości albo, jeśli ma jedną stronę, wgraj jego zdjęcie — zdjęcia zmniejszamy sami.`;
  }
  switch (result.status) {
    case 'shrunk':
      return `Zdjęcie (${size}) nawet po zmniejszeniu przekracza ${limit}. Zrób zdjęcie z bliska, samego dokumentu, albo je przytnij i spróbuj ponownie.`;
    case 'blocked':
      return `Ta przeglądarka blokuje zmniejszanie zdjęć (ochrona prywatności), a zdjęcie ma ${size} — można wgrać najwyżej ${limit}. Spróbuj w innej przeglądarce albo zrób zdjęcie w niższej rozdzielczości.`;
    default:
      return `Nie udało się zmniejszyć zdjęcia (${size}), a można wgrać najwyżej ${limit}. Zapisz je jako JPG i spróbuj ponownie.`;
  }
}

/**
 * Zmniejsza zdjęcie, zatrzymuje plik ponad limit i wysyła resztę akcją.
 * Odrzucona obietnica akcji wraca jako zwykły błąd: w `startTransition`
 * trafiłaby do granicy błędu strony zamiast do toastu.
 */
export async function sendExpenseFile(
  file: File,
  upload: (form: FormData) => Promise<ExpenseUploadResult>,
): Promise<ExpenseUploadResult> {
  const result = await shrinkReceiptPhoto(file);
  const tooLarge = expenseFileTooLargeMessage(file, result);
  if (tooLarge) return { success: false, error: tooLarge };

  const form = new FormData();
  form.append('photo', result.file);
  return upload(form).catch((error: unknown): ExpenseUploadResult => {
    console.error('[koszty] wgranie pliku odrzucone', error);
    return { success: false, error: uploadRejectedMessage(error) };
  });
}
