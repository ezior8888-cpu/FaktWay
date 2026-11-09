// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Formularz „Zapłata spoza wyliczenia” w „Ten miesiąc” (plan księgowości JDG,
 * K7.2, D15). Uwaga ze sprawdzenia w przeglądarce 8.11.2026: pole miesiąca
 * pozwalało wybrać bieżący miesiąc, a akcja go odrzucała dopiero po
 * wysłaniu. Pole i formularz trzymają teraz te same granice co akcja: od
 * stycznia 2025 r. do poprzedniego miesiąca, data zapłaty najpóźniej dziś.
 * Atrapa tylko dla akcji serwerowej (jej reguły sprawdza
 * `tests/unit/ksiegowosc-ten-miesiac-akcje.test.ts`).
 */

const mocks = vi.hoisted(() => ({ akcja: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/ksiegowosc-ten-miesiac', () => ({
  dodajZaplateRecznaAction: mocks.akcja,
  oznaczZaplaconeAction: vi.fn(),
  zatwierdzMiesiacAction: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ZaplataReczna } = await import('@/components/ksiegowosc/ten-miesiac-akcje');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.akcja.mockReset();
  mocks.akcja.mockResolvedValue({ success: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ZaplataReczna domyslnyMiesiac="2026-10" domyslnaData="2026-10-31" dzis="2026-11-07" />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

const pole = (id: string) => document.getElementById(id) as HTMLInputElement;

async function wpisz(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function zapisz() {
  const przycisk = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Zapisz zapłatę'))!;
  await act(async () => {
    przycisk.click();
    await new Promise((r) => setTimeout(r, 10));
  });
}

async function wypelnijKwoty() {
  await wpisz(pole('zaplata-kwota'), '1 000,00');
  await wpisz(pole('zaplata-bez-fp'), '900,00');
}

describe('zapłata spoza wyliczenia: granice pola miesiąca jak w akcji', () => {
  it('pole miesiąca od stycznia 2025 r. do poprzedniego miesiąca, data najpóźniej dziś', () => {
    expect(pole('zaplata-za-miesiac').min).toBe('2025-01');
    expect(pole('zaplata-za-miesiac').max).toBe('2026-10');
    expect(pole('zaplata-data').max).toBe('2026-11-07');
  });

  it('bieżący miesiąc wpisany ręcznie: komunikat przy polu bez wysyłki do serwera', async () => {
    await wpisz(pole('zaplata-za-miesiac'), '2026-11');
    await wpisz(pole('zaplata-data'), '2026-11-07');
    await wypelnijKwoty();
    await zapisz();
    expect(mocks.akcja).not.toHaveBeenCalled();
    expect(document.getElementById('zaplata-blad-zaMiesiac')?.textContent).toBe('Składki za miesiąc w trakcie zapisuje się po jego zakończeniu.');
  });

  it('data zapłaty z przyszłości wpisana ręcznie: komunikat przy polu bez wysyłki do serwera', async () => {
    await wpisz(pole('zaplata-data'), '2026-11-08');
    await wypelnijKwoty();
    await zapisz();
    expect(mocks.akcja).not.toHaveBeenCalled();
    expect(document.getElementById('zaplata-blad-dataZaplaty')?.textContent).toBe('Data zapłaty nie może być późniejsza niż dziś.');
  });

  it('poprzedni miesiąc: zapłata idzie do akcji', async () => {
    await wypelnijKwoty();
    await zapisz();
    expect(mocks.akcja).toHaveBeenCalledWith({ zaMiesiac: '2026-10', rodzaj: 'zus_spoleczne', kwota: '1 000,00', bezFp: '900,00', dataZaplaty: '2026-10-31' });
  });
});

describe('granice z jednej reguły dla pola, formularza i akcji', () => {
  it('w styczniu ostatni okres to grudzień poprzedniego roku (zapłata za grudzień 2025 r. w styczniu 2026 r.)', async () => {
    const { bladDatyZaplatyRecznej, ostatniMiesiacZaplatyRecznej } = await import('@/lib/ksiegowosc/zaplata-reczna');
    expect(ostatniMiesiacZaplatyRecznej('2026-01-15')).toBe('2025-12');
    expect(bladDatyZaplatyRecznej({ zaMiesiac: '2025-12', dataZaplaty: '2026-01-15' }, '2026-01-15')).toBeNull();
    expect(bladDatyZaplatyRecznej({ zaMiesiac: '2026-01', dataZaplaty: '2026-01-15' }, '2026-01-15')).toMatchObject({ pole: 'zaMiesiac' });
    expect(bladDatyZaplatyRecznej({ zaMiesiac: '2025-12', dataZaplaty: '2026-01-16' }, '2026-01-15')).toMatchObject({ pole: 'dataZaplaty' });
  });
});
