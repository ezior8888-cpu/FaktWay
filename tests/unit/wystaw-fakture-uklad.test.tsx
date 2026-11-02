import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: vi.fn(),
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));
vi.mock('@/components/invoices/advance-actions', () => ({
  saveAdvanceAction: vi.fn(),
  saveAndSendAdvanceAction: vi.fn(),
}));
vi.mock('@/components/invoices/final-actions', () => ({
  saveFinalAction: vi.fn(),
  saveAndSendFinalAction: vi.fn(),
}));

import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';
import { FinalInvoiceForm } from '@/components/invoices/final-form';
import { CorrectionPageFrame } from '@/components/invoices/finora/correction-page-frame';
import { InvoiceCreateActions } from '@/components/invoices/finora/invoice-create-actions';
import { DocumentHeaderRow, formatIsoDatePl } from '@/components/invoices/finora/invoice-document';
import { InvoiceForm } from '@/components/invoices/invoice-form';
import { InvoiceTypeSelector } from '@/components/invoices/invoice-type-selector';
import { tekstBezZnacznikow } from './helpers/tekst-html';

/**
 * P5 planu Finora: oprawa „Wystaw fakturę” (`invoices-create` Finory) dla
 * czterech rodzajów faktur. Sesja w chmurze nie otworzy panelu (§9 pkt 1),
 * więc układ pilnujemy na znacznikach: dokument (sprzedawca + numer + daty,
 * nabywca, pozycje, podsumowanie po prawej) i prawa kolumna z akcjami.
 *
 * Pola, walidację i akcje pilnują dotychczasowe testy (`nabywca-ue-formularz`,
 * `mpp-formularz`, `zaliczka-formularz-data-warszawa`, `korekta-*`) — tu
 * sprawdzamy, że oprawa niczego z nich nie zgubiła po drodze.
 */

/** Firma formularza (UX-01) — w tym teście tylko wymagany prop. */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seller = {
  nip: '1234567890',
  name: 'Firma Testowa sp. z o.o.',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};

/** Klasy, których na przeniesionych ekranach nie ma (§9 pkt 5). */
const ZAKAZANE = [/rgba\(15,10,30/, /white\/55/, /backdrop-blur/, /ff-glass-pane/];

function bezZakazanych(html: string) {
  for (const re of ZAKAZANE) expect(html).not.toMatch(re);
}

/** Znacznik otwierający elementu z `data-testid` (atrybuty w dowolnej kolejności). */
function openTag(html: string, testId: string): string {
  const i = at(html, `data-testid="${testId}"`);
  const start = html.lastIndexOf('<', i);
  return html.slice(start, html.indexOf('>', i) + 1);
}

/** Pozycja pierwszego wystąpienia — do sprawdzania kolejności sekcji. */
function at(html: string, needle: string): number {
  const i = html.indexOf(needle);
  expect(i, `brak w znacznikach: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('P5: faktura zwykła w układzie dokumentu Finory', () => {
  const html = renderToStaticMarkup(
    <InvoiceForm tenantId={TENANT} seller={seller} suggestedNumber="FV/10/2026/007" />,
  );

  it('siatka dokument + kolumna 18rem', () => {
    expect(openTag(html, 'wystaw-fakture-siatka')).toMatch(/lg:grid-cols-\[1fr_18rem\]/);
  });

  it('nagłówek dokumentu: sprzedawca, numer (id internalNumber z podpowiedzią) i daty', () => {
    expect(html).toContain('Firma Testowa sp. z o.o.');
    expect(html).toContain('NIP: 1234567890');
    expect(html).toContain('ul. Testowa 1');
    expect(html).toMatch(/<label[^>]*for="internalNumber"[^>]*>Numer faktury<\/label>/);
    // Podpowiedź numeru wchodzi przez `defaultValues` RHF (ref, nie atrybut),
    // więc w znacznikach serwera sprawdzamy samo pole.
    expect(html).toMatch(/<input[^>]*id="internalNumber"[^>]*name="internalNumber"|<input[^>]*name="internalNumber"[^>]*id="internalNumber"/);
    expect(html).toMatch(/<label[^>]*for="issue-date"[^>]*>Data wystawienia<\/label>/);
    expect(html).toMatch(/<input[^>]*id="issue-date"[^>]*name="issueDate"|<input[^>]*name="issueDate"[^>]*id="issue-date"/);
    expect(html).toContain('Data sprzedaży / dostawy');
    expect(html).toMatch(/name="saleDate"/);
    expect(html).toMatch(/<label[^>]*for="payment-due-date"[^>]*>Termin płatności<\/label>/);
    expect(html).toMatch(/name="paymentDueDate"/);
    // Skróty terminu zostają przy polu terminu.
    for (const dni of [7, 14, 30]) expect(html).toContain(`>${dni} dni</button>`);
  });

  it('kolejność dokumentu: nagłówek → Nabywca → Płatność → Pozycje → podsumowanie → Uwagi', () => {
    const naglowek = at(html, 'data-testid="sprzedawca"');
    const nabywca = at(html, 'data-testid="sekcja-nabywca"');
    const platnosc = at(html, 'data-testid="sekcja-platnosc"');
    const pozycje = at(html, 'data-testid="sekcja-pozycje"');
    const suma = at(html, 'aria-label="Podsumowanie faktury"');
    const uwagi = at(html, 'for="invoice-notes"');
    expect(naglowek).toBeLessThan(nabywca);
    expect(nabywca).toBeLessThan(platnosc);
    expect(platnosc).toBeLessThan(pozycje);
    expect(pozycje).toBeLessThan(suma);
    expect(suma).toBeLessThan(uwagi);
  });

  it('pola nabywcy, płatności i pozycji mają te same nazwy co przed P5 (e2e 07)', () => {
    for (const name of [
      'buyerName', 'buyerAddressLine1', 'buyerAddressLine2', 'buyerEmail',
      'bankAccount', 'splitPayment', 'notes',
      'lines.0.name', 'lines.0.unit', 'lines.0.quantity', 'lines.0.unitPriceNet', 'lines.0.vatRate',
    ]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toMatch(/id="buyer-is-consumer"/);
    expect(html).toContain('Metoda płatności');
    expect(html).toContain('Dodaj pozycję');
  });

  it('podsumowanie: Razem netto, VAT i Do zapłaty w złotych', () => {
    expect(html).toContain('Razem netto');
    expect(html).toMatch(/Do zapłaty<\/span><span[^>]*>0,00 zł/);
  });

  it('prawa kolumna: „Wystaw i wyślij do KSeF” (główny) nad „Zapisz szkic”, bez „Podgląd”', () => {
    const start = at(html, 'data-testid="akcje-formularza"');
    const card = html.slice(start, html.indexOf('</div></div>', start));
    expect(openTag(html, 'akcje-formularza')).toMatch(/max-lg:hidden/);
    const send = at(card, 'Wystaw i wyślij do KSeF');
    const save = at(card, 'Zapisz szkic');
    expect(send).toBeLessThan(save);
    expect(html).not.toContain('Podgląd');
    // Karta akcji stoi w DOM za dokumentem — na telefonie byłaby pod nim.
    expect(at(html, 'data-testid="dokument-formularza"')).toBeLessThan(start);
  });

  it('pasek przyklejony zostaje tylko poniżej lg', () => {
    expect(html).toMatch(/class="ff-sticky-actions pointer-events-none lg:hidden"/);
    const bar = html.slice(html.indexOf('ff-sticky-actions'));
    expect(bar).toContain('Wyślij do KSeF');
    expect(bar).toContain('Zapisz szkic');
  });

  it('bez danych przykładowych Finory i bez starego szkła', () => {
    bezZakazanych(html);
    expect(html).not.toMatch(/\$[0-9]|images\/avatars|Salesperson|SWIFT|Discount/);
    expect(html).not.toContain('PLN');
  });

  it('bez sprzedawcy: nagłówek odsyła do danych firmy, formularz działa dalej', () => {
    const bez = renderToStaticMarkup(<InvoiceForm tenantId={TENANT} />);
    expect(bez).toContain('Dane sprzedawcy weźmiemy z profilu firmy.');
    expect(bez).toMatch(/<a[^>]*href="\/settings"[^>]*>Sprawdź dane firmy<\/a>/);
    expect(bez).toContain('id="internalNumber"');
  });
});

describe('P5: faktura zaliczkowa', () => {
  const html = renderToStaticMarkup(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} />);

  it('sprzedawca w nagłówku, numer i daty obok', () => {
    expect(html).toContain('Firma Testowa sp. z o.o.');
    expect(html).toMatch(/<label[^>]*for="internalNumber"[^>]*>Numer<\/label>/);
    expect(html).toMatch(/name="issueDate"/);
    expect(html).toMatch(/name="paymentDueDate"/);
  });

  it('sekcje: Nabywca, Płatność (MPP), Zaliczka; podsumowanie z kalkulatora zaliczki', () => {
    const nabywca = at(html, 'data-testid="sekcja-nabywca"');
    const platnosc = at(html, 'data-testid="sekcja-platnosc"');
    const zaliczka = at(html, 'data-testid="sekcja-zaliczka"');
    const suma = at(html, 'aria-label="Podsumowanie zaliczki"');
    expect(nabywca).toBeLessThan(platnosc);
    expect(platnosc).toBeLessThan(zaliczka);
    expect(zaliczka).toBeLessThan(suma);
    expect(html).toContain('name="advance-split-payment"');
    for (const name of ['totalContractAmount', 'advanceAmount', 'expectedDeliveryDate', 'description', 'notes', 'bankAccount']) {
      expect(html, name).toContain(`name="${name}"`);
    }
    // Domyślnie 100 zł zaliczki przy 23%: 81,30 netto + 18,70 VAT; z umowy 1000 zostaje 900.
    expect(html).toContain('81,30 zł');
    expect(html).toContain('18,70 zł');
    expect(html).toMatch(/Do zapłaty<\/span><span[^>]*>100,00 zł/);
    expect(html).toContain('900,00 zł');
  });

  it('prawa kolumna i pasek', () => {
    expect(html).toMatch(/data-testid="akcje-formularza"/);
    // Karta akcji (od lg) i pasek na telefonie mówią to samo: wysyłamy ZALICZKĘ
    // (przegląd P5: na komputerze znikało słowo „zaliczkę”).
    const karta = html.slice(html.indexOf('data-testid="akcje-formularza"'));
    expect(karta.slice(0, karta.indexOf('</button>'))).toContain('Wystaw i wyślij zaliczkę do KSeF');
    expect(html).toContain('Wyślij zaliczkę do KSeF');
    expect(html).toMatch(/ff-sticky-actions pointer-events-none lg:hidden/);
    bezZakazanych(html);
    expect(html).not.toContain('PLN');
  });
});

describe('P5: faktura rozliczająca', () => {
  const advances = [
    { id: 'adv-1', internal_number: 'ZAL/1/2026', ksef_number: null, issue_date: '2026-09-05', advance_amount: 1230, gross_total: 1230 },
  ];

  it('zaliczki z datą DD.MM.RRRR i kwotą w zł; podsumowanie po prawej', () => {
    const html = renderToStaticMarkup(<FinalInvoiceForm initialSeller={seller} advanceInvoices={advances} tenantId={TENANT} />);
    expect(html).toContain('Firma Testowa sp. z o.o.');
    expect(html).toContain('ZAL/1/2026');
    expect(html).toContain('05.09.2026');
    expect(html).toContain('1230,00 zł');
    const zaliczki = at(html, 'data-testid="sekcja-zaliczki"');
    const pozycje = at(html, 'data-testid="sekcja-pozycje"');
    const suma = at(html, 'aria-label="Podsumowanie faktury rozliczającej"');
    expect(zaliczki).toBeLessThan(pozycje);
    expect(pozycje).toBeLessThan(suma);
    expect(html).toContain('Razem brutto pozycji');
    expect(html).toContain('Do zapłaty po odliczeniu zaliczek');
    for (const name of ['lines.0.name', 'lines.0.unit', 'lines.0.quantity', 'lines.0.unitPriceNet', 'lines.0.vatRate', 'final-split-payment']) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toMatch(/data-testid="akcje-formularza"/);
    bezZakazanych(html);
    expect(html).not.toContain('PLN');
  });

  it('pusta lista zaliczek ma swój komunikat', () => {
    const html = renderToStaticMarkup(<FinalInvoiceForm initialSeller={seller} advanceInvoices={[]} tenantId={TENANT} />);
    expect(html).toContain('Brak zaliczek do wyboru. Wystaw i zaakceptuj najpierw fakturę zaliczkową.');
  });
});

describe('P5: wybór rodzaju faktury w kartach Finory', () => {
  const html = renderToStaticMarkup(<InvoiceTypeSelector />);

  it('cztery karty-linki z dotychczasowymi adresami i tekstami', () => {
    for (const [type, label] of [
      ['regular', 'Faktura zwykła'],
      ['correction', 'Faktura korygująca'],
      ['advance', 'Faktura zaliczkowa'],
      ['final', 'Faktura rozliczająca'],
    ]) {
      expect(html).toMatch(new RegExp(`<a[^>]*href="/invoices/new/${type}"[\\s\\S]*?${label}`));
    }
    expect(html.match(/data-slot="card"/g)).toHaveLength(4);
    bezZakazanych(html);
    expect(html).not.toContain('material-symbols');
  });
});

describe('P5: ramka strony korekty', () => {
  it('formularz w lewej kolumnie siatki, prawa kolumna tylko z nawigacją', () => {
    const html = renderToStaticMarkup(
      <CorrectionPageFrame>
        <p>formularz-korekty</p>
      </CorrectionPageFrame>,
    );
    expect(html).toMatch(/lg:grid-cols-\[1fr_18rem\]/);
    expect(at(html, 'formularz-korekty')).toBeLessThan(at(html, 'data-testid="ramka-korekty"'));
    expect(openTag(html, 'ramka-korekty')).toMatch(/max-lg:hidden/);
    expect(html).toMatch(/<a[^>]*href="\/invoices\/new"[^>]*>Zmień rodzaj faktury<\/a>/);
    expect(html).not.toMatch(/<button/);
  });
});

describe('P5: karta akcji', () => {
  it('zablokowana podczas zapisu, z własnymi podpisami', () => {
    const html = renderToStaticMarkup(
      <InvoiceCreateActions onSend={() => {}} onSave={() => {}} sending saving={false} disabled sendLabel="Wyślij" />,
    );
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Wyślij');
    expect(html).toContain('Zapisz szkic');
    expect(html).toContain('animate-spin');
  });
});

describe('formatIsoDatePl', () => {
  it.each([
    ['2026-10-20', '20.10.2026'],
    ['2026-01-05T00:00:00Z', '05.01.2026'],
    [null, '—'],
    ['', '—'],
    ['nie-data', 'nie-data'],
  ])('%s → %s', (iso, out) => {
    expect(formatIsoDatePl(iso)).toBe(out);
  });
});

/**
 * Przegląd P5 (WCAG 1.3.1 / 4.1.2): każda etykieta pola wskazuje istniejącą
 * kontrolkę — `for` z pasującym `id` — albo ją owija (radio, checkbox).
 * Bez tego czytnik ekranu czyta pole bez nazwy, a klik w etykietę nic nie robi.
 */
function etykietyBezPola(html: string): string[] {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const bez: string[] = [];
  for (const m of html.matchAll(/<label([^>]*)>([\s\S]*?)<\/label>/g)) {
    const [, attrs, inner] = m;
    if (/<(input|select|textarea|button)\b/.test(inner)) continue;
    const target = attrs.match(/\sfor="([^"]+)"/)?.[1];
    if (!target || !ids.has(target)) bez.push(tekstBezZnacznikow(inner).trim());
  }
  return bez;
}

describe('P5 po przeglądzie: etykiety pól powiązane z kontrolkami', () => {
  it('faktura zwykła', () => {
    expect(etykietyBezPola(renderToStaticMarkup(
      <InvoiceForm tenantId={TENANT} seller={seller} suggestedNumber="FV/10/2026/007" />,
    ))).toEqual([]);
  });

  it('faktura zaliczkowa', () => {
    expect(etykietyBezPola(renderToStaticMarkup(<AdvanceInvoiceForm initialSeller={seller} tenantId={TENANT} />))).toEqual([]);
  });

  it('faktura rozliczająca', () => {
    expect(etykietyBezPola(renderToStaticMarkup(
      <FinalInvoiceForm initialSeller={seller} advanceInvoices={[]} tenantId={TENANT} />,
    ))).toEqual([]);
  });
});

describe('P5 po przeglądzie: wiersz nagłówka dokumentu na telefonie', () => {
  it('etykieta nad polem poniżej sm, obok od sm (375 px: pole daty nie wychodzi poza kartę)', () => {
    const html = renderToStaticMarkup(
      <DocumentHeaderRow label="Data sprzedaży / dostawy" htmlFor="x">
        <input id="x" />
      </DocumentHeaderRow>,
    );
    expect(html).toMatch(/class="flex flex-col gap-1\.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"/);
    expect(html).toMatch(/<div class="w-full sm:w-44 sm:flex-none"><input id="x"\/><\/div>/);
  });
});
