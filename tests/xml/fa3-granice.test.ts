import { describe, expect, it } from 'vitest';

import { generateAdvanceInvoiceXml, generateFinalInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import {
  advanceInvoiceSchema,
  correctionInvoiceSchema,
  correctionLineSchema,
  finalInvoiceSchema,
} from '@/lib/validators/invoice-validators';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { InvoiceXmlSchemaError, validateFA3 } from '@/lib/xml/validator';
import type { AdvanceInvoiceData, CorrectionInvoiceData, FinalInvoiceData, InvoiceLine } from '@/types/invoice-types';

import {
  adres,
  korekta,
  KUPUJACY,
  NABYWCA,
  OPCJE,
  PLATNOSC,
  POZYCJA,
  rozliczenie,
  SPRZEDAWCA,
  tekst,
  zaliczka,
  zaliczkaDoRozliczenia,
  zwykla,
} from './dane';

/**
 * C1 (plan „zero zgubionych faktur”, W4 i W6): granice tekstu ze schematu
 * FA(3) w generatorach i formularzach KOR, ZAL, ROZ i faktury zwykłej.
 *
 * Wartość, której XSD nie przyjmie (za długa, z samych spacji, ze znakiem
 * sterującym), przechodziła formularz i padała dopiero w zadaniu wysyłki,
 * surowym komunikatem xmllint. Ten plik sprawdza:
 *  A. dokument z każdym polem na samej granicy przechodzi XSD (złote pliki
 *     obok), a znak więcej daje błąd XSD: dowód, gdzie leży granica;
 *  B. generator odmawia wartości spoza granicy, zanim zbuduje XML, komunikatem
 *     z nazwą pola. To ten sam błąd `InvoiceXmlSchemaError` co dotąd, więc ten
 *     sam kod XSD_INVALID i stan `rejected`; zmienia się tylko treść i chwila
 *     odmowy. Generator nie odmawia niczego, co XSD przyjmuje;
 *  C. formularze odmawiają tych samych wartości. Błąd pól nabywcy na ZAL
 *     i ROZ ma klucz `buyer`, bo tylko ten komunikat te formularze pokazują.
 *
 * Jednostka miary ma dwie granice: XSD (P_8A) 256 i baza
 * (`invoice_line_items.unit` VARCHAR(50)). Generator pilnuje XSD, formularz
 * bazy. W6: walidator miał 20, więc korekta faktury z jednostką od 21 do 50
 * znaków była niemożliwa.
 */

async function bledyXsd(xml: string): Promise<string[]> {
  return (await validateFA3(xml)).errors.map((e) => e.message);
}

/** Zamienia treść pierwszego elementu `el` w gotowym XML. */
function podmien(xml: string, el: string, wartosc: string): string {
  const start = xml.indexOf(`<${el}>`);
  const koniec = xml.indexOf(`</${el}>`, start);
  if (start < 0 || koniec < 0) throw new Error(`Brak elementu ${el} w XML`);
  return xml.slice(0, start + el.length + 2) + wartosc + xml.slice(koniec);
}

/** Komunikaty odmowy generatora; gdy generator zbuduje XML, test pada. */
function odmowa(generuj: () => string): string[] {
  let xml: string;
  try {
    xml = generuj();
  } catch (e) {
    if (e instanceof InvoiceXmlSchemaError) return e.errors;
    throw e;
  }
  throw new Error(`Generator zbudował XML (${xml.length} znaków) zamiast odmówić`);
}

// ─── A. Na samej granicy ────────────────────────────────────────────────────

const strony512 = {
  seller: { ...SPRZEDAWCA, name: tekst(512), address: adres(tekst(512), tekst(512)) },
  buyer: { ...NABYWCA, name: tekst(512), address: adres(tekst(512), tekst(512)) },
};

/**
 * Każde pole tekstowe dokumentu na samej granicy XSD. Bez kodów PKWiU, GTIN
 * i CN: wszystkie trzy generatory piszą kod przed `P_7`, a XSD wymaga go po
 * (osobne ustalenie poza C1, dziś uśpione, bo żaden formularz kodu nie
 * ustawia). Granicę PKWiU sprawdza wstawka w poprawne miejsce niżej.
 */
const NA_GRANICY = {
  kor: () =>
    generateCorrectionInvoiceXml(
      korekta({
        ...strony512,
        internalNumber: tekst(256),
        correctionReason: tekst(256),
        parentInvoiceNumber: tekst(256),
        linesBefore: [{ ...POZYCJA, name: tekst(512), unit: tekst(256) }],
        linesAfter: [{ ...POZYCJA, name: tekst(512), unit: tekst(256), quantity: 2 }],
        notes: tekst(3500),
      }),
      OPCJE,
    ),
  zal: () =>
    generateAdvanceInvoiceXml(
      zaliczka({
        ...strony512,
        buyer: {
          type: 'b2c',
          idType: 'passport',
          idNumber: 'AB1234567'.repeat(6).slice(0, 50),
          name: tekst(512),
          address: adres(tekst(512), tekst(512)),
        },
        internalNumber: tekst(256),
        description: tekst(502),
        notes: tekst(3500),
      }),
      OPCJE,
    ),
  roz: () =>
    generateFinalInvoiceXml(
      rozliczenie({
        ...strony512,
        internalNumber: tekst(256),
        lines: [{ ...POZYCJA, unitPriceNet: 1000, name: tekst(512), unit: tekst(256) }],
        notes: tekst(3500),
      }),
      [zaliczkaDoRozliczenia({ ksef_number: null, internal_number: tekst(256) })],
      OPCJE,
    ),
  zwykla: () =>
    generateFA3Xml(
      zwykla(
        {
          seller: { nip: SPRZEDAWCA.nip, name: tekst(512), address: adres(tekst(512), tekst(512)) },
          buyer: { ...KUPUJACY, name: tekst(512), address: adres(tekst(512), tekst(512)) },
          payment: { ...PLATNOSC, bankName: tekst(256) },
          notes: tekst(3500),
        },
        { name: tekst(512), unit: tekst(256) },
      ),
      OPCJE,
    ),
};
type Rodzaj = keyof typeof NA_GRANICY;

describe('C1 A: dokument na samej granicy przechodzi XSD, znak więcej już nie', () => {
  it.each(Object.keys(NA_GRANICY) as Rodzaj[])('%s: pola na granicy, XML zgodny z XSD (złoty plik)', async (rodzaj) => {
    const xml = NA_GRANICY[rodzaj]();
    expect(await bledyXsd(xml)).toEqual([]);
    await expect(xml).toMatchFileSnapshot(`./fa3-granice-${rodzaj}.xml`);
  });

  it.each<[Rodzaj, string, number]>([
    ['kor', 'P_2', 256],
    ['kor', 'Nazwa', 512],
    ['kor', 'AdresL1', 512],
    ['kor', 'AdresL2', 512],
    ['kor', 'PrzyczynaKorekty', 256],
    ['kor', 'NrFaKorygowanej', 256],
    ['kor', 'P_7', 512],
    ['kor', 'P_8A', 256],
    ['kor', 'StopkaFaktury', 3500],
    ['zal', 'NrID', 50],
    ['zal', 'P_7', 512],
    ['zal', 'P_7Z', 512],
    ['roz', 'NrFaZaliczkowej', 256],
    ['zwykla', 'NazwaBanku', 256],
  ])('%s: %s o znak dłuższe niż %i to błąd XSD', async (rodzaj, el, max) => {
    const bledy = await bledyXsd(podmien(NA_GRANICY[rodzaj](), el, tekst(max + 1)));
    expect(
      bledy.some((m) => m.includes(`}${el}'`) && m.includes(`maximum length of '${max}'`)),
      bledy.join('\n'),
    ).toBe(true);
  });

  it('PKWiU: 50 znaków przechodzi XSD, 51 już nie (kod wstawiony po P_7, gdzie wymaga go XSD)', async () => {
    const xml = NA_GRANICY.kor();
    const poNazwie = xml.indexOf('</P_7>') + '</P_7>'.length;
    const zKodem = (kod: string) => `${xml.slice(0, poNazwie)}<PKWiU>${kod}</PKWiU>${xml.slice(poNazwie)}`;
    expect(await bledyXsd(zKodem('A1'.repeat(25)))).toEqual([]);
    const bledy = await bledyXsd(zKodem(`${'A1'.repeat(25)}B`));
    expect(
      bledy.some((m) => m.includes("}PKWiU'") && m.includes("maximum length of '50'")),
      bledy.join('\n'),
    ).toBe(true);
  });
});

// ─── B. Odmowa generatora ───────────────────────────────────────────────────

const po = (o: Partial<InvoiceLine>): InvoiceLine[] => [{ ...POZYCJA, quantity: 2, ...o }];
const pozycjaRoz = (o: Partial<InvoiceLine>): InvoiceLine[] => [{ ...POZYCJA, unitPriceNet: 1000, ...o }];

describe('C1 B: generator odmawia, zanim zbuduje XML, i mówi które pole', () => {
  // Co zrobić dalej, mówi strona faktury (zasady ponownej wysyłki różnią się
  // dla KOR, ZAL i ROZ), a wysyłka łączy komunikaty średnikiem: tu same fakty.
  it('pełny komunikat: pole, granica i długość; przy danych firmy także, gdzie je poprawić', () => {
    expect(odmowa(() => generateCorrectionInvoiceXml(korekta({ correctionReason: tekst(257) }), OPCJE))).toEqual([
      'Przyczyna korekty: najwyżej 256 znaków, a jest 257',
    ]);
    const sprzedawca = { ...SPRZEDAWCA, address: adres(tekst(513)) };
    expect(odmowa(() => generateCorrectionInvoiceXml(korekta({ seller: sprzedawca }), OPCJE))).toEqual([
      'Sprzedawca, adres (linia 1): najwyżej 512 znaków, a jest 513 (popraw w Ustawieniach firmy)',
    ]);
  });

  it('kilka pól naraz: wszystkie w jednej odmowie', () => {
    const kor = korekta({ correctionReason: tekst(257), notes: tekst(3501) });
    expect(odmowa(() => generateCorrectionInvoiceXml(kor, OPCJE))).toHaveLength(2);
  });

  it.each<[string, Partial<CorrectionInvoiceData>, string]>([
    ['przyczyna z samych spacji', { correctionReason: '     ' }, 'Przyczyna korekty: pole jest puste'],
    ['przyczyna ze znakiem sterującym', { correctionReason: 'Zwrot\u000Btowaru' }, 'Przyczyna korekty: zawiera niewidoczne znaki sterujące'],
    ['numer faktury korygowanej 257 znaków', { parentInvoiceNumber: tekst(257) }, 'Numer faktury korygowanej: najwyżej 256 znaków, a jest 257'],
    ['nazwa nabywcy 513 znaków', { buyer: { ...NABYWCA, name: tekst(513) } }, 'Nabywca, nazwa: najwyżej 512 znaków, a jest 513'],
    ['adres nabywcy (linia 2) z samych spacji', { buyer: { ...NABYWCA, address: adres('ul. Klienta 10', '   ') } }, 'Nabywca, adres (linia 2): pole jest puste'],
    ['nazwa pozycji 513 znaków', { linesAfter: po({ name: tekst(513) }) }, ', nazwa: najwyżej 512 znaków, a jest 513'],
    ['jednostka 257 znaków', { linesAfter: po({ unit: tekst(257) }) }, ', jednostka miary: najwyżej 256 znaków, a jest 257'],
    ['kod PKWiU 51 znaków', { linesAfter: po({ pkwiuCode: `${'A1'.repeat(25)}B` }) }, ', kod PKWiU: najwyżej 50 znaków, a jest 51'],
    ['uwagi 3501 znaków', { notes: tekst(3501) }, 'Uwagi: najwyżej 3500 znaków, a jest 3501'],
    ['uwagi ze znakiem U+FFFE', { notes: 'Uwaga￾' }, 'Uwagi: zawiera niewidoczne znaki sterujące'],
  ])('KOR: %s', (_opis, zmiana, komunikat) => {
    expect(odmowa(() => generateCorrectionInvoiceXml(korekta(zmiana), OPCJE))).toContainEqual(
      expect.stringContaining(komunikat),
    );
  });

  it('KOR kwotowa: opis 513 znaków', () => {
    const kor = korekta({
      correctionType: 'amount_change',
      linesBefore: undefined,
      linesAfter: undefined,
      amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: tekst(513) },
    });
    expect(odmowa(() => generateCorrectionInvoiceXml(kor, OPCJE))).toContainEqual(
      expect.stringContaining('Opis korekty kwotowej: najwyżej 512 znaków, a jest 513'),
    );
  });

  it.each<[string, Partial<AdvanceInvoiceData>, string]>([
    ['opis 503 znaki', { description: tekst(503) }, 'Opis zaliczki: najwyżej 502 znaki, a jest 503'],
    ['opis z samych spacji', { description: '      ' }, 'Opis zaliczki: pole jest puste'],
    ['opis ze znakiem sterującym', { description: 'Projekt\u0007strony' }, 'Opis zaliczki: zawiera niewidoczne znaki sterujące'],
    ['adres nabywcy 513 znaków', { buyer: { ...NABYWCA, address: adres(tekst(513)) } }, 'Nabywca, adres (linia 1): najwyżej 512 znaków, a jest 513'],
    ['uwagi 3501 znaków', { notes: tekst(3501) }, 'Uwagi: najwyżej 3500 znaków, a jest 3501'],
  ])('ZAL: %s', (_opis, zmiana, komunikat) => {
    expect(odmowa(() => generateAdvanceInvoiceXml(zaliczka(zmiana), OPCJE))).toContainEqual(
      expect.stringContaining(komunikat),
    );
  });

  it.each<[string, Partial<FinalInvoiceData>, string]>([
    ['nazwa pozycji 513 znaków', { lines: pozycjaRoz({ name: tekst(513) }) }, ', nazwa: najwyżej 512 znaków, a jest 513'],
    ['jednostka 257 znaków', { lines: pozycjaRoz({ unit: tekst(257) }) }, ', jednostka miary: najwyżej 256 znaków, a jest 257'],
    ['kod PKWiU 51 znaków', { lines: pozycjaRoz({ pkwiuCode: `${'A1'.repeat(25)}B` }) }, ', kod PKWiU: najwyżej 50 znaków, a jest 51'],
    ['nazwa nabywcy 513 znaków', { buyer: { ...NABYWCA, name: tekst(513) } }, 'Nabywca, nazwa: najwyżej 512 znaków, a jest 513'],
  ])('ROZ: %s', (_opis, zmiana, komunikat) => {
    expect(
      odmowa(() => generateFinalInvoiceXml(rozliczenie(zmiana), [zaliczkaDoRozliczenia()], OPCJE)),
    ).toContainEqual(expect.stringContaining(komunikat));
  });

  it('ROZ: numer zaliczki 257 znaków bez numeru KSeF', () => {
    const zal = zaliczkaDoRozliczenia({ ksef_number: null, internal_number: tekst(257) });
    expect(odmowa(() => generateFinalInvoiceXml(rozliczenie(), [zal], OPCJE))).toContainEqual(
      expect.stringContaining('Numer faktury zaliczkowej: najwyżej 256 znaków, a jest 257'),
    );
  });

  it.each<[string, () => ReturnType<typeof zwykla>, string]>([
    ['jednostka 257 znaków', () => zwykla({}, { unit: tekst(257) }), ', jednostka miary: najwyżej 256 znaków, a jest 257'],
    ['adres nabywcy (linia 2) z samych spacji', () => zwykla({ buyer: { ...KUPUJACY, address: adres('ul. Klienta 10', '   ') } }), 'Nabywca, adres (linia 2): pole jest puste'],
    ['uwagi 3501 znaków', () => zwykla({ notes: tekst(3501) }), 'Uwagi: najwyżej 3500 znaków, a jest 3501'],
    ['znak sterujący w nazwie nabywcy', () => zwykla({ buyer: { ...KUPUJACY, name: 'Klient\u001F sp. z o.o.' } }), 'Nabywca, nazwa: zawiera niewidoczne znaki sterujące'],
    ['nazwa banku 257 znaków', () => zwykla({ payment: { ...PLATNOSC, bankName: tekst(257) } }), 'Nazwa banku: najwyżej 256 znaków, a jest 257'],
  ])('faktura zwykła: %s', (_opis, faktura, komunikat) => {
    expect(odmowa(() => generateFA3Xml(faktura(), OPCJE))).toContainEqual(expect.stringContaining(komunikat));
  });
});

describe('C1 B: generator nie odmawia niczego, co XSD przyjmuje', () => {
  it('KOR: przyczyna 257 znaków z podwójną spacją (XSD zwija ją do 256)', async () => {
    const przyczyna = `${tekst(128)}  ${tekst(127)}`;
    expect(przyczyna).toHaveLength(257);
    expect(await bledyXsd(generateCorrectionInvoiceXml(korekta({ correctionReason: przyczyna }), OPCJE))).toEqual([]);
  });

  it('KOR: nazwa pozycji z 511 znaków i emoji (XSD liczy znaki, nie jednostki UTF-16)', async () => {
    const nazwa = `${tekst(511)}\u{1F600}`;
    expect(nazwa).toHaveLength(513);
    expect(await bledyXsd(generateCorrectionInvoiceXml(korekta({ linesAfter: po({ name: nazwa }) }), OPCJE))).toEqual([]);
  });

  it('KOR kwotowa: opis 512 znaków', async () => {
    const kor = korekta({
      correctionType: 'amount_change',
      linesBefore: undefined,
      linesAfter: undefined,
      amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: tekst(512) },
    });
    expect(await bledyXsd(generateCorrectionInvoiceXml(kor, OPCJE))).toEqual([]);
  });

  it('KOR: uwagi z nową linią i tabulatorem', async () => {
    const kor = korekta({ notes: 'Dziękujemy\nza\tzakupy\r\nPozdrawiamy' });
    expect(await bledyXsd(generateCorrectionInvoiceXml(kor, OPCJE))).toEqual([]);
  });

  it('ROZ: numer zaliczki 257 znaków nie trafia do XML, gdy zaliczka ma numer KSeF', async () => {
    const zal = zaliczkaDoRozliczenia({ internal_number: tekst(257) });
    expect(await bledyXsd(generateFinalInvoiceXml(rozliczenie(), [zal], OPCJE))).toEqual([]);
  });
});

// ─── C. Formularze ──────────────────────────────────────────────────────────

type Wynik = {
  success: boolean;
  error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
};
const bledy = (r: Wynik): string[] =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
const maBlad = (lista: string[], sciezka: string) => lista.some((e) => e.startsWith(`${sciezka}: `));

const NAGLOWEK = {
  issueDate: '2026-11-14',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-28',
  seller: SPRZEDAWCA,
  buyer: NABYWCA,
};

const formZal = (o: Record<string, unknown> = {}) => ({
  ...NAGLOWEK,
  invoiceType: 'advance',
  internalNumber: 'ZAL/2026/11/1',
  bankAccount: '61109010140000071219812874',
  splitPayment: false,
  advanceAmount: 1230,
  totalContractAmount: 12300,
  vatRate: '23',
  description: 'Projekt strony internetowej',
  ...o,
});

const formRoz = (o: Record<string, unknown> = {}) => ({
  ...NAGLOWEK,
  invoiceType: 'final',
  internalNumber: 'FR/2026/11/1',
  bankAccount: '61109010140000071219812874',
  splitPayment: false,
  advanceInvoiceIds: ['00000000-0000-4000-8000-000000000002'],
  totalAdvances: 123,
  lines: pozycjaRoz({}),
  ...o,
});

const formKor = (o: Record<string, unknown> = {}) => ({
  ...NAGLOWEK,
  invoiceType: 'correction',
  internalNumber: 'KOR/2026/11/1',
  parentInvoiceId: '00000000-0000-4000-8000-000000000001',
  parentInvoiceNumber: 'FV/2026/09/1',
  parentInvoiceIssueDate: '2026-09-30',
  correctionType: 'before_after',
  correctionReason: 'Zmiana ilości po reklamacji',
  typKorekty: '2',
  linesBefore: [POZYCJA],
  linesAfter: po({}),
  ...o,
});

const kwotowa = (description: string) => ({
  correctionType: 'amount_change',
  linesBefore: undefined,
  linesAfter: undefined,
  amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description },
});

const BAZA_ZWYKLA: InvoiceFormValues = {
  internalNumber: 'FV/1/11/2026',
  issueDate: '2026-11-14',
  saleDate: '',
  buyerNip: NABYWCA.nip,
  buyerName: 'Klient',
  buyerAddressLine1: 'ul. Klienta 10',
  buyerAddressLine2: '02-001 Warszawa',
  buyerEmail: '',
  buyerIsConsumer: false,
  buyerPesel: '',
  buyerIdDocument: '',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-28',
  bankAccount: 'PL61109010140000071219812874',
  notes: '',
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
};

const zal = (o: Record<string, unknown>) => bledy(advanceInvoiceSchema.safeParse(formZal(o)));
const roz = (o: Record<string, unknown>) => bledy(finalInvoiceSchema.safeParse(formRoz(o)));
const kor = (o: Record<string, unknown>) => bledy(correctionInvoiceSchema.safeParse(formKor(o)));
const zw = (o: Partial<InvoiceFormValues>) => bledy(invoiceFormSchema.safeParse({ ...BAZA_ZWYKLA, ...o }));

describe('C1 C: formularze odmawiają tych samych wartości', () => {
  it('dane bazowe przechodzą wszystkie cztery formularze', () => {
    expect(zal({})).toEqual([]);
    expect(roz({})).toEqual([]);
    expect(kor({})).toEqual([]);
    expect(zw({})).toEqual([]);
  });

  it('ZAL: opis 502 znaki przechodzi, 503 nie (P_7 to „Zaliczka: ” i opis, razem najwyżej 512)', () => {
    expect(maBlad(zal({ description: tekst(502) }), 'description')).toBe(false);
    expect(maBlad(zal({ description: tekst(503) }), 'description')).toBe(true);
  });

  it('ZAL: błąd adresu nabywcy jest pod kluczem `buyer` i nazywa pole', () => {
    const lista = zal({ buyer: { ...NABYWCA, address: adres(tekst(513)) } });
    expect(lista.some((e) => e.startsWith('buyer: ') && e.includes('adres (linia 1)') && e.includes('512')), lista.join('\n')).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['opis z samych spacji', { description: '      ' }, 'description'],
    ['opis ze znakiem sterującym', { description: 'Projekt\u000Bstrony' }, 'description'],
    ['uwagi ze znakiem sterującym', { notes: 'Uwaga\u000B' }, 'notes'],
    ['nazwa nabywcy 513 znaków', { buyer: { ...NABYWCA, name: tekst(513) } }, 'buyer'],
    ['adres nabywcy (linia 2) z samych spacji', { buyer: { ...NABYWCA, address: adres('ul. Klienta 10', '   ') } }, 'buyer'],
    ['nazwa nabywcy ze znakiem sterującym', { buyer: { ...NABYWCA, name: 'Klient\u0001' } }, 'buyer'],
  ])('ZAL: %s', (_opis, zmiana, sciezka) => {
    const lista = zal(zmiana);
    expect(maBlad(lista, sciezka), lista.join('\n')).toBe(true);
  });

  it('ROZ: jednostka 50 znaków przechodzi (kolumna VARCHAR(50)), 51 nie', () => {
    expect(maBlad(roz({ lines: pozycjaRoz({ unit: tekst(50) }) }), 'lines.0.unit')).toBe(false);
    expect(maBlad(roz({ lines: pozycjaRoz({ unit: tekst(51) }) }), 'lines.0.unit')).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['jednostka z samych spacji', { lines: pozycjaRoz({ unit: '   ' }) }, 'lines.0.unit'],
    ['nazwa pozycji z samych spacji', { lines: pozycjaRoz({ name: '   ' }) }, 'lines.0.name'],
    ['nazwa pozycji ze znakiem sterującym', { lines: pozycjaRoz({ name: 'Usługa\u000Bwdrożeniowa' }) }, 'lines.0.name'],
    ['kod PKWiU 51 znaków', { lines: pozycjaRoz({ pkwiuCode: `${'A1'.repeat(25)}B` }) }, 'lines.0.pkwiuCode'],
    ['nazwa nabywcy 513 znaków', { buyer: { ...NABYWCA, name: tekst(513) } }, 'buyer'],
  ])('ROZ: %s', (_opis, zmiana, sciezka) => {
    const lista = roz(zmiana);
    expect(maBlad(lista, sciezka), lista.join('\n')).toBe(true);
  });

  it('KOR: przyczyna 256 znaków przechodzi, 257 nie (PrzyczynaKorekty w XSD: 256)', () => {
    expect(maBlad(kor({ correctionReason: tekst(256) }), 'correctionReason')).toBe(false);
    expect(maBlad(kor({ correctionReason: tekst(257) }), 'correctionReason')).toBe(true);
  });

  it('KOR: opis korekty kwotowej 512 znaków przechodzi, 513 nie', () => {
    expect(kor(kwotowa(tekst(512)))).toEqual([]);
    expect(maBlad(kor(kwotowa(tekst(513))), 'amountChange.description')).toBe(true);
  });

  it('KOR (W6): jednostka 50 znaków przechodzi, także w pozycjach faktury pierwotnej', () => {
    expect(maBlad(kor({ linesAfter: po({ unit: tekst(50) }) }), 'linesAfter.0.unit')).toBe(false);
    expect(correctionLineSchema.safeParse({ ...POZYCJA, unit: tekst(50) }).success).toBe(true);
    expect(correctionLineSchema.safeParse({ ...POZYCJA, unit: tekst(51) }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['przyczyna z samych spacji', { correctionReason: '      ' }, 'correctionReason'],
    ['przyczyna ze znakiem sterującym', { correctionReason: 'Zwrot\u000Btowaru' }, 'correctionReason'],
    ['numer faktury korygowanej 257 znaków', { parentInvoiceNumber: tekst(257) }, 'parentInvoiceNumber'],
    ['uwagi ze znakiem sterującym', { notes: 'Uwaga\u000B' }, 'notes'],
    ['opis korekty kwotowej z samych spacji', kwotowa('   '), 'amountChange.description'],
  ])('KOR: %s', (_opis, zmiana, sciezka) => {
    const lista = kor(zmiana);
    expect(maBlad(lista, sciezka), lista.join('\n')).toBe(true);
  });

  it.each<[string, Partial<InvoiceFormValues>, string]>([
    ['nazwa nabywcy z samych spacji', { buyerName: '   ' }, 'buyerName'],
    ['adres nabywcy (linia 1) z samych spacji', { buyerAddressLine1: '   ' }, 'buyerAddressLine1'],
    ['adres nabywcy (linia 2) z samych spacji', { buyerAddressLine2: '   ' }, 'buyerAddressLine2'],
    ['nazwa pozycji z samych spacji', { lines: [{ ...BAZA_ZWYKLA.lines[0]!, name: '   ' }] }, 'lines.0.name'],
    ['jednostka z samych spacji', { lines: [{ ...BAZA_ZWYKLA.lines[0]!, unit: '  ' }] }, 'lines.0.unit'],
    ['nazwa nabywcy z samotnym surogatem UTF-16', { buyerName: 'Klient \uD800' }, 'buyerName'],
  ])('faktura zwykła: %s', (_opis, zmiana, sciezka) => {
    const lista = zw(zmiana);
    expect(maBlad(lista, sciezka), lista.join('\n')).toBe(true);
  });
});
