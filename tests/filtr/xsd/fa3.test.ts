import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';

import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * FA(3) na losowych danych (żelazny filtr F9, plan B4.6): NZ-FA-10 (każdy
 * wygenerowany XML przechodzi oficjalny XSD FA(3)), NZ-FA-01
 * (P_15 = Σ P_13_x + Σ P_14_x) i suma P_13_x równa sumie wartości netto
 * pozycji. Dotąd sprawdzał to tylko `pnpm verify:fa3`, poza CI. Faktura
 * zwykła w PLN, stawki 23, 8, 5, 0 i zw (z podstawą zwolnienia).
 */
const ILE = PRZYPADKI > 1_000 ? 300 : 25;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

const nazwa = fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,()+-]{1,60}$/).filter((s) => s.trim().length > 0);
const pozycja = fc.record({
  name: nazwa,
  unit: fc.constantFrom('szt.', 'usł.', 'godz.', 'kg', 'm2'),
  quantity: fc.oneof(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 99_999 }).map((n) => n / 1000)),
  unitPriceNet: fc.integer({ min: 1, max: 5_000_000 }).map((g) => g / 100),
  vatRate: fc.constantFrom('23', '8', '5', '0', 'zw') as fc.Arbitrary<'23' | '8' | '5' | '0' | 'zw'>,
});

type Linia = { name: string; unit: string; quantity: number; unitPriceNet: number; vatRate: '23' | '8' | '5' | '0' | 'zw' };

function faktura(linie: Linia[]): InvoiceInput {
  return {
    internalNumber: 'FV 2026/11/001',
    type: 'VAT',
    issueDate: '2026-11-09',
    saleDate: '2026-11-09',
    seller: {
      nip: '5260001246',
      name: 'ACME Software sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
      email: 'biuro@acme.test',
    },
    buyer: {
      nip: '5252241585',
      name: 'Klient sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
      email: 'kontakt@klient.test',
    },
    lines: linie.map((l, i) => ({ ordinal: i + 1, ...l })),
    payment: {
      currency: 'PLN',
      dueDate: '2026-11-23',
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
      bankName: 'Santander Bank Polska',
    },
  };
}

/** Jak `buildInvoiceFromForm`: adnotacje (podstawa zwolnienia, P_19A) dopina się do gotowej faktury. */
function gotowa(linie: Parameters<typeof faktura>[0]): Invoice {
  const invoice = finalizeInvoice(faktura(linie));
  return linie.some((l) => l.vatRate === 'zw') ? { ...invoice, annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } } : invoice;
}

const grosze = (tekst: string) => Math.round(Number(tekst) * 100);
const pola = (xml: string, wzorzec: RegExp) => [...xml.matchAll(wzorzec)].map((d) => grosze(d[1]));

describe('FA(3): losowe faktury', () => {
  it('przechodzą oficjalny XSD, a sumy w Fa zgadzają się z pozycjami (NZ-FA-01, NZ-FA-10)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pozycja, { minLength: 1, maxLength: 12 }), async (linie) => {
        const xml = generateFA3Xml(gotowa(linie), { generatedAt: new Date('2026-11-09T10:00:00Z') });
        const wynik = await validateFA3(xml);
        expect(wynik.errors.map((b) => b.message)).toEqual([]);

        const p13 = pola(xml, /<P_13_[0-9_]+>(-?[\d.]+)<\/P_13_[0-9_]+>/g).reduce((a, b) => a + b, 0);
        const p14 = pola(xml, /<P_14_\d+>(-?[\d.]+)<\/P_14_\d+>/g).reduce((a, b) => a + b, 0);
        const [p15] = pola(xml, /<P_15>(-?[\d.]+)<\/P_15>/g);
        expect(p15).toBe(p13 + p14);
        const netto = pola(xml, /<P_11>(-?[\d.]+)<\/P_11>/g).reduce((a, b) => a + b, 0);
        expect(p13).toBe(netto);
      }),
      opcjeXsd,
    );
  }, 600_000);
});
