import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ścieżka paragonu z telefonu (krok 22 toru B).
 *
 * Klient udostępnia zdjęcie i ląduje w wątku agenta. Sprawdzamy, co zastaje
 * w każdym z czterech przypadków — bo to te kilkanaście sekund decyduje, czy
 * skorzysta z tej drogi drugi raz.
 */

let search = new URLSearchParams();

// Jeden obiekt routera na cały test, jak w Next: nowy obiekt w każdym
// renderze restartowałby odpytywanie i test mierzyłby atrapę, nie pasek.
const router = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: () => {},
  replace: () => {},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => search,
}));

const { FloPhotoBanner, photoBannerMessage, photoBannerResult, strongerPhotoBannerResult } =
  await import('@/components/flo/flo-photo-banner');

const FAILED_SENTENCE = 'Nie odczytałem tego paragonu';

type PhotoResult = ReturnType<typeof photoBannerResult>;

function render(
  params: string,
  failedOcrJobIds?: string[],
  readOcrJobIds?: string[],
) {
  search = new URLSearchParams(params);
  return renderToStaticMarkup(
    <FloPhotoBanner
      readOcrJobIds={readOcrJobIds}
      failedOcrJobIds={failedOcrJobIds}
    />,
  );
}

afterEach(() => {
  search = new URLSearchParams();
  router.refresh.mockClear();
});

describe('FloPhotoBanner', () => {
  it('bez zdjęcia w adresie nie ma paska', () => {
    expect(render('')).toBe('');
  });

  it('po udostępnieniu zdjęcia mówi, że je ma i czyta', () => {
    const html = render('paragon=job-1');

    expect(html).toContain('Mam Twoje zdjęcie');
    expect(html).toContain('Czytam paragon');
  });

  it('gdy zdjęcie nie doszło, proponuje wyjście zamiast samego błędu', () => {
    const html = render('paragon=blad');

    expect(html).toContain('Nic nie zginęło');
    expect(html).toContain('Wydatkach');
  });

  it('pusty plik dostaje własne zdanie, nie ogólne „coś poszło nie tak”', () => {
    expect(render('paragon=brak-zdjecia')).toContain('Nie dostałem zdjęcia');
  });

  it('porażkę odczytu mówi wprost i nie twierdzi, że paragon odczytano', () => {
    const html = render('paragon=job-1', ['job-1']);

    expect(html).toContain(FAILED_SENTENCE);
    // Zdjęcie jest bezpieczne, a droga wyjścia czeka w karcie silnika.
    expect(html).toContain('Zdjęcie zostało w archiwum, nic nie przepadło');
    expect(html).toContain('w karcie poniżej');
    expect(html).not.toContain('odczytany');
    expect(html).not.toContain('Mam Twoje zdjęcie');
  });

  it('porażka innego zdjęcia nie dotyczy paragonu z adresu', () => {
    const html = render('paragon=job-1', ['job-2']);

    expect(html).toContain('Mam Twoje zdjęcie');
    expect(html).not.toContain(FAILED_SENTENCE);
  });

  it('karta kosztu tego zadania: już przy pierwszym renderze „odczytany”, bez migania', () => {
    // Bez zegara ten sam wynik na serwerze i w przeglądarce.
    expect(render('paragon=job-1', [], ['job-1'])).toContain('Paragon odczytany');
  });

  it('koszt z innego zdjęcia nie znaczy, że odczytano ten paragon', () => {
    const html = render('paragon=job-1', [], ['job-2']);

    expect(html).toContain('Mam Twoje zdjęcie');
    expect(html).not.toContain('Paragon odczytany');
  });

  it('mówi spokojnym tonem, bez wykrzykników i bez słowa „błąd”', () => {
    const cases: Array<[string, string[]]> = [
      ['paragon=job-1', []],
      ['paragon=blad', []],
      ['paragon=brak-zdjecia', []],
      ['paragon=job-1', ['job-1']],
    ];
    for (const [params, failed] of cases) {
      const html = render(params, failed);
      expect(html).not.toContain('!');
      expect(html).not.toMatch(/błąd|awaria/i);
    }

    // Zdania, które pojawiają się dopiero po zamontowaniu (czas), też.
    for (const result of ['failed', 'read', null] as const) {
      for (const slow of [false, true]) {
        const message = photoBannerMessage({ paragon: 'job-1', result, slow });
        expect(message).not.toContain('!');
        expect(message).not.toMatch(/błąd|awaria/i);
      }
    }
  });
});

describe('FloPhotoBanner — wybór zdania', () => {
  it('porażka tego zadania', () => {
    expect(
      photoBannerResult({ paragon: 'job-1', failedOcrJobIds: ['job-1'], readOcrJobIds: [] }),
    ).toBe('failed');
  });

  it('porażka wygrywa z kartą kosztu tego samego zadania (wyścig dwóch przebiegów)', () => {
    expect(
      photoBannerResult({ paragon: 'job-1', failedOcrJobIds: ['job-1'], readOcrJobIds: ['job-1'] }),
    ).toBe('failed');
  });

  it('karta kosztu tego zadania to odczyt udany', () => {
    expect(
      photoBannerResult({ paragon: 'job-1', failedOcrJobIds: ['job-2'], readOcrJobIds: ['job-1'] }),
    ).toBe('read');
  });

  it('karty innych zadań nie mówią nic o tym paragonie', () => {
    expect(
      photoBannerResult({ paragon: 'job-1', failedOcrJobIds: ['job-2'], readOcrJobIds: ['job-3'] }),
    ).toBeNull();
  });

  it('mocniejszy wynik: porażka > odczyt > brak, niezależnie od kolejności', () => {
    const cases: Array<[PhotoResult, PhotoResult, PhotoResult]> = [
      [null, null, null],
      [null, 'read', 'read'],
      ['read', null, 'read'],
      ['read', 'failed', 'failed'],
      ['failed', 'read', 'failed'],
      ['failed', null, 'failed'],
      [null, 'failed', 'failed'],
    ];
    for (const [a, b, expected] of cases) {
      expect(strongerPhotoBannerResult(a, b)).toBe(expected);
    }
  });

  it('porażka ma pierwszeństwo przed „dłużej niż zwykle”', () => {
    const message = photoBannerMessage({
      paragon: 'job-1',
      result: 'failed',
      slow: true,
    });

    expect(message).toContain(FAILED_SENTENCE);
    expect(message).not.toContain('dłużej niż zwykle');
  });

  it('odczyt udany ma pierwszeństwo przed „dłużej niż zwykle”', () => {
    expect(
      photoBannerMessage({ paragon: 'job-1', result: 'read', slow: true }),
    ).toContain('Paragon odczytany');
  });

  it('bez wyniku po trzech minutach mówi, że trwa to dłużej', () => {
    expect(
      photoBannerMessage({ paragon: 'job-1', result: null, slow: true }),
    ).toContain('dłużej niż zwykle');
  });
});

describe('FloPhotoBanner — odpytywanie w przeglądarce', () => {
  // Prawdziwe renderowanie z efektami: odpytywanie żyje w `useEffect`, więc
  // render serwerowy go nie widzi.
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  function mount(props: {
    readOcrJobIds?: string[];
    failedOcrJobIds?: string[];
  }) {
    act(() =>
      root.render(
        <FloPhotoBanner
          readOcrJobIds={props.readOcrJobIds}
          failedOcrJobIds={props.failedOcrJobIds}
        />,
      ),
    );
  }

  function advance(ms: number) {
    act(() => vi.advanceTimersByTime(ms));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://app.example.test/flo?paragon=job-1',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    search = new URLSearchParams('paragon=job-1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('bez wyniku odświeża wątek co 15 s', () => {
    mount({});
    advance(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    advance(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('po porażce nie odświeża i mówi o niej wprost', () => {
    mount({ failedOcrJobIds: ['job-1'] });
    advance(60_000);

    expect(router.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain(FAILED_SENTENCE);
  });

  it('po odczycie TEGO paragonu nie odświeża i nie mówi „dłużej niż zwykle”', () => {
    mount({ readOcrJobIds: ['job-1'] });
    advance(10 * 60_000);

    expect(router.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(container.textContent).toContain('Paragon odczytany');
    expect(container.textContent).not.toContain('dłużej niż zwykle');
  });

  it('koszt z innego zdjęcia: czyta dalej, odświeża, po trzech minutach mówi „dłużej niż zwykle”', () => {
    mount({ readOcrJobIds: ['job-2'] });
    expect(container.textContent).toContain('Czytam paragon');

    advance(10 * 60_000);
    // Co 15 s do trzeciej minuty włącznie.
    expect(router.refresh).toHaveBeenCalledTimes(12);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.textContent).not.toContain('Paragon odczytany');
    expect(container.textContent).toContain('dłużej niż zwykle');
  });

  it('gdy karta kosztu dojdzie w trakcie, odświeżanie staje', () => {
    mount({});
    advance(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    mount({ readOcrJobIds: ['job-1'] });
    advance(60_000);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.textContent).toContain('Paragon odczytany');
  });

  it('zamknięta karta porażki nie cofa paska do „czytam” ani nie wznawia odświeżania', () => {
    mount({ failedOcrJobIds: ['job-1'] });
    expect(container.textContent).toContain(FAILED_SENTENCE);

    // Klient zamknął kartę „Nie odczytałem” — wątek jej już nie zawiera.
    mount({});
    advance(60_000);

    expect(router.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(container.textContent).toContain(FAILED_SENTENCE);
  });

  it('potwierdzony koszt znika z wątku, a pasek dalej mówi „odczytany”', () => {
    mount({ readOcrJobIds: ['job-1'] });
    mount({});
    expect(container.textContent).toContain('Paragon odczytany');
    expect(container.textContent).not.toContain('Czytam paragon');
  });

  it('inny paragon w adresie zaczyna od zera', () => {
    mount({ failedOcrJobIds: ['job-1'] });
    expect(container.textContent).toContain(FAILED_SENTENCE);

    search = new URLSearchParams('paragon=job-2');
    mount({ failedOcrJobIds: ['job-1'] });
    expect(container.textContent).not.toContain(FAILED_SENTENCE);
    expect(container.textContent).toContain('Czytam paragon');

    advance(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('gdy karta porażki dojdzie w trakcie, odświeżanie staje', () => {
    mount({});
    advance(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    mount({ failedOcrJobIds: ['job-1'] });
    advance(60_000);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.textContent).toContain(FAILED_SENTENCE);
  });
});
