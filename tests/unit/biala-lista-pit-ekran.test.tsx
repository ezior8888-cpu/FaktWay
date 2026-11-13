// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RP-BL-01 na ekranie „Do zapłaty” i na karcie kosztu (krok 3.4): po
 * „Sprawdź rachunek w wykazie” z odpowiedzią „poza wykazem” ostrzeżenie mówi
 * o koszcie w PIT tylko przy fakturze wystawionej przed 1.01.2027 (art. 22p
 * ustawy o PIT po zmianie z Dz.U. 2026 poz. 1371, art. 1 pkt 2 i art. 3).
 * Solidarna odpowiedzialność za VAT i ZAW-NR zostają przy każdej fakturze.
 *
 * Prawdziwe: lista (`listaDoZaplaty`) i blok `DanePrzelewu` z kliknięciem.
 * Atrapy: akcje serwerowe (sprawdzenie w wykazie, zapłata), router i toasty.
 */

const walidacja = vi.hoisted(() => ({ validateBankAccountAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => walidacja);
vi.mock('@/app/actions/expense-payments', () => ({ markExpensePaidAction: vi.fn(), undoExpensePaidAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { DanePrzelewu } = await import('@/components/expenses/do-zaplaty/dane-przelewu');
const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

const NIP = '1234567890';
const DZIS = '2027-01-15';

function wiersz(p1: string, pola: Partial<Wiersz> = {}): Wiersz {
  return {
    id: 'exp-1',
    seller_name: 'Dostawca sp. z o.o.',
    seller_nip: NIP,
    document_number: 'FV/12/2026',
    gross_amount: 20000,
    vat_amount: 3739.84,
    payment_due_date: '2027-01-20',
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2027-01-02T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    issue_date: p1,
    faktura: { ksef_number: `${NIP}-20261231-0A1B2C3D4E01-7A`, internal_number: 'FV/12/2026', currency: 'PLN', issue_date: p1 },
    ...pola,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  walidacja.validateBankAccountAction.mockResolvedValue({ success: true, isOnWhitelist: false, checkedOn: DZIS });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** Blok danych do przelewu po sprawdzeniu rachunku: tekst ostrzeżenia „poza wykazem”. */
async function ostrzezeniePozaWykazem(w: Wiersz): Promise<string> {
  const [koszt] = listaDoZaplaty([w], DZIS).pozycje;
  expect(koszt?.wymagaBialejListy).toBe(true);
  await act(async () => root.render(<DanePrzelewu koszt={koszt!} dzis={DZIS} mozeOznaczac={false} />));
  const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Sprawdź rachunek w wykazie'));
  expect(przycisk).toBeDefined();
  await act(async () => przycisk!.click());
  const znajdz = () =>
    [...container.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes('Tego rachunku nie ma w wykazie'));
  for (let i = 0; i < 10 && !znajdz(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(walidacja.validateBankAccountAction).toHaveBeenCalledWith(NIP, 'PL61109010140000071219812874');
  const alert = znajdz();
  expect(alert).toBeDefined();
  return (alert!.textContent ?? '').replace(/ /g, ' ');
}

describe('ostrzeżenie „poza wykazem” według dnia wystawienia faktury', () => {
  it('faktura z 31.12.2026 płacona w 2027: tej kwoty nie zaliczysz do kosztów w PIT, VAT i ZAW-NR', async () => {
    const tekst = await ostrzezeniePozaWykazem(wiersz('2026-12-31'));
    expect(tekst).toContain('tej kwoty nie zaliczysz do kosztów w PIT');
    expect(tekst).toContain('odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę');
    expect(tekst).toContain('(formularz ZAW-NR)');
  });

  it('faktura z 1.01.2027: bez zdania o PIT, VAT i ZAW-NR zostają', async () => {
    const tekst = await ostrzezeniePozaWykazem(wiersz('2027-01-01'));
    expect(tekst).not.toContain('PIT');
    expect(tekst).not.toContain('kosztów');
    expect(tekst).toContain('odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę');
    expect(tekst).toContain('w ciągu 7 dni od zlecenia przelewu');
    expect(tekst).toContain('(formularz ZAW-NR)');
  });

  it('P_1 z 31.12.2026, a data kosztu poprawiona na 2.01.2027: dawne ostrzeżenie (liczy się P_1)', async () => {
    const tekst = await ostrzezeniePozaWykazem(wiersz('2026-12-31', { issue_date: '2027-01-02' }));
    expect(tekst).toContain('tej kwoty nie zaliczysz do kosztów w PIT');
  });
});
