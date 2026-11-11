import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';

import {
  EdiPlusPlusDocumentNotSupportedError,
  EdiPlusPlusForeignCurrencyNotSupportedError,
  generateEdiPlusPlus,
  type EdiPlusPlusInput,
} from '@/lib/exports/edi-plus-plus-generator';
import type { JpkInvoice, JpkInvoiceLine } from '@/lib/exports/jpk-fa-generator';
import { isExportFormatSuspended } from '@/lib/exports/suspended-formats';

/**
 * EDI++ (InsERT, Subiekt GT / Rewizor GT) — plik wzorcowy według dokumentu
 * „Komunikacja - Struktura danych EDI++” (wersja formatu 1.05; tabele 2, 3, 4
 * i p. 1.5, 1.6). Numery pól w komentarzach to numery „L.p.” z tego dokumentu.
 */

const issuer = {
  nip: '1234567890',
  name: 'Firma Testowa',
  address: { city: 'Warszawa', postCode: '00-001', street: 'ul. Testowa', buildingNumber: '1' },
};

function line(vatRate: string, netAmount: number, vatAmount: number, position = 1): JpkInvoiceLine {
  return { position, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate, vatAmount };
}

function invoice(over: Partial<JpkInvoice> & Pick<JpkInvoice, 'invoiceNumber' | 'lines'>): JpkInvoice {
  const net = over.lines.reduce((s, l) => s + l.netAmount, 0);
  const vat = over.lines.reduce((s, l) => s + (l.vatAmount ?? 0), 0);
  return {
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: '2026-09-10',
    saleDate: '2026-09-09',
    buyerName: 'Nabywca Testowy',
    buyerNip: '9876543210',
    netTotal: Math.round(net * 100) / 100,
    vatTotal: Math.round(vat * 100) / 100,
    grossTotal: Math.round((net + vat) * 100) / 100,
    ...over,
  };
}

const NOW = new Date('2026-10-05T10:15:30Z'); // 12:15:30 w Warszawie

function input(over: Partial<EdiPlusPlusInput> = {}): EdiPlusPlusInput {
  return {
    issuer,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    issuedInvoices: [],
    receivedInvoices: [],
    generatedAt: NOW,
    ...over,
  };
}

const text = (buf: Buffer) => iconv.decode(buf, 'win1250');
const lines = (buf: Buffer) => text(buf).split('\r\n');

describe('EDI++: układ pliku (tabela 1, 2)', () => {
  const buf = generateEdiPlusPlus(
    input({
      issuedInvoices: [
        invoice({
          invoiceNumber: 'FV/1/09/2026',
          buyerName: 'Nabywca "Żółć" Sp. z o.o.',
          buyerAddress: 'ul. Łąkowa 5, 00-950 Warszawa',
          paymentDueDate: '2026-09-24',
          lines: [line('23', 100, 23)],
        }),
      ],
    }),
  );

  it('plik wzorcowy: [INFO], [NAGLOWEK], [ZAWARTOSC], pusta linia na końcu', () => {
    const expected = [
      '[INFO]',
      '"1.05",0,1250,"FaktWay","1234567890","Firma Testowa","Firma Testowa","Warszawa","00-001","ul. Testowa 1","1234567890","","","","",1,20260901000000,20260930000000,"FaktWay",20261005121530,"Polska","PL","PL1234567890",0',
      '[NAGLOWEK]',
      '"FS",1,0,1,"","","FS FV/1/09/2026","",,"","","9876543210","Nabywca ""Żółć"" Sp. z o.o.","Nabywca ""Żółć"" Sp. z o.o.","Warszawa","00-950","ul. Łąkowa 5","9876543210","","","Warszawa",20260910000000,20260909000000,,1,1,"",100.00,23.00,123.00,0.00,"",0.00,"",20260924000000,0.00,123.00,0,0,0,0,"","","",0.00,0.00,"PLN",1.00,"","","","",0,0,0,"",0.00,"",0.00,"Polska","PL",0',
      '[ZAWARTOSC]',
      '"23",23.00,100.00,23.00,123.00',
      '',
      '',
    ].join('\r\n');
    expect(text(buf)).toBe(expected);
  });

  it('strona kodowa 1250: polskie litery to bajty Windows-1250, nie UTF-8', () => {
    const hex = buf.toString('hex');
    // „Żółć” w Windows-1250: Ż=AF ó=F3 ł=B3 ć=E6
    expect(hex).toContain(Buffer.from([0xaf, 0xf3, 0xb3, 0xe6]).toString('hex'));
    expect(hex).not.toContain('c5bb'); // „Ż” w UTF-8
  });

  it('cudzysłów w nazwie jest podwojony, a rekord zostaje w jednej linii', () => {
    expect(text(buf)).toContain('"Nabywca ""Żółć"" Sp. z o.o."');
  });

  it('separator dziesiętny kropka, bez separatora tysięcy, daty yyyymmddhhnnss', () => {
    const big = generateEdiPlusPlus(
      input({ issuedInvoices: [invoice({ invoiceNumber: 'FV/2', lines: [line('23', 12345.6, 2839.49)] })] }),
    );
    const t = text(big);
    expect(t).toContain('12345.60,2839.49,15185.09');
    expect(t).not.toMatch(/\d,\d{3}\.\d{2}/);
    expect(t).toContain('20260910000000');
  });
});

describe('EDI++: typy dokumentów i stawki VAT (tabela 3 pole 1, p. 1.5)', () => {
  const sales = invoice({
    invoiceNumber: 'FV/3/09/2026',
    lines: [
      line('23', 100, 23, 1),
      line('8', 50, 4, 2),
      line('5', 20, 1, 3),
      line('0', 10, 0, 4),
      line('zw', 5, 0, 5),
      line('np', 7, 0, 6),
    ],
  });
  const out = lines(generateEdiPlusPlus(input({ issuedInvoices: [sales] })));
  const zawartosc = out.slice(out.indexOf('[ZAWARTOSC]') + 1).filter(Boolean);

  it('tabela VAT: jeden wiersz na stawkę, symbol i wysokość z p. 1.5', () => {
    expect(zawartosc).toEqual([
      '"23",23.00,100.00,23.00,123.00',
      '"8",8.00,50.00,4.00,54.00',
      '"5",5.00,20.00,1.00,21.00',
      '"0",0.00,10.00,0.00,10.00',
      '"zw",-1.00,5.00,0.00,5.00',
      // spec zna „npo” (-4,00); „np” z FA(3) nie ma osobnego symbolu (niepewne)
      '"npo",-4.00,7.00,0.00,7.00',
    ]);
  });

  it('odwrotne obciążenie: symbol „oo”, wysokość -5,00, rodzaj transakcji 6', () => {
    const oo = invoice({ invoiceNumber: 'FV/4', lines: [line('oo', 200, 0)] });
    const t = lines(generateEdiPlusPlus(input({ issuedInvoices: [oo] })));
    expect(t).toContain('"oo",-5.00,200.00,0.00,200.00');
    const header = t[t.indexOf('[NAGLOWEK]') + 1].split(',');
    expect(header[54]).toBe('6'); // pole 55 „Rodzaj transakcji”
  });

  it('FS, FZ, KFS, KFZ: typ z pierwszego pola nagłówka', () => {
    const kor = (n: string) =>
      invoice({
        invoiceNumber: n,
        invoiceType: 'correction',
        correctedInvoiceNumber: 'FV/3/09/2026',
        correctionReason: 'Błąd w cenie',
        lines: [line('23', -10, -2.3)],
      });
    const out2 = lines(
      generateEdiPlusPlus(
        input({
          issuedInvoices: [sales, kor('FK/1')],
          receivedInvoices: [
            invoice({ invoiceNumber: 'ZAK/1', sellerName: 'Dostawca Sp. z o.o.', sellerNip: '5555555555', lines: [line('23', 10, 2.3)] }),
            kor('ZAK/K1'),
          ],
        }),
      ),
    );
    const heads = out2.filter((_, i) => out2[i - 1] === '[NAGLOWEK]');
    expect(heads.map((h) => h.split(',')[0])).toEqual(['"FS"', '"KFS"', '"FZ"', '"KFZ"']);
    const kfs = heads[1].split(',');
    expect(kfs[7]).toBe('"FV/3/09/2026"'); // pole 8: numer dokumentu korygowanego
    expect(heads[1]).toContain('-10.00,-2.30,-12.30'); // kwoty korekty: różnica, jak w bazie (C-01)
  });

  it('faktura zakupu: kontrahentem jest sprzedawca, numer dostawcy w polu 5', () => {
    const t = lines(
      generateEdiPlusPlus(
        input({
          receivedInvoices: [
            invoice({ invoiceNumber: 'ZAK/9', sellerName: 'Dostawca Sp. z o.o.', sellerNip: '5555555555', lines: [line('23', 10, 2.3)] }),
          ],
        }),
      ),
    );
    const head = t[t.indexOf('[NAGLOWEK]') + 1];
    expect(head).toContain('"5555555555","Dostawca Sp. z o.o."');
    expect(head).not.toContain('Nabywca Testowy');
    expect(head.split(',')[4]).toBe('"ZAK/9"');
  });
});

describe('EDI++: liczby, daty, pozycje', () => {
  it('liczba pozycji (pole 25) = liczba pozycji faktury', () => {
    const inv = invoice({ invoiceNumber: 'FV/5', lines: [line('23', 1, 0.23, 1), line('23', 2, 0.46, 2), line('8', 3, 0.24, 3)] });
    const t = lines(generateEdiPlusPlus(input({ issuedInvoices: [inv] })));
    expect(t[t.indexOf('[NAGLOWEK]') + 1].split(',')[24]).toBe('3');
  });

  it('kwoty z dwoma miejscami, ujemne bez „-0.00”', () => {
    const inv = invoice({ invoiceNumber: 'FV/6', lines: [line('23', 0.005, 0)] });
    const t = text(generateEdiPlusPlus(input({ issuedInvoices: [inv] })));
    expect(t).not.toContain('-0.00');
    expect(t).toContain('0.01,0.00,0.01'); // roundToCents, nie toFixed(2) z 0,005
  });

  it('kilka faktur: numer porządkowy (pole 4) rośnie osobno dla każdego typu', () => {
    const t = lines(
      generateEdiPlusPlus(
        input({
          issuedInvoices: [
            invoice({ invoiceNumber: 'A', lines: [line('23', 1, 0.23)] }),
            invoice({ invoiceNumber: 'B', issueDate: '2026-09-11', lines: [line('23', 1, 0.23)] }),
          ],
        }),
      ),
    );
    const heads = t.filter((_, i) => t[i - 1] === '[NAGLOWEK]');
    expect(heads.map((h) => h.split(',')[3])).toEqual(['1', '2']);
  });
});

describe('EDI++: odmowy bez pliku (fail-closed, z nazwą dokumentu)', () => {
  it('waluta obca albo brak waluty: wyjątek, bez pliku', () => {
    for (const currency of ['EUR', null, undefined]) {
      const inv = invoice({ invoiceNumber: 'FV/EUR', currency, lines: [line('23', 1, 0.23)] });
      expect(() => generateEdiPlusPlus(input({ issuedInvoices: [inv] }))).toThrow(EdiPlusPlusForeignCurrencyNotSupportedError);
      expect(() => generateEdiPlusPlus(input({ receivedInvoices: [inv] }))).toThrow(EdiPlusPlusForeignCurrencyNotSupportedError);
    }
  });

  it('faktura zaliczkowa i rozliczeniowa, usługa art. 100 (np_ii), kontrahent z UE: odmowa z numerem', () => {
    const cases = [
      invoice({ invoiceNumber: 'ZAL/1', invoiceType: 'advance', lines: [line('23', 1, 0.23)] }),
      invoice({ invoiceNumber: 'ROZ/1', invoiceType: 'final', lines: [line('23', 1, 0.23)] }),
      invoice({ invoiceNumber: 'NPII/1', lines: [line('np_ii', 1, 0)] }),
      invoice({ invoiceNumber: 'UE/1', buyerNip: undefined, buyerVatUe: 'DE123456789', lines: [line('23', 1, 0.23)] }),
    ];
    for (const inv of cases) {
      const run = () => generateEdiPlusPlus(input({ issuedInvoices: [inv] }));
      expect(run).toThrow(EdiPlusPlusDocumentNotSupportedError);
      expect(run).toThrow(inv.invoiceNumber);
    }
  });

  it('sumy tabeli VAT różne od sum nagłówka: odmowa (plik nie zafałszuje kwot)', () => {
    const inv = invoice({ invoiceNumber: 'FV/BAD', lines: [line('23', 100, 23)], netTotal: 90 });
    expect(() => generateEdiPlusPlus(input({ issuedInvoices: [inv] }))).toThrow(/FV\/BAD/);
  });

  it('numer faktury dłuższy niż pole pełnego numeru (30 znaków z mnemonikiem): odmowa, nie obcięcie', () => {
    const inv = invoice({ invoiceNumber: 'X'.repeat(40), lines: [line('23', 1, 0.23)] });
    expect(() => generateEdiPlusPlus(input({ issuedInvoices: [inv] }))).toThrow(EdiPlusPlusDocumentNotSupportedError);
  });
});

describe('EDI++: format pozostaje wstrzymany do próbnego importu', () => {
  it('insert_subiekt jest na liście wstrzymanych (decyzja Igora z 29.09.2026)', () => {
    expect(isExportFormatSuspended('insert_subiekt')).toBe(true);
  });
});
