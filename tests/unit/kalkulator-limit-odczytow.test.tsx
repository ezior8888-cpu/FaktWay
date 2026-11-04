// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MONTHLY_PRICE_GROSS_GROSZE } from '@/lib/billing/pricing';

/**
 * Recenzja PR #355: kalkulator liczył każdy dokument jako 1,5 min „z odczytem
 * ze zdjęcia” przy suwaku do 200 miesięcznie, a odczyt ma twardy limit 3 zł na
 * firmę miesięcznie, czyli około 55 rozpoznań (lib/ai/tenant-ai-budget.ts).
 * Po wyczerpaniu limitu dane wpisuje się ręcznie, więc oszczędności z odczytu
 * nie ma. Przy 200 dokumentach strona pokazywała blisko 4 razy za dużo.
 */

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SavingsCalculatorPreview } = await import('@/components/marketing/savings-calculator-preview');

const ABONAMENT_ROCZNIE = (MONTHLY_PRICE_GROSS_GROSZE * 12) / 100;
const STAWKA = 150;
/** Oszczędność na dokumencie: 8 min ręcznie minus 1,5 min z odczytem. */
const MINUT_OSZCZEDNOSCI = 6.5;

const zyskDla = (dokumentyZOdczytem: number) =>
  Math.round(((dokumentyZOdczytem * 12 * MINUT_OSZCZEDNOSCI) / 60) * STAWKA - ABONAMENT_ROCZNIE);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function pokaz(dokumentyMiesiecznie: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SavingsCalculatorPreview />));

  const suwak = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const ustawiacz = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    ustawiacz.call(suwak, String(dokumentyMiesiecznie));
    suwak.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const etykieta = [...host.querySelectorAll('p')].find((p) => p.textContent === 'Zysk netto rocznie')!;
  const zysk = Number.parseInt((etykieta.nextElementSibling!.textContent ?? '').replace(/\D/g, ''), 10);
  return { zysk, tekst: host.textContent ?? '' };
}

describe('kalkulator oszczędności: limit odczytów ze zdjęcia', () => {
  it('do limitu liczy każdy dokument z odczytem', () => {
    expect(pokaz(20).zysk).toBe(zyskDla(20));
  });

  it('ponad limit miesięczny (55) nie dolicza oszczędności z odczytu', () => {
    // Przy 200 dokumentach wynik jest taki sam jak przy 55: reszta idzie ręcznie.
    expect(pokaz(200).zysk).toBe(zyskDla(55));
  });

  it('stopka podaje limit odczytów', () => {
    expect(pokaz(20).tekst).toMatch(/limit[^.]*55 dokumentów miesięcznie/);
  });
});
