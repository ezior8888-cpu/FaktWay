// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ekrany proformy i oferty (krok 2.4): lista, podgląd, przyciski i formularz.
 * Ekran mówi, że dokument nie jest fakturą, nie trafia do KSeF ani do KPiR,
 * JPK, raportów i przypomnień. Zamiana w fakturę otwiera formularz faktury;
 * gdy z dokumentu jest już faktura, najpierw pyta (druga faktura tylko po
 * potwierdzeniu). Formularz odsyła firmę strony (UX-01).
 */

const m = vi.hoisted(() => ({ save: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh, replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/proformy', () => ({
  saveQuoteDraftAction: m.save,
  addQuoteContractorAction: vi.fn(),
  issueQuoteAction: vi.fn(),
  deleteQuoteDraftAction: vi.fn(),
  sendQuoteEmailAction: vi.fn(),
}));

import { QuoteActions } from '@/app/(dashboard)/proformy/_components/quote-actions';
import { QuoteDocument } from '@/app/(dashboard)/proformy/_components/quote-document';
import { QuoteForm } from '@/app/(dashboard)/proformy/_components/quote-form';
import { QuotesList } from '@/app/(dashboard)/proformy/_components/quotes-list';
import { quoteItems, quoteTotals, type QuoteListItem, type SalesQuote } from '@/lib/proformy/model';
import { QUOTE_BOOKS_NOTICE, quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const SZKIC = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';

const plain = (html: string) => html.replace(/[  ]/g, ' ').replace(/&quot;/g, '"');

function wiersz(extra: Partial<QuoteListItem> = {}): QuoteListItem {
  return {
    id: DOKUMENT,
    kind: 'proforma',
    status: 'issued',
    number: 'PRO/1/2026',
    issueDate: '2026-11-11',
    validUntil: null,
    counterpartyName: 'Kontrahent Testowy',
    grossTotal: 15_408,
    ...extra,
  };
}

function dokument(extra: Partial<SalesQuote> = {}): SalesQuote {
  const items = quoteItems([
    { name: 'Wdrożenie systemu (etap 1)', unit: 'szt', quantity: 1, unitPriceNet: 12_000, vatRate: '23' },
    { name: 'Szkolenie zespołu', unit: 'godz.', quantity: 4, unitPriceNet: 150, vatRate: '8' },
  ]);
  return {
    id: DOKUMENT,
    tenantId: TENANT,
    kind: 'proforma',
    status: 'issued',
    number: 'PRO/1/2026',
    issueDate: '2026-11-11',
    validUntil: null,
    items,
    ...quoteTotals(items),
    currency: 'PLN',
    contractorId: KONTRAHENT,
    counterparty: {
      name: 'Kontrahent Testowy',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Klienta 10',
      addressLine2: '02-001 Warszawa',
      email: 'zakupy@kontrahent.test',
    },
    issuer: {
      name: 'Moja Firma',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Przykładowa 1',
      addressLine2: '00-001 Warszawa',
    },
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    notes: 'Realizacja po wpłacie.',
    issuedAt: '2026-11-11T09:30:00.000Z',
    createdAt: '2026-11-11T09:00:00.000Z',
    ...extra,
  };
}

describe('lista proform i ofert', () => {
  it('wiersz: numer, rodzaj, kontrahent, data, ważność, kwota brutto, stan i link do podglądu', () => {
    const html = plain(renderToStaticMarkup(
      <QuotesList rows={[wiersz(), wiersz({ id: SZKIC, status: 'draft', number: null, kind: 'offer', validUntil: '2026-12-11' })]} />,
    ));
    for (const tekst of ['PRO/1/2026', 'Proforma', 'Oferta', 'Kontrahent Testowy', '11.11.2026', '11.12.2026', '15 408,00 zł', 'Wystawiona', 'Szkic']) {
      expect(html, tekst).toContain(tekst);
    }
    expect(html).toContain(`href="/proformy/${DOKUMENT}"`);
    expect(html).toContain(`href="/proformy/${SZKIC}"`);
  });

  it('pusta lista: zachęta z linkiem do nowego dokumentu', () => {
    const html = renderToStaticMarkup(<QuotesList rows={[]} />);
    expect(html).toContain('href="/proformy/nowa"');
    expect(html).toMatch(/Nie masz jeszcze proform ani ofert/);
  });

  it('teksty bez długich myślników', () => {
    expect(renderToStaticMarkup(<QuotesList rows={[wiersz()]} />)).not.toMatch(/[—–]/);
  });
});

describe('podgląd dokumentu', () => {
  it('wystawiona proforma: numer, strony, pozycje, kwoty, płatność, adnotacja i informacja o księgach', () => {
    const html = plain(renderToStaticMarkup(<QuoteDocument quote={dokument()} issuer={dokument().issuer} />));
    for (const tekst of [
      'Proforma',
      'PRO/1/2026',
      'Moja Firma',
      'Kontrahent Testowy',
      'Wdrożenie systemu (etap 1)',
      '12 600,00',
      // pl-PL nie grupuje liczb czterocyfrowych (lib/format/pl.ts): 2808, ale 12 600.
      '2808,00',
      '15 408,00',
      '25.11.2026',
      'PL61 1090 1014 0000 0712 1981 2874',
      'Realizacja po wpłacie.',
      quoteNotInvoiceNotice('proforma'),
      QUOTE_BOOKS_NOTICE,
    ]) {
      expect(html, tekst).toContain(tekst);
    }
    expect(QUOTE_BOOKS_NOTICE).toMatch(/KPiR/);
    expect(QUOTE_BOOKS_NOTICE).toMatch(/JPK/);
    expect(QUOTE_BOOKS_NOTICE).toMatch(/przypomnie/);
  });

  it('szkic: bez numeru, z informacją, że numer nada wystawienie', () => {
    const html = renderToStaticMarkup(
      <QuoteDocument quote={dokument({ status: 'draft', number: null, issuer: null, issuedAt: null })} issuer={dokument().issuer} />,
    );
    expect(html).toMatch(/Szkic/);
    expect(html).toMatch(/numer nada/i);
    expect(html).not.toContain('PRO/1/2026');
  });

  it('oferta: data ważności, bez płatności', () => {
    const html = plain(renderToStaticMarkup(
      <QuoteDocument
        quote={dokument({ kind: 'offer', number: 'OF/2/2026', validUntil: '2026-12-11', paymentMethod: null, paymentDueDate: null, bankAccount: null })}
        issuer={dokument().issuer}
      />,
    ));
    expect(html).toContain('Oferta ważna do: 11.12.2026');
    expect(html).not.toMatch(/Termin zapłaty|Numer rachunku/);
    expect(html).toContain(quoteNotInvoiceNotice('offer'));
  });
});

describe('przyciski wystawionego dokumentu: zamiana w fakturę', () => {
  it('bez faktur: linki do formularza faktury i faktury zaliczkowej z dokumentem w adresie', () => {
    const html = renderToStaticMarkup(
      <QuoteActions quoteId={DOKUMENT} kind='proforma' status='issued' number='PRO/1/2026' defaultEmail={null} issuerReady invoices={[]} />,
    );
    expect(html).toContain(`href="/invoices/new/regular?proforma=${DOKUMENT}"`);
    expect(html).toContain(`href="/invoices/new/advance?proforma=${DOKUMENT}"`);
    expect(html).toContain(`href="/api/proformy/${DOKUMENT}/pdf"`);
  });

  it('z fakturą: bez bezpośredniego linku, najpierw pytanie z numerem istniejącej faktury', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QuoteActions
          quoteId={DOKUMENT}
          kind='proforma'
          status='issued'
          number='PRO/1/2026'
          defaultEmail={null}
          issuerReady
          invoices={[{ invoiceId: 'inv-1', internalNumber: 'FV/1/11/2026', invoiceKind: 'regular', ksefStatus: 'draft', seq: 1 }]}
        />,
      );
    });
    expect(container.innerHTML).not.toContain(`href="/invoices/new/regular?proforma=${DOKUMENT}"`);
    const przycisk = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Wystaw fakturę') && !b.textContent.includes('zaliczkową'));
    expect(przycisk).toBeTruthy();
    await act(async () => {
      przycisk!.click();
    });
    const dialog = document.body.innerHTML;
    expect(dialog).toContain('FV/1/11/2026');
    expect(dialog).toContain(`/invoices/new/regular?proforma=${DOKUMENT}&amp;kolejna=1`);
    act(() => root.unmount());
    container.remove();
  });
});

describe('formularz proformy i oferty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    m.save.mockReset().mockResolvedValue({ success: true, id: SZKIC });
    m.push.mockReset();
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('bez kontrahentów w bazie: komunikat z wyjściem przez NIP', () => {
    const html = renderToStaticMarkup(<QuoteForm tenantId={TENANT} contractors={[]} today='2026-11-11' />);
    expect(html).toMatch(/Nie masz jeszcze kontrahentów/);
    expect(html).toMatch(/NIP/);
  });

  it('mówi, że dokument nie jest fakturą i nie trafia do KSeF; waluta PLN', () => {
    const html = renderToStaticMarkup(
      <QuoteForm tenantId={TENANT} contractors={[{ id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: null }]} today='2026-11-11' />,
    );
    expect(html).toMatch(/nie jest fakturą VAT/);
    expect(html).toMatch(/PLN/);
  });

  it('zapis szkicu odsyła dane, firmę strony i identyfikator szkicu, potem przechodzi do podglądu', async () => {
    await act(async () => {
      root.render(
        <QuoteForm
          tenantId={TENANT}
          contractors={[{ id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: null }]}
          today='2026-11-11'
          quoteId={SZKIC}
          initial={{
            kind: 'proforma',
            contractorId: KONTRAHENT,
            issueDate: '2026-11-11',
            validUntil: '',
            items: [{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
            currency: 'PLN',
            paymentMethod: 'transfer',
            paymentDueDate: '2026-11-25',
            bankAccount: 'PL61109010140000071219812874',
            notes: '',
          }}
        />,
      );
    });
    const zapisz = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Zapisz szkic'));
    expect(zapisz).toBeTruthy();
    await act(async () => {
      zapisz!.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(m.save).toHaveBeenCalledTimes(1);
    const [wartosci, firma, id] = m.save.mock.calls[0]!;
    expect(firma).toBe(TENANT);
    expect(id).toBe(SZKIC);
    expect(wartosci).toMatchObject({ kind: 'proforma', contractorId: KONTRAHENT, currency: 'PLN', bankAccount: 'PL61109010140000071219812874' });
    expect(m.push).toHaveBeenCalledWith(`/proformy/${SZKIC}`);
  });
});
