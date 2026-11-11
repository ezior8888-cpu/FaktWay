import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';

import {
  groszeZKwotyPolskiej,
  groszeZKwotySwift,
  groszeZKwotyXml,
  groszeZLiczbyGroszy,
} from '@/lib/import/bank/kwoty';
import { nrbZNumeruBankuIRachunku, rachunekZnormalizowany } from '@/lib/import/bank/rachunek';
import { parseBankFile } from '@/lib/import/bank';

/**
 * Parsery wyciągów bankowych (plan kompletnej aplikacji, krok 3.2, część 1).
 * Przykłady są zbudowane według specyfikacji banków (źródła w nagłówkach
 * parserów) i zanonimizowane: rachunki z przykładów dokumentacji, nazwy
 * i tytuły zmyślone, NIP testowy 1234567890. Kwoty liczymy w groszach na
 * liczbach całkowitych.
 */

const RACHUNEK = 'PL61109010140000071219812874';
const KONTRAHENT = 'PL27114020040000300201355387';

const bajty = (text: string, encoding: string) => new Uint8Array(iconv.encode(text, encoding));
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

describe('kwoty w groszach', () => {
  it.each([
    ['-1 234,56', -123456],
    ['1 234,56', 123456],
    ['12 345 678,90', 1234567890],
    ['1234,5', 123450],
    ['1234', 123400],
    ['0,07', 7],
    ['+15,00', 1500],
    ['\u22125,00', -500],
    ['1\u00A0234,56', 123456],
    ['1\u202F234,56', 123456],
    ['  -0,30 ', -30],
  ])('zapis polski %s', (text, grosze) => {
    expect(groszeZKwotyPolskiej(text)).toBe(grosze);
  });

  it.each(['', 'abc', ',50', '1,234,56', '1 23,45', '1.234,56', '12,345', '1234.56', '- 5,00', '1 2345,00', '99999999999999999999'])(
    'zapis polski odrzuca %j',
    (text) => {
      expect(groszeZKwotyPolskiej(text)).toBeNull();
    },
  );

  it('SWIFT: przecinek zawsze, najwyżej dwa miejsca', () => {
    expect(groszeZKwotySwift('449,77')).toBe(44977);
    expect(groszeZKwotySwift('10000,')).toBe(1000000);
    expect(groszeZKwotySwift('0,5')).toBe(50);
    expect(groszeZKwotySwift('123456789101,45')).toBe(12345678910145);
    for (const bad of ['449', '449,777', '-1,00', '1.00', '', ',']) expect(groszeZKwotySwift(bad), bad).toBeNull();
  });

  it('XML ISO 20022: kropka, najwyżej dwa miejsca, bez zgadywania', () => {
    expect(groszeZKwotyXml('490879.24')).toBe(49087924);
    expect(groszeZKwotyXml('20')).toBe(2000);
    expect(groszeZKwotyXml('3.5')).toBe(350);
    for (const bad of ['1.005', '1,00', '-1.00', '1e3', '', ' ']) expect(groszeZKwotyXml(bad), bad).toBeNull();
  });

  it('liczba groszy (PKO BP Elixir)', () => {
    expect(groszeZLiczbyGroszy('8800')).toBe(8800);
    expect(groszeZLiczbyGroszy('0')).toBe(0);
    for (const bad of ['88,00', '-1', '', '1234567890123456']) expect(groszeZLiczbyGroszy(bad), bad).toBeNull();
  });
});

describe('numer rachunku', () => {
  it('NRB, IBAN ze spacjami i z ukośnikiem dają ten sam zapis', () => {
    expect(rachunekZnormalizowany('61109010140000071219812874')).toBe(RACHUNEK);
    expect(rachunekZnormalizowany(' /PL61 1090 1014 0000 0712 1981 2874')).toBe(RACHUNEK);
    expect(rachunekZnormalizowany('pl61109010140000071219812874')).toBe(RACHUNEK);
    expect(rachunekZnormalizowany('DE89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(rachunekZnormalizowany('')).toBeNull();
    expect(rachunekZnormalizowany('12')).toBeNull();
  });

  it('cyfry kontrolne NRB z numeru banku i rachunku (pola ~30 i ~31)', () => {
    expect(nrbZNumeruBankuIRachunku('10901014', '0000071219812874')).toBe(RACHUNEK);
    expect(nrbZNumeruBankuIRachunku('1090101', '0000071219812874')).toBeNull();
  });
});

// ─── MT940 ───────────────────────────────────────────────────────────────
// PKO BP: „Struktura plików wyjściowych. Raporty plikowe iPKO biznes”, wersja 10,
// raport MT940: CP852, podpola :86: po tyldzie, tytuł ~20-~25 po 27 znaków,
// kontrahent ~32-~33, IBAN ~38, puste podpole = znak ASCII 255.

/** Bajt 0xFF w CP852 to U+00A0; w ISO 8859-2 i Windows-1250 to „˙” (U+02D9). */
const PUSTE = '\u00A0';
/** Podpola po 27 znaków: dłuższy tekst przechodzi do następnego bez spacji. */
function podpola(start: number, text: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = text.slice(i * 27, (i + 1) * 27);
    out.push(`~${start + i}${part === '' ? PUSTE : part}`);
  }
  return out;
}

function pkoOperacja(opts: { sign: 'C' | 'D'; amount: string; title: string; name: string; iban: string; id: string }): string[] {
  return [
    `:61:2611051105${opts.sign}${opts.amount}N150NONREF//${opts.id}`,
    '150 0',
    ':86:020~00150',
    ...podpola(20, opts.title, 6),
    '~3011402004',
    '~310000300201355387',
    ...podpola(32, opts.name, 2),
    `~38${opts.iban}`,
    `~60${PUSTE}`,
    '~63SWRK 12282222444466668888',
  ];
}

const PKO_MT940 = [
  '',
  ':20:MT940',
  `:25:/${RACHUNEK}`,
  ':28C:105',
  ':60F:C261104PLN14541,28',
  ...pkoOperacja({
    sign: 'C',
    amount: '12345,67',
    title: 'Zapłata za fakturę FV/12/11/2026 dziękujemy',
    name: 'ŻÓŁTA ŁÓDŹ SP. Z O.O. UL. KRÓTKA 1 00-950 WARSZAWA',
    iban: KONTRAHENT,
    id: '3370500600001400',
  }),
  ...pkoOperacja({
    sign: 'D',
    amount: '1234,56',
    title: 'Opłata za przelew',
    name: 'Ćma Ęś',
    iban: KONTRAHENT,
    id: '3370500600001401',
  }),
  ':62F:C261105PLN25652,39',
  ':64:C261105PLN25652,39',
  '-',
].join('\r\n');

// mBank: „Opis formatu pliku wyciągów dziennych MT940”, wersja 1.3 (12.11.2020):
// ISO 8859-2, :61: z trzecią literą waluty, :86: jako tekst z kluczami
// („z rach.:”, „od:”, „tyt.:”, „TNR:”) rozdzielanymi średnikiem.
const MBANK_MT940 = [
  '\u0001',
  ':20:ST261105CYC/1',
  `:25:${RACHUNEK}`,
  ':28C:8/1',
  ':60F:C261104PLN60213,04',
  ':61:2611051105CN1230,00NTRFNONREF//BR26110539000001',
  '973-PRZELEW PRZYCH.',
  ':86:973 Przelew przychodzący; z rach.: 27114020040000300201355387; od: Źródło Wiedzy Sp. z o.o. ul. Długa 5 00-950 Warszawa; tyt.: FV/7/11/2026; TNR: 145271016138277.020002',
  ':61:2611051105DN2,50NCHGNONREF//BR26110539000001',
  '824-OPŁ. ZA PRZEL. ELIXIR MT',
  ':86:824 OPŁATA ZA PRZELEW ELIXIR; TNR: 145271016138274.040001',
  ':62F:C261105PLN61440,54',
  '-\u0003',
].join('\n');

// ING Bank Śląski: „Opis formatów plików importu i eksportu wykorzystywanych w ING
// Business”, wersja 1.20A, rozdział 8: CP852, kod operacji „S” + 3 cyfry, kilka
// pól :86: na operację, podpola także w jednej linii, linia informacyjna S940.
const ING_MT940 = [
  ':20:MT940',
  `:25: /${RACHUNEK}`,
  ':28C: 00001',
  ':60F:C261104PLN100,00',
  ':61:2611051105C1000,00S07697201080012',
  ':86:076',
  ':86:076~00COCGPRZELEW',
  '~20FAKTURA FV/9/11/2026',
  '~21~22',
  '~23~24',
  '~25',
  '~2927114020040000300201355387~3011402004',
  '~310000300201355387~32KONTRAHENT SP. Z O.O.',
  '~33',
  '~34076',
  `~38${KONTRAHENT}`,
  '~62UL. GRZYBOWSKA 12',
  '~6300-950 WARSZAWA',
  ':61:2611051105C0,00S940NONREF',
  ':86:940~00Informacje szczegółowe:',
  ':86:940~20Saldo dost.:1100,00~21Saldo bież.:1100,00',
  ':62F:C261105PLN1100,00',
  ':64:C261105PLN1100,00',
  ':86:NAME ACCOUNT OWNER:FIRMA TESTOWA',
  'ACCOUNT DESCRIPTION:CURRENT ACCOUNT',
].join('\r\n');

describe('MT940', () => {
  it('PKO BP (CP852): uznanie i obciążenie, tysiące, polskie znaki, tytuł z podpól po 27 znaków', () => {
    const result = parseBankFile(bajty(PKO_MT940, 'cp852'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('mt940');
    expect(result.operations).toEqual([
      {
        account: RACHUNEK,
        bookingDate: '2026-11-05',
        valueDate: '2026-11-05',
        amountGrosze: 1234567,
        currency: 'PLN',
        counterpartyName: 'ŻÓŁTA ŁÓDŹ SP. Z O.O. UL. KRÓTKA 1 00-950 WARSZAWA',
        counterpartyAccount: KONTRAHENT,
        title: 'Zapłata za fakturę FV/12/11/2026 dziękujemy',
        bankReference: '3370500600001400',
      },
      expect.objectContaining({ amountGrosze: -123456, title: 'Opłata za przelew', counterpartyName: 'Ćma Ęś' }),
    ]);
  });

  it('mBank (ISO 8859-2): tekst z kluczami, trzecia litera waluty, opłata jako obciążenie', () => {
    const result = parseBankFile(bajty(MBANK_MT940, 'iso-8859-2'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toEqual([
      expect.objectContaining({
        account: RACHUNEK,
        bookingDate: '2026-11-05',
        amountGrosze: 123000,
        currency: 'PLN',
        counterpartyName: 'Źródło Wiedzy Sp. z o.o. ul. Długa 5 00-950 Warszawa',
        counterpartyAccount: KONTRAHENT,
        title: 'FV/7/11/2026',
        bankReference: 'BR26110539000001',
      }),
      expect.objectContaining({ amountGrosze: -250, title: 'OPŁATA ZA PRZELEW ELIXIR' }),
    ]);
  });

  it('ING (CP852): kilka pól :86:, podpola w jednej linii, linia informacyjna S940 pominięta', () => {
    const result = parseBankFile(bajty(ING_MT940, 'cp852'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toEqual(
      expect.objectContaining({
        account: RACHUNEK,
        amountGrosze: 100000,
        title: 'FAKTURA FV/9/11/2026',
        counterpartyAccount: KONTRAHENT,
        counterpartyName: 'KONTRAHENT SP. Z O.O. UL. GRZYBOWSKA 12 00-950 WARSZAWA',
      }),
    );
    expect(result.skipped).toBe(1);
  });

  it('rok daty księgowania na przełomie roku bierze się z daty waluty', () => {
    const text = [':20:MT940', `:25:/${RACHUNEK}`, ':60F:C261231PLN0,00', ':61:2612310102C5,00N150NONREF//1', ':86:020~00150', '~20Tytuł', ':62F:C270102PLN5,00', '-'].join('\n');
    const result = parseBankFile(utf8(text));
    expect(result.ok && result.operations[0]?.bookingDate).toBe('2027-01-02');
    expect(result.ok && result.operations[0]?.valueDate).toBe('2026-12-31');
  });

  it('linia :61: spoza formatu to odmowa całego pliku, a nie zgadywanie kwoty', () => {
    const text = [':20:MT940', `:25:/${RACHUNEK}`, ':60F:C261104PLN0,00', ':61:2611051105C12.345,67N150NONREF', ':62F:C261105PLN0,00', '-'].join('\n');
    expect(parseBankFile(utf8(text))).toEqual({ ok: false, code: 'invalid_file' });
  });
});

// ─── CAMT.053 ────────────────────────────────────────────────────────────
// ISO 20022 camt.053.001.02 (przykład z dokumentacji iPKO biznes, wersja 10,
// i ING Business 1.20A, rozdział 10) oraz camt.053.001.08 (mBank, „Opis formatu
// pliku eksportu wyciągów dziennych camt.053.001.08”): Ntry/Amt, CdtDbtInd,
// BookgDt, ValDt, AcctSvcrRef, RltdPties/Dbtr (w .08 Dbtr/Pty), RmtInf/Ustrd.

function camt(version: '02' | '08', entries: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}">
<BkToCstmrStmt><GrpHdr><MsgId>CAMT1</MsgId><CreDtTm>2026-11-06T08:00:00+01:00</CreDtTm></GrpHdr>
<Stmt><Id>S1</Id><Acct><Id><IBAN>${RACHUNEK}</IBAN></Id><Ccy>PLN</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="PLN">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-04</Dt></Dt></Bal>
${entries}
</Stmt></BkToCstmrStmt></Document>`;
}

const CAMT_02 = camt(
  '02',
  `<Ntry><Amt Ccy="PLN">20.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>false</RvslInd><Sts>BOOK</Sts>
<BookgDt><Dt>2026-11-05</Dt></BookgDt><ValDt><Dt>2026-11-05</Dt></ValDt><AcctSvcrRef>8190502200005582</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>DOSTAWCA SP. Z O.O.</Nm></Cdtr><CdtrAcct><Id><IBAN>PL29105010251000009098143861</IBAN></Id></CdtrAcct></RltdPties>
<RmtInf><Ustrd>FAKTURA ZAKUPU 7/2026</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="PLN">12345.67</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>false</RvslInd><Sts>BOOK</Sts>
<BookgDt><Dt>2026-11-05</Dt></BookgDt><ValDt><Dt>2026-11-05</Dt></ValDt><AcctSvcrRef>8190502100006441</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Żółta Łódź &amp; Syn</Nm></Dbtr><DbtrAcct><Id><IBAN>${KONTRAHENT}</IBAN></Id></DbtrAcct></RltdPties>
<RmtInf><Ustrd>PRZELEW ZA FAKTURĘ</Ustrd><Ustrd>FV/12/11/2026</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="PLN">99.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-11-05</Dt></BookgDt></Ntry>`,
);

const CAMT_08 = camt(
  '08',
  `<Ntry><Amt Ccy="PLN">1230.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><DtTm>2026-11-05T10:15:00+01:00</DtTm></BookgDt><ValDt><Dt>2026-11-05</Dt></ValDt><AcctSvcrRef>REF-08</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>Nabywca Testowy</Nm></Pty></Dbtr><DbtrAcct><Id><Othr><Id>27114020040000300201355387</Id></Othr></Id></DbtrAcct></RltdPties>
<RmtInf><Ustrd>1234567890-20261105-0A1B2C3D4E5F-6A</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`,
);

describe('CAMT.053', () => {
  it('camt.053.001.02: obciążenie i uznanie, tysiące, encje XML, kilka linii tytułu, operacja oczekująca pominięta', () => {
    const result = parseBankFile(utf8(CAMT_02));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('camt053');
    expect(result.operations).toEqual([
      expect.objectContaining({ amountGrosze: -2000, counterpartyName: 'DOSTAWCA SP. Z O.O.', title: 'FAKTURA ZAKUPU 7/2026' }),
      {
        account: RACHUNEK,
        bookingDate: '2026-11-05',
        valueDate: '2026-11-05',
        amountGrosze: 1234567,
        currency: 'PLN',
        counterpartyName: 'Żółta Łódź & Syn',
        counterpartyAccount: KONTRAHENT,
        title: 'PRZELEW ZA FAKTURĘ FV/12/11/2026',
        bankReference: '8190502100006441',
      },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('camt.053.001.08: Dbtr/Pty/Nm, rachunek w Othr, data z DtTm w strefie Warszawy', () => {
    const result = parseBankFile(utf8(CAMT_08));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toEqual([
      expect.objectContaining({
        bookingDate: '2026-11-05',
        amountGrosze: 123000,
        counterpartyName: 'Nabywca Testowy',
        counterpartyAccount: KONTRAHENT,
        title: '1234567890-20261105-0A1B2C3D4E5F-6A',
      }),
    ]);
  });

  it('kwota z trzema miejscami po przecinku albo DOCTYPE to odmowa pliku', () => {
    expect(parseBankFile(utf8(CAMT_08.replace('1230.00', '1230.005')))).toEqual({ ok: false, code: 'invalid_file' });
    const doctype = CAMT_08.replace('<Document', '<!DOCTYPE x [<!ENTITY a "b">]><Document');
    expect(parseBankFile(utf8(doctype))).toEqual({ ok: false, code: 'invalid_file' });
  });
});

// ─── CSV: PKO BP (raport plikowy Elixir) ─────────────────────────────────
// PKO BP, „Struktura plików wyjściowych. Raporty plikowe iPKO biznes”, wersja 10,
// raport Elixir: Windows-1250, przecinek, tekst w cudzysłowie, podpola po „|”,
// 111 = uznanie, 222 = obciążenie, kwota w groszach, data RRRRMMDD.
const PKO_ELIXIR = [
  `111,20261105,1234567,11402004,10901014,"${KONTRAHENT}","61109010140000071219812874","ŻÓŁTA ŁÓDŹ SP. Z O.O.|UL. KRÓTKA 1|00-950 WARSZAWA|","|||",00000000,10901014,"Zapłata za fakturę numer FV/12/11/20|26|||","","3370523300000016","",""`,
  `222,20261105,123456,10901014,10101010,"PL49101010100160562221000000","61109010140000071219812874","DOSTAWCA SP. Z O.O.|||","|||",00000000,10101010,"FAKTURA 77/2026|||","","3170516000000251","",""`,
  `222,20261105,200,,10901014,"","61109010140000071219812874","|||","|||",00000000,10901014,"PROW.ZA PRZEL.|||","","3430500500001085","",""`,
].join('\r\n');

describe('CSV PKO BP (Elixir)', () => {
  it('Windows-1250: uznanie i obciążenia, kwota w groszach, polskie znaki, podpola po „|”', () => {
    const result = parseBankFile(bajty(PKO_ELIXIR, 'win1250'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('csv_pko_elixir');
    expect(result.operations).toEqual([
      {
        account: RACHUNEK,
        bookingDate: '2026-11-05',
        valueDate: '2026-11-05',
        amountGrosze: 1234567,
        currency: 'PLN',
        counterpartyName: 'ŻÓŁTA ŁÓDŹ SP. Z O.O. UL. KRÓTKA 1 00-950 WARSZAWA',
        counterpartyAccount: KONTRAHENT,
        // Pierwsze podpole tytułu ma pełne 35 znaków, więc dalszy ciąg dochodzi bez spacji.
        title: 'Zapłata za fakturę numer FV/12/11/2026',
        bankReference: '3370523300000016',
      },
      expect.objectContaining({ amountGrosze: -123456, counterpartyName: 'DOSTAWCA SP. Z O.O.' }),
      expect.objectContaining({ amountGrosze: -200, counterpartyName: null, counterpartyAccount: null, title: 'PROW.ZA PRZEL.' }),
    ]);
  });

  it('wiersz z inną liczbą pól albo zła data to odmowa całego pliku', () => {
    expect(parseBankFile(utf8(`111,20261105,100,"a"`))).toEqual({ ok: false, code: 'unknown_format' });
    const zlaData = PKO_ELIXIR.replace('111,20261105', '111,20261341');
    expect(parseBankFile(bajty(zlaData, 'win1250'))).toEqual({ ok: false, code: 'invalid_file' });
  });
});

describe('rozpoznanie pliku', () => {
  it('pusty, nieznany i CSV innego banku: odmowa z kodem', () => {
    expect(parseBankFile(new Uint8Array())).toEqual({ ok: false, code: 'empty' });
    expect(parseBankFile(utf8('#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Kwota;\n2026-11-05;2026-11-05;PRZELEW;FV 1;-1 234,56;'))).toEqual({ ok: false, code: 'unknown_format' });
    expect(parseBankFile(utf8('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02"><BkToCstmrAcctRpt/></Document>'))).toEqual({ ok: false, code: 'unknown_format' });
  });
});
