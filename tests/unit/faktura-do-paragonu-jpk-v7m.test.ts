import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sprawdzJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import { importedContentFlags, type ExportExpense } from '@/lib/exports/data-fetcher';
import { amountsOf, JpkDocumentNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, summarizeJpkV7m, type JpkV7mInputData } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Faktura do paragonu (FP) w JPK_V7M(3): plan kompletnej aplikacji, krok 1.2,
 * część 2. Reguły tylko ze źródeł urzędowych:
 *
 * - art. 109 ust. 3d ustawy o VAT: FP ujmuje się w ewidencji w okresie, w którym
 *   ją wystawiono, i nie zwiększa ona wartości sprzedaży ani podatku należnego;
 * - XSD JPK_V7M(3) w repo (`lib/exports/schemas/jpk-v7m3/schemat.xsd`):
 *   `TypDokumentu` „FP” w wierszu sprzedaży, PodatekNalezny „z wyłączeniem
 *   faktur oznaczonych FP”;
 * - MF, „Pytania i odpowiedzi JPK_VAT z deklaracją” (podatki.gov.pl, odczyt
 *   13.11.2026, oznaczenia dokumentów): FP za okres wystawienia, poza sumami
 *   kontrolnymi, „w pełnych wartościach”; sprzedaż z kasy zapisem zbiorczym RO;
 * - strażnik pliku (`lib/bezpieczniki/jpk-v7m.ts`, FILTR-RT-JPK-02 i -05): wzory
 *   z opisów pól XSD, niezależne od generatora (sprzedaż bez FP).
 *
 * Raportu z kasy (RO) FaktWay nie wykazuje, więc FP z paragonem z miesiąca
 * pliku to odmowa: plik bez RO zaniżyłby podatek należny o tę sprzedaż.
 */

const KSEF_FP = '5260001246-20261109-0100001AF629-AF';
const KSEF_ZWYKLA = '5260001246-20261105-0100001AF629-B0';
const PARAGON = { receipt: { receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' } };

const linia = (netAmount: number, vatRate: string, position = 1) => ({
  position, name: 'Rower', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate,
});

function faktura(o: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/1/11/2026',
    invoiceType: 'regular',
    currency: 'PLN',
    issueDate: '2026-11-05',
    saleDate: '2026-11-05',
    buyerName: 'Klient Sp. z o.o.',
    buyerNip: '5252241585',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    ksefNumber: KSEF_ZWYKLA,
    lines: [linia(1000, '23')],
    ...o,
  } as JpkInvoice;
}

/** FP wystawiona w FaktWay: oznaczenie z `fa3_data.receipt`, jak w eksporcie (`importedContentFlags`). */
function fakturaFp(o: Partial<JpkInvoice> = {}): JpkInvoice {
  return faktura({
    invoiceNumber: 'FV/5/11/2026',
    issueDate: '2026-11-09',
    saleDate: '2026-10-15',
    ksefNumber: KSEF_FP,
    ...importedContentFlags('app', PARAGON),
    ...o,
  });
}

const koszt: ExportExpense = {
  id: 'exp-1', issueDate: '2026-11-06', documentNumber: 'FZ/7/11', documentType: 'invoice',
  sellerName: 'Dostawca Sp. z o.o.', sellerNip: '5252241585', sellerAddress: null,
  netAmount: 200, vatAmount: 46, grossAmount: 246, vatDeductibleAmount: 46,
  kpirColumn: 'col_13', categoryLabel: 'Usługi', ksefNumber: null,
};

function plik(issuedInvoices: JpkInvoice[], expenses: ExportExpense[] = [koszt]): JpkV7mInputData {
  return {
    issuer: { nip: '5260001246', name: 'Moja Firma Sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    generatedAt: new Date('2026-12-10T10:00:00Z'),
    issuedInvoices,
    expenses,
    previousSurplus: 0,
  };
}

const wiersze = (xml: string) => [...xml.matchAll(/<SprzedazWiersz>([\s\S]*?)<\/SprzedazWiersz>/g)].map((m) => m[1]!);
const wierszFaktury = (xml: string, numer: string) => wiersze(xml).find((w) => w.includes(`<DowodSprzedazy>${numer}</DowodSprzedazy>`)) ?? '';
const pole = (xml: string, nazwa: string) => xml.match(new RegExp(`<${nazwa}>([^<]*)</${nazwa}>`))?.[1];
/** Część deklaracyjna: pola P_ z wartościami, w kolejności pliku. */
const deklaracja = (xml: string) => [...xml.matchAll(/<(P_\d+)>([^<]*)<\/P_\d+>/g)].map((m) => `${m[1]}=${m[2]}`);
/** Pola K_ wiersza ewidencji jako „K_19=1000.00”. */
const polaK = (w: string) => [...w.matchAll(/<(K_\d+)>([^<]*)<\/K_\d+>/g)].map((m) => `${m[1]}=${m[2]}`);

/** Pola K_ ze stawek faktury (te same pola co generator: 23 % K_19/K_20, 8 % K_17/K_18, 5 % K_15/K_16, 0 % K_13, zw K_10). */
function oczekiwaneK(inv: JpkInvoice): string[] {
  const pola: Record<string, [string, string | null]> = { '23': ['K_19', 'K_20'], '8': ['K_17', 'K_18'], '5': ['K_15', 'K_16'], '0': ['K_13', null], zw: ['K_10', null] };
  const wynik = new Map<string, number>();
  for (const { rate, net, vat } of amountsOf(inv).rates) {
    const [kNetto, kVat] = pola[rate]!;
    wynik.set(kNetto, (wynik.get(kNetto) ?? 0) + Math.round(net * 100));
    if (kVat) wynik.set(kVat, (wynik.get(kVat) ?? 0) + Math.round(vat * 100));
  }
  return ['K_10', 'K_13', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20']
    .filter((k) => wynik.has(k) && (wynik.get(k) !== 0 || ['K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20'].includes(k)))
    .map((k) => `${k}=${(wynik.get(k)! / 100).toFixed(2)}`);
}

/** Ta sama faktura bez oznaczenia FP (wzorzec kwot: FP nie zmienia kwot faktury, MF: „w pełnych wartościach”). */
const bezFp = (inv: JpkInvoice): JpkInvoice => ({ ...inv, ksefMarkers: undefined });

describe('JPK_V7M(3): wiersz faktury do paragonu (FP)', () => {
  it('FP z paragonem z poprzedniego miesiąca: TypDokumentu FP po NrKSeF, data sprzedaży z paragonu, pełne kwoty; XSD i strażnik bez uwag', async () => {
    const xml = generateJpkV7m(plik([faktura(), fakturaFp()]));

    const wynik = await validateJpkV7m(xml);
    expect(wynik.errors).toEqual([]);
    expect(sprawdzJpkV7m(xml, '2026-11')).toEqual([]);

    const fp = wierszFaktury(xml, 'FV/5/11/2026');
    expect(fp).toMatch(new RegExp(`<NrKSeF>${KSEF_FP}</NrKSeF>\\s*<TypDokumentu>FP</TypDokumentu>\\s*<K_19>`));
    expect(pole(fp, 'DataWystawienia')).toBe('2026-11-09');
    expect(pole(fp, 'DataSprzedazy')).toBe('2026-10-15');
    expect(polaK(fp)).toEqual(['K_19=1000.00', 'K_20=230.00']);
    // Zwykła faktura bez oznaczenia.
    expect(wierszFaktury(xml, 'FV/1/11/2026')).not.toContain('<TypDokumentu>');

    // Sumy kontrolne i deklaracja tylko ze zwykłej faktury (art. 109 ust. 3d, opis PodatekNalezny).
    expect(pole(xml, 'LiczbaWierszySprzedazy')).toBe('2');
    expect(pole(xml, 'PodatekNalezny')).toBe('230.00');
    expect(pole(xml, 'P_19')).toBe('1000');
    expect(pole(xml, 'P_20')).toBe('230');
    expect(pole(xml, 'P_37')).toBe('1000');
    expect(pole(xml, 'P_38')).toBe('230');
    expect(pole(xml, 'P_51')).toBe('184');
  });

  it('FP z importu KSeF (Fa/FP = 1) ma ten sam wiersz co FP wystawiona w FaktWay', async () => {
    const zImportu = faktura({
      invoiceNumber: 'FP/3/2026', issueDate: '2026-11-12', saleDate: '2026-09-30', importedFromKsef: true,
      ...importedContentFlags('ksef_import', { annotations: {}, ksefMarkers: { fp: true } }),
    });
    const xml = generateJpkV7m(plik([zImportu], []));
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
    expect(sprawdzJpkV7m(xml, '2026-11')).toEqual([]);
    expect(wierszFaktury(xml, 'FP/3/2026')).toContain('<TypDokumentu>FP</TypDokumentu>');
    expect(pole(xml, 'PodatekNalezny')).toBe('0.00');
    expect(pole(xml, 'P_38')).toBe('0');
  });

  it('niezmiennik: FP nie zmienia deklaracji ani PodatekNalezny, ma w ewidencji pełne kwoty faktury, a plik przechodzi XSD i strażnika', async () => {
    const stawka = fc.constantFrom('23', '8', '5', '0', 'zw');
    const pozycje = fc.array(fc.record({ grosze: fc.integer({ min: 1, max: 20_000_000 }), stawka }), { minLength: 1, maxLength: 3 });
    const zPozycji = (lista: Array<{ grosze: number; stawka: string }>) => {
      const lines = lista.map((p, i) => linia(p.grosze / 100, p.stawka, i + 1));
      const netto = lista.reduce((s, p) => s + p.grosze, 0);
      return { lines, netTotal: netto / 100 };
    };
    const dane = fc.record({
      zwykle: fc.array(fc.record({ pozycje, dzien: fc.integer({ min: 1, max: 30 }) }), { maxLength: 4 }),
      fp: fc.array(
        fc.record({ pozycje, dzien: fc.integer({ min: 1, max: 30 }), miesiacParagonu: fc.constantFrom('08', '09', '10'), dzienParagonu: fc.integer({ min: 1, max: 28 }) }),
        { minLength: 1, maxLength: 4 },
      ),
    });
    await fc.assert(
      fc.asyncProperty(dane, async ({ zwykle, fp }) => {
        const dzien = (d: number) => `2026-11-${String(d).padStart(2, '0')}`;
        const regularne = zwykle.map((z, i) => faktura({ invoiceNumber: `FV/${i + 1}/Z`, issueDate: dzien(z.dzien), saleDate: dzien(z.dzien), ...zPozycji(z.pozycje) }));
        const doParagonu = fp.map((z, i) =>
          fakturaFp({
            invoiceNumber: `FV/${i + 1}/FP`,
            issueDate: dzien(z.dzien),
            saleDate: `2026-${z.miesiacParagonu}-${String(z.dzienParagonu).padStart(2, '0')}`,
            ...zPozycji(z.pozycje),
          }),
        );
        const zFp = generateJpkV7m(plik([...regularne, ...doParagonu]));
        const bezFaktur = generateJpkV7m(plik(regularne));

        expect((await validateJpkV7m(zFp)).errors).toEqual([]);
        expect(sprawdzJpkV7m(zFp, '2026-11')).toEqual([]);
        // Deklaracja i PodatekNalezny jak bez FP (art. 109 ust. 3d).
        expect(deklaracja(zFp)).toEqual(deklaracja(bezFaktur));
        expect(pole(zFp, 'PodatekNalezny')).toBe(pole(bezFaktur, 'PodatekNalezny'));
        expect(summarizeJpkV7m(plik([...regularne, ...doParagonu]))).toMatchObject({
          ...summarizeJpkV7m(plik(regularne)),
          salesCount: regularne.length + doParagonu.length,
        });
        // Każda FP ma swój wiersz z oznaczeniem i pełnymi kwotami faktury.
        expect(pole(zFp, 'LiczbaWierszySprzedazy')).toBe(String(regularne.length + doParagonu.length));
        for (const inv of doParagonu) {
          const w = wierszFaktury(zFp, inv.invoiceNumber);
          expect(w).toContain('<TypDokumentu>FP</TypDokumentu>');
          expect(polaK(w)).toEqual(oczekiwaneK(bezFp(inv)));
        }
      }),
      { numRuns: 20, seed: 1202 },
    );
  }, 120_000);
});

describe('VAT miesiąca w module księgowości: FP z wcześniejszego miesiąca bez podatku należnego', () => {
  it('kwoty jak bez FP, liczba sprzedaży z FP', () => {
    const wynik = vatMiesiaca({ sprzedaz: [faktura(), fakturaFp()], koszty: [koszt] }, 0);
    expect(wynik).toMatchObject({ ok: true, naleznyGr: 23_000, naliczonyGr: 4_600, doZaplatyGr: 18_400, liczbaSprzedazy: 2 });
    expect(vatMiesiaca({ sprzedaz: [fakturaFp()], koszty: [] }, 0)).toMatchObject({ ok: true, naleznyGr: 0, doZaplatyGr: 0, liczbaSprzedazy: 1 });
  });
});

describe('FP, której wzorca FaktWay nie spełni: odmowa z powodem i wyjściem', () => {
  it('paragon z miesiąca pliku: sprzedaż z kasy tego miesiąca wykazuje się raportem RO, którego FaktWay nie tworzy', () => {
    const tenSamMiesiac = fakturaFp({ invoiceNumber: 'FV/7/11/2026', saleDate: '2026-11-03' });
    const tresc = /^JPK wstrzymany: faktura FV\/7\/11\/2026 \(KSeF [^)]+\) jest fakturą do paragonu \(FP\) z 03\.11\.2026.*raportem z kasy \(RO\).*FaktWay nie wykazuje.*poza FaktWay/;
    expect(() => generateJpkV7m(plik([faktura(), tenSamMiesiac]))).toThrow(JpkDocumentNotSupportedError);
    expect(() => generateJpkV7m(plik([faktura(), tenSamMiesiac]))).toThrow(tresc);
    expect(() => summarizeJpkV7m(plik([tenSamMiesiac]))).toThrow(tresc);
    expect(vatMiesiaca({ sprzedaz: [tenSamMiesiac], koszty: [] }, 0)).toEqual({ ok: false, brak: expect.stringMatching(tresc) });
  });

  it('FP z importu bez daty sprzedaży: data sprzedaży to data wystawienia, więc też odmowa (bez zgadywania miesiąca paragonu)', () => {
    const bezDaty = fakturaFp({ invoiceNumber: 'FP/9/2026', saleDate: undefined });
    expect(() => generateJpkV7m(plik([bezDaty]))).toThrow(/FP\/9\/2026.*jest fakturą do paragonu.*\(RO\)/);
  });

  it('korekta z oznaczeniem FP z importu: odmowa jak dotąd (MF opisuje dwa sposoby, FaktWay żadnego nie wybiera)', () => {
    const korekta = fakturaFp({ invoiceNumber: 'KOR/FP/1', invoiceType: 'correction', netTotal: -100, vatTotal: -23, grossTotal: -123, lines: [linia(-100, '23')] });
    expect(() => generateJpkV7m(plik([korekta]))).toThrow(/KOR\/FP\/1.*faktura do paragonu \(FP\)/);
  });

  it('FP z innym oznaczeniem z pliku KSeF (TP): odmowa z nazwą oznaczenia', () => {
    const zTp = fakturaFp({ invoiceNumber: 'FP/TP/1', ksefMarkers: { fp: true, tp: true } });
    expect(() => generateJpkV7m(plik([zTp]))).toThrow(/FP\/TP\/1.*powiązania między nabywcą a sprzedawcą \(TP\)/);
  });

  it('JPK_FA (bez oznaczenia FP w strukturze): odmowa z powodem, bez obietnicy, że CSV zadziała', () => {
    const fp = fakturaFp();
    expect(() => amountsOf(fp)).toThrow(JpkDocumentNotSupportedError);
    expect(() => amountsOf(fp)).toThrow(/^JPK wstrzymany: faktura FV\/5\/11\/2026 \(KSeF [^)]+\) to faktura do paragonu \(FP\).*JPK_FA nie ma oznaczenia FP.*raportem z kasy/);
    expect(() => amountsOf(fp)).not.toThrow(/CSV z FaktWay działają/);
  });
});
