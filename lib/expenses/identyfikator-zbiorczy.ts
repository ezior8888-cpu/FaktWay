/**
 * Identyfikator zbiorczy na liście „Do zapłaty” (plan kompletnej aplikacji,
 * krok 1.4, część 2; RP-PLAT-01, RP-PLAT-02, RP-PLAT-03).
 *
 * Od płatności z 1.01.2027 przelew za kilka faktur jednego dostawcy ma
 * w tytule identyfikator zbiorczy nadany przez KSeF (art. 108g ustawy o VAT
 * w brzmieniu z Dz.U. 2025 poz. 1203). Ten moduł wyznacza, które koszty
 * z listy da się objąć jednym identyfikatorem:
 *  - co najmniej 2 niezapłacone faktury w złotych z poprawnym numerem KSeF
 *    od tego samego dostawcy, czyli z tym samym polskim NIP sprzedawcy
 *    (identyfikator nie obejmuje faktur różnych sprzedawców, błąd KSeF 71004);
 *  - osobno faktury z podzieloną płatnością (MPP) i bez niej, bo to osobne
 *    przelewy: przy MPP identyfikator stoi w komunikacie w miejscu numeru
 *    faktury (jak numer KSeF przy jednej fakturze w kroku 1.4, część 1);
 *  - faktury bez numeru KSeF (offline przed przyjęciem przez KSeF, awaryjne,
 *    spoza KSeF) do żądania nie trafiają; faktur niewprowadzonych do KSeF
 *    z powodu awarii obowiązek nie obejmuje (art. 108g ust. 4);
 *  - faktury, przy których z pliku KSeF nie wiadomo, czy jest MPP, też nie
 *    trafiają do grupy: nie wiadomo, którym przelewem je zapłacić.
 * Jedna faktura u dostawcy: zwykły numer KSeF w tytule (karta kosztu).
 *
 * Plik przelewów z kroku 3.4 robi osobny przelew dla każdej faktury z jej
 * numerem KSeF, więc go to nie zmienia: identyfikator jest do przelewu
 * zleconego w bankowości ręcznie.
 *
 * Moduł bez importów serwerowych: strona liczy grupy, ekran je pokazuje,
 * akcja sprawdza nimi wybór. Testy: `tests/unit/identyfikator-zbiorczy-grupy.test.ts`.
 */

import type { KosztDoZaplaty, WierszKosztuDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { listaDoZaplaty } from '@/lib/expenses/do-zaplaty';
import {
  MAKS_FAKTUR_W_IDENTYFIKATORZE,
  MIN_FAKTUR_W_IDENTYFIKATORZE,
  poprawnyIdentyfikatorZbiorczy,
} from '@/lib/invoices/identyfikator-zbiorczy';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/** Kto tworzy identyfikator: wywołanie KSeF w imieniu firmy, jak wysyłka JPK (K6). Księgowa i członek mają wgląd. */
export const ROLE_IDENTYFIKATORA = ['owner', 'admin'] as const;

export function mozeTworzycIdentyfikator(rola: string | null | undefined): boolean {
  return typeof rola === 'string' && (ROLE_IDENTYFIKATORA as readonly string[]).includes(rola);
}

export interface FakturaGrupy {
  id: string;
  numerFaktury: string;
  numerKsef: string;
  kwota: number;
  vat: number;
}

export interface FakturaPozaGrupa {
  id: string;
  numerFaktury: string;
  powod: 'brak_numeru_ksef' | 'mpp_nieznane';
}

export interface GrupaIdentyfikatora {
  /** Dostawca i rodzaj przelewu, np. `1234567890:mpp`. */
  klucz: string;
  nip: string;
  sprzedawca: string;
  mpp: boolean;
  /** Kolejność jak na liście (od najbliższego terminu). */
  faktury: FakturaGrupy[];
  /** Numery KSeF bez powtórzeń, rosnąco po kodach znaków: tak idą do KSeF i do bazy. */
  numeryKsef: string[];
  /** Suma kwot do zapłaty (po wpłatach częściowych z faktur). */
  suma: number;
  /** Suma VAT do komunikatu MPP; `null`, gdy któraś faktura podaje wpłaty częściowe. */
  vat: number | null;
  wplatyCzesciowe: boolean;
  /** Wspólny rachunek z faktur albo `null`. */
  rachunek: string | null;
  /** Faktury podają różne rachunki albo któraś nie podaje rachunku. */
  rozneRachunki: boolean;
  /** Faktury tego dostawcy poza identyfikatorem (przy pierwszej grupie dostawcy). */
  poza: FakturaPozaGrupa[];
  /** Identyfikator zapisany dla dokładnie tego zestawu faktur (00191) albo `null`. */
  identyfikator: string | null;
}

export interface ZapisanyIdentyfikator {
  numeryKsef: readonly string[];
  identyfikator: string;
}

/** Polski NIP sprzedawcy jako 10 cyfr („PL”, spacje i myślniki odpadają) albo `null`. */
export function nipDostawcy(nip: string | null | undefined): string | null {
  const czysty = (nip ?? '').replace(/[\s-]/g, '').replace(/^PL/i, '');
  return /^[0-9]{10}$/.test(czysty) ? czysty : null;
}

/** Zestaw numerów KSeF jako napis: bez powtórzeń, rosnąco po kodach znaków (jak `COLLATE "C"`). */
export function kluczFaktur(numery: readonly string[]): string {
  return [...new Set(numery)].sort().join(',');
}

function pozycjaGrupy(koszt: KosztDoZaplaty): FakturaGrupy {
  return { id: koszt.id, numerFaktury: koszt.numerFaktury, numerKsef: koszt.numerKsef!, kwota: koszt.kwota, vat: koszt.vat };
}

function zbudujGrupe(nip: string, mpp: boolean, koszty: KosztDoZaplaty[], zapisane: ReadonlyMap<string, string>): GrupaIdentyfikatora {
  const numeryKsef = [...new Set(koszty.map((k) => k.numerKsef!))].sort();
  const wplatyCzesciowe = koszty.some((k) => k.kwota !== k.brutto);
  const rachunki = new Set(koszty.map((k) => k.rachunek));
  const rachunek = rachunki.size === 1 ? (koszty[0]!.rachunek ?? null) : null;
  return {
    klucz: `${nip}:${mpp ? 'mpp' : 'zwykly'}`,
    nip,
    sprzedawca: koszty[0]!.sprzedawca,
    mpp,
    faktury: koszty.map(pozycjaGrupy),
    numeryKsef,
    suma: roundToCents(koszty.reduce((s, k) => s + k.kwota, 0)),
    vat: wplatyCzesciowe ? null : roundToCents(koszty.reduce((s, k) => s + k.vat, 0)),
    wplatyCzesciowe,
    rachunek,
    rozneRachunki: rachunek === null,
    poza: [],
    identyfikator: zapisane.get(numeryKsef.join(',')) ?? null,
  };
}

/**
 * Grupy do identyfikatora zbiorczego z pozycji listy „Do zapłaty”. Kolejność
 * grup według pierwszej faktury na liście. Zapisane identyfikatory pasują
 * tylko do dokładnie tego samego zestawu numerów KSeF (kolejność bez
 * znaczenia) i tylko po sprawdzeniu formatu i sumy kontrolnej.
 */
export function grupyDoIdentyfikatora(
  pozycje: readonly KosztDoZaplaty[],
  zapisane: readonly ZapisanyIdentyfikator[] = [],
): GrupaIdentyfikatora[] {
  const gotowe = new Map<string, string>();
  for (const z of zapisane) {
    const identyfikator = poprawnyIdentyfikatorZbiorczy(z.identyfikator);
    if (identyfikator) gotowe.set(kluczFaktur(z.numeryKsef), identyfikator);
  }

  const wGrupach = new Map<string, { nip: string; mpp: boolean; koszty: KosztDoZaplaty[] }>();
  const pozaWedlugNip = new Map<string, FakturaPozaGrupa[]>();
  for (const koszt of pozycje) {
    const nip = nipDostawcy(koszt.nip);
    if (!nip) continue;
    if (!koszt.numerKsef || koszt.mpp === null) {
      const lista = pozaWedlugNip.get(nip) ?? [];
      lista.push({ id: koszt.id, numerFaktury: koszt.numerFaktury, powod: koszt.numerKsef ? 'mpp_nieznane' : 'brak_numeru_ksef' });
      pozaWedlugNip.set(nip, lista);
      continue;
    }
    const klucz = `${nip}:${koszt.mpp ? 'mpp' : 'zwykly'}`;
    const grupa = wGrupach.get(klucz) ?? { nip, mpp: koszt.mpp, koszty: [] };
    grupa.koszty.push(koszt);
    wGrupach.set(klucz, grupa);
  }

  const wynik: GrupaIdentyfikatora[] = [];
  const dostawcyZPoza = new Set<string>();
  for (const { nip, mpp, koszty } of wGrupach.values()) {
    const numery = new Set(koszty.map((k) => k.numerKsef));
    if (numery.size < MIN_FAKTUR_W_IDENTYFIKATORZE || numery.size > MAKS_FAKTUR_W_IDENTYFIKATORZE) continue;
    const grupa = zbudujGrupe(nip, mpp, koszty, gotowe);
    if (!dostawcyZPoza.has(nip)) {
      grupa.poza = pozaWedlugNip.get(nip) ?? [];
      dostawcyZPoza.add(nip);
    }
    wynik.push(grupa);
  }
  return wynik;
}

// ─── Sprawdzenie wyboru w akcji ─────────────────────────────────────────

const fakturaZ = (numer: string | null | undefined) => (numer?.trim() ? numer.trim() : 'bez numeru');

function wyliczenie(numery: readonly string[]): string {
  return numery.length === 1 ? `Faktura ${numery[0]}` : `Faktury ${numery.join(', ')}`;
}

export const IDENTYFIKATOR_TEKSTY = {
  rola:
    'Identyfikator zbiorczy tworzy właściciel albo administrator firmy. Do tego czasu każdą fakturę można zapłacić ' +
    'osobnym przelewem z jej numerem KSeF w tytule.',
  wybor: 'Nie udało się utworzyć identyfikatora zbiorczego: wybór faktur jest niepoprawny. Odśwież stronę i spróbuj ponownie.',
  srodowisko:
    'Połączenie FaktWay z KSeF nie jest teraz ustawione, więc identyfikatora zbiorczego nie da się utworzyć. Napisz do ' +
    'pomocy FaktWay. Do tego czasu każdą fakturę można zapłacić osobnym przelewem z jej numerem KSeF w tytule.',
  odczyt: 'Nie udało się odczytać faktur do identyfikatora zbiorczego. Odśwież stronę i spróbuj ponownie.',
  migracja:
    'Identyfikator zbiorczy będzie dostępny po aktualizacji FaktWay. Do tego czasu każdą fakturę można zapłacić ' +
    'osobnym przelewem z jej numerem KSeF w tytule.',
  zapis: 'Nie udało się zapisać prośby o identyfikator zbiorczy. Spróbuj ponownie za chwilę.',
  rozniDostawcy:
    'Identyfikator zbiorczy obejmuje faktury jednego dostawcy (ten sam NIP sprzedawcy), a wybrane faktury są od ' +
    'różnych dostawców. Identyfikator tworzy się osobno dla każdego dostawcy.',
  mppIZwykle:
    'Wybrane faktury mają podzieloną płatność (MPP) i zwykłą. To osobne przelewy, więc identyfikator zbiorczy tworzy ' +
    'się osobno dla faktur z MPP i bez MPP.',
  zaMalo:
    'Identyfikator zbiorczy obejmuje co najmniej 2 faktury z numerem KSeF od jednego dostawcy. Przy jednej fakturze ' +
    'w tytule przelewu wystarczy jej numer KSeF.',
  bezNip:
    'Identyfikator zbiorczy wymaga polskiego NIP sprzedawcy (10 cyfr), a tej faktury nie da się przypisać do ' +
    'sprzedawcy z NIP. Taką fakturę można zapłacić osobnym przelewem z jej numerem w tytule.',
  bladDanych:
    'Nie udało się utworzyć identyfikatora zbiorczego. Spróbuj ponownie za chwilę, a jeśli to się powtórzy, napisz do pomocy FaktWay.',
} as const;

/** Identyfikator dla tych faktur już powstaje (druga karta, dwuklik). */
export function wTrakcie(grupa: Pick<GrupaIdentyfikatora, 'faktury' | 'sprzedawca'>): string {
  return `Identyfikator zbiorczy dla ${grupa.faktury.length} faktur od ${grupa.sprzedawca} właśnie powstaje w KSeF. Odśwież stronę za chwilę.`;
}

export type SprawdzenieWyboru = { ok: true; grupa: GrupaIdentyfikatora } | { ok: false; powod: string };

/**
 * Wybór z ekranu sprawdzony na świeżo odczytanych kosztach (RLS): każdy koszt
 * jest na liście „Do zapłaty”, ma numer KSeF i znane MPP, a wszystkie są od
 * jednego dostawcy i tego samego rodzaju przelewu. Odmowa nazywa faktury
 * i mówi, co zrobić.
 */
export function sprawdzWybor(
  ids: readonly string[],
  wiersze: readonly WierszKosztuDoZaplaty[],
  dzis: string,
): SprawdzenieWyboru {
  const pozycje = listaDoZaplaty(wiersze, dzis).pozycje;
  const naLiscie = new Map(pozycje.map((p) => [p.id, p]));
  const odczytane = new Map(wiersze.map((w) => [w.id, w]));

  const brak = ids.filter((id) => !naLiscie.has(id));
  if (brak.length > 0) {
    const znane = brak.map((id) => odczytane.get(id)).filter((w): w is WierszKosztuDoZaplaty => Boolean(w));
    const numery = znane.map((w) => fakturaZ(w.faktura?.internal_number ?? w.document_number));
    if (numery.length === 0) {
      return { ok: false, powod: 'Części wybranych faktur nie ma już na liście „Do zapłaty” tej firmy. Odśwież stronę i spróbuj ponownie.' };
    }
    const jedna = numery.length === 1;
    return {
      ok: false,
      powod:
        `${wyliczenie(numery)} ${jedna ? 'nie jest' : 'nie są'} już na liście „Do zapłaty” (na przykład ${jedna ? 'jest' : 'są'} ` +
        `już ${jedna ? 'zapłacona' : 'zapłacone'}). Odśwież stronę i utwórz identyfikator dla pozostałych faktur.`,
    };
  }

  const wybrane = ids.map((id) => naLiscie.get(id)!);
  const bezNumeru = wybrane.filter((k) => !k.numerKsef);
  if (bezNumeru.length > 0) {
    const numery = bezNumeru.map((k) => fakturaZ(k.numerFaktury));
    const jedna = numery.length === 1;
    return {
      ok: false,
      powod:
        `${wyliczenie(numery)} nie ${jedna ? 'ma' : 'mają'} numeru KSeF, więc nie ${jedna ? 'może' : 'mogą'} być ` +
        'w identyfikatorze zbiorczym: identyfikator obejmuje tylko faktury z numerem KSeF. Odśwież stronę i utwórz ' +
        'identyfikator dla pozostałych faktur.',
    };
  }
  const bezMpp = wybrane.filter((k) => k.mpp === null);
  if (bezMpp.length > 0) {
    const numery = bezMpp.map((k) => fakturaZ(k.numerFaktury));
    const jedna = numery.length === 1;
    return {
      ok: false,
      powod:
        `Nie wiadomo, czy ${jedna ? `faktura ${numery[0]} ma` : `faktury ${numery.join(', ')} mają`} podzieloną ` +
        `płatność (MPP), więc ${jedna ? 'nie trafia' : 'nie trafiają'} do identyfikatora zbiorczego. Sprawdź to ` +
        'w fakturze; taką fakturę można zapłacić osobnym przelewem z jej numerem KSeF w tytule.',
    };
  }
  if (wybrane.some((k) => !nipDostawcy(k.nip))) return { ok: false, powod: IDENTYFIKATOR_TEKSTY.bezNip };
  if (new Set(wybrane.map((k) => nipDostawcy(k.nip))).size > 1) return { ok: false, powod: IDENTYFIKATOR_TEKSTY.rozniDostawcy };
  if (new Set(wybrane.map((k) => k.mpp)).size > 1) return { ok: false, powod: IDENTYFIKATOR_TEKSTY.mppIZwykle };

  const grupy = grupyDoIdentyfikatora(wybrane);
  if (grupy.length !== 1 || grupy[0]!.faktury.length !== ids.length) return { ok: false, powod: IDENTYFIKATOR_TEKSTY.zaMalo };
  return { ok: true, grupa: grupy[0]! };
}

export type IdentyfikatorZbiorczyResult =
  | {
      success: true;
      identyfikator: string;
      /** `utworzony`: KSeF nadał teraz; `zapisany_wczesniej`: z bazy, bez pytania KSeF. */
      status: 'utworzony' | 'zapisany_wczesniej';
      /** Czy identyfikator jest w bazie (kolejne kliknięcie go odda). */
      zapisany: boolean;
    }
  | { success: false; error: string };
