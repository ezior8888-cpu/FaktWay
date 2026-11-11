import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.4, część 2: na liście „Do zapłaty” blok „Przelew za kilka faktur
 * jednego dostawcy”. Przy co najmniej 2 niezapłaconych fakturach z numerem
 * KSeF od jednego dostawcy właściciel i administrator mają przycisk
 * „Identyfikator zbiorczy”; zapisany identyfikator to tytuł przelewu grupy,
 * a przy MPP stoi w miejscu numeru faktury. Decyzja D1: nowy blok z
 * istniejących komponentów nad listą; karty kosztów bez zmian.
 *
 * Prawdziwe: lista, grupy, widok `KosztyDoZaplaty` z nowym blokiem.
 * Zastąpione: akcje serwerowe, router i toasty.
 */

vi.mock('@/app/actions/expense-payments', () => ({ markExpensePaidAction: vi.fn(), undoExpensePaidAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => ({ validateBankAccountAction: vi.fn() }));
vi.mock('@/app/actions/plik-przelewow', () => ({ pobierzPlikPrzelewowAction: vi.fn() }));
vi.mock('@/app/actions/identyfikator-zbiorczy', () => ({ utworzIdentyfikatorZbiorczyAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const DZIS = '2026-11-11';
const NIP_A = '1111111111';
const NIP_B = '1234567890';
const ksef = (nip: string, n: number) => `${nip}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';
/** Kwoty po polsku mają twardą spację w tysiącach; testy porównują zwykłą. */
const norm = (html: string) => html.replace(/ /g, ' ');

type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

function wiersz(n: number, pola: Partial<Wiersz> = {}, nip = NIP_A): Wiersz {
  return {
    id: `exp-${n}`,
    seller_name: nip === NIP_A ? 'Dostawca A sp. z o.o.' : 'Dostawca B sp. z o.o.',
    seller_nip: nip,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: '2026-11-20',
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(nip, n), internal_number: `FV/${n}/11/2026`, currency: 'PLN' },
    ...pola,
  };
}

async function ekran(
  wiersze: Wiersz[],
  props: { mozeTworzycIdentyfikator: boolean; mozeOznaczac?: boolean; zapisane?: Array<{ numeryKsef: string[]; identyfikator: string }> },
) {
  const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
  const { grupyDoIdentyfikatora } = await import('@/lib/expenses/identyfikator-zbiorczy');
  const { KosztyDoZaplaty } = await import('@/components/expenses/do-zaplaty/koszty-do-zaplaty');
  const lista = listaDoZaplaty(wiersze, DZIS);
  return norm(
    renderToStaticMarkup(
      <KosztyDoZaplaty
        lista={lista}
        dzis={DZIS}
        mozeOznaczac={props.mozeOznaczac ?? props.mozeTworzycIdentyfikator}
        grupy={grupyDoIdentyfikatora(lista.pozycje, props.zapisane ?? [])}
        mozeTworzycIdentyfikator={props.mozeTworzycIdentyfikator}
      />,
    ),
  );
}

/** Przycisk „Identyfikator zbiorczy” (ikona i tekst w jednym `<button>`). */
const PRZYCISK = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Identyfikator zbiorczy<\/button>/;

/** Tekst bloku identyfikatora (bez reszty listy), żeby sprawdzić tylko nowe treści. */
function blok(html: string): string {
  const start = html.indexOf('id="identyfikator-zbiorczy-tytul"');
  expect(start).toBeGreaterThan(-1);
  const koniec = html.indexOf('</section>', start);
  return html.slice(start, koniec);
}

describe('lista „Do zapłaty”: identyfikator zbiorczy', () => {
  it('dwie faktury jednego dostawcy: blok z podstawą prawną, dostawcą, liczbą faktur, sumą i przyciskiem dla właściciela', async () => {
    const html = blok(await ekran([wiersz(1), wiersz(2, { gross_amount: '200.10' })], { mozeTworzycIdentyfikator: true }));

    expect(html).toContain('Przelew za kilka faktur jednego dostawcy');
    expect(html).toContain(
      'Od 1 stycznia 2027 r. przy przelewie za kilka faktur jednego dostawcy w tytule podaje się identyfikator zbiorczy (art. 108g ustawy o VAT).',
    );
    expect(html).toContain('Dostawca A');
    expect(html).toContain(`NIP ${NIP_A}`);
    expect(html).toContain('2 faktury');
    // Polski zapis liczb nie grupuje tysięcy w liczbach czterocyfrowych.
    expect(html).toContain('1430,10 zł');
    expect(html).toContain('FV/1/11/2026');
    expect(html).toContain('FV/2/11/2026');
    expect(html).toMatch(PRZYCISK);
  });

  it('członek i księgowa: bez przycisku, z informacją, kto tworzy identyfikator', async () => {
    const html = blok(await ekran([wiersz(1), wiersz(2)], { mozeTworzycIdentyfikator: false }));

    expect(html).not.toMatch(PRZYCISK);
    expect(html).toContain('Identyfikator zbiorczy tworzy właściciel albo administrator firmy.');
  });

  it('zapisany identyfikator: tytuł przelewu grupy z kopiowaniem, bez ponownego tworzenia', async () => {
    const html = blok(
      await ekran([wiersz(1), wiersz(2)], {
        mozeTworzycIdentyfikator: true,
        zapisane: [{ numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identyfikator: WEKTOR }],
      }),
    );

    expect(html).toContain('Tytuł przelewu');
    expect(html).toContain(WEKTOR);
    expect(html).toContain('Kopiuj identyfikator zbiorczy');
    expect(html).not.toMatch(PRZYCISK);
  });

  it('MPP: identyfikator w miejscu numeru faktury, suma VAT i NIP do komunikatu', async () => {
    const html = blok(
      await ekran([wiersz(1, { payment_split: true }), wiersz(2, { payment_split: true })], {
        mozeTworzycIdentyfikator: true,
        zapisane: [{ numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identyfikator: WEKTOR }],
      }),
    );

    expect(html).toContain('podzielona płatność (MPP)');
    expect(html).toContain('w miejscu numeru faktury');
    expect(html).toContain(WEKTOR);
    expect(html).toContain('460,00 zł');
    expect(html).toContain(NIP_A);
    expect(html).not.toContain('Tytuł przelewu');
  });

  it('faktura bez numeru KSeF u tego dostawcy: poza identyfikatorem, z wyjaśnieniem', async () => {
    const html = blok(
      await ekran(
        [wiersz(1), wiersz(2), wiersz(3, { faktura: { ksef_number: null, internal_number: 'FV/3/11/2026', currency: 'PLN' } })],
        { mozeTworzycIdentyfikator: true },
      ),
    );

    expect(html).toContain('FV/3/11/2026');
    expect(html).toContain('nie ma numeru KSeF');
    expect(html).toContain('2 faktury');
  });

  it('jedna faktura u dostawcy: bez bloku (tytuł to jej numer KSeF na karcie)', async () => {
    const html = await ekran([wiersz(1), wiersz(2, {}, NIP_B)], { mozeTworzycIdentyfikator: true });

    expect(html).not.toContain('identyfikator-zbiorczy-tytul');
    expect(html).toContain(`${ksef(NIP_A, 1)} FV/1/11/2026`);
  });

  it('bez długich myślników w bloku', async () => {
    const html = blok(
      await ekran(
        [
          wiersz(1, { payment_split: true }),
          wiersz(2, { payment_split: true }),
          wiersz(3),
          wiersz(4, { payment_account: 'PL27114020040000300201355387' }),
          wiersz(5, { payment_split: null }),
          wiersz(6, { faktura: { ksef_number: null, internal_number: 'FV/6/11/2026', currency: 'PLN' } }),
        ],
        { mozeTworzycIdentyfikator: false },
      ),
    );

    expect(html).not.toMatch(/[—–]/);
  });
});
