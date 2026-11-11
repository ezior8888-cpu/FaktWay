import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4, część 2: na liście „Do zapłaty” wybór kosztów i „Pobierz plik
 * przelewów”, potem podsumowanie z pominięciami i ich powodami.
 * Decyzja D1: nowy blok i pola wyboru z istniejących komponentów (przycisk,
 * pole wyboru, alert) na liście z części 1; nic nie jest przestawione.
 *
 * Prawdziwe: lista (`listaDoZaplaty`), widok `KosztyDoZaplaty`, podsumowanie.
 * Zastąpione: akcje serwerowe, router i toasty.
 */

vi.mock('@/app/actions/expense-payments', () => ({ markExpensePaidAction: vi.fn(), undoExpensePaidAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => ({ validateBankAccountAction: vi.fn() }));
vi.mock('@/app/actions/plik-przelewow', () => ({ pobierzPlikPrzelewowAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NIP = '1234567890';
const ksef = (n: number) => `${NIP}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const DZIS = '2026-11-10';
const RACHUNEK_FIRMY = '45105010380000000000001234';
const norm = (html: string) => html.replace(/ /g, ' ');

type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

function wiersz(n: number): Wiersz {
  return {
    id: `exp-${n}`,
    seller_name: `Dostawca ${n} sp. z o.o.`,
    seller_nip: NIP,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: '2026-11-20',
    payment_account: 'PL58109010140000000000004321',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(n), internal_number: `FV/${n}/11/2026`, currency: 'PLN' },
  };
}

async function ekran(props: { mozeOznaczac: boolean; rachunekFirmy?: string | null }) {
  const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
  const { KosztyDoZaplaty } = await import('@/components/expenses/do-zaplaty/koszty-do-zaplaty');
  return norm(renderToStaticMarkup(
    <KosztyDoZaplaty lista={listaDoZaplaty([wiersz(1), wiersz(2)], DZIS)} dzis={DZIS} {...props} />,
  ));
}

describe('lista „Do zapłaty”: plik przelewów', () => {
  it('wybór kosztów i przycisk pobrania; pobranie nie oznacza zapłaty', async () => {
    const html = await ekran({ mozeOznaczac: true, rachunekFirmy: RACHUNEK_FIRMY });

    expect(html).toContain('Plik przelewów do banku');
    expect(html).toMatch(/Pobierz plik przelewów/);
    expect(html).toContain('Zaznacz wszystkie');
    expect(html).toContain('Do pliku przelewów: Dostawca 1');
    expect(html).toContain('Do pliku przelewów: Dostawca 2');
    expect(html).toContain('45 1050 1038 0000 0000 0000 1234');
    expect(html).toMatch(/nie oznacza kosztów jako zapłaconych/);
    expect(html).not.toMatch(/[—–]/);
  });

  it('bez rachunku firmy: co uzupełnić i gdzie, przycisk nieaktywny', async () => {
    const html = await ekran({ mozeOznaczac: true, rachunekFirmy: null });
    expect(html).toMatch(/Uzupełnij rachunek firmy/);
    expect(html).toContain('href="/settings#rachunek-firmy"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]{0,400}Pobierz plik przelewów/);
  });

  it('księgowa (bez prawa zapłaty): bez wyboru i bez pliku', async () => {
    const html = await ekran({ mozeOznaczac: false, rachunekFirmy: RACHUNEK_FIRMY });
    expect(html).not.toContain('Pobierz plik przelewów');
    expect(html).not.toContain('Do pliku przelewów');
  });
});

describe('podsumowanie pliku przelewów', () => {
  it('liczba, suma, MPP, dowód sprawdzenia białej listy i pominięcia z powodem', async () => {
    const { PodsumowaniePlikuPrzelewow } = await import('@/components/expenses/do-zaplaty/plik-przelewow');
    const html = norm(renderToStaticMarkup(
      <PodsumowaniePlikuPrzelewow
        podsumowanie={{
          nazwaPliku: 'przelewy-2026-11-10.pli',
          dzien: DZIS,
          liczba: 2,
          suma: 21230,
          mpp: 1,
          przelewy: [
            { id: 'exp-1', sprzedawca: 'Dostawca 1 sp. z o.o.', numerFaktury: 'FV/1/11/2026', kwota: 20000, dataWykonania: '2026-11-20', mpp: true, bialaLista: { requestId: 'd2n10-84df1a1', dzien: DZIS } },
            { id: 'exp-2', sprzedawca: 'Dostawca 2 sp. z o.o.', numerFaktury: 'FV/2/11/2026', kwota: 1230, dataWykonania: DZIS, mpp: false, bialaLista: null },
          ],
          pominiete: [
            { id: 'exp-3', sprzedawca: 'Dostawca 3 sp. z o.o.', numerFaktury: 'FV/3/11/2026', kod: 'brak_rachunku', powod: 'Faktura nie podaje rachunku sprzedawcy.' },
          ],
        }}
      />,
    ));

    expect(html).toContain('przelewy-2026-11-10.pli');
    expect(html).toMatch(/2 przelewy/);
    expect(html).toContain('21 230,00 zł');
    expect(html).toMatch(/MPP/);
    expect(html).toContain('d2n10-84df1a1');
    expect(html).toContain('Pominięte: 1');
    expect(html).toContain('Dostawca 3');
    expect(html).toContain('Faktura nie podaje rachunku sprzedawcy.');
    expect(html).toMatch(/Oznacz jako zapłacone|wyciąg/);
    expect(html).not.toMatch(/[—–]/);
  });

  it('nic nie weszło do pliku: bez nazwy pliku, z powodami', async () => {
    const { PodsumowaniePlikuPrzelewow } = await import('@/components/expenses/do-zaplaty/plik-przelewow');
    const html = renderToStaticMarkup(
      <PodsumowaniePlikuPrzelewow
        podsumowanie={{
          nazwaPliku: null, dzien: DZIS, liczba: 0, suma: 0, mpp: 0, przelewy: [],
          pominiete: [{ id: 'exp-1', sprzedawca: 'Dostawca 1', numerFaktury: 'FV/1', kod: 'zaplacony', powod: 'Koszt jest już oznaczony jako zapłacony.' }],
        }}
      />,
    );
    expect(html).toMatch(/Żaden z zaznaczonych kosztów nie trafił do pliku/);
    expect(html).toContain('Koszt jest już oznaczony jako zapłacony.');
  });
});
