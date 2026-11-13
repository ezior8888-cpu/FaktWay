/**
 * Rachunek spoza wykazu podatników VAT (biała lista) a koszt w PIT według dnia
 * wystawienia faktury kosztowej (rejestr RP-BL-01, plan kompletnej aplikacji,
 * krok 3.4). Jedno miejsce reguły dla listy „Do zapłaty”, karty kosztu
 * i pliku przelewów.
 *
 * Do 31.12.2026 zapłata ponad 15 000 zł (próg z art. 19 Prawa przedsiębiorców)
 * na rachunek spoza wykazu odbiera koszt w PIT (art. 22p ustawy o PIT), chyba
 * że w 7 dni pójdzie zawiadomienie ZAW-NR. Ustawa z 18.09.2026 r. (Dz.U. 2026
 * poz. 1371) od 1.01.2027 zostawia w art. 22p tylko płatność bez rachunku
 * płatniczego (art. 1 pkt 2), a do płatności z faktury wystawionej przed
 * 1.01.2027 każe stosować art. 22p w brzmieniu dotychczasowym (art. 3), także
 * przy zapłacie w 2027 r. Liczy się więc dzień wystawienia faktury, nie dzień
 * zapłaty. W VAT bez zmian: solidarna odpowiedzialność za VAT sprzedawcy
 * i zawiadomienie ZAW-NR zostają przy każdej fakturze.
 *
 * Dzień wystawienia: P_1 z faktury KSeF (`invoices.issue_date`), a bez niego
 * data dokumentu kosztu (`expenses.issue_date`), jako dzień w Europe/Warsaw
 * (`issueDayInWarsaw`). Czy przy fakturze z KSeF liczy się P_1, czy dzień
 * przesłania do KSeF, rozstrzyga prawnik (pytanie 18 w
 * `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md`). P_1 nie jest późniejszy od
 * przesłania, więc dawne ostrzeżenie obejmuje co najmniej te faktury, które
 * obejmowałoby przy dniu przesłania. Bez czytelnej daty: dawne zasady
 * (ostrzeżenie zostaje).
 *
 * Gotówka: zapłata ponad 15 000 zł bez rachunku płatniczego odbiera koszt
 * w PIT przed zmianą i po niej. Uwaga tylko tam, gdzie wiadomo o gotówce:
 * faktura podaje formę płatności 1 (gotówka, `FormaPlatnosci` z FA(3)).
 *
 * Moduł bez importów serwerowych: lista (serwer), ekran (przeglądarka)
 * i akcja pliku przelewów. Testy: `tests/unit/biala-lista-pit.test.ts`.
 */

import { issueDayInWarsaw } from '@/lib/expenses/vat-deduction-document';

/** Pierwszy dzień wystawienia faktury, przy którym rachunek spoza wykazu nie odbiera już kosztu w PIT. */
export const PIT_BEZ_SANKCJI_BIALEJ_LISTY_OD = '2027-01-01';

/** `FormaPlatnosci` z FA(3) (`TFormaPlatnosci`): 1 to gotówka. */
const FORMA_GOTOWKA = '1';

/** Daty kosztu: dokument kosztu i jego faktura KSeF. */
export interface DatyKosztu {
  /** Data dokumentu kosztu (RRRR-MM-DD). */
  issue_date?: string | null;
  /** Faktura KSeF kosztu; `issue_date` to P_1. */
  faktura?: { issue_date?: string | null } | null;
}

/** Dzień wystawienia faktury kosztowej w Polsce: P_1 z faktury KSeF, a bez niego data dokumentu kosztu; `null` bez czytelnej daty. */
export function dzienWystawieniaKosztu(w: DatyKosztu): string | null {
  return issueDayInWarsaw(w.faktura?.issue_date) ?? issueDayInWarsaw(w.issue_date);
}

/** Czy zapłata ponad 15 000 zł na rachunek spoza wykazu odbiera koszt w PIT: faktura sprzed 1.01.2027 albo bez dnia wystawienia. */
export function rachunekSpozaWykazuOdbieraKosztPit(dzienWystawienia: string | null): boolean {
  return dzienWystawienia === null || dzienWystawienia < PIT_BEZ_SANKCJI_BIALEJ_LISTY_OD;
}

const ZAWIADOMIENIE =
  'chyba że w ciągu 7 dni od zlecenia przelewu zawiadomisz naczelnika właściwego urzędu skarbowego (formularz ZAW-NR).';

/** Skutki zapłaty ponad 15 000 zł na rachunek spoza wykazu: to samo zdanie na ekranie i w powodzie pliku przelewów. */
export function skutkiRachunkuSpozaWykazu(odbieraKosztPit: boolean): string {
  return odbieraKosztPit
    ? 'Zapłata ponad 15 000 zł na rachunek spoza wykazu oznacza, że tej kwoty nie zaliczysz do kosztów w PIT ' +
        `i odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę, ${ZAWIADOMIENIE}`
    : 'Zapłata ponad 15 000 zł na rachunek spoza wykazu oznacza, że odpowiadasz solidarnie za VAT niezapłacony ' +
        `przez sprzedawcę, ${ZAWIADOMIENIE}`;
}

/** Uwaga przy koszcie ponad 15 000 zł brutto, którego faktura podaje płatność gotówką. */
export const UWAGA_GOTOWKA =
  'Faktura podaje płatność gotówką. Zapłata ponad 15 000 zł bez rachunku płatniczego (gotówką) oznacza, ' +
  'że tej kwoty nie zaliczysz do kosztów w PIT.';

/** Czy faktura podaje płatność gotówką (`FormaPlatnosci` 1 z pliku KSeF). */
export function platnoscGotowka(formaPlatnosci: string | null | undefined): boolean {
  return formaPlatnosci === FORMA_GOTOWKA;
}
