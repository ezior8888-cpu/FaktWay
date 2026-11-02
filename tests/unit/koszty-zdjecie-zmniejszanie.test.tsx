// @vitest-environment jsdom
import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 4 planu skalowania (EXT-09, HOR-V1, LIM-08, CPU-06, DBC-02, BCK-09).
 * Server Action przyjmuje najwyżej 1 MiB (domyślny limit Next, `next.config.ts`
 * go nie zmienia), a zdjęcie z aparatu telefonu ma 2–5 MB. Dlatego przycisk
 * „Dodaj wydatek” zmniejsza zdjęcie w przeglądarce (dłuższy bok ≤ 2000 px,
 * JPEG 0,8) przed wysłaniem. PDF idzie bez zmian, a JPEG/PNG/WEBP/GIF
 * w limicie bez ponownego kodowania. Plik, który dalej nie mieści się
 * w limicie, dostaje komunikat i nie trafia do akcji. Odrzucona obietnica
 * akcji (413, sieć, strona sprzed wdrożenia) kończy się toastem, nie granicą
 * błędu strony.
 *
 * jsdom nie ma płótna ani dekodera obrazów, więc `createImageBitmap`,
 * `getContext` i `toBlob` to atrapy. Atrapa kontekstu pamięta `fillStyle`
 * i oddaje piksele z `fillRect` 1×1 (sonda płótna). Atrapa `toBlob` liczy
 * rozmiar JPEG z liczby pikseli (0,15 B/px przy jakości 0,8). Prawdziwy
 * pomiar na zdjęciu jest w opisie PR, tu sprawdzamy drogę pliku.
 */

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  upload: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => mocks.router,
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/app/actions/expenses', () => ({
  getOcrJobStatusAction: mocks.getStatus,
  uploadExpensePhotoAction: mocks.upload,
}));

import { CaptureButton } from '@/components/expenses/capture-button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB_ID = '11111111-1111-4111-8111-111111111111';
/** Limit pliku w przeglądarce (1 MB dziesiętnie, `lib/upload-limit.ts`). */
const FILE_LIMIT = 1_000_000;
const MB = 1024 * 1024;

/** Atrapa kodera JPEG: rozmiar z pikseli płótna i jakości. */
let bytesPerPixel = (quality: number) => 0.15 * (quality / 0.8);
/** Podmiana odczytu pikseli (Firefox z ochroną przed fingerprintingiem). */
let readback: ((width: number, height: number) => Uint8ClampedArray) | null = null;

type Drawn = { canvas: HTMLCanvasElement; calls: string[] };
let drawn: Drawn[] = [];
let toBlobCalls: Array<{ type: string | undefined; quality: number | undefined; width: number; height: number }> = [];
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };

function hexToRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? 'ffffff';
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function fakeContext(canvas: HTMLCanvasElement) {
  const entry: Drawn = { canvas, calls: [] };
  drawn.push(entry);
  let fillStyle = '#000000';
  const pixels = new Map<string, [number, number, number]>();
  return {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    set imageSmoothingQuality(value: string) {
      entry.calls.push(`smoothing=${value}`);
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      entry.calls.push(`fillRect ${fillStyle} ${x},${y},${w},${h}`);
      if (w === 1 && h === 1) pixels.set(`${x},${y}`, hexToRgb(fillStyle));
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      if (readback) return { data: readback(w, h) };
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const [r, g, b] = pixels.get(`${x + col},${y + row}`) ?? [0, 0, 0];
          data.set([r, g, b, 255], (row * w + col) * 4);
        }
      }
      return { data };
    },
    drawImage: (_img: unknown, x: number, y: number, w: number, h: number) =>
      entry.calls.push(`drawImage ${x},${y},${w},${h}`),
  };
}

/** Płótno, na którym narysowano zdjęcie (pierwsze to sonda 4×1). */
function photoCanvas(): Drawn | undefined {
  return drawn.find((d) => d.calls.some((call) => call.startsWith('drawImage')));
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error ? <p data-granica>Granica błędu</p> : this.props.children;
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

// jsdom nie ma `URL.createObjectURL`, `img.decode()` ani `toBlob` — test je
// podstawia i oddaje po sobie.
const urlStatics = URL as unknown as Record<'createObjectURL' | 'revokeObjectURL', unknown>;
const imgProto = HTMLImageElement.prototype as unknown as Record<'decode', unknown>;
const canvasProto = HTMLCanvasElement.prototype as unknown as Record<'toBlob', unknown>;
const saved = {
  createObjectURL: urlStatics.createObjectURL,
  revokeObjectURL: urlStatics.revokeObjectURL,
  decode: imgProto.decode,
  toBlob: canvasProto.toBlob,
};

/** Zapas `<img>`: dekoduje (`ok`) albo odrzuca, z podanymi wymiarami. */
function imgFallback({ ok, width = 0, height = 0 }: { ok: boolean; width?: number; height?: number }) {
  const revoke = vi.fn();
  urlStatics.createObjectURL = vi.fn(() => 'blob:zdjecie');
  urlStatics.revokeObjectURL = revoke;
  imgProto.decode = ok
    ? vi.fn(async () => undefined)
    : vi.fn(async () => {
        throw new DOMException('decode', 'EncodingError');
      });
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(height);
  return { revoke };
}

beforeEach(() => {
  vi.resetAllMocks();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Wgranie się udaje, odczyt czeka — test kończy się przed odpytywaniem.
  mocks.upload.mockResolvedValue({ success: true, ocrJobId: JOB_ID });
  mocks.getStatus.mockReturnValue(new Promise(() => {}));

  drawn = [];
  toBlobCalls = [];
  readback = null;
  bytesPerPixel = (quality: number) => 0.15 * (quality / 0.8);
  bitmap = { width: 4000, height: 3000, close: vi.fn() };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return fakeContext(this) as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  canvasProto.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback, type?: string, quality?: number) {
    toBlobCalls.push({ type, quality, width: this.width, height: this.height });
    const size = Math.round(this.width * this.height * bytesPerPixel(quality ?? 0.92));
    setTimeout(() => callback(new Blob([new Uint8Array(size)], { type: type ?? 'image/png' })), 0);
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  urlStatics.createObjectURL = saved.createObjectURL;
  urlStatics.revokeObjectURL = saved.revokeObjectURL;
  imgProto.decode = saved.decode;
  canvasProto.toBlob = saved.toBlob;
  process.off('unhandledRejection', onUnhandled);
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Boundary>
        <CaptureButton />
      </Boundary>,
    );
  });
  return host;
}

/** Wybiera plik w polu aparatu albo galerii i czeka na koniec wgrywania. */
async function choose(file: File, field: 'camera' | 'gallery' = 'gallery') {
  const el = host ?? (await render());
  const inputs = el.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const input = field === 'camera' ? inputs[0]! : inputs[1]!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Dekodowanie i koder JPEG są asynchroniczne (atrapa `toBlob` odpowiada
  // w następnym takcie), więc dajemy przejściu kilka prawdziwych taktów.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function sentFile(): File {
  expect(mocks.upload).toHaveBeenCalledOnce();
  const form = mocks.upload.mock.calls[0]![0] as FormData;
  const photo = form.get('photo');
  expect(photo).toBeInstanceOf(File);
  return photo as File;
}

function photo(size: number, name = 'IMG_2041.JPG', type = 'image/jpeg') {
  return new File([new Uint8Array(size)], name, { type });
}

function boundaryShown() {
  return host!.querySelector('[data-granica]') !== null;
}

function onlyToast(): string {
  expect(mocks.toast.error).toHaveBeenCalledOnce();
  return String(mocks.toast.error.mock.calls[0]![0]);
}

describe('CaptureButton — zdjęcie zmniejszane przed wysłaniem (sesja 4)', () => {
  it('JPEG 4000×3000, 4 MB → do akcji trafia JPEG 2000×1500 poniżej limitu', async () => {
    const original = photo(4 * MB);
    await choose(original, 'camera');

    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(original, { imageOrientation: 'from-image' });
    expect(toBlobCalls).toEqual([{ type: 'image/jpeg', quality: 0.8, width: 2000, height: 1500 }]);
    expect(photoCanvas()!.calls).toContain('drawImage 0,0,2000,1500');
    expect(bitmap.close).toHaveBeenCalled();

    const sent = sentFile();
    expect(sent.type).toBe('image/jpeg');
    expect(sent.name).toBe('IMG_2041.jpg');
    expect(sent.size).toBeLessThan(FILE_LIMIT);
    expect(sent.size).toBeLessThan(original.size / 4);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('pionowe zdjęcie 3000×4000 → dłuższy bok 2000 px (1500×2000)', async () => {
    bitmap = { width: 3000, height: 4000, close: vi.fn() };
    await choose(photo(3 * MB));

    expect(toBlobCalls[0]).toMatchObject({ width: 1500, height: 2000 });
    expect(sentFile().size).toBeLessThan(FILE_LIMIT);
  });

  it('PNG z przezroczystością → białe tło pod obrazem, wynik JPEG', async () => {
    bitmap = { width: 2400, height: 1200, close: vi.fn() };
    await choose(photo(2 * MB, 'zrzut ekranu.png', 'image/png'));

    const calls = photoCanvas()!.calls;
    const fill = calls.indexOf('fillRect #ffffff 0,0,2000,1000');
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('drawImage 0,0,2000,1000')).toBeGreaterThan(fill);
    const sent = sentFile();
    expect(sent.type).toBe('image/jpeg');
    expect(sent.name).toBe('zrzut ekranu.jpg');
  });

  it('obraz mniejszy niż 2000 px nie jest powiększany', async () => {
    bitmap = { width: 1200, height: 900, close: vi.fn() };
    await choose(photo(1.5 * MB, 'skan.png', 'image/png'));

    expect(toBlobCalls[0]).toMatchObject({ width: 1200, height: 900 });
    expect(sentFile().type).toBe('image/jpeg');
  });

  it('zrzut przewijany 1080×10000 → krótszy bok nie spada do 216 px (442×4096)', async () => {
    bitmap = { width: 1080, height: 10000, close: vi.fn() };
    bytesPerPixel = () => 0.12;
    await choose(photo(3 * MB, 'e-paragon.png', 'image/png'));

    expect(toBlobCalls[0]).toMatchObject({ width: 442, height: 4096 });
    expect(sentFile().size).toBeLessThan(FILE_LIMIT);
  });

  it('JPEG mieszczący się w limicie idzie bez ponownego kodowania', async () => {
    const small = photo(400 * 1000, 'paragon.jpg');
    await choose(small);

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    expect(toBlobCalls).toEqual([]);
    expect(sentFile()).toBe(small);
  });

  it('PDF idzie bez zmian — bez dekodowania i bez płótna', async () => {
    const pdf = photo(300 * 1024, 'faktura.pdf', 'application/pdf');
    await choose(pdf);

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    expect(toBlobCalls).toEqual([]);
    expect(sentFile()).toBe(pdf);
  });

  it('HEIC odkodowany przez przeglądarkę idzie jako JPEG, nawet gdy JPEG jest większy', async () => {
    // Serwer HEIC odrzuca, więc „mniejszy oryginał” tu nie wygrywa.
    bitmap = { width: 1800, height: 1200, close: vi.fn() };
    const heic = photo(250 * 1000, 'IMG_0003.HEIC', 'image/heic');
    await choose(heic);

    const sent = sentFile();
    expect(sent.type).toBe('image/jpeg');
    expect(sent.name).toBe('IMG_0003.jpg');
    expect(sent.size).toBeGreaterThan(heic.size);
  });

  it('błąd dekodowania (np. HEIC w Chrome) → wysyłamy oryginał, jeśli mieści się w limicie', async () => {
    vi.mocked(globalThis.createImageBitmap).mockRejectedValue(new DOMException('decode', 'InvalidStateError'));
    const { revoke } = imgFallback({ ok: false });
    const heic = photo(600 * 1024, 'IMG_0001.HEIC', 'image/heic');
    await choose(heic);

    expect(sentFile()).toBe(heic);
    expect(toBlobCalls).toEqual([]);
    expect(revoke).toHaveBeenCalledWith('blob:zdjecie');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('zapas <img>: gdy createImageBitmap zawiedzie, obraz dekoduje element img', async () => {
    vi.mocked(globalThis.createImageBitmap).mockRejectedValue(new TypeError('imageOrientation'));
    const { revoke } = imgFallback({ ok: true, width: 4032, height: 3024 });

    await choose(photo(4 * MB));

    expect(toBlobCalls[0]).toMatchObject({ type: 'image/jpeg', width: 2000, height: 1500 });
    expect(sentFile().size).toBeLessThan(FILE_LIMIT);
    expect(revoke).toHaveBeenCalledWith('blob:zdjecie');
  });

  it('przeglądarka podmienia piksele płótna (Firefox z ochroną przed fingerprintingiem) → bez płótna, komunikat', async () => {
    // Firefox oddaje wtedy losowy wzór albo biel zamiast narysowanych pikseli.
    readback = (w, h) => new Uint8ClampedArray(w * h * 4).fill(255);
    await choose(photo(3 * MB));

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    expect(toBlobCalls).toEqual([]);
    expect(mocks.upload).not.toHaveBeenCalled();
    const message = onlyToast();
    expect(message).toContain('blokuje zmniejszanie');
    expect(message).toContain('3,2 MB');
  });

  it('drobny szum odczytu (Brave, Safari) nie wyłącza zmniejszania', async () => {
    readback = (w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0]].forEach(([r, g, b], x) => data.set([r! - 3, g! + 2, b! + 1, 255], x * 4));
      return data;
    };
    await choose(photo(4 * MB));

    expect(toBlobCalls).toHaveLength(1);
    expect(sentFile().size).toBeLessThan(FILE_LIMIT);
  });

  it('JPEG 0,8 tuż ponad limitem (1,02 MB) → druga próba z jakością 0,6', async () => {
    bytesPerPixel = (quality: number) => (quality >= 0.8 ? 0.34 : 0.2);
    await choose(photo(5 * MB));

    expect(toBlobCalls.map((call) => call.quality)).toEqual([0.8, 0.6]);
    const sent = sentFile();
    expect(sent.size).toBeLessThan(FILE_LIMIT);
    expect(sent.type).toBe('image/jpeg');
  });

  it('JPEG większy od oryginału PNG ponad limitem → zostaje oryginał i komunikat', async () => {
    bitmap = { width: 2000, height: 1500, close: vi.fn() };
    bytesPerPixel = () => 0.5;
    await choose(photo(1_100_000, 'wykres.png', 'image/png'));

    expect(toBlobCalls.map((call) => call.quality)).toEqual([0.8, 0.6]);
    expect(mocks.upload).not.toHaveBeenCalled();
    const message = onlyToast();
    expect(message).toContain('Zdjęcie (1,1 MB) nawet po zmniejszeniu');
    expect(message).not.toContain('przeglądark');
  });

  it('zdjęcie zmniejszone, ale nadal ponad limitem → komunikat z rozmiarem wybranego pliku', async () => {
    bytesPerPixel = () => 0.45;
    await choose(photo(6 * MB));

    expect(toBlobCalls.map((call) => call.quality)).toEqual([0.8, 0.6]);
    expect(mocks.upload).not.toHaveBeenCalled();
    const message = onlyToast();
    expect(message).toContain('Zdjęcie (6,3 MB) nawet po zmniejszeniu');
    expect(message).not.toContain('przeglądark');
  });

  it('PDF 2 MB → komunikat o limicie, akcja niewołana, przycisk wolny', async () => {
    await choose(photo(2 * MB, 'skan.pdf', 'application/pdf'));

    expect(mocks.upload).not.toHaveBeenCalled();
    const message = onlyToast();
    expect(message).toContain('PDF ma 2,1 MB');
    expect(message).toContain('najwyżej 1 MB');
    expect(host!.querySelector('button')!.textContent).toContain('Dodaj wydatek');
  });

  it('PDF tuż ponad limitem → rozmiar w komunikacie nie wygląda na mieszczący się', async () => {
    await choose(photo(FILE_LIMIT + 1, 'skan.pdf', 'application/pdf'));

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onlyToast()).toContain('PDF ma 1,1 MB');
  });

  it('zdjęcie, którego nie da się odkodować, ponad limit → „zapisz jako JPG”, akcja niewołana', async () => {
    vi.mocked(globalThis.createImageBitmap).mockRejectedValue(new DOMException('decode', 'InvalidStateError'));
    imgFallback({ ok: false });
    await choose(photo(3 * MB, 'IMG_0002.HEIC', 'image/heic'));

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onlyToast()).toContain('JPG');
  });

  it('akcja odrzuca obietnicę (413 od Next) → toast, nie granica błędu strony', async () => {
    mocks.upload.mockRejectedValue(new Error('Body exceeded 1 MB limit.'));
    await choose(photo(4 * MB));

    expect(boundaryShown()).toBe(false);
    const message = onlyToast();
    expect(message).not.toContain('Body exceeded');
    expect(message).toMatch(/Nie udało się wysłać/);
    expect(host!.querySelector('button')!.textContent).toContain('Dodaj wydatek');
    expect(unhandled).toEqual([]);
  });

  it('strona sprzed wdrożenia (nieznana akcja) → prośba o odświeżenie strony', async () => {
    mocks.upload.mockRejectedValue(new UnrecognizedActionError('Server Action "abc" was not found on the server.'));
    await choose(photo(300 * 1000, 'paragon.jpg'));

    expect(boundaryShown()).toBe(false);
    expect(onlyToast()).toMatch(/Odśwież stronę/);
  });

  it('arkusz nie obiecuje już 10 MB', async () => {
    const el = await render();
    await act(async () => {
      el.querySelector('button')!.click();
    });
    expect(document.body.textContent).toContain('Zrób zdjęcie');
    expect(document.body.textContent).toContain('PDF do 1 MB');
    expect(document.body.textContent).not.toContain('10 MB');
  });
});
