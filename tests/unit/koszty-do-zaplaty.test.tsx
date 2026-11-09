import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4 planu kompletnej aplikacji, część 1: lista „Do zapłaty” w Wydatkach.
 * Niezapłacone koszty z terminem, od najbliższego terminu, z sumą,
 * przeterminowane wyróżnione; przy koszcie rachunek, kwota i gotowy tytuł
 * przelewu z numerem KSeF (funkcja z kroku 1.4), przy MPP sam numer KSeF.
 *
 * Prawdziwe: `listaDoZaplaty`, `tytulPrzelewu`, widok `KosztyDoZaplaty`.
 * Zastąpione: akcje serwerowe (zapłata, biała lista), router i toasty.
 */

vi.mock('@/app/actions/expense-payments', () => ({
  markExpensePaidAction: vi.fn(),
  undoExpensePaidAction: vi.fn(),
}));
vi.mock('@/app/actions/validation', () => ({ validateBankAccountAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NIP = '1234567890';
const ksef = (n: number) => `${NIP}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const DZIS = '2026-11-09';
/** Kwoty po polsku mają twardą spację w tysiącach; testy porównują zwykłą. */
const norm = (html: string) => html.replace(/\u00a0/g, ' ');

type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

function wiersz(n: number, pola: Partial<Wiersz> = {}): Wiersz {
  return {
    id: `exp-${n}`,
    seller_name: `Dostawca ${n} sp. z o.o.`,
    seller_nip: NIP,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: '2026-11-20',
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(n), internal_number: `FV/${n}/11/2026`, currency: 'PLN' },
    ...pola,
  };
}

describe('lista „Do zapłaty”', () => {
  it('od najbliższego terminu, z sumą; przeterminowane osobno; termin dziś nie jest po terminie', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const lista = listaDoZaplaty([
      wiersz(1, { payment_due_date: '2026-11-20', gross_amount: 1000 }),
      wiersz(2, { payment_due_date: '2026-11-05', gross_amount: '200.10' }),
      wiersz(3, { payment_due_date: DZIS, gross_amount: 300.2 }),
    ], DZIS);

    expect(lista.pozycje.map((p) => p.id)).toEqual(['exp-2', 'exp-3', 'exp-1']);
    expect(lista.pozycje.map((p) => p.dniDoTerminu)).toEqual([-4, 0, 11]);
    expect(lista.pozycje.map((p) => p.przeterminowany)).toEqual([true, false, false]);
    expect(lista.suma).toBe(1500.3);
    expect(lista.przeterminowane).toEqual({ liczba: 1, suma: 200.1 });
  });

  it('pomija zapłacone, bez terminu, korekty na minus; koszty poza złotymi liczy osobno, bez sumy', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const lista = listaDoZaplaty([
      wiersz(1),
      wiersz(2, { paid_at: '2026-11-08' }),
      wiersz(3, { payment_due_date: null }),
      wiersz(4, { gross_amount: -123 }),
      wiersz(5, { faktura: { ksef_number: ksef(5), internal_number: 'INV-5', currency: 'EUR' } }),
      wiersz(6, { faktura: null }),
    ], DZIS);

    expect(lista.pozycje.map((p) => p.id)).toEqual(['exp-1']);
    expect(lista.suma).toBe(1230);
    expect(lista.pominiete).toBe(2);
  });

  it('tytuł przelewu: numer KSeF i numer faktury; przy MPP sam numer KSeF z kwotą VAT do komunikatu', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const [zwykly, mpp] = listaDoZaplaty([
      wiersz(1),
      wiersz(2, { payment_due_date: '2026-11-21', payment_split: true, gross_amount: 24600, vat_amount: 4600 }),
    ], DZIS).pozycje;

    expect(zwykly!.tytul).toBe(`${ksef(1)} FV/1/11/2026`);
    expect(mpp!.tytul).toBe(ksef(2));
    expect(mpp!).toMatchObject({ mpp: true, vat: 4600, numerKsef: ksef(2) });
  });

  it('biała lista: sprawdzenie od kwoty ponad 15 000 zł brutto (15 000,00 zł jeszcze nie)', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const lista = listaDoZaplaty([
      wiersz(1, { gross_amount: 15000 }),
      wiersz(2, { gross_amount: 15000.01 }),
    ], DZIS);
    // Ten sam termin: najpierw wyższa kwota.
    expect(lista.pozycje.map((p) => [p.id, p.wymagaBialejListy])).toEqual([['exp-2', true], ['exp-1', false]]);
  });

  it('uwagi przy brakach: rachunek, MPP nieznane, kilka terminów, faktor, wpłata częściowa, problemy odczytu', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const [p] = listaDoZaplaty([
      wiersz(1, {
        payment_account: null,
        payment_split: null,
        payment_terms: {
          zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 3,
          rachunekFaktora: '12102010260000150201234567', zaplaconoCzesciowo: 230, problemy: ['P_18A „3”'],
        },
      }),
    ], DZIS).pozycje;

    expect(p!.kwota).toBe(1000);
    const uwagi = p!.uwagi.join('\n');
    expect(uwagi).toMatch(/nie podaje rachunku/);
    expect(uwagi).toMatch(/podzielona płatność \(MPP\)/);
    expect(uwagi).toMatch(/3 terminy/);
    expect(uwagi).toMatch(/rachunek faktora/);
    expect(uwagi).toMatch(/wpłaty częściowe/);
    expect(uwagi).toMatch(/nie dało się odczytać/);
    expect(uwagi).not.toMatch(/[—–]/);
  });
});

describe('ekran „Do zapłaty”', () => {
  it('suma, wyróżnione „po terminie”, przyciski kopiowania i sprawdzenie rachunku przy kwocie ponad 15 000 zł', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const { KosztyDoZaplaty } = await import('@/components/expenses/do-zaplaty/koszty-do-zaplaty');
    const lista = listaDoZaplaty([
      wiersz(1, { payment_due_date: '2026-11-05', gross_amount: 20000, vat_amount: 3739.84 }),
      wiersz(2),
    ], DZIS);

    const html = norm(renderToStaticMarkup(<KosztyDoZaplaty lista={lista} dzis={DZIS} mozeOznaczac />));

    expect(html).toContain('Razem do zapłaty');
    expect(html).toContain('21 230,00 zł');
    expect(html).toMatch(/Po terminie: 1/);
    expect(html.indexOf('Dostawca 1')).toBeLessThan(html.indexOf('Dostawca 2'));
    expect(html).toMatch(/data-przeterminowany="true"[^>]*>[\s\S]*Dostawca 1/);
    expect(html).toContain('Kopiuj numer rachunku');
    expect(html).toContain('Kopiuj kwotę');
    expect(html).toContain('Kopiuj tytuł przelewu');
    expect(html).toContain(`${ksef(2)} FV/2/11/2026`);
    expect(html.match(/Sprawdź rachunek w wykazie/g)).toHaveLength(1);
    expect(html).toContain('Oznacz jako zapłacone');
    expect(html).toContain(`max="${DZIS}"`);
    expect(html).not.toMatch(/[—–]/);
  });

  it('pusty stan i koszty poza złotymi z wyjściem (gdzie sprawdzić kwotę)', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const { KosztyDoZaplaty } = await import('@/components/expenses/do-zaplaty/koszty-do-zaplaty');
    const lista = listaDoZaplaty([
      wiersz(5, { faktura: { ksef_number: ksef(5), internal_number: 'INV-5', currency: 'EUR' } }),
    ], DZIS);

    const html = norm(renderToStaticMarkup(<KosztyDoZaplaty lista={lista} dzis={DZIS} mozeOznaczac />));

    expect(html).toContain('Nie ma kosztów do zapłaty z terminem');
    expect(html).toMatch(/1 koszt w walucie obcej/);
    expect(html).toMatch(/sprawdź w fakturze/);
  });

  it('księgowa (bez prawa zmiany) widzi dane do przelewu, ale nie przycisk zapłaty', async () => {
    const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
    const { KosztyDoZaplaty } = await import('@/components/expenses/do-zaplaty/koszty-do-zaplaty');
    const html = renderToStaticMarkup(
      <KosztyDoZaplaty lista={listaDoZaplaty([wiersz(1)], DZIS)} dzis={DZIS} mozeOznaczac={false} />,
    );
    expect(html).toContain('Kopiuj tytuł przelewu');
    expect(html).not.toContain('Oznacz jako zapłacone');
  });
});
