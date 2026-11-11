/**
 * Przelewy do dostawców z wyciągu jako zapłaty kosztów z listy „Do zapłaty”
 * (plan kompletnej aplikacji, krok 3.2, część 3; lista, termin, rachunek
 * dostawcy i ręczne „Oznacz jako zapłacone” z kroku 3.4, #531).
 *
 * Dopasowanie (czysta funkcja `dopasujKoszty`):
 *  - przelew w złotych na rachunek równy rachunkowi z faktury kosztu z listy
 *    (z „PL” albo bez); przelew na inny rachunek nie dotyczy kosztów i nie
 *    wraca do klienta (RODO: prywatne wydatki, wynagrodzenia);
 *  - jedno kliknięcie „Potwierdź” tylko przy pewnym dopasowaniu: rachunek,
 *    kwota równa kwocie do zapłaty (albo sumie kosztów, gdy tytuł wskazuje
 *    kilka faktur) i tytuł z numerem KSeF, identyfikatorem zbiorczym z #603
 *    (zapisany zestaw faktur jednego dostawcy) albo numerem faktury;
 *  - reszta to wybór klienta z kosztów na ten sam rachunek albo „Pomiń”.
 *    Numer KSeF albo identyfikator zbiorczy w tytule, który nie pasuje do
 *    kosztów z listy, zatrzymuje słabsze dopasowanie po samej kwocie: tytuł
 *    wskazuje inny dokument.
 * Baza sprawdza rachunek, kwotę, walutę i stan kosztów jeszcze raz
 * (`confirm_bank_expense_payment`, 00196), więc wybór klienta też ma te granice.
 *
 * Moduł bez importów serwerowych: biorą go akcje, strona i komponent kliencki.
 * Testy: `tests/unit/wyciag-koszty.test.ts`.
 */

import type { KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { kwotaWGroszach } from '@/lib/expenses/elixir0';
import type { ZapisanyIdentyfikator } from '@/lib/expenses/identyfikator-zbiorczy';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { poprawnyIdentyfikatorZbiorczy, WZORZEC_IDENTYFIKATORA_ZBIORCZEGO } from '@/lib/invoices/identyfikator-zbiorczy';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';

import { invoiceNumberInText } from './dopasowanie';
import { DECISION_FAILED, groszeZBazy } from './ekran';
import { canonicalKsefNumber, ksefNumbersInText } from './numer-ksef';
import { rachunekZnormalizowany } from './rachunek';
import type { BankFileFormat } from './typy';

/** Rodzaj dopasowania; ta sama lista stoi w `confirm_bank_expense_payment` (00196). */
export const RODZAJE_DOPASOWANIA_KOSZTU = ['ksef_number', 'collective_identifier', 'invoice_number', 'amount', 'manual'] as const;
export type RodzajDopasowaniaKosztu = (typeof RODZAJE_DOPASOWANIA_KOSZTU)[number];

/** Tyle kosztów obejmuje najwyżej identyfikator zbiorczy; ta sama granica stoi w 00196. */
export const MAKS_KOSZTOW_PRZELEWU = 500;

/** Koszt z listy „Do zapłaty” w kształcie potrzebnym do dopasowania i na ekranie. */
export interface KosztDoPrzelewu {
  id: string;
  sprzedawca: string;
  numerFaktury: string;
  numerKsef: string | null;
  /** Do zapłaty w groszach (brutto bez wpłat częściowych z faktury). */
  kwotaGr: number;
  /** Rachunek z faktury, tak jak zapisany przy koszcie. */
  rachunek: string | null;
  termin: string;
}

/** Wypływ z wyciągu pokazany klientowi do decyzji. Nie jest zapisany w bazie. */
export interface PrzelewDoKosztu {
  /** Klucz duplikatu (`operationKeys`), ten sam przy ponownym wgraniu pliku. */
  key: string;
  /** Rachunek firmy z wyciągu. */
  account: string;
  bookingDate: string;
  /** Kwota w groszach, ujemna (wypływ). */
  amountGrosze: number;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  title: string | null;
  reference: string | null;
}

export type PropozycjaKosztu =
  | { rodzaj: 'ksef_number' | 'collective_identifier' | 'invoice_number'; kosztIds: string[]; pewne: true }
  | { rodzaj: 'amount'; kosztIds: string[]; pewne: false };

export type UwagaDopasowania =
  | 'ksef_nieznany'
  | 'identyfikator_nieznany'
  | 'kwota_inna'
  | 'kilka_kosztow'
  | 'bez_propozycji'
  /** Koszt z propozycji zapłacono innym przelewem w tej samej sesji ekranu. */
  | 'koszt_zaplacony';

export interface DopasowanieKosztu {
  propozycja: PropozycjaKosztu | null;
  uwaga: UwagaDopasowania | null;
  /** Koszty wskazane w tytule (numer KSeF, identyfikator albo numer faktury), także przy innej kwocie. */
  wskazane: string[];
  /** Koszty z listy na ten sam rachunek odbiorcy, w kolejności listy: do wyboru przez klienta. */
  kandydaci: string[];
}

export interface PrzelewZPropozycja extends PrzelewDoKosztu, DopasowanieKosztu {}

/** Przelew czekający na decyzję w przeglądarce, z formatem pliku, z którego pochodzi (potrzebny przy zapisie). */
export interface PrzelewDoDecyzji extends PrzelewZPropozycja {
  fileFormat: BankFileFormat;
}

/** Stan ekranu po wgraniach: przelewy do decyzji (bez zapisu w bazie) i komunikat ostatniego błędu. */
export interface PropozycjeKosztow {
  przelewy: PrzelewDoDecyzji[];
  koszty: KosztDoPrzelewu[];
  error: string | null;
}

/**
 * Wynik kolejnego wgrania dokładany do stanu ekranu: ten sam przelew (klucz)
 * z nowszego pliku zastępuje starszy, koszty z nowszego odczytu wygrywają.
 * Błąd nie kasuje propozycji z wcześniejszego pliku.
 */
export function scalPropozycje(prev: PropozycjeKosztow | null, wynik: ProposeBankExpensesResult): PropozycjeKosztow {
  const stare: PropozycjeKosztow = prev ?? { przelewy: [], koszty: [], error: null };
  if (!wynik.success) return { ...stare, error: wynik.error };
  const nowe = wynik.przelewy.map((p) => ({ ...p, fileFormat: wynik.fileFormat }));
  const klucze = new Set(nowe.map((p) => p.key));
  const koszty = new Map(stare.koszty.map((k) => [k.id, k]));
  for (const k of wynik.koszty) koszty.set(k.id, k);
  return { przelewy: [...stare.przelewy.filter((p) => !klucze.has(p.key)), ...nowe], koszty: [...koszty.values()], error: null };
}

/**
 * Po decyzji przy jednym przelewie: znika on z listy, a koszty, które właśnie
 * zapłacił, znikają z wyboru przy pozostałych. Propozycja z takim kosztem
 * przestaje być jednym kliknięciem (baza i tak odmówiłaby `expense_paid`).
 */
export function poRozstrzygnieciu(stan: PropozycjeKosztow, key: string, oplacone: readonly string[]): PropozycjeKosztow {
  const zaplacone = new Set(oplacone);
  const przelewy = stan.przelewy
    .filter((p) => p.key !== key)
    .map((p) => {
      if (zaplacone.size === 0) return p;
      const kandydaci = p.kandydaci.filter((id) => !zaplacone.has(id));
      const wskazane = p.wskazane.filter((id) => !zaplacone.has(id));
      const zajeta = p.propozycja?.kosztIds.some((id) => zaplacone.has(id)) ?? false;
      return zajeta ? { ...p, kandydaci, wskazane, propozycja: null, uwaga: 'koszt_zaplacony' as const } : { ...p, kandydaci, wskazane };
    });
  return { ...stan, przelewy };
}

/** Koszt z listy „Do zapłaty” (`listaDoZaplaty`): kwota w groszach przez `roundToCents`. */
export function kosztDoPrzelewu(k: KosztDoZaplaty): KosztDoPrzelewu | null {
  const kwotaGr = kwotaWGroszach(k.kwota);
  if (kwotaGr === null) return null;
  return {
    id: k.id,
    sprzedawca: k.sprzedawca,
    numerFaktury: k.numerFaktury,
    numerKsef: k.numerKsef,
    kwotaGr,
    rachunek: k.rachunek,
    termin: k.termin,
  };
}

/**
 * Zapis rachunku do zapytania o koszty (`payment_account` bywa z „PL” albo
 * bez): dla polskiego rachunku oba warianty, zagraniczny IBAN bez zmian.
 * Napis, który nie jest rachunkiem, odpada.
 */
export function wariantyRachunku(rachunki: readonly (string | null)[]): string[] {
  const out = new Set<string>();
  for (const rachunek of rachunki) {
    const n = rachunekZnormalizowany(rachunek);
    if (!n) continue;
    out.add(n);
    if (/^PL\d{26}$/.test(n)) out.add(n.slice(2));
  }
  return [...out];
}

const IDENTYFIKATOR_W_TEKSCIE = new RegExp(`(?<![0-9A-Z])(?:${WZORZEC_IDENTYFIKATORA_ZBIORCZEGO})(?![0-9A-Z])`, 'g');

/** Identyfikatory zbiorcze z tytułu (format i suma kontrolna), wielkimi literami, bez powtórzeń. */
export function identyfikatoryZbiorczeWTekscie(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.toUpperCase().matchAll(IDENTYFIKATOR_W_TEKSCIE)) {
    const poprawny = poprawnyIdentyfikatorZbiorczy(m[0]);
    if (poprawny) found.add(poprawny);
  }
  return [...found];
}

const suma = (koszty: readonly KosztDoPrzelewu[]) => koszty.reduce((s, k) => s + k.kwotaGr, 0);

function pewne(rodzaj: 'ksef_number' | 'collective_identifier' | 'invoice_number', trafione: readonly KosztDoPrzelewu[], kandydaci: string[]): DopasowanieKosztu {
  const ids = trafione.map((k) => k.id);
  return { propozycja: { rodzaj, kosztIds: ids, pewne: true }, uwaga: null, wskazane: ids, kandydaci };
}

const bez = (uwaga: UwagaDopasowania, kandydaci: string[], wskazane: string[] = []): DopasowanieKosztu => ({ propozycja: null, uwaga, wskazane, kandydaci });

/**
 * Propozycja kosztów dla wypływu z wyciągu. `null`: przelew nie dotyczy kosztów
 * z listy (inny rachunek, wpływ, brak rachunku) i nie wraca do klienta.
 */
export function dopasujKoszty(
  przelew: Pick<PrzelewDoKosztu, 'amountGrosze' | 'counterpartyAccount' | 'title'>,
  koszty: readonly KosztDoPrzelewu[],
  zapisane: readonly ZapisanyIdentyfikator[] = [],
): DopasowanieKosztu | null {
  if (!Number.isSafeInteger(przelew.amountGrosze) || przelew.amountGrosze >= 0) return null;
  const rachunek = rachunekZnormalizowany(przelew.counterpartyAccount);
  if (!rachunek) return null;
  const naRachunek = koszty.filter((k) => k.kwotaGr > 0 && rachunekZnormalizowany(k.rachunek) === rachunek);
  if (naRachunek.length === 0) return null;
  const kandydaci = naRachunek.map((k) => k.id);
  const kwotaGr = -przelew.amountGrosze;
  const tytul = przelew.title ?? '';

  const numeryKsef = ksefNumbersInText(tytul);
  if (numeryKsef.length > 0) {
    const trafione = naRachunek.filter((k) => {
      const numer = canonicalKsefNumber(k.numerKsef);
      return numer !== null && numeryKsef.includes(numer);
    });
    if (trafione.length === 0) return bez('ksef_nieznany', kandydaci);
    return suma(trafione) === kwotaGr ? pewne('ksef_number', trafione, kandydaci) : bez('kwota_inna', kandydaci, trafione.map((k) => k.id));
  }

  const identyfikatory = identyfikatoryZbiorczeWTekscie(tytul);
  if (identyfikatory.length > 0) {
    for (const identyfikator of identyfikatory) {
      const zestaw = zapisane.find((z) => poprawnyIdentyfikatorZbiorczy(z.identyfikator) === identyfikator);
      if (!zestaw) continue;
      const numery = new Set(zestaw.numeryKsef.map((n) => canonicalKsefNumber(n)).filter((n): n is string => n !== null));
      const trafione = naRachunek.filter((k) => {
        const numer = canonicalKsefNumber(k.numerKsef);
        return numer !== null && numery.has(numer);
      });
      // Cały zestaw musi być na liście: faktura zapłacona w międzyczasie to inna kwota i inny przelew.
      if (numery.size === 0 || trafione.length !== numery.size) continue;
      return suma(trafione) === kwotaGr ? pewne('collective_identifier', trafione, kandydaci) : bez('kwota_inna', kandydaci, trafione.map((k) => k.id));
    }
    return bez('identyfikator_nieznany', kandydaci);
  }

  const poNumerze = naRachunek.filter((k) => k.numerFaktury !== '' && invoiceNumberInText(k.numerFaktury, tytul));
  if (poNumerze.length > 0) {
    return suma(poNumerze) === kwotaGr ? pewne('invoice_number', poNumerze, kandydaci) : bez('kwota_inna', kandydaci, poNumerze.map((k) => k.id));
  }

  const poKwocie = naRachunek.filter((k) => k.kwotaGr === kwotaGr);
  if (poKwocie.length === 1) return { propozycja: { rodzaj: 'amount', kosztIds: [poKwocie[0]!.id], pewne: false }, uwaga: null, wskazane: [], kandydaci };
  return bez(poKwocie.length > 1 ? 'kilka_kosztow' : 'bez_propozycji', kandydaci);
}

// ─── Teksty ekranu i akcji ───────────────────────────────────────────────

const money = (grosze: number) => formatPaymentMoney(grosze / 100);

export const EXPENSE_BANK_ROLE_REFUSAL =
  'Przelewy do dostawców jako zapłaty kosztów potwierdza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.';
export const EXPENSE_MATCH_FAILED =
  'Nie udało się sprawdzić przelewów do dostawców z listy „Do zapłaty”, więc nie pokazujemy propozycji. Wgraj ten sam plik jeszcze raz: operacje zapisane wcześniej nie wejdą drugi raz.';
export const EXPENSE_LOAD_FAILED =
  'Nie udało się wczytać ostatnich zapłat kosztów z wyciągu. Odśwież stronę, a jeśli to się powtórzy, napisz do nas przez Pomoc.';
export const EXPENSE_SKIPPED_TEXT =
  'Pominięto przelew. Tytułu przelewu, nazwy ani rachunku odbiorcy nie zapisaliśmy; zostają kwota, dzień i znacznik, żeby przelew nie wrócił przy kolejnym wgraniu.';
export const EXPENSE_NOT_CONFIRMED_TEXT = 'Tego przelewu nie ma już wśród zapłat kosztów z wyciągu, więc nie ma czego cofać. Odśwież stronę.';
/** Wyjście przy odmowie: ręczne oznaczenie zapłaty z kroku 3.4. */
const RECZNIE = 'Zapłatę oznacza się wtedy w Wydatkach, w „Do zapłaty”, przyciskiem „Oznacz jako zapłacone”.';

function faktura(k: KosztDoPrzelewu | undefined): string {
  if (!k) return 'koszt';
  return `${k.numerFaktury || 'bez numeru'} (${k.sprzedawca})`;
}

/** „Faktura X (dostawca)” albo „Faktury X, Y (dostawca)”; `biernik`: „fakturę X …” w środku zdania. */
function faktury(ids: readonly string[], koszty: ReadonlyMap<string, KosztDoPrzelewu>, biernik = false): string {
  const lista = ids.map((id) => koszty.get(id)).filter((k): k is KosztDoPrzelewu => k !== undefined);
  if (lista.length === 0) return biernik ? 'koszt z listy' : 'Koszt z listy';
  if (lista.length === 1) return `${biernik ? 'fakturę' : 'Faktura'} ${faktura(lista[0])}`;
  return `${biernik ? 'faktury' : 'Faktury'} ${lista.map((k) => k.numerFaktury || 'bez numeru').join(', ')} (${lista[0]!.sprzedawca})`;
}

const SPOSOB: Record<'ksef_number' | 'collective_identifier' | 'invoice_number', string> = {
  ksef_number: 'numer KSeF w tytule',
  collective_identifier: 'identyfikator zbiorczy w tytule',
  invoice_number: 'numer faktury w tytule',
};

/** Opis propozycji przy przelewie: co pasuje, a przy braku pewności, co zrobić. */
export function opisDopasowania(d: DopasowanieKosztu, koszty: ReadonlyMap<string, KosztDoPrzelewu>): string {
  if (d.propozycja?.pewne) {
    const ile = d.propozycja.kosztIds.length > 1;
    return `${faktury(d.propozycja.kosztIds, koszty)}: ${SPOSOB[d.propozycja.rodzaj]}, ${ile ? 'suma' : 'kwota'} i rachunek jak na ${ile ? 'fakturach' : 'fakturze'}.`;
  }
  if (d.propozycja) {
    return `${faktury(d.propozycja.kosztIds, koszty)}: kwota i rachunek jak na fakturze, ale tytuł przelewu nie wskazuje faktury. Sprawdź i wybierz koszt.`;
  }
  switch (d.uwaga) {
    case 'ksef_nieznany':
      return 'Numer KSeF z tytułu nie pasuje do żadnego kosztu z listy „Do zapłaty” na ten rachunek. Sprawdź tytuł albo wybierz koszt ręcznie.';
    case 'identyfikator_nieznany':
      return 'Identyfikator zbiorczy z tytułu nie pasuje do faktur z listy „Do zapłaty” na ten rachunek: nie ma go wśród zapisanych albo część jego faktur jest już zapłacona. Wybierz koszty ręcznie albo pomiń przelew.';
    case 'kwota_inna': {
      const wskazane = d.wskazane.map((id) => koszty.get(id)).filter((k): k is KosztDoPrzelewu => k !== undefined);
      return `Tytuł przelewu wskazuje ${faktury(d.wskazane, koszty, true)}, ale kwota przelewu jest inna niż do zapłaty (${money(suma(wskazane))}). Przelew łączymy z kosztami tylko przy równej kwocie. ${RECZNIE}`;
    }
    case 'kilka_kosztow':
      return 'Kilka kosztów od tego dostawcy ma tę kwotę do zapłaty. Wybierz właściwy.';
    case 'koszt_zaplacony':
      return 'Koszt z propozycji jest już zapłacony innym przelewem z tego wyciągu. Jeśli to druga zapłata tej samej faktury, przelew można pominąć; inny koszt da się wybrać ręcznie.';
    default:
      return 'Rachunek odbiorcy jest na fakturach z listy „Do zapłaty”, ale kwota nie pasuje do żadnej z nich. Wybierz koszty, których suma równa się przelewowi, albo pomiń przelew.';
  }
}

export interface BankExpenseRefusalContext {
  documentNumber?: string | null;
  dueGr?: number | null;
  amountGr?: number | null;
}

const dokument = (numer: string | null | undefined) => (numer ? `Koszt ${numer}` : 'Wybrany koszt');

/** Tekst odmowy RPC zapłat kosztów z wyciągu: nazwa dokumentu i co zrobić (protokół napraw, pkt 4). */
export function bankExpenseRefusalText(code: unknown, ctx: BankExpenseRefusalContext = {}): string {
  switch (code) {
    case 'operation_confirmed':
      return 'Ten przelew jest już zapisany jako zapłata innych kosztów. Jeśli tamten wybór był pomyłką, cofa się go przyciskiem „Cofnij” w ostatnich zapłatach kosztów, potem można wybrać jeszcze raz.';
    case 'operation_skipped':
      return `Ten przelew jest pominięty, a jego danych nie zapisaliśmy. ${RECZNIE}`;
    case 'not_expense_payment':
      return 'Ten przelew nie pasuje do kosztów firmy (rachunek odbiorcy nie jest rachunkiem z żadnej faktury kosztowej), więc go nie zapisujemy.';
    case 'expense_not_found':
      return 'Nie znaleziono wybranego kosztu w aktywnej firmie. Odśwież stronę albo przełącz firmę.';
    case 'expense_paid':
      return `${dokument(ctx.documentNumber)} jest już oznaczony jako zapłacony. Jeśli ten przelew to inna zapłata, można go pominąć; jeśli wcześniejsze oznaczenie było pomyłką, cofa się je przy koszcie w Wydatkach.`;
    case 'nothing_to_pay':
      return `${dokument(ctx.documentNumber)} to korekta na minus, więc nie ma czego płacić. Ten przelew można pominąć.`;
    case 'expense_currency':
      return `${dokument(ctx.documentNumber)} jest w innej walucie niż złoty, a przelewy z wyciągu łączymy tylko z kosztami w złotych. ${RECZNIE}`;
    case 'account_mismatch':
      return `Rachunek odbiorcy przelewu jest inny niż rachunek na fakturze (${ctx.documentNumber ?? 'wybrany koszt'}), więc nie łączymy przelewu z tym kosztem. Jeśli to zapłata tej faktury, warto sprawdzić rachunek na białej liście. ${RECZNIE}`;
    case 'amount_mismatch': {
      const kwoty =
        typeof ctx.amountGr === 'number' && typeof ctx.dueGr === 'number' ? ` (${money(ctx.amountGr)}, a do zapłaty ${money(ctx.dueGr)})` : '';
      return `Kwota przelewu jest inna niż do zapłaty za wybrane koszty${kwoty}. Przelew łączymy z kosztami tylko przy równej kwocie; inną kwotę zapłaty oznacza się w Wydatkach przyciskiem „Oznacz jako zapłacone”, a przelew można pominąć.`;
    }
    case 'payment_in_future':
      return 'Dzień księgowania przelewu jest późniejszy niż dziś, więc zapłatę da się zapisać dopiero od tego dnia.';
    case 'invalid_operation':
      return 'Dane przelewu są niepełne, więc nic nie zapisaliśmy. Wgraj wyciąg jeszcze raz.';
    default:
      return DECISION_FAILED;
  }
}

export interface BankExpenseConfirmed {
  status: 'confirmed' | 'already_confirmed';
  paidOn: string | null;
  documents: Array<{ numer: string | null; sprzedawca: string | null }>;
}

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Komunikat po potwierdzeniu. */
export function bankExpenseConfirmedText(r: BankExpenseConfirmed): string {
  if (r.status === 'already_confirmed') return 'Ta zapłata jest już zapisana.';
  const dzien = isDay(r.paidOn) ? ` z dniem ${formatIsoDatePl(r.paidOn)}` : '';
  if (r.documents.length === 1) {
    const d = r.documents[0]!;
    return `Zapisano zapłatę kosztu ${d.numer ?? 'bez numeru'}${d.sprzedawca ? ` (${d.sprzedawca})` : ''}${dzien}. Koszt zniknął z listy „Do zapłaty”.`;
  }
  const numery = r.documents.map((d) => d.numer ?? 'bez numeru').join(', ');
  return `Zapisano zapłatę kosztów ${numery}${dzien}. Koszty zniknęły z listy „Do zapłaty”.`;
}

/** Komunikat po cofnięciu: co wróciło, co zostało i jak przypisać przelew jeszcze raz. */
export function bankExpenseUndoneText(reverted: number, kept: readonly string[]): string {
  const powrot = reverted > 0 ? ` ${reverted === 1 ? 'Koszt wrócił' : 'Koszty wróciły'} na listę „Do zapłaty”.` : '';
  const zostaje =
    kept.length > 0
      ? ` ${kept.length === 1 ? `Koszt ${kept[0]} zmieniony` : `Koszty ${kept.join(', ')} zmienione`} po potwierdzeniu ${kept.length === 1 ? 'został' : 'zostały'} bez zmian; ich zapłatę zmienia się w Wydatkach.`
      : '';
  return `Cofnięto zapłatę z przelewu.${powrot}${zostaje} Przelewu nie przechowujemy: żeby przypisać go do innego kosztu, wgraj wyciąg jeszcze raz.`;
}

/** Podsumowanie po wgraniu: ile przelewów do kosztów czeka na decyzję niżej. */
export function podsumowanieKosztow(liczba: number, znane: number): string | null {
  if (liczba === 0 && znane === 0) return null;
  const czesci: string[] = [];
  if (liczba > 0) czesci.push(`Przelewy do dostawców z listy „Do zapłaty” (${liczba}) czekają niżej na decyzję; zapiszemy je dopiero po potwierdzeniu.`);
  if (znane > 0) czesci.push(`Przelewów do kosztów rozstrzygniętych wcześniej (${znane}) nie pokazujemy drugi raz.`);
  return czesci.join(' ');
}

// ─── Wynik akcji propozycji ──────────────────────────────────────────────

export type ProposeBankExpensesResult =
  | {
      success: true;
      fileFormat: BankFileFormat;
      /** Przelewy na rachunki dostawców z listy, w kolejności z pliku, bez rozstrzygniętych wcześniej. */
      przelewy: PrzelewZPropozycja[];
      /** Koszty występujące w propozycjach i wyborze, w kolejności listy „Do zapłaty”. */
      koszty: KosztDoPrzelewu[];
      /** Przelewy do kosztów rozstrzygnięte wcześniej (potwierdzone albo pominięte). */
      znane: number;
    }
  | { success: false; error: string };

// ─── Odczyt RPC z 00196 ──────────────────────────────────────────────────

export interface KosztWZaplacie {
  id: string;
  numer: string | null;
  sprzedawca: string | null;
  /** Dzień zapłaty kosztu teraz: inny niż dzień przelewu albo `null` znaczy zmianę po potwierdzeniu. */
  zaplaconoO: string | null;
}

export interface ZaplataKosztuRozstrzygnieta {
  id: string;
  bookingDate: string;
  /** Ujemna (wypływ). */
  amountGrosze: number;
  state: 'confirmed' | 'skipped';
  decidedAt: string | null;
  /** Tylko przy potwierdzonych: pominięte nie mają danych drugiej strony. */
  counterpartyName: string | null;
  title: string | null;
  koszty: KosztWZaplacie[];
}

export interface ZaplatyKosztowRpc {
  confirmedTotal: number;
  decided: ZaplataKosztuRozstrzygnieta[];
}

export type ZaplatyKosztowEkranu = ({ ok: true } & ZaplatyKosztowRpc) | { ok: false; error: string };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const rows = (value: unknown): Record<string, unknown>[] | null =>
  Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row)) ? (value as Record<string, unknown>[]) : null;

/** Wynik `bank_expense_operations`. Kształt inny niż oczekiwany to `null` (ekran mówi o błędzie odczytu). */
export function parseBankExpenseOperationsRpc(data: unknown): ZaplatyKosztowRpc | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const decidedRows = rows(d.decided);
  const total = d.confirmed_total;
  if (!decidedRows || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return null;

  const decided: ZaplataKosztuRozstrzygnieta[] = [];
  for (const row of decidedRows) {
    const amountGrosze = groszeZBazy(row.amount);
    const kosztRows = rows(row.expenses);
    if (typeof row.id !== 'string' || !isDay(row.booking_date) || amountGrosze === null || amountGrosze >= 0 ||
        (row.state !== 'confirmed' && row.state !== 'skipped') || !kosztRows) {
      return null;
    }
    const koszty: KosztWZaplacie[] = [];
    for (const k of kosztRows) {
      if (typeof k.id !== 'string') return null;
      koszty.push({ id: k.id, numer: textOrNull(k.document_number), sprzedawca: textOrNull(k.seller_name), zaplaconoO: isDay(k.paid_at) ? k.paid_at : null });
    }
    decided.push({
      id: row.id,
      bookingDate: row.booking_date,
      amountGrosze,
      state: row.state,
      decidedAt: textOrNull(row.decided_at),
      counterpartyName: textOrNull(row.counterparty_name),
      title: textOrNull(row.title),
      koszty,
    });
  }
  return { confirmedTotal: total, decided };
}

/** Wynik `bank_known_operations`: klucz i stan; kształt inny niż oczekiwany to `null`. */
export function parseKnownBankOperationsRpc(data: unknown): Map<string, string> | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const known = rows(d.known);
  if (d.status !== 'ok' || !known) return null;
  const out = new Map<string, string>();
  for (const row of known) {
    if (typeof row.key !== 'string' || typeof row.state !== 'string') return null;
    out.set(row.key, row.state);
  }
  return out;
}
