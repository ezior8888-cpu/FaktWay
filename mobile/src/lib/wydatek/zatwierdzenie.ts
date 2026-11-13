/**
 * Wydatek ze zdjęcia (etap M9): pola ekranu sprawdzenia odczytu na treść
 * `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie` i czekanie na odczyt (OCR)
 * po wgraniu.
 *
 * Bez React Native: ten sam plik czytają testy strony
 * (`tests/unit/mobile-wydatki.test.ts`), które sprawdzają wynik prawdziwym
 * schematem trasy. Importy względne (patrz `mobile/AGENTS.md`).
 *
 * Treść jest taka jak z formularza kosztu strony (`handleSave` w
 * `components/expenses/expense-edit-form.tsx`): wszystkie pola, VAT zawsze
 * (serwer liczy odliczenie od nowa tylko przy faktycznej zmianie), numer
 * i notatka bez pustego tekstu, potwierdzenie złotych tylko przy dokumencie
 * w walucie bez kursu NBP. Zasady zapisu sprawdza serwer.
 */
import type { KolumnaKpir, Koszt } from '../../dane-przykladowe';
import type { OdczytWydatkuOdpowiedz, ZmianyWydatkuTelefonu } from '../api/kontrakt';

/** Pola ekranu sprawdzenia odczytu; kwoty w groszach. */
export type FormularzWydatku = {
  dostawca: string;
  nip: string;
  numer: string;
  data: string;
  netto: number;
  vat: number;
  brutto: number;
  kolumna: KolumnaKpir;
  kategoria: string;
  wKpir: boolean;
  notatki: string;
  /** Klient potwierdza, że wpisał kwoty w złotych (tylko przy `czekaNaZlote`). */
  zlotePotwierdzone: boolean;
};

/**
 * Kod waluty, gdy kwoty kosztu ze zdjęcia są jeszcze w walucie dokumentu
 * (bez kursu NBP i bez potwierdzenia złotych); `null`, gdy są w złotych.
 * Koszt z KSeF ma własną drogę (opis na stronie).
 */
export function czekaNaZlote(k: Pick<Koszt, 'zrodlo' | 'walutaKwot'>): string | null {
  if (k.zrodlo === 'ksef') return null;
  return k.walutaKwot && k.walutaKwot !== 'PLN' ? k.walutaKwot : null;
}

/** VAT kosztu w groszach: zapisany przy koszcie z bazy, inaczej brutto minus netto. */
export function vatKosztu(k: Pick<Koszt, 'vat' | 'netto' | 'brutto'>): number {
  return k.vat ?? k.brutto - k.netto;
}

export function formularzZKosztu(k: Koszt): FormularzWydatku {
  return {
    dostawca: k.dostawca,
    nip: k.nip ?? '',
    numer: k.numer,
    data: k.data,
    netto: k.netto,
    vat: vatKosztu(k),
    brutto: k.brutto,
    kolumna: k.kolumna,
    kategoria: k.kategoria,
    wKpir: k.wKpir,
    notatki: k.opis,
    zlotePotwierdzone: false,
  };
}

const zlote = (grosze: number) => Math.round(grosze) / 100;

/** Treść zatwierdzenia jak formularz kosztu strony. */
export function zmianyWydatku(f: FormularzWydatku, waluta: string | null): ZmianyWydatkuTelefonu {
  const numer = f.numer.trim();
  const notatki = f.notatki.trim();
  const nip = f.nip.replace(/\D/g, '');
  return {
    seller_name: f.dostawca.trim(),
    seller_nip: nip === '' ? null : nip,
    ...(numer ? { document_number: numer } : {}),
    issue_date: f.data,
    net_amount: zlote(f.netto),
    vat_amount: zlote(f.vat),
    gross_amount: zlote(f.brutto),
    kpir_column: `col_${f.kolumna}`,
    category_label: f.kategoria,
    is_deductible: f.wKpir,
    ...(notatki ? { notes: notatki } : {}),
    ...(waluta !== null ? { confirmPlnAmounts: f.zlotePotwierdzone } : {}),
  };
}

/** Pole z błędem i zdanie pod nim; `null`, gdy można wysłać. Resztę sprawdza serwer. */
export type BladFormularza = { pole: 'dostawca' | 'data' | 'netto' | 'vat' | 'brutto'; komunikat: string };

export function sprawdzFormularz(f: FormularzWydatku): BladFormularza | null {
  if (!f.dostawca.trim()) return { pole: 'dostawca', komunikat: 'Wpisz nazwę sprzedawcy.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.data)) return { pole: 'data', komunikat: 'Wybierz datę dokumentu.' };
  if (!Number.isFinite(f.netto)) return { pole: 'netto', komunikat: 'Wpisz kwotę netto, np. 81,30.' };
  if (!Number.isFinite(f.vat)) return { pole: 'vat', komunikat: 'Wpisz VAT, np. 18,70. Bez VAT wpisz 0.' };
  if (!Number.isFinite(f.brutto) || f.brutto <= 0) return { pole: 'brutto', komunikat: 'Wpisz kwotę brutto z dokumentu.' };
  return null;
}

// ─── Czekanie na odczyt ───────────────────────────────────────────────

/**
 * Jedno pytanie o stan odczytu (`GET /wydatki/odczyt/{id}`):
 * `nieznany` to brak sieci albo 503: stan nieznany, pytamy dalej i nie
 * wgrywamy zdjęcia drugi raz (na stronie E16, drugi koszt z tego samego zdjęcia).
 */
export type StanOdczytuTelefonu =
  | { stan: 'trwa' }
  | { stan: 'gotowy'; wydatekId: string }
  | { stan: 'nieudany'; komunikat: string }
  | { stan: 'brak' }
  | { stan: 'nieznany' }
  | { stan: 'sesja' };

export function stanOdczytuZOdpowiedzi(o: OdczytWydatkuOdpowiedz['odczyt']): StanOdczytuTelefonu {
  if (o.stan === 'completed' && o.wydatekId) return { stan: 'gotowy', wydatekId: o.wydatekId };
  if (o.stan === 'failed') return { stan: 'nieudany', komunikat: o.blad ?? 'Nie udało się odczytać dokumentu.' };
  // `completed` bez wydatku nie powinno się zdarzyć; czekamy jak przy `processing`.
  return { stan: 'trwa' };
}

export type KoniecCzekania =
  | { wynik: 'gotowy'; wydatekId: string }
  | { wynik: 'nieudany'; komunikat: string }
  | { wynik: 'brak' }
  | { wynik: 'czas' }
  | { wynik: 'sesja' }
  | { wynik: 'przerwano' };

export type OpcjeCzekania = {
  /** Odstęp między pytaniami (jak strona: 2 s). */
  coMs?: number;
  /** Najdłużej tyle czekamy (strona: 60 s; telefon dłużej, bo bywa w słabej sieci). */
  limitMs?: number;
  czekaj?: (ms: number) => Promise<void>;
  teraz?: () => number;
  /** Ekran zamknięty: bez dalszych pytań i bez przejścia. */
  przerwano?: () => boolean;
};

export const ODCZYT_CO_MS = 2000;
export const ODCZYT_LIMIT_MS = 90_000;

/** Pyta o odczyt, aż będzie gotowy, nieudany, zniknie albo minie limit. Jedno pytanie naraz. */
export async function czekajNaOdczyt(pytaj: () => Promise<StanOdczytuTelefonu>, opcje: OpcjeCzekania = {}): Promise<KoniecCzekania> {
  const co = opcje.coMs ?? ODCZYT_CO_MS;
  const limit = opcje.limitMs ?? ODCZYT_LIMIT_MS;
  const czekaj = opcje.czekaj ?? ((ms: number) => new Promise<void>((gotowe) => setTimeout(gotowe, ms)));
  const teraz = opcje.teraz ?? Date.now;
  const przerwano = opcje.przerwano ?? (() => false);
  const start = teraz();
  for (;;) {
    if (przerwano()) return { wynik: 'przerwano' };
    const s = await pytaj().catch((): StanOdczytuTelefonu => ({ stan: 'nieznany' }));
    if (przerwano()) return { wynik: 'przerwano' };
    if (s.stan === 'gotowy') return { wynik: 'gotowy', wydatekId: s.wydatekId };
    if (s.stan === 'nieudany') return { wynik: 'nieudany', komunikat: s.komunikat };
    if (s.stan === 'brak') return { wynik: 'brak' };
    if (s.stan === 'sesja') return { wynik: 'sesja' };
    if (teraz() - start + co > limit) return { wynik: 'czas' };
    await czekaj(co);
  }
}
