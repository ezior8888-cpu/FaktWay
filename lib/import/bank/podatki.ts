/**
 * Przelewy do ZUS i urzędu skarbowego z wyciągu (plan kompletnej aplikacji,
 * krok 3.2, część 2): rozpoznanie po rachunku odbiorcy, odczyt symbolu
 * formularza i okresu z tytułu przelewu na mikrorachunek, propozycja zapłaty
 * rozliczenia modułu księgowości i teksty ekranu „Bank”. Czyste funkcje bez
 * importów serwerowych: biorą je akcje, strona i komponent kliencki.
 *
 * Rachunków tu nie liczymy: mikrorachunek liczy `mikrorachunekZNip`, a rachunek
 * składkowy ZUS jest w ustawieniach podatkowych (te same, które ekran
 * „Ten miesiąc” pokazuje jako dane do przelewu). Tu je tylko porównujemy.
 *
 * Zapis w tytule przelewu na mikrorachunek (źródła):
 *  - okres: rozporządzenie Ministra Finansów i Gospodarki z 8.04.2026 r.
 *    w sprawie wzoru formularza wpłaty gotówkowej oraz polecenia przelewu na
 *    rachunek organu podatkowego (Dz. U. poz. 537), załącznik nr 2, pole 11:
 *    rok RR, typ okresu (R rok, K kwartał, M miesiąc, D dekada, J dzień)
 *    i numer okresu bez znaków rozdzielających: 25R, 25K03, 25M02, 25D0207,
 *    25J0703. P (półrocze) czytamy też: ma je wcześniejszy wzór, który wolno
 *    stosować jeszcze 6 miesięcy (§ 2), i opisy formatów banków;
 *  - symbol formularza: rozporządzenie MFiG z 25.09.2025 r. w sprawie rodzajów
 *    podatków, opłat lub niepodatkowych należności budżetowych, których wpłata
 *    jest realizowana przy użyciu mikrorachunku podatkowego (Dz. U. poz. 1305),
 *    załącznik, części II (PIT) i III (VAT);
 *  - pola `/TI/`, `/OKR/`, `/SFP/`, `/TXT/`: przelew podatkowy w formacie
 *    Elixir, np. Nest Bank, „Import przelewów” (ELIXIR-0, pole 12):
 *    „/TI/N…/OKR/19R/SFP/VAT-7/TXT/podatek”.
 * Okres i symbol bez pól (np. „PPE 26M01”) czytamy tylko w zapisie MF i tylko
 * wtedy, gdy w tytule jest jeden okres i jeden symbol.
 */

import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';
import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';

import { groszeZBazy } from './ekran';
import { rachunekZnormalizowany } from './rachunek';
import { foldText } from './tekst';

// ─── Rozpoznanie po rachunku ─────────────────────────────────────────────

/** Rodzaj przelewu podatkowego; ta sama lista stoi w CHECK-u `payment_imports.tax_kind` (00186). */
export const RODZAJE_PRZELEWU = ['zus', 'us'] as const;
export type RodzajPrzelewu = (typeof RODZAJE_PRZELEWU)[number];

export interface KontaPodatkowe {
  /** Rachunki składkowe ZUS (26 cyfr) ze wszystkich wersji ustawień podatkowych. */
  zus: readonly string[];
  /** Mikrorachunek podatkowy z NIP firmy (26 cyfr) albo `null` bez poprawnego NIP. */
  us: string | null;
}

const cyfry = (rachunek: string | null): string | null => {
  const pl = rachunekZnormalizowany(rachunek);
  return pl && /^PL\d{26}$/.test(pl) ? pl.slice(2) : null;
};

/** Przelew do ZUS po rachunku składkowym firmy, do urzędu po jej mikrorachunku; inny rachunek to `null`. */
export function rodzajPrzelewu(rachunekOdbiorcy: string | null, konta: KontaPodatkowe): RodzajPrzelewu | null {
  const numer = cyfry(rachunekOdbiorcy);
  if (!numer) return null;
  if (konta.zus.some((nrs) => cyfry(nrs) === numer)) return 'zus';
  if (konta.us && cyfry(konta.us) === numer) return 'us';
  return null;
}

// ─── Odczyt tytułu ───────────────────────────────────────────────────────

export type TypOkresu = 'R' | 'P' | 'K' | 'M' | 'D' | 'J';

export interface OkresWplaty {
  /** Zapis z tytułu, np. „26M01”. */
  zapis: string;
  typ: TypOkresu;
  rok: number;
  /** RRRR-MM, gdy okres to miesiąc; inny typ okresu to `null`. */
  miesiac: string | null;
}

/** Rozliczenie modułu, do którego może należeć symbol: ryczałt, zaliczka PIT, VAT miesięczny. */
export type PodatekZSymbolu = 'ryczalt' | 'pit' | 'vat';

export interface OdczytTytulu {
  /** Symbol w zapisie z wykazu MF („PIT-28”, „JPK-V7M”) albo taki, jaki stoi w tytule. */
  symbol: string | null;
  /** Rozliczenie, którego symbol dotyczy; `null` dla innych podatków i deklaracji kwartalnych. */
  podatek: PodatekZSymbolu | null;
  /** Symbol jest w wykazie MF (Dz. U. 2025 poz. 1305, części II i III). */
  wWykazieMf: boolean;
  okres: OkresWplaty | null;
  /** Dwa różne okresy albo symbole w tytule: żadnego nie uznajemy. */
  niejednoznaczny: boolean;
  /** Skąd odczyt: pola /OKR/ i /SFP/ albo sam tekst tytułu. */
  zrodlo: 'pola' | 'tekst' | null;
}

/** Symbole, które dotyczą rozliczeń modułu (wykaz MF, części II i III). */
const PODATEK_SYMBOLU: Readonly<Record<string, PodatekZSymbolu>> = {
  PPE: 'ryczalt',
  'PIT-28': 'ryczalt',
  PIT: 'pit',
  PPL: 'pit',
  'PIT-36': 'pit',
  'PIT-36L': 'pit',
  'VAT-7': 'vat',
  'JPK-V7M': 'vat',
};

/** Pozostałe symbole części II (PIT) i III (VAT) wykazu MF: znane, ale poza rozliczeniami miesięcznymi modułu. */
const INNE_SYMBOLE_MF = new Set([
  'PIT-4R', 'PIT-7', 'PIT-8AR', 'PIT-28S', 'PIT-36LS', 'PIT-36S', 'PIT-37', 'PIT-38', 'PIT-39', 'PIT-CFC', 'PIT-ISN',
  'PIT-NZ', 'PIT-NZS', 'PIT-PZ', 'PIT-STD', 'PPD', 'PPW', 'TWPOD',
  'JPK-V7K', 'VAT-7D', 'VAT-7K', 'VAT-8', 'VAT-9M', 'VAT-10', 'VAT-12', 'VAT-14', 'VAT-IN', 'VAT-KU', 'VAT-Z',
]);

/**
 * Symbol w tekście tytułu: tylko symbole rozliczeń modułu, deklaracje VAT
 * kwartalne i dawne PIT-5 i PIT-5L (poza wykazem MF, ale wciąż wpisywane).
 * Granice: bez liter i cyfr obok, a „PIT-4R” nie jest „PIT”.
 */
const SYMBOL_W_TEKSCIE = /(?<![A-Z0-9])(PPE|PPL|JPK[-_ ]?V7[MK]|VAT-?7[KD]?|PIT(?:[- ]?(?:36L|36|28|5L|5))?)(?![A-Z0-9]|[-_][A-Z0-9])/g;

/** Zapis kanoniczny („PIT28” → „PIT-28”, „JPK_V7M” → „JPK-V7M”); inny napis bez zmian. */
function symbolKanoniczny(surowy: string): string {
  const s = surowy.replace(/\s+/g, '').replace(/_/g, '-');
  const pit = /^PIT-?(36L|36|28|5L|5)$/.exec(s);
  if (pit) return `PIT-${pit[1]}`;
  const vat = /^VAT-?7([KD]?)$/.exec(s);
  if (vat) return `VAT-7${vat[1]}`;
  const jpk = /^JPK-?V7([MK])$/.exec(s);
  if (jpk) return `JPK-V7${jpk[1]}`;
  return s;
}

const NUMER_OKRESU: Readonly<Record<TypOkresu, RegExp>> = {
  R: /^$/,
  P: /^0[12]$/,
  K: /^0[1-4]$/,
  M: /^(0[1-9]|1[0-2])$/,
  D: /^0[1-3](0[1-9]|1[0-2])$/,
  J: /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])$/,
};

/** Okres w zapisie MF albo `null` (np. „26M13”, „26X01”). */
export function okresZZapisu(zapis: string): OkresWplaty | null {
  const m = /^(\d{2})([RPKMDJ])(\d{0,4})$/.exec(zapis);
  if (!m) return null;
  const typ = m[2] as TypOkresu;
  if (!NUMER_OKRESU[typ].test(m[3]!)) return null;
  const rok = 2000 + Number(m[1]);
  return { zapis, typ, rok, miesiac: typ === 'M' ? `${rok}-${m[3]}` : null };
}

const OKRES_W_TEKSCIE = /(?<![A-Z0-9])(\d{2}(?:R|P\d{2}|K\d{2}|M\d{2}|D\d{4}|J\d{4}))(?![A-Z0-9])/g;

function pole(tytul: string, znacznik: 'OKR' | 'SFP'): string | null {
  const m = new RegExp(`/${znacznik}/([^/]*)`).exec(tytul);
  return m ? m[1]!.replace(/\s+/g, '') : null;
}

function jedyny<T>(wartosci: readonly T[], klucz: (v: T) => string): { wartosc: T | null; niejednoznaczny: boolean } {
  const rozne = new Map(wartosci.map((v) => [klucz(v), v]));
  if (rozne.size > 1) return { wartosc: null, niejednoznaczny: true };
  return { wartosc: rozne.values().next().value ?? null, niejednoznaczny: false };
}

function opisSymbolu(symbol: string | null): Pick<OdczytTytulu, 'symbol' | 'podatek' | 'wWykazieMf'> {
  if (!symbol) return { symbol: null, podatek: null, wWykazieMf: false };
  const podatek = PODATEK_SYMBOLU[symbol] ?? null;
  return { symbol, podatek, wWykazieMf: podatek !== null || INNE_SYMBOLE_MF.has(symbol) };
}

/**
 * Symbol formularza i okres z tytułu przelewu na mikrorachunek. Pola `/OKR/`
 * i `/SFP/` mają pierwszeństwo przed tekstem; okres albo symbol, którego nie da
 * się odczytać jednoznacznie, to `null` (bez zgadywania).
 */
export function czytajTytulPrzelewu(tytul: string | null): OdczytTytulu {
  const pusty: OdczytTytulu = { symbol: null, podatek: null, wWykazieMf: false, okres: null, niejednoznaczny: false, zrodlo: null };
  if (!tytul) return pusty;
  // Wielkie litery bez polskich znaków; spacje przy ukośnikach znikają (linie wyciągu sklejone spacją).
  const t = foldText(tytul).replace(/\s*\/\s*/g, '/');
  let zrodlo: OdczytTytulu['zrodlo'] = null;
  let niejednoznaczny = false;

  let okres: OkresWplaty | null = null;
  const poleOkresu = pole(t, 'OKR');
  if (poleOkresu !== null) {
    okres = okresZZapisu(poleOkresu);
    zrodlo = 'pola';
  } else {
    const znalezione = [...t.matchAll(OKRES_W_TEKSCIE)].map((m) => okresZZapisu(m[1]!)).filter((o): o is OkresWplaty => o !== null);
    const wynik = jedyny(znalezione, (o) => o.zapis);
    okres = wynik.wartosc;
    niejednoznaczny ||= wynik.niejednoznaczny;
    if (znalezione.length > 0) zrodlo = 'tekst';
  }

  let symbol: string | null;
  const poleSymbolu = pole(t, 'SFP');
  if (poleSymbolu !== null) {
    symbol = poleSymbolu === '' ? null : symbolKanoniczny(poleSymbolu);
    zrodlo = 'pola';
  } else {
    const znalezione = [...t.matchAll(SYMBOL_W_TEKSCIE)].map((m) => symbolKanoniczny(m[1]!));
    const wynik = jedyny(znalezione, (s) => s);
    symbol = wynik.wartosc;
    niejednoznaczny ||= wynik.niejednoznaczny;
    if (znalezione.length > 0) zrodlo ??= 'tekst';
  }

  return { ...opisSymbolu(symbol), okres, niejednoznaczny, zrodlo };
}

// ─── Propozycja zapłaty rozliczenia ──────────────────────────────────────

/** Wersja rozliczenia z `tax_settlements` (00168), jak ją czyta strona „Bank”. */
export interface RozliczenieZaplaty {
  id: string;
  /** RRRR-MM */
  miesiac: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwotaGr: number;
  status: 'zatwierdzone' | 'zaplacone';
  zaplaconeO: string | null;
}

/** Przelew podatkowy z wyciągu: kwota w groszach jest ujemna (wypływ). */
export interface OperacjaPodatkowa {
  id: string;
  rodzaj: RodzajPrzelewu;
  bookingDate: string;
  amountGrosze: number;
  title: string | null;
}

export interface OpcjaZaplaty {
  /** Rozliczenia (najnowsze wersje) zapłacone tym przelewem, rosnąco po id. */
  ids: string[];
  miesiac: string;
  rodzaje: RodzajRozliczenia[];
  wyliczoneGr: number;
  /** Wszystkie rozliczenia opcji są już oznaczone jako zapłacone: przelew dojdzie jako dowód, data zostanie. */
  zaplacone: boolean;
  /** Dzień zapłaty już zapisany przy rozliczeniu (pierwszy z opcji). */
  zaplaconeO: string | null;
  /** Część składek miesiąca (osobny przelew społecznych albo zdrowotnej). */
  czesciowa: boolean;
  etykieta: string;
}

export type SposobPrzypisania = 'tytul' | 'kwota';
/** Rodzaj dopasowania przy potwierdzeniu; ta sama lista stoi w `confirm_bank_tax_payment` (00186). */
export const RODZAJE_DOPASOWANIA_PODATKU = ['title', 'amount', 'manual'] as const;
export type RodzajDopasowaniaPodatku = (typeof RODZAJE_DOPASOWANIA_PODATKU)[number];

export interface PropozycjaZaplaty {
  /** Przypisanie do potwierdzenia jednym przyciskiem albo `null` (wybór klienta). */
  przypisanie: { opcja: OpcjaZaplaty; sposob: SposobPrzypisania } | null;
  /** Przelew minus wyliczona kwota przypisania, w groszach; bez przypisania `null`. */
  roznicaGr: number | null;
  /** Czemu nie ma przypisania (zdanie dla klienta). */
  powod: string | null;
  /** Co odczytaliśmy z tytułu (tylko przelew do urzędu). */
  odczyt: OdczytTytulu | null;
  /** Rozliczenia do wyboru ręcznego, bez potwierdzonych innym przelewem. */
  opcje: OpcjaZaplaty[];
}

const RODZAJE_US: readonly RodzajRozliczenia[] = ['ryczalt', 'pit', 'vat'];
const RODZAJE_ZUS: readonly RodzajRozliczenia[] = ['zus_spoleczne', 'zdrowotna'];

/** Nazwy do etykiet opcji i komunikatów. */
const NAZWA: Readonly<Record<RodzajRozliczenia, string>> = {
  ryczalt: 'Ryczałt',
  pit: 'Zaliczka PIT',
  vat: 'VAT',
  zus_spoleczne: 'Składki społeczne',
  zdrowotna: 'Składka zdrowotna',
};
const DOPELNIACZ: Readonly<Record<PodatekZSymbolu, string>> = { ryczalt: 'ryczałtu', pit: 'zaliczki PIT', vat: 'VAT' };

const PO_ZATWIERDZENIU = 'Miesiąc zatwierdza się w Księgowości, w „Ten miesiąc”; do tego czasu przelew czeka tutaj.';
const RECZNIE = 'więc rozliczenie wybiera się ręcznie.';

/** Najnowsza wersja każdego rozliczenia (miesiąc i rodzaj): tylko ona przyjmuje zapłatę z wyciągu. */
function najnowsze(rozliczenia: readonly RozliczenieZaplaty[]): RozliczenieZaplaty[] {
  const mapa = new Map<string, RozliczenieZaplaty>();
  for (const r of rozliczenia) {
    const klucz = `${r.miesiac}|${r.rodzaj}`;
    const obecne = mapa.get(klucz);
    if (!obecne || r.wersja > obecne.wersja) mapa.set(klucz, r);
  }
  return [...mapa.values()];
}

function etykietaZus(miesiac: string, rodzaje: readonly RodzajRozliczenia[]): string {
  const m = monthLabel(miesiac);
  if (rodzaje.length === 2) return `Składki ZUS za ${m} (społeczne i zdrowotna)`;
  return `${NAZWA[rodzaje[0]!]} za ${m}`;
}

function opcja(rozliczenia: readonly RozliczenieZaplaty[], czesciowa: boolean): OpcjaZaplaty {
  const lista = [...rozliczenia].sort((a, b) => a.id.localeCompare(b.id));
  const miesiac = lista[0]!.miesiac;
  const rodzaje = [...rozliczenia].sort((a, b) => RODZAJE_ZUS.indexOf(a.rodzaj) - RODZAJE_ZUS.indexOf(b.rodzaj)).map((r) => r.rodzaj);
  const zus = RODZAJE_ZUS.includes(lista[0]!.rodzaj);
  return {
    ids: lista.map((r) => r.id),
    miesiac,
    rodzaje,
    wyliczoneGr: lista.reduce((suma, r) => suma + r.kwotaGr, 0),
    zaplacone: lista.every((r) => r.status === 'zaplacone'),
    zaplaconeO: lista.find((r) => r.zaplaconeO)?.zaplaconeO ?? null,
    czesciowa,
    etykieta: zus ? etykietaZus(miesiac, rodzaje) : `${NAZWA[lista[0]!.rodzaj]} za ${monthLabel(miesiac)}`,
  };
}

/** Najpierw niezapłacone, pełne miesiące składek, najbliższa kwota, najnowszy miesiąc. */
function posortowane(opcje: OpcjaZaplaty[], kwotaGr: number): OpcjaZaplaty[] {
  return opcje.sort(
    (a, b) =>
      Number(a.zaplacone) - Number(b.zaplacone) ||
      Number(a.czesciowa) - Number(b.czesciowa) ||
      Math.abs(a.wyliczoneGr - kwotaGr) - Math.abs(b.wyliczoneGr - kwotaGr) ||
      b.miesiac.localeCompare(a.miesiac) ||
      a.etykieta.localeCompare(b.etykieta, 'pl'),
  );
}

const TYP_OKRESU: Readonly<Record<TypOkresu, string>> = { R: 'rok', P: 'półrocze', K: 'kwartał', M: 'miesiąc', D: 'dekada', J: 'dzień' };

function powodBezPrzypisaniaUs(odczyt: OdczytTytulu): string | null {
  if (odczyt.niejednoznaczny) return `W tytule przelewu jest kilka różnych okresów albo symboli formularza, ${RECZNIE}`;
  if (!odczyt.okres) return `W tytule przelewu nie ma okresu w zapisie MF (np. 26M01 za styczeń 2026), ${RECZNIE}`;
  if (!odczyt.okres.miesiac) {
    return `W tytule jest okres ${odczyt.okres.zapis} (${TYP_OKRESU[odczyt.okres.typ]}), a rozliczenia w FaktWay są miesięczne, ${RECZNIE}`;
  }
  if (!odczyt.symbol) return `W tytule przelewu nie ma symbolu formularza (np. PPE, PPL, VAT-7), ${RECZNIE}`;
  if (!odczyt.podatek) {
    return odczyt.wWykazieMf
      ? `Symbol ${odczyt.symbol} nie dotyczy miesięcznych rozliczeń w FaktWay (ryczałt, zaliczka PIT, VAT miesięczny), ${RECZNIE}`
      : `Symbolu ${odczyt.symbol} nie ma w wykazie symboli MF dla mikrorachunku, ${RECZNIE}`;
  }
  return null;
}

/**
 * Propozycja zapłaty dla przelewu podatkowego. Nic nie zapisuje: przypisanie
 * i wybór ręczny klient potwierdza przyciskiem.
 *
 *  - Urząd: przypisanie tylko przy pewnym okresie miesięcznym i symbolu
 *    rozliczenia z tytułu (najnowsza wersja tego rozliczenia), także przy
 *    kwocie innej niż wyliczona (różnica w `roznicaGr`).
 *  - ZUS: przelew na rachunek składkowy nie ma okresu, więc przypisanie tylko
 *    wtedy, gdy kwota jest równa składkom dokładnie jednego miesiąca (najpierw
 *    wśród niezapłaconych). Opcje to pełne miesiące i osobno składki
 *    społeczne albo zdrowotna (dwa przelewy za jeden miesiąc).
 *  - Do wyboru są rozliczenia z miesięcy do dnia przelewu, z kwotą większą od
 *    zera, bez potwierdzonych innym przelewem (`potwierdzone`: rozliczenie →
 *    operacja). Już zapłacone są na końcu listy (przelew dojdzie jako dowód).
 */
export function propozycjaZaplaty(
  op: OperacjaPodatkowa,
  rozliczenia: readonly RozliczenieZaplaty[],
  potwierdzone: ReadonlyMap<string, string>,
): PropozycjaZaplaty {
  const kwotaGr = -op.amountGrosze;
  const miesiacPrzelewu = op.bookingDate.slice(0, 7);
  const wolne = (r: RozliczenieZaplaty) => {
    const przez = potwierdzone.get(r.id);
    return przez === undefined || przez === op.id;
  };
  const aktualne = najnowsze(rozliczenia).filter((r) => r.miesiac <= miesiacPrzelewu);
  const wynik = (
    przypisanie: PropozycjaZaplaty['przypisanie'],
    powod: string | null,
    odczyt: OdczytTytulu | null,
    opcje: OpcjaZaplaty[],
  ): PropozycjaZaplaty => ({ przypisanie, roznicaGr: przypisanie ? kwotaGr - przypisanie.opcja.wyliczoneGr : null, powod, odczyt, opcje });

  if (op.rodzaj === 'us') {
    const odczyt = czytajTytulPrzelewu(op.title);
    const opcje = posortowane(
      aktualne.filter((r) => RODZAJE_US.includes(r.rodzaj) && r.kwotaGr > 0 && wolne(r)).map((r) => opcja([r], false)),
      kwotaGr,
    );
    const powod = powodBezPrzypisaniaUs(odczyt);
    if (powod) return wynik(null, powod, odczyt, opcje);
    const miesiac = odczyt.okres!.miesiac!;
    const podatek = odczyt.podatek!;
    const cel = `${NAZWA[podatek]} za ${monthLabel(miesiac)}`;
    const r = najnowsze(rozliczenia).find((x) => x.miesiac === miesiac && x.rodzaj === podatek);
    if (!r) return wynik(null, `Rozliczenie „${cel}” z tytułu przelewu nie jest jeszcze zatwierdzone. ${PO_ZATWIERDZENIU}`, odczyt, opcje);
    if (r.miesiac > miesiacPrzelewu) return wynik(null, `Przelew jest wcześniejszy niż ${monthLabel(miesiac)}, ${RECZNIE}`, odczyt, opcje);
    if (!wolne(r)) return wynik(null, `${cel} ma już potwierdzoną zapłatę innym przelewem z wyciągu, ${RECZNIE}`, odczyt, opcje);
    return wynik({ opcja: opcja([r], false), sposob: 'tytul' }, null, odczyt, opcje);
  }

  const skladki = aktualne.filter((r) => RODZAJE_ZUS.includes(r.rodzaj) && r.kwotaGr > 0 && wolne(r));
  const miesiace = new Map<string, RozliczenieZaplaty[]>();
  for (const r of skladki) miesiace.set(r.miesiac, [...(miesiace.get(r.miesiac) ?? []), r]);
  const wszystkie: OpcjaZaplaty[] = [];
  for (const lista of miesiace.values()) {
    wszystkie.push(opcja(lista, false));
    if (lista.length > 1) for (const r of lista) wszystkie.push(opcja([r], true));
  }
  const opcje = posortowane(wszystkie, kwotaGr);
  if (opcje.length === 0) return wynik(null, `Nie ma zatwierdzonych składek ZUS do zapłaty za miesiące do dnia przelewu. ${PO_ZATWIERDZENIU}`, null, []);
  const rowne = (lista: OpcjaZaplaty[]) => lista.filter((o) => o.wyliczoneGr === kwotaGr);
  let pasujace = rowne(opcje.filter((o) => !o.zaplacone));
  if (pasujace.length === 0) pasujace = rowne(opcje.filter((o) => o.zaplacone));
  if (pasujace.length === 1) return wynik({ opcja: pasujace[0]!, sposob: 'kwota' }, null, null, opcje);
  if (pasujace.length > 1) return wynik(null, 'Kwota przelewu jest równa składkom za kilka miesięcy, więc miesiąc wybiera się ręcznie.', null, opcje);
  return wynik(null, 'Kwota przelewu nie jest równa składkom za żaden zatwierdzony miesiąc, więc miesiąc wybiera się ręcznie; przy wyborze widać różnicę.', null, opcje);
}

// ─── Teksty ekranu ───────────────────────────────────────────────────────

const zl = (grosze: number) => formatPaymentMoney(grosze / 100);

/** Przy składkach: odliczenie w „Ten miesiąc” bierze kwotę zapłaconej wersji rozliczenia (`ten-miesiac-dane.ts`), nie kwotę z banku. */
export const ODLICZENIE_OD_WYLICZONEJ = 'Odliczenie składek w „Ten miesiąc” liczy się od kwoty wyliczonej, nie od kwoty z banku.';

/** Różnica kwoty z banku i wyliczonej: zdanie dla klienta (pusta przy równych). */
export function opisRoznicy(roznicaGr: number, wyliczoneGr: number, rodzaj: RodzajPrzelewu | null = null): string {
  if (roznicaGr === 0) return '';
  const strona = roznicaGr > 0 ? 'więcej' : 'mniej';
  const odliczenie = rodzaj === 'zus' && roznicaGr < 0 ? ` ${ODLICZENIE_OD_WYLICZONEJ}` : '';
  return `Przelew jest o ${zl(Math.abs(roznicaGr))} ${strona} niż wyliczona kwota (${zl(wyliczoneGr)}): zapisujemy kwotę z banku, a wyliczenie zostaje bez zmian.${odliczenie}`;
}

/** Nazwa zapłaty do komunikatów: „ZUS za wrzesień 2026 (składki społeczne i zdrowotna)”, „ryczałtu za wrzesień 2026”. */
export function nazwaZaplaty(rodzaj: RodzajPrzelewu, miesiac: string, rodzaje: readonly RodzajRozliczenia[]): string {
  const m = monthLabel(miesiac);
  if (rodzaj === 'zus') {
    const zus = rodzaje.filter((r) => RODZAJE_ZUS.includes(r));
    const opis = zus.length === 2 ? 'składki społeczne i zdrowotna' : zus[0] === 'zdrowotna' ? 'składka zdrowotna' : 'składki społeczne';
    return `ZUS za ${m} (${opis})`;
  }
  const podatek = rodzaje.find((r): r is PodatekZSymbolu => (RODZAJE_US as readonly string[]).includes(r));
  return `${podatek ? DOPELNIACZ[podatek] : 'podatku'} za ${m}`;
}

/** Opis propozycji przy operacji na ekranie „Bank”. */
export function opisPropozycji(op: OperacjaPodatkowa, p: PropozycjaZaplaty): string {
  if (!p.przypisanie) return p.powod ?? 'Rozliczenie wybiera się ręcznie albo operację można pominąć.';
  const { opcja: o, sposob } = p.przypisanie;
  const zrodlo =
    sposob === 'tytul' && p.odczyt?.symbol && p.odczyt.okres
      ? ` (z tytułu: ${p.odczyt.symbol}, okres ${p.odczyt.okres.zapis})`
      : sposob === 'kwota'
        ? ': kwota równa wyliczonym składkom'
        : '';
  const kwoty = p.roznicaGr === 0 ? ` Przelew ${zl(-op.amountGrosze)} jest równy wyliczonej kwocie.` : ` ${opisRoznicy(p.roznicaGr ?? 0, o.wyliczoneGr, op.rodzaj)}`;
  const stan =
    o.zaplacone && o.zaplaconeO
      ? ` Rozliczenie jest już oznaczone jako zapłacone ${formatIsoDatePl(o.zaplaconeO)}; po potwierdzeniu przelew będzie przy nim jako dowód, a data zapłaty zostanie.`
      : ` Po potwierdzeniu rozliczenie będzie oznaczone jako zapłacone ${formatIsoDatePl(op.bookingDate)}.`;
  return `Zapłata ${nazwaZaplaty(op.rodzaj, o.miesiac, o.rodzaje)}${zrodlo}.${kwoty}${stan}`;
}

/** Opis potwierdzonej albo pominiętej zapłaty w „Ostatnich decyzjach”. */
export function opisRozstrzygniecia(
  d: Pick<PrzelewRozstrzygniety, 'rodzaj' | 'amountGrosze' | 'state' | 'settlementIds'>,
  rozliczenia: ReadonlyMap<string, RozliczenieZaplaty>,
): { opis: string; zmienione: boolean } {
  if (d.state === 'skipped') return { opis: 'Pominięta, tytuł i dane odbiorcy usunięte.', zmienione: false };
  const lista = d.settlementIds.map((id) => rozliczenia.get(id)).filter((r): r is RozliczenieZaplaty => r !== undefined);
  if (lista.length === 0 || lista.length !== d.settlementIds.length) return { opis: 'Potwierdzona zapłata rozliczenia.', zmienione: false };
  const kwotaGr = -d.amountGrosze;
  const wyliczoneGr = lista.reduce((suma, r) => suma + r.kwotaGr, 0);
  const roznicaGr = kwotaGr - wyliczoneGr;
  const zmienione = lista.some((r) => r.status !== 'zaplacone');
  const roznica = roznicaGr === 0 ? '' : `, przelew o ${zl(Math.abs(roznicaGr))} ${roznicaGr > 0 ? 'więcej' : 'mniej'}`;
  const stan = zmienione
    ? ' Rozliczenie nie jest już oznaczone jako zapłacone (zmiana w „Ten miesiąc”); „Cofnij” odłączy od niego ten przelew.'
    : '';
  return {
    opis: `Zapłata ${nazwaZaplaty(d.rodzaj, lista[0]!.miesiac, lista.map((r) => r.rodzaj))}: przelew ${zl(kwotaGr)}, wyliczone ${zl(wyliczoneGr)}${roznica}.${stan}`,
    zmienione,
  };
}

// ─── Odczyt `bank_tax_operations` (00186) ────────────────────────────────

export interface PrzelewCzekajacy extends OperacjaPodatkowa {
  /** Własny rachunek z wyciągu. */
  account: string;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
}

export interface PrzelewRozstrzygniety {
  id: string;
  rodzaj: RodzajPrzelewu;
  bookingDate: string;
  amountGrosze: number;
  state: 'confirmed' | 'skipped';
  decidedAt: string | null;
  /** Rozliczenia zapłacone tym przelewem (puste przy pominiętym). */
  settlementIds: string[];
  /** Rozliczenia, które potwierdzenie oznaczyło jako zapłacone (cofnięcie oddaje im stan). */
  markedIds: string[];
  title: string | null;
}

/** Potwierdzone zapłaty: rozliczenie należy do jednego przelewu. */
export interface PowiazaniePrzelewu {
  id: string;
  bookingDate: string;
  settlementIds: string[];
}

export interface PrzelewyPodatkoweRpc {
  pending: PrzelewCzekajacy[];
  /** Wszystkie przelewy do sprawdzenia (lista ma najwyżej 300). */
  pendingTotal: number;
  decided: PrzelewRozstrzygniety[];
  links: PowiazaniePrzelewu[];
}

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const isKind = (value: unknown): value is RodzajPrzelewu => typeof value === 'string' && (RODZAJE_PRZELEWU as readonly string[]).includes(value);
const listaId = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '') ? (value as string[]) : null;
const wiersze = (value: unknown): Record<string, unknown>[] | null =>
  Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row)) ? (value as Record<string, unknown>[]) : null;

/** Kwota przelewu z bazy w groszach: tylko wypływ (liczba ujemna z groszami). */
function wyplywGrosze(value: unknown): number | null {
  const grosze = groszeZBazy(value);
  return grosze !== null && grosze < 0 ? grosze : null;
}

/**
 * Wynik RPC `bank_tax_operations`. Kształt inny niż oczekiwany to `null`:
 * ekran mówi wtedy, że przelewów nie udało się wczytać, zamiast pokazać pustą listę.
 */
export function parseBankTaxOperationsRpc(data: unknown): PrzelewyPodatkoweRpc | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const pendingRows = wiersze(d.pending);
  const decidedRows = wiersze(d.decided);
  const linkRows = wiersze(d.links);
  const pendingTotal = typeof d.pending_total === 'number' && Number.isSafeInteger(d.pending_total) && d.pending_total >= 0 ? d.pending_total : null;
  if (!pendingRows || !decidedRows || !linkRows || pendingTotal === null) return null;

  const pending: PrzelewCzekajacy[] = [];
  for (const row of pendingRows) {
    const amountGrosze = wyplywGrosze(row.amount);
    if (typeof row.id !== 'string' || !isKind(row.tax_kind) || typeof row.account !== 'string' || !isDay(row.booking_date) || amountGrosze === null) return null;
    pending.push({
      id: row.id,
      rodzaj: row.tax_kind,
      account: row.account,
      bookingDate: row.booking_date,
      amountGrosze,
      title: textOrNull(row.title),
      counterpartyName: textOrNull(row.counterparty_name),
      counterpartyAccount: textOrNull(row.counterparty_account),
    });
  }

  const decided: PrzelewRozstrzygniety[] = [];
  for (const row of decidedRows) {
    const amountGrosze = wyplywGrosze(row.amount);
    const settlementIds = listaId(row.settlement_ids);
    const markedIds = listaId(row.marked_ids);
    if (typeof row.id !== 'string' || !isKind(row.tax_kind) || !isDay(row.booking_date) || amountGrosze === null ||
        (row.state !== 'confirmed' && row.state !== 'skipped') || !settlementIds || !markedIds) {
      return null;
    }
    decided.push({
      id: row.id,
      rodzaj: row.tax_kind,
      bookingDate: row.booking_date,
      amountGrosze,
      state: row.state,
      decidedAt: textOrNull(row.decided_at),
      settlementIds,
      markedIds,
      title: textOrNull(row.title),
    });
  }

  const links: PowiazaniePrzelewu[] = [];
  for (const row of linkRows) {
    const settlementIds = listaId(row.settlement_ids);
    if (typeof row.id !== 'string' || !isDay(row.booking_date) || !settlementIds) return null;
    links.push({ id: row.id, bookingDate: row.booking_date, settlementIds });
  }

  return { pending, pendingTotal, decided, links };
}

// ─── Dane ekranu i komunikaty akcji ──────────────────────────────────────

export interface PrzelewNaEkranie extends PrzelewCzekajacy {
  /** `null`: rozliczeń nie udało się wczytać (bez propozycji, „Pomiń” działa). */
  propozycja: PropozycjaZaplaty | null;
  opis: string | null;
}

export interface RozstrzygniecieNaEkranie extends PrzelewRozstrzygniety {
  opis: string;
  zmienione: boolean;
}

export type PrzelewyPodatkoweEkranu =
  | { ok: true; pending: PrzelewNaEkranie[]; pendingTotal: number; decided: RozstrzygniecieNaEkranie[]; bladRozliczen: boolean }
  | { ok: false; error: string };

export const TAX_LOAD_FAILED =
  'Nie udało się wczytać przelewów do ZUS i urzędu skarbowego. Odśwież stronę, a jeśli to się powtórzy, napisz do nas przez Pomoc.';
export const TAX_SETTLEMENTS_LOAD_FAILED =
  'Nie udało się wczytać rozliczeń z „Ten miesiąc”, więc nie pokazujemy propozycji. Odśwież stronę; przelewy czekają bez zmian.';
export const TAX_ROLE_REFUSAL = 'Zapłaty podatków i składek z wyciągu potwierdza właściciel albo administrator firmy.';
export const TAX_UNAVAILABLE = 'Potwierdzanie zapłat podatków i składek z wyciągu nie jest dostępne dla tej firmy.';
export const TAX_NOT_CONFIRMED_TEXT = 'Ta operacja nie ma już potwierdzonej zapłaty rozliczenia. Odśwież stronę.';

export interface TaxRefusalContext {
  linkedOn?: string | null;
  okres?: string | null;
}

/** Tekst odmowy RPC zapłat z wyciągu: co się stało i co dalej (protokół napraw, pkt 4). */
export function taxRefusalText(code: unknown, ctx: TaxRefusalContext = {}): string {
  switch (code) {
    case 'operation_not_found':
      return 'Nie znaleziono tej operacji w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'operation_skipped':
      return 'Ta operacja jest pominięta, a jej dane usunęliśmy. Zapłatę rozliczenia oznacza się wtedy w „Ten miesiąc” przyciskiem „Zapłacone”.';
    case 'operation_confirmed':
      return 'Ta operacja ma już potwierdzoną zapłatę innego rozliczenia. Najpierw cofa się ją przyciskiem „Cofnij” w ostatnich decyzjach, potem można wybrać jeszcze raz.';
    case 'not_tax_payment':
      return 'To nie jest przelew do ZUS ani na mikrorachunek podatkowy, więc nie zapiszemy go jako zapłaty rozliczenia.';
    case 'tax_module_disabled':
      return TAX_UNAVAILABLE;
    case 'payment_in_future':
      return 'Dzień księgowania przelewu jest późniejszy niż dziś, więc zapłatę da się potwierdzić dopiero od tego dnia.';
    case 'settlement_not_found':
      return 'Nie znaleziono tego rozliczenia. Po odświeżeniu strony lista pokazuje aktualne rozliczenia.';
    case 'settlement_kind':
      return 'Ten przelew nie pasuje do wybranego rozliczenia: na rachunek składkowy idą składki ZUS, a na mikrorachunek podatki. Po odświeżeniu strony lista pokazuje pasujące rozliczenia.';
    case 'settlement_outdated':
      return 'Rozliczenie ma nowszą wersję, zatwierdzoną po otwarciu strony. Po odświeżeniu lista pokazuje aktualną wersję do potwierdzenia.';
    case 'paid_before_period': {
      const okres = ctx.okres && /^\d{4}-\d{2}$/.test(ctx.okres) ? monthLabel(ctx.okres) : 'miesiąc rozliczenia';
      return `Przelew jest wcześniejszy niż ${okres}, więc nie może być zapłatą za ten miesiąc. Inne rozliczenie da się wybrać ręcznie albo operację pominąć.`;
    }
    case 'settlement_linked': {
      const dzien = ctx.linkedOn && isDay(ctx.linkedOn) ? ` przelewem z ${formatIsoDatePl(ctx.linkedOn)}` : ' innym przelewem';
      return `To rozliczenie ma już potwierdzoną zapłatę${dzien}. Jeśli tamten wybór był pomyłką, cofa się go w ostatnich decyzjach; jeśli to druga część zapłaty, tę operację można pominąć.`;
    }
    default:
      return 'Nie udało się zapisać decyzji. Sprawdź połączenie i spróbuj ponownie.';
  }
}

export interface TaxConfirmed {
  status: 'confirmed' | 'already_confirmed';
  rodzaj: RodzajPrzelewu | null;
  okres: string | null;
  rodzaje: RodzajRozliczenia[];
  paidOn: string | null;
  computedGr: number | null;
  differenceGr: number | null;
  marked: number | null;
}

/** Komunikat po potwierdzeniu zapłaty z wyciągu. */
export function taxConfirmedText(r: TaxConfirmed): string {
  if (r.status === 'already_confirmed') return 'Ta zapłata jest już zapisana.';
  const nazwa = r.rodzaj && r.okres ? nazwaZaplaty(r.rodzaj, r.okres, r.rodzaje) : 'rozliczenia';
  const glowne =
    r.marked === 0
      ? `Przelew${r.paidOn ? ` z ${formatIsoDatePl(r.paidOn)}` : ''} jest teraz przy rozliczeniu (${nazwa}) jako dowód zapłaty; rozliczenie było już oznaczone jako zapłacone, więc jego data została bez zmian.`
      : `Zapisano zapłatę ${nazwa}${r.paidOn ? ` z dniem ${formatIsoDatePl(r.paidOn)}` : ''}.`;
  const roznica = r.differenceGr && r.computedGr !== null ? ` ${opisRoznicy(r.differenceGr, r.computedGr, r.rodzaj)}` : '';
  return `${glowne}${roznica}`;
}

/** Komunikat po cofnięciu potwierdzenia. */
export function taxUndoneText(reverted: number, kept: number): string {
  const powrot = reverted > 0 ? ` ${reverted === 1 ? 'Rozliczenie wróciło' : 'Rozliczenia wróciły'} do stanu „zatwierdzone”.` : '';
  const zostaje = kept > 0 ? ' Rozliczenie zmienione po potwierdzeniu zostało bez zmian; jego zapłatę zmienia się w „Ten miesiąc”.' : '';
  return `Cofnięto potwierdzenie zapłaty z wyciągu, a operacja wróciła do sprawdzenia.${powrot}${zostaje}`;
}
