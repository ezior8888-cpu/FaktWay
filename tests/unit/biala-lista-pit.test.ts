import { describe, expect, it } from 'vitest';

/**
 * RP-BL-01 po zmianie art. 22p ustawy o PIT (ustawa z 18.09.2026 r.,
 * Dz.U. 2026 poz. 1371, art. 1 pkt 2 i art. 3): zapłata ponad 15 000 zł na
 * rachunek spoza wykazu podatników VAT odbiera koszt w PIT tylko przy fakturze
 * wystawionej przed 1.01.2027, także gdy zapłata jest już w 2027 r. Od faktury
 * z 1.01.2027 zostaje sama solidarna odpowiedzialność za VAT i zawiadomienie
 * ZAW-NR. Liczy się dzień wystawienia faktury w Polsce (P_1 z faktury KSeF,
 * a bez niego data dokumentu kosztu), nie dzień zapłaty.
 *
 * Gotówka ponad 15 000 zł (płatność bez rachunku płatniczego) odbiera koszt
 * w PIT przed zmianą i po niej; uwaga tylko tam, gdzie faktura podaje gotówkę.
 *
 * Prawdziwe: reguła dnia, lista „Do zapłaty” (`listaDoZaplaty`) i teksty.
 */

type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

const NIP = '1234567890';
const KSEF = `${NIP}-20261231-0A1B2C3D4E01-7A`;
const DZIS_2027 = '2027-01-15';

/** Koszt ponad 15 000 zł z faktury KSeF; `p1` to data wystawienia z faktury (P_1). */
function wiersz(p1: string | null | undefined, pola: Partial<Wiersz> = {}): Wiersz {
  return {
    id: 'exp-1',
    seller_name: 'Dostawca sp. z o.o.',
    seller_nip: NIP,
    document_number: 'FV/12/2026',
    gross_amount: 20000,
    vat_amount: 3739.84,
    payment_due_date: '2027-01-20',
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2027-01-02T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    issue_date: p1 ?? null,
    faktura: { ksef_number: KSEF, internal_number: 'FV/12/2026', currency: 'PLN', issue_date: p1 },
    ...pola,
  };
}

async function modul() {
  return import('@/lib/expenses/biala-lista-pit');
}

async function pozycja(w: Wiersz, dzis = DZIS_2027) {
  const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
  const [p] = listaDoZaplaty([w], dzis).pozycje;
  expect(p).toBeDefined();
  return p!;
}

describe('dzień wystawienia faktury kosztowej (P_1, dzień w Polsce)', () => {
  it('P_1 z faktury KSeF ma pierwszeństwo przed datą dokumentu kosztu', async () => {
    const { dzienWystawieniaKosztu } = await modul();
    expect(dzienWystawieniaKosztu({ issue_date: '2027-01-02', faktura: { issue_date: '2026-12-31' } })).toBe('2026-12-31');
    expect(dzienWystawieniaKosztu({ issue_date: '2026-12-30', faktura: { issue_date: '2027-01-01' } })).toBe('2027-01-01');
  });

  it('bez daty z faktury (albo bez faktury): data dokumentu kosztu', async () => {
    const { dzienWystawieniaKosztu } = await modul();
    expect(dzienWystawieniaKosztu({ issue_date: '2027-01-05', faktura: { issue_date: null } })).toBe('2027-01-05');
    expect(dzienWystawieniaKosztu({ issue_date: '2027-01-05', faktura: null })).toBe('2027-01-05');
    expect(dzienWystawieniaKosztu({ issue_date: '2026-12-31' })).toBe('2026-12-31');
  });

  it('nieczytelna data z faktury: data dokumentu kosztu; obie nieczytelne: brak dnia', async () => {
    const { dzienWystawieniaKosztu } = await modul();
    expect(dzienWystawieniaKosztu({ issue_date: '2027-01-05', faktura: { issue_date: '31.12.2026' } })).toBe('2027-01-05');
    expect(dzienWystawieniaKosztu({ issue_date: '2026-02-30', faktura: { issue_date: '' } })).toBeNull();
    expect(dzienWystawieniaKosztu({})).toBeNull();
  });

  it('granica dnia w Europe/Warsaw: 22:59:59 UTC 31.12.2026 to jeszcze 31.12, 23:00 UTC to już 1.01.2027', async () => {
    const { dzienWystawieniaKosztu } = await modul();
    expect(dzienWystawieniaKosztu({ faktura: { issue_date: '2026-12-31T22:59:59Z' } })).toBe('2026-12-31');
    expect(dzienWystawieniaKosztu({ faktura: { issue_date: '2026-12-31T23:00:00Z' } })).toBe('2027-01-01');
    expect(dzienWystawieniaKosztu({ faktura: { issue_date: '2026-12-31T23:59:59+01:00' } })).toBe('2026-12-31');
    expect(dzienWystawieniaKosztu({ faktura: { issue_date: '2027-01-01T00:00:00+01:00' } })).toBe('2027-01-01');
    // Bez strefy to czas polski: 23:59 31 grudnia zostaje 31 grudnia.
    expect(dzienWystawieniaKosztu({ faktura: { issue_date: '2026-12-31T23:59:00' } })).toBe('2026-12-31');
  });
});

describe('czy rachunek spoza wykazu odbiera koszt w PIT', () => {
  it('faktura z 31.12.2026: tak (art. 22p w brzmieniu dotychczasowym)', async () => {
    const { rachunekSpozaWykazuOdbieraKosztPit, PIT_BEZ_SANKCJI_BIALEJ_LISTY_OD } = await modul();
    expect(PIT_BEZ_SANKCJI_BIALEJ_LISTY_OD).toBe('2027-01-01');
    expect(rachunekSpozaWykazuOdbieraKosztPit('2026-12-31')).toBe(true);
    expect(rachunekSpozaWykazuOdbieraKosztPit('2025-06-30')).toBe(true);
  });

  it('faktura z 1.01.2027 i później: nie', async () => {
    const { rachunekSpozaWykazuOdbieraKosztPit } = await modul();
    expect(rachunekSpozaWykazuOdbieraKosztPit('2027-01-01')).toBe(false);
    expect(rachunekSpozaWykazuOdbieraKosztPit('2027-12-31')).toBe(false);
  });

  it('bez dnia wystawienia: tak, ostrzeżenie zostaje (fail-closed)', async () => {
    const { rachunekSpozaWykazuOdbieraKosztPit } = await modul();
    expect(rachunekSpozaWykazuOdbieraKosztPit(null)).toBe(true);
  });
});

describe('lista „Do zapłaty”: skutek w PIT według dnia wystawienia, nie zapłaty', () => {
  it('faktura z 31.12.2026 płacona 15.01.2027: dawne zasady, koszt w PIT zagrożony', async () => {
    const p = await pozycja(wiersz('2026-12-31'));
    expect(p.wymagaBialejListy).toBe(true);
    expect(p.sankcjaPitBialejListy).toBe(true);
  });

  it('faktura z 1.01.2027: bez skutku w PIT (VAT zostaje, sprawdzenie rachunku dalej wymagane)', async () => {
    const p = await pozycja(wiersz('2027-01-01'));
    expect(p.wymagaBialejListy).toBe(true);
    expect(p.sankcjaPitBialejListy).toBe(false);
  });

  it('dzień zapłaty nie zmienia wyniku: faktura z 31.12.2026 płacona w marcu 2027 i z 2.01.2027 płacona tego dnia', async () => {
    expect((await pozycja(wiersz('2026-12-31', { payment_due_date: '2027-03-31' }), '2027-03-01')).sankcjaPitBialejListy).toBe(true);
    expect((await pozycja(wiersz('2027-01-02', { payment_due_date: '2027-01-02' }), '2027-01-02')).sankcjaPitBialejListy).toBe(false);
  });

  it('P_1 z 31.12.2026, a data kosztu poprawiona na 2.01.2027: liczy się P_1', async () => {
    const p = await pozycja(wiersz('2026-12-31', { issue_date: '2027-01-02' }));
    expect(p.sankcjaPitBialejListy).toBe(true);
  });

  it('faktura bez daty wystawienia: data kosztu; bez obu dat: dawne zasady', async () => {
    const zDatyKosztu = wiersz(null, { issue_date: '2027-01-04' });
    expect((await pozycja(zDatyKosztu)).sankcjaPitBialejListy).toBe(false);
    const bezDat = wiersz(undefined, { issue_date: undefined });
    expect((await pozycja(bezDat)).sankcjaPitBialejListy).toBe(true);
  });

  it('znacznik czasu z 23:30 UTC 31.12.2026 to w Polsce 1.01.2027: bez skutku w PIT', async () => {
    expect((await pozycja(wiersz('2026-12-31T23:30:00Z'))).sankcjaPitBialejListy).toBe(false);
    expect((await pozycja(wiersz('2026-12-31T22:30:00Z'))).sankcjaPitBialejListy).toBe(true);
  });
});

describe('teksty skutków rachunku spoza wykazu', () => {
  it('faktura sprzed 2027: PIT, VAT i ZAW-NR w 7 dni (tekst jak dotąd)', async () => {
    const { skutkiRachunkuSpozaWykazu } = await modul();
    expect(skutkiRachunkuSpozaWykazu(true)).toBe(
      'Zapłata ponad 15 000 zł na rachunek spoza wykazu oznacza, że tej kwoty nie zaliczysz do kosztów w PIT ' +
        'i odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę, chyba że w ciągu 7 dni od zlecenia przelewu ' +
        'zawiadomisz naczelnika właściwego urzędu skarbowego (formularz ZAW-NR).',
    );
  });

  it('faktura od 1.01.2027: VAT i ZAW-NR zostają, bez zdania o PIT', async () => {
    const { skutkiRachunkuSpozaWykazu } = await modul();
    const tekst = skutkiRachunkuSpozaWykazu(false);
    expect(tekst).not.toMatch(/PIT|koszt/);
    expect(tekst).toMatch(/odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę/);
    expect(tekst).toMatch(/w ciągu 7 dni od zlecenia przelewu/);
    expect(tekst).toMatch(/ZAW-NR/);
  });

  it('bez długich myślników i bez trybu rozkazującego', async () => {
    const { skutkiRachunkuSpozaWykazu, UWAGA_GOTOWKA } = await modul();
    for (const tekst of [skutkiRachunkuSpozaWykazu(true), skutkiRachunkuSpozaWykazu(false), UWAGA_GOTOWKA]) {
      expect(tekst).not.toMatch(/[—–]/);
      expect(tekst).not.toMatch(/\b[Zz]apłać\b/);
    }
  });
});

describe('gotówka ponad 15 000 zł: uwaga tylko przy formie płatności „gotówka” z faktury', () => {
  const terminy = (forma?: unknown) => ({
    zrodlo: 'ksef_xml',
    odczytano: '2027-01-02T10:00:00.000Z',
    liczbaTerminow: 1,
    problemy: [],
    ...(forma === undefined ? {} : { formaPlatnosci: forma }),
  });

  it('FormaPlatnosci 1 i brutto 20 000 zł: uwaga o kosztach w PIT, przy fakturze z 2026 i z 2027', async () => {
    const { UWAGA_GOTOWKA } = await modul();
    for (const p1 of ['2026-12-31', '2027-01-01']) {
      const p = await pozycja(wiersz(p1, { payment_terms: terminy('1') }));
      expect(p.uwagi).toContain(UWAGA_GOTOWKA);
    }
    expect(UWAGA_GOTOWKA).toMatch(/gotówk/);
    expect(UWAGA_GOTOWKA).toMatch(/nie zaliczysz do kosztów w PIT/);
  });

  it('15 000,00 zł to jeszcze nie „ponad 15 000 zł”; przelew (6), brak formy i dane spoza pliku: bez uwagi', async () => {
    const { UWAGA_GOTOWKA } = await modul();
    const bez = [
      wiersz('2027-01-01', { gross_amount: 15000, payment_terms: terminy('1') }),
      wiersz('2027-01-01', { payment_terms: terminy('6') }),
      wiersz('2027-01-01', { payment_terms: terminy() }),
      wiersz('2027-01-01', { payment_terms: terminy(1) }),
      wiersz('2027-01-01', { payment_terms: null }),
    ];
    for (const w of bez) expect((await pozycja(w)).uwagi).not.toContain(UWAGA_GOTOWKA);
  });
});
