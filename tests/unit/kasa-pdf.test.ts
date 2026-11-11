import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCashReport, type CashDocument } from '@/lib/kasa/model';
import {
  cashDocumentPdfFilename,
  cashReportPdfFilename,
  renderCashDocumentPdf,
  renderCashReportPdf,
} from '@/lib/kasa/pdf';

/**
 * PDF dowodu kasowego i raportu kasowego (plan kompletnej aplikacji, krok 3.7).
 * Urzędowego wzoru KP i KW nie ma, więc dowód ma elementy z § 6 ust. 3 pkt 3
 * rozporządzenia o PKPiR (Dz.U. 2025 poz. 1299): wystawca i strona (nazwy,
 * adresy), data wystawienia i data operacji, przedmiot i wartość, podpisy
 * osób uprawnionych i numer, który wiąże dowód z zapisami. Dowód jest po
 * polsku i w złotych (§ 6 ust. 1 i 4). Korekta mówi, który dowód koryguje
 * i dlaczego (§ 6 ust. 7: dowód własny wydany kontrahentowi poprawia się
 * dowodem korygującym).
 */

function dowod(over: Partial<CashDocument> = {}): CashDocument {
  return {
    id: 'd-1',
    tenantId: 't-1',
    kind: 'KP',
    number: 'KP/3/2026',
    issueDate: '2026-11-11',
    operationDate: '2026-11-05',
    amount: 1234.56,
    title: 'Zapłata za fakturę FV/1/2026',
    counterparty: { name: 'Jan Kowalski', nip: null, countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    issuedByName: 'Anna Nowak',
    issuedAt: '2026-11-11T09:30:00.000Z',
    invoiceId: 'inv-1',
    invoiceNumber: 'FV/1/2026',
    paymentId: 'pay-1',
    relatedDocument: null,
    correctsId: null,
    correctsNumber: null,
    correctionReason: null,
    ...over,
  };
}

/** Wszystkie napisy na stronach, z twardą spacją (separator tysięcy pl-PL) jako zwykłą. */
async function wydruk(render: () => Promise<Buffer>): Promise<string[]> {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await render();
  const napisy = text.mock.calls.map((c) => String(c[0]).replace(/[  ]/g, ' '));
  text.mockRestore();
  return napisy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF dowodu: elementy z § 6 ust. 3 pkt 3', () => {
  it('KP: rodzaj i numer, obie daty, wystawca i wpłacający, tytuł, kwota w złotych, kto wystawił, faktura', async () => {
    const napisy = await wydruk(() => renderCashDocumentPdf(dowod()));
    for (const oczekiwany of [
      'KP Dowód wpłaty',
      'Nr KP/3/2026',
      'Data wystawienia: 11.11.2026',
      'Data operacji: 05.11.2026',
      'Wystawca',
      'Moja Firma',
      'NIP: 1234567890',
      'ul. Przykładowa 1',
      '00-001 Warszawa',
      'Wpłacający',
      'Jan Kowalski',
      'ul. Klienta 10',
      'Tytułem: Zapłata za fakturę FV/1/2026',
      'Dotyczy faktury: FV/1/2026',
      'Kwota: 1234,56 zł',
      'Wystawił: Anna Nowak',
    ]) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
  });

  it('miejsca na podpisy: wystawiający i strona operacji (KP: wpłacił, KW: otrzymał)', async () => {
    const kp = await wydruk(() => renderCashDocumentPdf(dowod()));
    expect(kp).toEqual(expect.arrayContaining(['Podpis wystawiającego', 'Wpłacił (podpis)']));
    const kw = await wydruk(() => renderCashDocumentPdf(dowod({ kind: 'KW', number: 'KW/1/2026', invoiceId: null, invoiceNumber: null, paymentId: null })));
    expect(kw).toEqual(expect.arrayContaining(['KW Dowód wypłaty', 'Odbiorca', 'Podpis wystawiającego', 'Otrzymał (podpis)']));
    expect(kw).not.toContain('Wpłacający');
  });

  it('NIP strony i „Dotyczy” tylko wtedy, gdy są', async () => {
    const z = await wydruk(() => renderCashDocumentPdf(dowod({
      counterparty: { name: 'Firma Klient', nip: '1234567890', countryCode: 'PL', addressLine1: '', addressLine2: '' },
      relatedDocument: 'Umowa 7/2026',
    })));
    expect(z).toEqual(expect.arrayContaining(['Firma Klient', 'NIP: 1234567890', 'Dotyczy: Umowa 7/2026']));
  });

  it('korekta: kwota ujemna, dowód korygowany i przyczyna', async () => {
    const napisy = await wydruk(() => renderCashDocumentPdf(dowod({
      number: 'KP/7/2026',
      amount: -1234.56,
      title: 'Korekta dowodu KP/3/2026',
      correctsId: 'd-0',
      correctsNumber: 'KP/3/2026',
      correctionReason: 'Zła kwota',
      paymentId: null,
    })));
    expect(napisy).toEqual(expect.arrayContaining([
      'KP Dowód wpłaty, korekta',
      'Korekta dowodu KP/3/2026 z dnia operacji 05.11.2026. Ta korekta znosi tamten dowód w całości.',
      'Przyczyna korekty: Zła kwota',
      'Kwota: -1234,56 zł',
    ]));
  });

  it('ten sam dowód daje ten sam plik (data utworzenia = chwila wystawienia)', async () => {
    const a = await renderCashDocumentPdf(dowod());
    const b = await renderCashDocumentPdf(dowod());
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('nazwa pliku z numeru', () => {
    expect(cashDocumentPdfFilename('KP/3/2026')).toBe('KP-3-2026.pdf');
  });
});

describe('PDF raportu kasowego', () => {
  const report = buildCashReport({
    from: '2026-11-01',
    to: '2026-11-30',
    openingDate: '2026-10-01',
    balanceBefore: 50,
    documents: [
      {
        id: 'a', kind: 'KP', number: 'KP/1/2026', operationDate: '2026-11-03', issueDate: '2026-11-03', amount: 100,
        title: 'Zapłata za fakturę FV/1/2026', counterpartyName: 'Jan Kowalski', invoiceNumber: 'FV/1/2026',
        correctsNumber: null, correctedByNumber: null, issuedAt: '2026-11-03T09:00:00.000Z',
      },
      {
        id: 'b', kind: 'KW', number: 'KW/1/2026', operationDate: '2026-11-04', issueDate: '2026-11-04', amount: 30.5,
        title: 'Zakup materiałów', counterpartyName: 'Sklep ABC', invoiceNumber: null,
        correctsNumber: null, correctedByNumber: null, issuedAt: '2026-11-04T09:00:00.000Z',
      },
    ],
  });
  const firma = { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' };

  it('okres, stan na początek, wpłaty, wypłaty, stan na koniec i lista dowodów', async () => {
    const napisy = await wydruk(() => renderCashReportPdf({ report, company: firma, generatedAt: '2026-11-30T18:00:00.000Z' }));
    for (const oczekiwany of [
      'Raport kasowy',
      'Okres: od 01.11.2026 do 30.11.2026',
      'Moja Firma, NIP: 1234567890',
      'Stan na początek okresu: 50,00 zł',
      'Wpłaty (KP): 100,00 zł',
      'Wypłaty (KW): 30,50 zł',
      'Stan na koniec okresu: 119,50 zł',
      'KP/1/2026',
      'KW/1/2026',
      'Jan Kowalski',
      'Sklep ABC',
      '150,00',
      '119,50',
    ]) {
      expect(napisy, oczekiwany).toContain(oczekiwany);
    }
  });

  it('pusty okres: zdanie zamiast tabeli', async () => {
    const pusty = buildCashReport({ from: '2026-12-01', to: '2026-12-31', openingDate: '2026-10-01', balanceBefore: 0, documents: [] });
    const napisy = await wydruk(() => renderCashReportPdf({ report: pusty, company: firma, generatedAt: '2026-12-31T18:00:00.000Z' }));
    expect(napisy).toContain('W tym okresie nie ma dowodów kasowych.');
  });

  it('nazwa pliku z okresu', () => {
    expect(cashReportPdfFilename('2026-11-01', '2026-11-30')).toBe('raport-kasowy-2026-11-01-2026-11-30.pdf');
  });
});
