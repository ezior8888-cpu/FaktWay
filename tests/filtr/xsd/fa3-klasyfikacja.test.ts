import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateFinalInvoiceXml, type AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { CorrectionInvoiceData, FinalInvoiceData, InvoiceLine } from '@/types/invoice-types';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * Kod towaru w pozycji faktury (C1-KOLEJNOSC, NZ-FA-10). W sekwencji
 * `FaWiersz` oficjalnego XSD FA(3) kody stoją po nazwie towaru: P_7, Indeks,
 * GTIN, PKWiU, CN, PKOB, dopiero potem P_8A. Generatory faktury zwykłej,
 * rozliczającej (ROZ) i korygującej (KOR) wstawiały kod przed P_7, więc
 * pozycja z kodem dawała XML, którego XSD nie przyjmuje: wysyłka takiej
 * faktury kończyłaby się `XSD_INVALID`, zanim cokolwiek trafi do KSeF.
 *
 * Który z trzech elementów dostaje kod, generator wybiera po kształcie kodu,
 * a ROZ i KOR biorą go z `pkwiuCode` i przepuszczają tylko litery i cyfry.
 * To osobne ustalenie C1-KLASYFIKACJA. Macierz zastaje ten wybór, nie
 * poprawia go: w ROZ i KOR kod EAN i kod CN podane w `pkwiuCode` dają
 * `<GTIN>` i `<CN>`. Naprawa C1-KLASYFIKACJA (osobne pola na kody) zmieni
 * wejścia tych przypadków, a nie usunie ich.
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

type Element = 'GTIN' | 'PKWiU' | 'CN';
const KODY: { element: Element; kod: string; nazwa: string }[] = [
  { element: 'GTIN', kod: '5901234123457', nazwa: 'Laptop' }, // EAN-13
  { element: 'PKWiU', kod: '62', nazwa: 'Wdrożenie systemu' }, // dział PKWiU 62: usługi związane z oprogramowaniem
  { element: 'CN', kod: '847130', nazwa: 'Laptop' }, // podpozycja HS 8471 30: komputery przenośne
];

type Pozycja = { name: string; unit: string; quantity: number; unitPriceNet: number; kod?: string };

const adres = (linia1: string) => ({ countryCode: 'PL', addressLine1: linia1, addressLine2: '00-001 Warszawa' });

/** Pozycje ROZ i KOR: kod w `pkwiuCode`, stawka 23% (stawka nie ma tu znaczenia). */
const liniePkwiu = (pozycje: Pozycja[]): InvoiceLine[] =>
  pozycje.map(({ kod, ...p }) => ({ ...p, vatRate: '23', pkwiuCode: kod }));

/**
 * Faktura zwykła: kod idzie wprost do `classificationCode`. Generator sprawdza
 * sumę kontrolną NIP, więc NIP-y są fikcyjne, ale z poprawną sumą (jak
 * w `tests/rls-wyciag-podatki.test.ts`); `1234567890` tej kontroli nie przechodzi.
 */
function zwykla(pozycje: Pozycja[]): string {
  const invoice = finalizeInvoice({
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-14',
    saleDate: '2026-11-14',
    seller: { nip: '1234563218', name: 'ACME Software sp. z o.o.', address: adres('ul. Przykładowa 1/2'), email: 'biuro@acme.test' },
    buyer: { nip: '1111111111', name: 'Klient sp. z o.o.', address: adres('ul. Klienta 10'), email: 'kontakt@klient.test' },
    lines: pozycje.map(({ kod, ...p }, i) => ({ ordinal: i + 1, ...p, vatRate: '23' as const, classificationCode: kod })),
    payment: {
      currency: 'PLN',
      dueDate: '2026-11-28',
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
      bankName: 'Santander Bank Polska',
    },
  });
  return generateFA3Xml(invoice, { generatedAt: new Date('2026-11-14T10:00:00Z') });
}

/** Faktura rozliczająca z jedną zaliczką 1,23 zł brutto (23%) z numerem KSeF. */
function rozliczenie(pozycje: Pozycja[]): string {
  const data = {
    invoiceType: 'final',
    internalNumber: 'FR/2026/09/1',
    issueDate: '2026-09-20',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-04',
    bankAccount: 'PL61109010140000071219812874',
    seller: { nip: '1234567890', name: 'ACME Software sp. z o.o.', address: adres('ul. Przykładowa 1/2'), email: 'biuro@acme.test' },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Klient sp. z o.o.', address: adres('ul. Klienta 10') },
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    advanceInvoiceIds: ['00000000-0000-4000-8000-000000000001'],
    totalAdvances: 1.23,
    lines: liniePkwiu(pozycje),
  } as unknown as FinalInvoiceData;
  const zaliczka: AdvanceInvoiceSettlementRow = {
    internal_number: 'ZAL/2026/08/1',
    ksef_number: '1234567890-20260801-0100001AF629-AF',
    advance_amount: 1.23,
    issue_date: '2026-08-01',
    vat_rate: '23',
    net_amount: 1,
    vat_amount: 0.23,
  };
  return generateFinalInvoiceXml(data, [zaliczka], { generatedAt: new Date('2026-09-20T10:00:00Z') });
}

/**
 * Korekta. „Przed/po” zmienia ilość każdej pozycji, więc każda ma wiersz
 * `StanPrzed` i wiersz po, oba z kodem. Anulowanie daje jeden wiersz na
 * pozycję faktury pierwotnej (ilość na minusie), bez `StanPrzed`.
 */
function korekta(rodzaj: 'before_after' | 'cancellation', pozycje: Pozycja[]): string {
  const przed = liniePkwiu(pozycje);
  const data = {
    invoiceType: 'correction',
    internalNumber: 'KOR 2026/11/001',
    issueDate: '2026-11-09',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-23',
    parentInvoiceId: '00000000-0000-4000-8000-000000000001',
    parentInvoiceNumber: 'FV 2026/09/001',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: '1234567890-20260930-0100001AF629-AF',
    correctionType: rodzaj,
    correctionReason: 'Zmiana warunków po reklamacji',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'ACME Software sp. z o.o.', address: adres('ul. Przykładowa 1/2') },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Klient sp. z o.o.', address: adres('ul. Klienta 10') },
    linesBefore: przed,
    ...(rodzaj === 'before_after' ? { linesAfter: przed.map((l) => ({ ...l, quantity: l.quantity + 1 })) } : {}),
  } as unknown as CorrectionInvoiceData;
  return generateCorrectionInvoiceXml(data, { generatedAt: new Date('2026-11-09T10:00:00Z') });
}

const GENERATORY = [
  { nazwa: 'zwykła', xml: zwykla, wierszyNaPozycje: 1 },
  { nazwa: 'ROZ', xml: rozliczenie, wierszyNaPozycje: 1 },
  { nazwa: 'KOR przed/po', xml: (p: Pozycja[]) => korekta('before_after', p), wierszyNaPozycje: 2 },
  { nazwa: 'KOR anulowanie', xml: (p: Pozycja[]) => korekta('cancellation', p), wierszyNaPozycje: 1 },
];

/** Treść każdego `FaWiersz`. */
function wiersze(xml: string): string[] {
  return xml
    .split('<FaWiersz>')
    .slice(1)
    .map((w) => w.slice(0, w.indexOf('</FaWiersz>')));
}

const ZNACZNIKI = ['P_7', 'GTIN', 'PKWiU', 'CN', 'P_8A'];

/** Kolejność nazwy (P_7), kodu i jednostki (P_8A) w jednym `FaWiersz`. */
function kolejnosc(wiersz: string): string[] {
  return ZNACZNIKI.filter((z) => wiersz.includes(`<${z}>`)).sort(
    (a, b) => wiersz.indexOf(`<${a}>`) - wiersz.indexOf(`<${b}>`),
  );
}

/** Kody z liter i cyfr do 50 znaków (PKWiU i CN: TZnakowy50), w tym kształty GTIN i CN. */
const kod = fc.oneof(
  fc.stringMatching(/^\d{8,14}$/),
  fc.stringMatching(/^\d{4,7}$/),
  fc.stringMatching(/^[A-Za-z0-9]{1,50}$/),
);

describe('FA(3): kod towaru w FaWiersz po P_7 (C1-KOLEJNOSC, NZ-FA-10)', () => {
  for (const g of GENERATORY) {
    for (const { element, kod: k, nazwa } of KODY) {
      it(`${g.nazwa}, ${element}: XSD przyjmuje, kod między P_7 a P_8A`, async () => {
        const xml = g.xml([{ name: nazwa, unit: 'szt.', quantity: 2, unitPriceNet: 3500, kod: k }]);
        const wynik = await validateFA3(xml);
        expect(wynik.errors.map((b) => b.message)).toEqual([]);

        const w = wiersze(xml);
        expect(w).toHaveLength(g.wierszyNaPozycje);
        for (const wiersz of w) {
          expect(wiersz).toContain(`<${element}>${k}</${element}>`);
          expect(kolejnosc(wiersz)).toEqual(['P_7', element, 'P_8A']);
        }
      });
    }
  }

  it('losowe kody, także pozycje bez kodu: XSD przyjmuje, każdy kod między P_7 a P_8A', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.option(kod, { nil: undefined }), { minLength: 1, maxLength: 5 }), async (kody) => {
        // Nazwy różne: korekta paruje pozycje po nazwie, więc każda dostaje własny wiersz po.
        const pozycje = kody.map((k, i) => ({ name: `Pozycja ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceNet: 100, kod: k }));
        const zKodem = kody.filter((k) => k !== undefined).length;
        for (const g of GENERATORY) {
          const xml = g.xml(pozycje);
          const wynik = await validateFA3(xml);
          expect(wynik.errors.map((b) => b.message), g.nazwa).toEqual([]);

          const kolejnosci = wiersze(xml)
            .map(kolejnosc)
            .filter((k) => k.length > 2);
          expect(kolejnosci, g.nazwa).toHaveLength(g.wierszyNaPozycje * zKodem);
          for (const k of kolejnosci) {
            expect(k, g.nazwa).toEqual(['P_7', expect.stringMatching(/^(GTIN|PKWiU|CN)$/), 'P_8A']);
          }
        }
      }),
      opcjeXsd,
    );
  }, 600_000);
});
