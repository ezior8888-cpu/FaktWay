// Dane przykładowe stron z kartami (poprawka Bartosza 21.10.2026: firma przed
// weryfikacją KSeF ma zobaczyć „pełną okazałość” aplikacji; PLAN-PRAWDZIWE-DANE
// §5.3–5.4, etap E2). Zestaw tabel dla atrapy PostgREST-a: Pulpit, Przepływy
// i Analizy czytają go TYMI SAMYMI loaderami co prawdziwą bazę, więc liczby są
// spójne z definicji (zysk = przychód − koszty, wpływy = faktury sprzedaży
// według terminów płatności).
//
// KSZTAŁT FINORY (poprawka Bartosza 23.10.2026: „pierwsze wrażenie ma być:
// o jezu, ale to jest ładne”). Generator nie losuje miesięcy, tylko celuje
// w wykresy szablonu Finora, przeliczone na złote (× 1000 zł):
//   - sprzedaż brutto 7 ostatnich miesięcy = sumy słupków „Finance” Finory
//     (20, 28, 40, 25, 44, 50, 44) — stos Koszty + Zysk + VAT należny,
//   - 5 miesięcy wcześniej dokłada początek linii „Wyświetlenia” (pary jak
//     20-20, 50-50, 30), więc 12 miesięcy VAT należnego ma jej rytm,
//   - ten sam okres rok wcześniej = blada seria „Telefon” karty przychodu,
//   - lata wstecz = słupki „Rocznie” (28,4 / 31,2 / 36,4 / 39,1 względem
//     ostatnich 12 miesięcy), stąd historia od stycznia sprzed czterech lat,
//   - terminy płatności układają wpływy miesięcy jak „Miesięcznie” Finory
//     (32, 28, 35, 26, 38, 30), a należności bieżącego miesiąca w kolumny
//     17% / 65% / 18% (dawne „Odwiedzający”),
//   - koszty brutto 7 ostatnich miesięcy to 55–90% wpływów, na zmianę nisko
//     i wysoko jak „Miesięcznie” Finory (`KOSZTY_FINORY`, poprawka ze
//     zrzutów 24.10.2026 — dawniej 25–40%, słupki wydatków ledwie od ziemi),
//     zawsze z zyskiem; starsze lata — część sprzedaży jak „Rocznie” Finory.
//     Stali dostawcy z dawnych danych przykładowych Analiz (sprzed E2, te
//     same kategorie i miesiące, kwoty × 1,6), resztę dopełnia podwykonawca
//     (koszt zmienny), więc kategorie Analizy kosztów są wyrównane jak
//     w Finorze, a nie jedna wielka. Na „Finansach” koszty to dolny segment.
// Wykresy Finory nie są ze sobą spójne (np. „Wyświetlenia” i „Finance” to
// osobne wymyślone serie), a tu każda liczba wynika z tych samych faktur —
// pierwszeństwo ma wykres „Finanse”, reszta jest tak blisko, jak pozwala
// spójność (szczegóły przy stałych niżej).
//
// Wpływy jak u prawdziwej firmy po weryfikacji KSeF (E11, decyzja D-W):
// klient nic nie oznacza, więc żadna faktura nie ma `paid_at` — wpływ to dzień
// terminu płatności (korekta bez terminu — dzień wystawienia). Firmy i NIP-y
// są fikcyjne: każda nazwa z „Przykład”, NIP-y zaczynają się od zer (AGENTS.md).
//
// Koszty jak u prawdziwej firmy po weryfikacji KSeF (E10, decyzja D-K):
// faktury zakupu z KSeF — z ostatnich miesięcy ze Skrzynki, każda z jednym
// wydatkiem (kategoria, opis), starsze z historii KSeF bez wydatku
// (archiwum) — oraz wydatki spoza KSeF (OCR, ręczne, paragony). Karty liczą
// je jedną definicją (`getCostsWithKsefPurchases`), KPiR — same wydatki.
import { currentMonthKey, daysInMonth, shiftMonthKey } from '@/lib/analytics-finance/months';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import type { KsefEnvironment } from '@/types/ksef';

import type { Row, Tables } from './fake-postgrest';

/** Firma-atrapa: wiersze przykładowe nie należą do żadnej prawdziwej firmy. */
export const DEMO_TENANT = 'przyklad-analizy';
const T = DEMO_TENANT;

/** Tyle pełnych lat wstecz sięga historia (od stycznia) — widok „Rocznie” ma pięć słupków jak w Finorze. */
export const LATA_HISTORII = 4;

export interface OpcjePrzykladu {
  /**
   * Wariant firmy zwolnionej z VAT (art. 113) — TYLKO dla testów karty limitu.
   * Faktury bez VAT, koszty bez odliczenia, obroty mniejsze (limit nie
   * przekroczony), podstawa zwolnienia w `tenants`.
   */
  zwolnionyZVat?: boolean;
}

const r2 = (n: number) => roundToCents(n) || 0;
const pad = (n: number) => String(n).padStart(2, '0');
const suma = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);

interface Kalendarz {
  now: Date;
  /** Dziś w Warszawie, RRRR-MM-DD. */
  today: string;
  /** Bieżący miesiąc w Warszawie, RRRR-MM. */
  month: string;
  /** Dzień miesiąca dziś (1–31). */
  day: number;
  /** Ile miesięcy historii (z bieżącym): od stycznia sprzed `LATA_HISTORII` lat. */
  miesiace: number;
}

function kalendarz(now: Date): Kalendarz {
  const today = todayInWarsaw(now);
  const month = currentMonthKey(now);
  const monthIndex = Number(month.slice(5, 7)) - 1;
  return { now, today, month, day: Number(today.slice(8, 10)), miesiace: monthIndex + 1 + 12 * LATA_HISTORII };
}

function dodaj(iso: string, dni: number): string {
  const wynik = addDaysToIsoDate(iso, dni);
  if (wynik === null) throw new Error(`Dane przykładowe: zła data ${iso}`);
  return wynik;
}

/** Różnica dni między datami RRRR-MM-DD. */
function dniMiedzy(from: string, to: string): number {
  const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Niedziela tygodnia (pn–nd) dnia `iso` — granica kolumny „Ten tydzień”. */
function niedziela(iso: string): string {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dodaj(iso, (7 - dow) % 7);
}

/**
 * Dzień `day` miesiąca `k` wstecz. W bieżącym miesiącu dni są ściśnięte do
 * tych, które już minęły (dzień 28 przy „dziś” = 14. to 13.), więc bieżący
 * miesiąc ma od 1. dnia pełny komplet dokumentów i nic nie ma daty z przyszłości.
 */
function dzien(kal: Kalendarz, k: number, day: number): string {
  const key = shiftMonthKey(kal.month, -k);
  const dim = daysInMonth(key);
  let d = Math.min(day, dim);
  if (k === 0) d = Math.max(1, Math.ceil((d * kal.day) / dim));
  return `${key}-${pad(d)}`;
}

/** Ostatni dzień miesiąca `k` wstecz. */
function koniecMiesiaca(kal: Kalendarz, k: number): string {
  const key = shiftMonthKey(kal.month, -k);
  return `${key}-${pad(daysInMonth(key))}`;
}

// ─── Plan miesięcy: kształt wykresów Finory ───────────────────────────────

/**
 * Sprzedaż brutto miesięcy k = 0…6 (k = miesięcy wstecz), tys. zł: sumy
 * słupków „Finance” Finory od lipca wstecz do stycznia (44, 50, 44, 25, 40,
 * 28, 20). Stos na karcie (od dołu): Koszty + Zysk + VAT należny (23% netto).
 *
 * Szczyt 49,05 zamiast 50 (poprawka ze zrzutów 24.10.2026): netto 39,9 tys.
 * mieści się w automatycznej osi recharts 0–40 tys., więc słupki kart
 * „Przychód netto” i „Trend sprzedaży” sięgają pod górę wykresu jak w Finorze.
 * Przy 50 tys. brutto (netto 40,65) oś skakała do 60 tys. i najwyższy słupek
 * miał 2/3 wysokości. Na osi „Finanse” (0–50 tys.) różnicy nie widać.
 */
const FINANSE_FINORY = [44, 49.05, 44, 25, 40, 28, 20];
/**
 * k = 7…11: początek linii „Wyświetlenia” Finory (20-20, 50-50, 30 przy
 * szczycie 105) w skali karty VAT — dalszych siedem punktów to już słupki
 * „Finanse”, bo VAT należny to 23% tej samej sprzedaży.
 */
const LINIA_VAT_FINORY = [16, 26, 26, 11, 11];
/**
 * k = 12…16: te same miesiące rok wcześniej — blada seria „Telefon” karty
 * „Przychód netto” (80, 120, 138, 80, 141 przy szczycie 164) w jej skali.
 */
const ROK_WCZESNIEJ_FINORY = [43, 24, 42, 37, 24];
const STALE_MIESIACE = [...FINANSE_FINORY, ...LINIA_VAT_FINORY, ...ROK_WCZESNIEJ_FINORY];
/** Lata Y−1…Y−4 względem ostatnich 12 miesięcy — słupki „Rocznie” Finory (39,1 / 36,4 / 31,2 / 28,4). */
const LATA_FINORY = [39.1, 36.4, 31.2, 28.4].map((v) => v / 39.1);
/** Lekka fala wolnych miesięcy starszych lat (średnia 1), żeby rok nie był płaski. */
const FALA = [1.06, 0.94, 1.03, 0.95, 1.08, 0.97, 1.01, 0.93, 1.05, 0.98, 1.02, 0.98];
/** Wolny miesiąc mieści się w tylu tys. zł brutto (jak słupki „Finance”: 8–46 przy skali do 50). */
const MIN_MIESIAC = 8;
const MAKS_MIESIAC = 46;

/**
 * Wpływy miesięcy k = 1…6 (tys. zł brutto): „Miesięcznie” Finory (3000,
 * 3800, 2600, 3500, 2800, 3200 zł × 10). Bieżący miesiąc liczy się sam
 * (wpływy do wczoraj) — przy końcu miesiąca to ~32 tys., jak 3400 w Finorze.
 */
const WPLYWY_FINORY = [30, 38, 26, 35, 28, 32];

/**
 * Wpływy 7 ostatnich tygodni (od najstarszego): „Tygodniowo” Finory (620,
 * 340, 780, 410, 890, 460, 300) — naprzemiennie wysoko i nisko, bieżący
 * tydzień najniżej (liczy się tylko do wczoraj).
 */
const TYGODNIE_FINORY = [620, 340, 780, 410, 890, 460, 300];
/**
 * Wagi tygodni do rozkładu terminów: przed siedmioma tygodniami Finory jeszcze
 * dwa — ósmy, bo krzywa kafla „Wpływy w tym miesiącu” ma 8 punktów (sumy
 * tygodni, zrzuty 24.10.2026), i dziewiąty jako zapas: terminy ścięte do
 * końca miesiąca tuż przed ósmym tygodniem mogą zejść poza krzywą. Bez nich
 * terminy z początku i końca miesiąca zbierały się w ósmym tygodniu wstecz
 * i krzywa zaczynała się szczytem 2–3 razy wyższym od reszty.
 */
const WAGI_TYGODNI = [480, 480, ...TYGODNIE_FINORY];

/** Należności bieżącego miesiąca według terminów: „Ten tydzień” / „Do 30 dni” / „Później” — 17 / 65 / 18 jak kolumny Finory. */
const NALEZNOSCI_FINORY = { tenTydzien: 17, do30: 65, pozniej: 18 } as const;

/** Sprzedaż brutto (zł) każdego miesiąca historii, k = 0 … `kal.miesiace − 1`. */
function planSprzedazy(kal: Kalendarz): number[] {
  const brutto = Array.from({ length: kal.miesiace }, (_, k) => (STALE_MIESIACE[k] ?? 0) * 1000);
  const ostatnieDwanascie = suma(brutto.slice(0, 12));
  const monthIndex = Number(kal.month.slice(5, 7)) - 1;
  LATA_FINORY.forEach((udzial, i) => {
    const y = i + 1;
    // Miesiące roku Y−y: od grudnia (k = monthIndex + 1 + 12(y−1)) do stycznia.
    const ks = Array.from({ length: 12 }, (_, j) => monthIndex + 1 + 12 * (y - 1) + j).filter((k) => k < kal.miesiace);
    const wolne = ks.filter((k) => k >= STALE_MIESIACE.length);
    if (wolne.length === 0) return;
    const reszta = ostatnieDwanascie * udzial - suma(ks.filter((k) => k < STALE_MIESIACE.length).map((k) => brutto[k]!));
    const wagi = wolne.map((k) => FALA[k % FALA.length]!);
    wolne.forEach((k, j) => {
      brutto[k] = Math.min(MAKS_MIESIAC * 1000, Math.max(MIN_MIESIAC * 1000, Math.round((reszta * wagi[j]!) / suma(wagi))));
    });
  });
  return brutto;
}

/**
 * Koszty brutto miesięcy k = 0…6 (tys. zł) — słupki „Wydatki” wykresu
 * „Przepływy pieniężne” (poprawka ze zrzutów 24.10.2026: dawniej 25–40%
 * wpływów, w Finorze 55–125%). Na zmianę nisko i wysoko jak „Miesięcznie”
 * Finory (1900, 3420, 2100, 3250, 2000, 2400, 2400 od lipca wstecz): 55–90%
 * wpływów miesiąca (32, 30, 38, 26, 35, 28, 32 tys.), bez straty — przy
 * niskiej sprzedaży (20 tys. sprzed 6 miesięcy, 25 tys. sprzed 3) koszty
 * zostają pod przychodem netto, więc Finora 125% to tu ~85%.
 */
const KOSZTY_FINORY = [19, 26.8, 20.8, 22.1, 20, 22.4, 17.6];
/**
 * Starsze miesiące: koszty brutto jako część sprzedaży brutto miesiąca, rok
 * po roku (bieżący rok, Y−1 … Y−4) — „Rocznie” Finory (wydatki 26,18 / 36 /
 * 30 / 33 / 24,2 przy wpływach 34,6 / 39,1 / 36,4 / 31,2 / 28,4), ścięte tak,
 * żeby każdy rok miał zysk.
 */
const UDZIAL_KOSZTOW_LAT = [0.65, 0.78, 0.7, 0.86, 0.72];
/** Lekka fala starszych miesięcy (±3%), żeby rok kosztów nie był płaski. */
const FALA_KOSZTOW = FALA.map((f) => 1 + (f - 1) / 2);
/** Kwoty stałych dostawców (czynsz, leasing, księgowość…) wobec dawnych danych Analiz — resztę do celu dopełnia podwykonawca. */
const SKALA_DOSTAWCOW = 1.6;
/** Koszty miesiąca nie przekraczają tej części przychodu netto (zysk zostaje, słupek „Finanse” się nie odwraca). */
const MAKS_UDZIAL_KOSZTOW = 0.9;

/** Ile lat wstecz (0 = bieżący rok) leży miesiąc `k`. */
function rokWstecz(kal: Kalendarz, k: number): number {
  return Number(kal.month.slice(0, 4)) - Number(shiftMonthKey(kal.month, -k).slice(0, 4));
}

// ─── Sprzedaż ─────────────────────────────────────────────────────────────

type Pozycja = [name: string, unit: string, share: number];

interface Klient {
  nip: string;
  /** Krótka nazwa jak pozycje list Finory („Dell XPS 13”, „Czynsz za biuro”). */
  name: string;
  /** Dzień wystawienia w miesiącu. */
  day: number;
  /** Termin płatności w dniach od wystawienia (starsze miesiące). */
  termin: number;
  /** Waga w sprzedaży miesiąca (udział po przeskalowaniu do planu). */
  waga: number;
  /**
   * Zmiana wagi rok do roku (+ rośnie, − maleje) — strzałki w rankingu
   * klientów („Najwięksi klienci”: +, −, +, −, + jak „Najczęściej kupowane”
   * Finory). Liczy się różnica między klientami, nie poziom: sprzedaż
   * miesiąca i tak trzyma plan.
   */
  trend: number;
  aktywny: (k: number) => boolean;
  items: Pozycja[];
}

const ZAWSZE = () => true;

/**
 * Klienci okresowi (Fundacja, Biuro Podróży, Pracownia) wystawiają w miesiącu
 * poprzednim, nie bieżącym: bieżący ma już trzy faktury z terminem od dziś
 * (`TERMINY_OD_DZIS`), więc kafle „Faktury w KSeF” i „Średnia faktura” mają
 * zmianę rzędu Finory (+22%, −16%), nie +60%.
 */
const KLIENCI: Klient[] = [
  {
    nip: '0000001010', name: 'Hurtownia Przykład', day: 3, termin: 30, waga: 9600, trend: 0.48, aktywny: ZAWSZE,
    items: [['Abonament serwisowy', 'mies.', 0.55], ['Wdrożenie systemu', 'usł.', 0.45]],
  },
  {
    nip: '0000002020', name: 'Studio Przykład', day: 5, termin: 14, waga: 5600, trend: 0.08, aktywny: ZAWSZE,
    items: [['Projekt graficzny', 'szt.', 0.6], ['Konsultacje', 'godz.', 0.4]],
  },
  {
    nip: '0000003030', name: 'Sklep Przykład', day: 10, termin: 21, waga: 5200, trend: 0.46, aktywny: ZAWSZE,
    items: [['Hosting', 'mies.', 0.3], ['Abonament serwisowy', 'mies.', 0.7]],
  },
  {
    nip: '0000004040', name: 'Kancelaria Przykład', day: 14, termin: 30, waga: 4200, trend: 0.14, aktywny: ZAWSZE,
    items: [['Konsultacje', 'godz.', 0.5], ['Abonament serwisowy', 'mies.', 0.5]],
  },
  {
    nip: '0000006060', name: 'Gabinet Przykład', day: 7, termin: 14, waga: 2400, trend: -0.2, aktywny: ZAWSZE,
    items: [['Hosting', 'mies.', 0.4], ['Konsultacje', 'godz.', 0.6]],
  },
  {
    nip: '0000007070', name: 'Drukarnia Przykład', day: 20, termin: 30, waga: 3600, trend: 0.28, aktywny: ZAWSZE,
    items: [['Wdrożenie systemu', 'usł.', 1]],
  },
  {
    nip: '0000005050', name: 'Fundacja Przykład', day: 18, termin: 21, waga: 3400, trend: -0.2, aktywny: (k) => k % 2 === 1,
    items: [['Szkolenie zespołu', 'godz.', 1]],
  },
  {
    nip: '0000008080', name: 'Biuro Podróży Przykład', day: 24, termin: 14, waga: 5800, trend: -0.2, aktywny: (k) => k % 3 === 1,
    items: [['Szkolenie zespołu', 'godz.', 0.5], ['Konsultacje', 'godz.', 0.5]],
  },
  {
    nip: '0000009090', name: 'Pracownia Przykład', day: 16, termin: 14, waga: 1900, trend: -0.2, aktywny: (k) => k % 4 === 1,
    items: [['Projekt graficzny', 'szt.', 1]],
  },
  {
    // Nowy klient (ostatnie 8 miesięcy) — w rankingu „nowy”, bez procentu.
    nip: '0000011110', name: 'Agencja Przykład', day: 26, termin: 21, waga: 2600, trend: -0.2, aktywny: (k) => k <= 7,
    items: [['Licencja roczna', 'szt.', 0.35], ['Abonament serwisowy', 'mies.', 0.65]],
  },
];

/**
 * Faktury bieżącego miesiąca z terminem w kolumnach „Ten tydzień” i „Później”
 * (zwykłe faktury miesiąca wypełniają „Do 30 dni”). Kwoty z proporcji
 * `NALEZNOSCI_FINORY` — kolumny Należności mają kształt Finory każdego dnia.
 */
const TERMINY_OD_DZIS: Array<{
  klient: number;
  dzien: number;
  kolumna: 'tenTydzien' | 'pozniej';
  /** Część kolumny (dwie faktury „Później”). */
  czesc: number;
  /** Termin: dni od dziś (`null` — jutro albo dziś w niedzielę). */
  zaDni: number | null;
  items: Pozycja[];
}> = [
  { klient: 8, dzien: 9, kolumna: 'tenTydzien', czesc: 1, zaDni: null, items: [['Projekt graficzny', 'szt.', 1]] },
  { klient: 5, dzien: 12, kolumna: 'pozniej', czesc: 10 / 18, zaDni: 38, items: [['Szkolenie zespołu', 'godz.', 1]] },
  { klient: 4, dzien: 19, kolumna: 'pozniej', czesc: 8 / 18, zaDni: 47, items: [['Konsultacje', 'godz.', 1]] },
];

/** Korekta w bieżącym miesiącu: rabat do faktury Studia z poprzedniego miesiąca (netto). */
const KOREKTA_NETTO = -400;

/**
 * Bez wpłat (D-W: klient nic nie oznacza) — status jak wyzwalacz
 * `update_invoice_payment_status` (00073) dla `paid_amount = 0`.
 */
function platnosc(kal: Kalendarz, due: string | null) {
  return {
    payment_status: due !== null && due < kal.today ? 'overdue' : 'unpaid',
    paid_amount: 0,
    paid_at: null,
  };
}

interface Faktura {
  id: string;
  k: number;
  /** Indeks w `KLIENCI` (dzień terminu „następnego miesiąca” rozkłada się po nim). */
  i: number;
  klient: Klient;
  issue: string;
  net: number;
  gross: number;
  due: string | null;
  items: Pozycja[];
}

/**
 * Terminy płatności (E11: wpływ = dzień terminu). Miesiące k = 1…6 dostają
 * wpływy z `WPLYWY_FINORY`: część faktur miesiąca ma termin w tym samym
 * miesiącu, reszta — w następnym (rozłożona po jego dniach, większe kwoty
 * wcześniej, więc kafel „Wpływy w tym miesiącu” rośnie szybko i wyrównuje
 * się jak krzywa Finory). Miesiąc 7 wpływa cały w 6. Starsze — zwykły termin
 * klienta. Bieżący miesiąc to należności (`terminyBiezace`).
 */
function terminy(kal: Kalendarz, plan: Faktura[]): void {
  const zMiesiaca = (k: number) =>
    plan.filter((f) => f.k === k).sort((a, b) => a.issue.localeCompare(b.issue) || a.id.localeCompare(b.id));

  for (const f of plan) {
    if (f.k >= 8) f.due = dodaj(f.issue, f.klient.termin);
  }

  let przeniesione = 0;
  for (let k = Math.min(7, kal.miesiace - 1); k >= 1; k--) {
    const faktury = zMiesiaca(k);
    const cel = k <= 6 ? WPLYWY_FINORY[k - 1]! * 1000 - przeniesione : 0;
    const nastepny: Faktura[] = [];
    let wTymMiesiacu = 0;
    for (const f of faktury) {
      // Termin w tym samym miesiącu, dopóki suma nie przekroczy celu o więcej niż pół faktury.
      if (k <= 6 && wTymMiesiacu + f.gross / 2 <= cel) {
        wTymMiesiacu += f.gross;
        const due = dodaj(f.issue, f.klient.termin);
        const koniec = koniecMiesiaca(kal, k);
        f.due = due <= koniec ? due : koniec;
      } else {
        nastepny.push(f);
      }
    }
    przeniesione = suma(nastepny.map((f) => f.gross));
    // Termin w miesiącu k − 1: większe kwoty wcześniej, dni rozłożone od 2.
    // do wczoraj (bieżący miesiąc) albo do 20. (miesiące zamknięte).
    const key = shiftMonthKey(kal.month, -(k - 1));
    const ostatni = k === 1 ? kal.day - 1 : 20;
    nastepny.sort((a, b) => b.gross - a.gross || a.id.localeCompare(b.id));
    nastepny.forEach((f, j) => {
      if (ostatni < 1) {
        // 1. dzień miesiąca: wczoraj to poprzedni miesiąc — termin na jego koniec.
        f.due = koniecMiesiaca(kal, k);
        return;
      }
      const start = Math.min(2, ostatni);
      const d = nastepny.length === 1 ? start : start + Math.round((j * (ostatni - start)) / (nastepny.length - 1));
      f.due = `${key}-${pad(d)}`;
    });
  }
}

/** Poniedziałek tygodnia (pn–nd) dnia `iso`. */
function poniedzialek(iso: string): string {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dodaj(iso, -((dow + 6) % 7));
}

/**
 * Wpływy ostatnich 9 tygodni (7 rytmem „Tygodniowo” Finory i dwa przed nimi,
 * `WAGI_TYGODNI`): terminy, które już
 * minęły, przesuwamy w obrębie TEGO SAMEGO miesiąca (sumy „Miesięcznie” bez
 * zmian) i nie przed dniem wystawienia. Najpierw każda faktura idzie do
 * tygodnia z największym względnym brakiem wobec udziału Finory (największe
 * kwoty pierwsze), potem kilka przejść poprawek: faktura zmienia tydzień,
 * jeśli to zmniejsza względne odchylenie od Finory.
 */
function tygodnie(kal: Kalendarz, plan: Faktura[]): void {
  const wczoraj = dodaj(kal.today, -1);
  const pierwszy = dodaj(poniedzialek(kal.today), -7 * (WAGI_TYGODNI.length - 1));
  if (wczoraj < pierwszy) return;
  const wOknie = plan.filter((f) => f.k >= 1 && f.due !== null && f.due >= pierwszy && f.due <= wczoraj);
  if (wOknie.length === 0) return;
  const tydzien = (d: string) => Math.floor(dniMiedzy(pierwszy, d) / 7);
  /** Dni, na które wolno przesunąć termin: ten sam miesiąc, od wystawienia, w oknie, do wczoraj. */
  const dni = new Map(wOknie.map((f) => {
    const out: string[] = [];
    const month = f.due!.slice(0, 7);
    for (let d = f.issue > pierwszy ? f.issue : pierwszy; d <= wczoraj; d = dodaj(d, 1)) {
      if (d.slice(0, 7) === month) out.push(d);
    }
    return [f.id, out];
  }));
  const tygodnieFaktury = (f: Faktura) => [...new Set(dni.get(f.id)!.map(tydzien))];
  const dostepne = new Set(wOknie.flatMap(tygodnieFaktury));
  const wagi = WAGI_TYGODNI.map((w, t) => (dostepne.has(t) ? w : 0));
  const cel = wagi.map((w) => (w * suma(wOknie.map((f) => f.gross))) / suma(wagi));
  const przypisane = wagi.map(() => 0);
  const wybor = new Map<string, number>();
  const kolejnosc = [...wOknie].sort((a, b) => b.gross - a.gross || a.id.localeCompare(b.id));
  // Brak i odchylenie WZGLĘDNE (wobec celu tygodnia): mały tydzień Finory też dostaje swoje, żaden nie zostaje pusty.
  const brak = (w: number) => (cel[w]! - przypisane[w]!) / cel[w]!;
  for (const f of kolejnosc) {
    const t = tygodnieFaktury(f).reduce((best, w) => (brak(w) > brak(best) ? w : best));
    wybor.set(f.id, t);
    przypisane[t]! += f.gross;
  }
  const blad = (w: number, zmiana: number) => ((przypisane[w]! + zmiana - cel[w]!) / cel[w]!) ** 2;
  for (let przejscie = 0; przejscie < 6; przejscie++) {
    let poprawa = false;
    for (const f of kolejnosc) {
      const z = wybor.get(f.id)!;
      for (const w of tygodnieFaktury(f)) {
        if (w === z) continue;
        const roznica = blad(z, -f.gross) + blad(w, f.gross) - blad(z, 0) - blad(w, 0);
        if (roznica < -1e-6) {
          przypisane[z]! -= f.gross;
          przypisane[w]! += f.gross;
          wybor.set(f.id, w);
          poprawa = true;
          break;
        }
      }
    }
    if (!poprawa) break;
  }
  // Faktury tygodnia rozłożone po jego dniach roboczych (poprawka ze zrzutów
  // 24.10.2026): wszystkie w środku tygodnia dawały na kaflu „Wpływy w tym
  // miesiącu” schodek na jeden dzień i płaskie plateau — krzywa narastająca ma
  // iść łagodnie jak w Finorze. Sumy tygodni i miesięcy bez zmian.
  const wTygodniuFaktury = new Map<number, Faktura[]>();
  for (const f of kolejnosc) {
    const t = wybor.get(f.id)!;
    wTygodniuFaktury.set(t, [...(wTygodniuFaktury.get(t) ?? []), f]);
  }
  for (const faktury of wTygodniuFaktury.values()) {
    faktury.forEach((f, r) => {
      const wTygodniu = dni.get(f.id)!.filter((d) => tydzien(d) === wybor.get(f.id));
      // Dni robocze (bez weekendu, jeśli się da) — termin jak u prawdziwej faktury.
      const robocze = wTygodniu.filter((d) => {
        const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
        return dow !== 0 && dow !== 6;
      });
      const zbior = robocze.length > 0 ? robocze : wTygodniu;
      // Jedna faktura — środek tygodnia; kilka — równo od pierwszego do ostatniego dnia (większe kwoty wcześniej).
      const idx = faktury.length === 1
        ? Math.floor((zbior.length - 1) / 2)
        : Math.round((r * (zbior.length - 1)) / (faktury.length - 1));
      f.due = zbior[idx]!;
    });
  }
}

/**
 * Należności bieżącego miesiąca (E11, D-W): zwykłe faktury z terminem po tym
 * tygodniu, w ciągu 30 dni („Do 30 dni”), co 3 dni od poniedziałku — lista
 * „Spodziewane wpływy” ma rytm „za 3, 6, 9, 12 dni” jak w Finorze.
 */
function terminyBiezace(kal: Kalendarz, plan: Faktura[]): void {
  const poNiedzieli = dodaj(niedziela(kal.today), 1);
  plan
    .filter((f) => f.k === 0 && f.due === null && !f.id.startsWith('f-termin') && f.id !== 'f-kor')
    .sort((a, b) => a.issue.localeCompare(b.issue) || a.id.localeCompare(b.id))
    .forEach((f, j) => {
      f.due = dodaj(poNiedzieli, (j * 3) % 22);
    });
}

function faktury(
  kal: Kalendarz,
  env: KsefEnvironment,
  opcje: OpcjePrzykladu,
): { invoices: Row[]; lines: Row[]; brutto: number[]; netto: number[] } {
  const skala = opcje.zwolnionyZVat ? 0.45 : 1;
  const vatRate = opcje.zwolnionyZVat ? 0 : 0.23;
  const brutto = planSprzedazy(kal);
  const netto = brutto.map((g) => (g / 1.23) * skala);
  const plan: Faktura[] = [];

  // Bieżący miesiąc: korekta + należności w proporcjach Finory (zwykłe = „Do 30 dni”).
  const korNet = r2(KOREKTA_NETTO * skala);
  const do30 = ((netto[0]! - korNet) * NALEZNOSCI_FINORY.do30) / 100;
  const kolumna = { tenTydzien: (do30 * NALEZNOSCI_FINORY.tenTydzien) / NALEZNOSCI_FINORY.do30, pozniej: (do30 * NALEZNOSCI_FINORY.pozniej) / NALEZNOSCI_FINORY.do30 };

  for (let k = 0; k < kal.miesiace; k++) {
    const aktywni = KLIENCI.map((klient, i) => ({ klient, i })).filter(({ klient }) => klient.aktywny(k));
    // Trend działa przez dwa lata (ranking porównuje 12 z 12 miesiącami); starsze lata — wagi sprzed dwóch lat.
    const wagi = aktywni.map(({ klient }) => klient.waga * (1 + klient.trend) ** (-Math.min(k, 24) / 12));
    const cel = k === 0 ? do30 : netto[k]!;
    aktywni.forEach(({ klient, i }, j) => {
      const net = r2((cel * wagi[j]!) / suma(wagi));
      plan.push({
        id: `f-${k}-${i}`, k, i, klient, issue: dzien(kal, k, klient.day), net, gross: r2(net * (1 + vatRate)), due: null, items: klient.items,
      });
    });
  }
  const tenTydzien = niedziela(kal.today);
  const jutro = dodaj(kal.today, 1);
  TERMINY_OD_DZIS.forEach(({ klient, dzien: day, kolumna: k, czesc, zaDni, items }, j) => {
    const net = r2(kolumna[k] * czesc);
    plan.push({
      id: `f-termin-${j + 1}`, k: 0, i: klient, klient: KLIENCI[klient]!, issue: dzien(kal, 0, day), net,
      gross: r2(net * (1 + vatRate)),
      due: zaDni === null ? (jutro <= tenTydzien ? jutro : kal.today) : dodaj(kal.today, zaDni),
      items,
    });
  });
  terminy(kal, plan);
  tygodnie(kal, plan);
  terminyBiezace(kal, plan);

  const invoices: Row[] = [];
  const lines: Row[] = [];
  const numer = new Map<string, number>();
  const nastepny = (month: string) => {
    const n = (numer.get(month) ?? 0) + 1;
    numer.set(month, n);
    return n;
  };
  const wspolne = (issue: string) => ({
    tenant_id: T,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_environment: env,
    advance_invoice_ids: [],
    currency: 'PLN',
    issue_date: issue,
    sale_date: issue,
    is_b2c: false,
    origin: 'app',
    payment_data: null,
    created_at: issue === kal.today ? kal.now.toISOString() : `${issue}T08:00:00.000Z`,
  });

  plan.sort((a, b) => a.issue.localeCompare(b.issue) || a.id.localeCompare(b.id));
  for (const f of plan) {
    const due = f.due ?? dodaj(f.issue, f.klient.termin);
    invoices.push({
      id: f.id,
      ...wspolne(f.issue),
      invoice_kind: 'regular',
      invoice_type: 'VAT',
      parent_invoice_id: null,
      internal_number: `FV/${f.issue.slice(0, 4)}/${f.issue.slice(5, 7)}/${pad(nastepny(f.issue.slice(0, 7)))}`,
      net_total: f.net,
      vat_total: r2(f.gross - f.net),
      gross_total: f.gross,
      buyer_nip: f.klient.nip,
      buyer_data: { name: f.klient.name, nip: f.klient.nip },
      payment_due_date: due,
      ...platnosc(kal, due),
    });
    // Ostatnia pozycja domyka netto faktury co do grosza.
    let reszta = f.net;
    f.items.forEach(([name, unit, share], j) => {
      const amount = j === f.items.length - 1 ? r2(reszta) : r2(f.net * share);
      reszta -= amount;
      lines.push({ id: `${f.id}-l${j}`, invoice_id: f.id, name, unit, net_amount: amount });
    });
  }

  // Korekta w bieżącym miesiącu: rabat do faktury Studia z poprzedniego miesiąca.
  // 1. dnia miesiąca byłaby jedynym wpływem miesiąca (bez terminu wpływa w dniu
  // wystawienia) — kafel „Wpływy w tym miesiącu” pokazałby „−492 zł”; wtedy jej nie ma.
  if (kal.day === 1) return { invoices, lines, brutto, netto };
  // Najpóźniej wczoraj: korekta z dziś byłaby jedynym wpływem bieżącego tygodnia (słupek pod osią).
  const kor = `${kal.month}-${pad(Math.min(Number(dzien(kal, 0, 16).slice(8, 10)), kal.day - 1))}`;
  const korVat = r2(korNet * vatRate);
  invoices.push({
    id: 'f-kor',
    ...wspolne(kor),
    invoice_kind: 'correction',
    invoice_type: 'KOR',
    parent_invoice_id: 'f-1-1',
    internal_number: `KOR/${kor.slice(0, 4)}/${kor.slice(5, 7)}/01`,
    net_total: korNet,
    vat_total: korVat,
    gross_total: r2(korNet + korVat),
    buyer_nip: KLIENCI[1]!.nip,
    buyer_data: { name: KLIENCI[1]!.name, nip: KLIENCI[1]!.nip },
    payment_due_date: null,
    ...platnosc(kal, null),
  });
  return { invoices, lines, brutto, netto };
}

// ─── Wydatki ──────────────────────────────────────────────────────────────

interface Dostawca {
  nip: string | null;
  name: string;
  category: string;
  day: number;
  /** Brutto dokumentu `k` miesięcy wstecz. */
  gross: (k: number) => number;
  aktywny: (k: number) => boolean;
  /** Paragon zamiast faktury (VAT bez odliczenia, koszt = brutto). */
  paragon?: boolean;
  /** VAT bez prawa do odliczenia (reprezentacja). */
  bezOdliczenia?: boolean;
  /** Dokument z bieżącego miesiąca czeka na opisanie („Do opisania”). */
  doOpisania?: boolean;
  /**
   * Skąd dokument (E10): `ksef` — faktura zakupu z KSeF (Skrzynka z wydatkiem
   * albo archiwum z historii), `ocr` — zdjęcie dokumentu spoza KSeF; brak —
   * wydatek wpisany ręcznie.
   */
  kanal?: 'ksef' | 'ocr';
}

/**
 * Miesiące 0…6 jak w dawnych danych przykładowych Analiz (przed E2: te same
 * miesiące, kwoty × `SKALA_DOSTAWCOW`), starsze — co `co` miesięcy. Dwie
 * zmiany wobec dawnych list (szkolenie z 4. miesiąca wstecz w 3., reklama
 * z 2. w 1.) — sumy miesięcy i tak wyznacza `KOSZTY_FINORY`.
 */
function miesiace(lista: readonly number[], co: number, przesuniecie = 0) {
  return (k: number) => (k <= 6 ? lista.includes(k) : k % co === przesuniecie);
}
/** Kwota z dawnych danych (rośnie lub maleje z `k` przez pół roku), starsze miesiące powtarzają ten rytm. */
const pol = (k: number) => (k <= 6 ? k : k % 7);

const DOSTAWCY: Dostawca[] = [
  // Czynsz 2400 zł netto (dawniej 2460 brutto; × `SKALA_DOSTAWCOW` — 3840): koszt roku większy od piątego klienta, więc
  // „Największe źródła przepływów” mieszają wpływy i koszty jak w Finorze (zielone i czerwone kwoty).
  // Faktura za czynsz 1. dnia (poprawka ze zrzutów 24.10.2026; dawniej 3.): skok o 1/3 kosztów
  // tuż po starcie wyginał krzywą kafla „Koszty w tym miesiącu” w dołek pod pierwszym punktem.
  { nip: '0000000011', name: 'Coworking Przykład sp. z o.o.', category: 'Czynsz', day: 1, gross: () => 2952, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000022', name: 'Leasing Przykład S.A.', category: 'Usługi finansowe', day: 15, gross: () => 1599, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000033', name: 'Biuro Rachunkowe Przykład sp. z o.o.', category: 'Usługi obce', day: 10, gross: () => 738, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000044', name: 'Chmura Przykład sp. z o.o.', category: 'Oprogramowanie', day: 1, gross: () => 615, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000055', name: 'Energia Przykład S.A.', category: 'Energia', day: 12, gross: (k) => 380 + pol(k) * 17.5, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000066', name: 'Telekom Przykład S.A.', category: 'Telekomunikacja', day: 8, gross: () => 184.5, aktywny: ZAWSZE, kanal: 'ksef' },
  { nip: '0000000077', name: 'Stacja Paliw Przykład sp. z o.o.', category: 'Paliwo', day: 6, gross: (k) => 412.3 - pol(k) * 21, aktywny: ZAWSZE, kanal: 'ocr' },
  { nip: '0000000077', name: 'Stacja Paliw Przykład sp. z o.o.', category: 'Paliwo', day: 19, gross: (k) => 368.9 + pol(k) * 12, aktywny: ZAWSZE, kanal: 'ocr' },
  // Tankowanie z końca miesiąca także w bieżącym (dawniej od poprzedniego): w ściśniętym bieżącym
  // miesiącu wypada w tym tygodniu, więc ostatni słupek „Tygodniowo” ma koszty jak w Finorze.
  { nip: '0000000077', name: 'Stacja Paliw Przykład sp. z o.o.', category: 'Paliwo', day: 27, gross: (k) => 198 + pol(k) * 5, aktywny: ZAWSZE, kanal: 'ocr' },
  { nip: '0000000088', name: 'Agencja Reklamowa Przykład sp. z o.o.', category: 'Marketing', day: 14, gross: (k) => (k === 0 ? 1230 : 615), aktywny: miesiace([0, 1, 5], 3), kanal: 'ksef' },
  { nip: '0000000099', name: 'Restauracja Przykład', category: 'Reprezentacja', day: 17, gross: (k) => 286 - pol(k) * 9, aktywny: miesiace([0, 1, 3, 4], 2), bezOdliczenia: true, doOpisania: true, kanal: 'ocr' },
  { nip: null, name: 'Sklep Papierniczy Przykład', category: 'Materiały biurowe', day: 9, gross: (k) => 159.9 + pol(k) * 7, aktywny: miesiace([0, 2, 4, 6], 2), paragon: true, doOpisania: true },
  { nip: null, name: 'Księgarnia Przykład', category: 'Pozostałe', day: 20, gross: () => 89, aktywny: miesiace([0, 3], 6), paragon: true },
  { nip: '0000000101', name: 'Szkolenia Przykład sp. z o.o.', category: 'Usługi obce', day: 24, gross: () => 1476, aktywny: miesiace([1, 3], 6, 1), kanal: 'ksef' },
  { nip: '0000000112', name: 'Kurier Przykład sp. z o.o.', category: 'Pozostałe', day: 4, gross: (k) => 36.9 + pol(k), aktywny: ZAWSZE },
  { nip: '0000000123', name: 'Sklep Komputerowy Przykład S.A.', category: 'Oprogramowanie', day: 22, gross: () => 1845, aktywny: miesiace([3], 12, 3), kanal: 'ksef' },
];

/**
 * Podwykonawca (programista na fakturze z KSeF) dopełnia koszty miesiąca do
 * celu (`KOSZTY_FINORY`, `UDZIAL_KOSZTOW_LAT`) — koszt zmienny firmy
 * usługowej, który rośnie i spada z projektami; stali dostawcy mają stałe kwoty.
 */
const PODWYKONAWCA: DaneDostawcy = {
  nip: '0000000134',
  name: 'Programista Przykład',
  category: 'Usługi obce',
  kanal: 'ksef',
};
/** Podwykonawca fakturuje dwa razy w miesiącu (połowa i koniec) — koszty tygodni bez jednego szpica. */
const PODWYKONAWCA_FAKTURY = [
  { day: 11, udzial: 0.45 },
  { day: 25, udzial: 0.55 },
] as const;
/** Poniżej tej kwoty brutto podwykonawca nie wystawia faktury w miesiącu. */
const MIN_PODWYKONAWCA = 300;

/**
 * Skrzynka KSeF działa od tylu miesięcy (z bieżącym): faktury zakupu z tego
 * okresu mają wydatek ze Skrzynki, starsze są archiwum z historii KSeF.
 * Sześć — każdy miesiąc do wyboru w Analizach (`ANALYTICS_MONTH_OPTIONS`) ma
 * kategorie wydatków jak w dawnych danych przykładowych Analiz, a archiwum
 * („Faktury z KSeF”) zaczyna się od najstarszego słupka „Finanse”.
 */
const MIESIACE_SKRZYNKI = 6;

/** Firma przykładowa jako nabywca faktur zakupu (fikcyjna, jak reszta). */
const NABYWCA = { name: 'Twoja Firma Przykład', nip: '0000000000' } as const;

type DaneDostawcy = Pick<Dostawca, 'nip' | 'name' | 'category' | 'paragon' | 'bezOdliczenia' | 'kanal'>;

function wydatek(
  kal: Kalendarz,
  id: string,
  nr: number,
  d: DaneDostawcy,
  date: string,
  gross: number,
  net: number,
  zwolniony: boolean,
  reviewed: boolean,
  /** Faktura ze Skrzynki, z której powstał wydatek (00121: jeden wydatek na fakturę). */
  faktura: Row | null = null,
): Row {
  const vat = r2(gross - net);
  const odliczenie = zwolniony || d.paragon || d.bezOdliczenia ? 0 : vat;
  return {
    id,
    tenant_id: T,
    source: faktura ? 'ksef_inbox' : d.kanal === 'ocr' ? 'ocr_photo' : 'manual',
    ksef_invoice_id: faktura ? faktura.id : null,
    issue_date: date,
    seller_nip: d.nip,
    seller_name: d.name,
    document_number: faktura
      ? faktura.internal_number
      : d.paragon
        ? `PAR ${date.slice(8, 10)}/${nr}`
        : `FV/${nr}/${date.slice(5, 7)}/${date.slice(0, 4)}`,
    is_deductible: true,
    is_reviewed: reviewed,
    document_type: d.paragon ? 'receipt' : 'invoice',
    net_amount: net,
    vat_amount: vat,
    gross_amount: gross,
    vat_deductible_amount: odliczenie,
    category_label: d.category,
    ocr_extracted_data: null,
    created_at: date === kal.today ? kal.now.toISOString() : `${date}T08:00:00.000Z`,
  };
}

/**
 * Faktura zakupu z KSeF (E10) w kształcie zapisu prawdziwych ścieżek:
 * Skrzynka (`inbox-polling`: metadane w `fa3_data`, bez `seller_data`) albo
 * historia (`processImportedInvoices`: `seller_data`). Bez terminu i bez
 * wpłat — zakupów nie rozliczamy (statusy jak wyzwalacz 00073 dla braku terminu).
 */
function fakturaZakupu(
  kal: Kalendarz,
  env: KsefEnvironment,
  id: string,
  nr: number,
  d: DaneDostawcy,
  date: string,
  gross: number,
  net: number,
  origin: 'ksef_inbox' | 'ksef_import',
): Row {
  const sprzedawca = { name: d.name, nip: d.nip };
  return {
    id,
    tenant_id: T,
    direction: 'incoming',
    origin,
    ksef_status: 'accepted',
    ksef_environment: env,
    ksef_number: `${d.nip}-${date.replaceAll('-', '')}-${id.toUpperCase()}`,
    internal_number: `FV/${nr}/${date.slice(5, 7)}/${date.slice(0, 4)}`,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    currency: 'PLN',
    issue_date: date,
    sale_date: date,
    net_total: net,
    vat_total: r2(gross - net),
    gross_total: gross,
    seller_nip: d.nip,
    seller_data: origin === 'ksef_import' ? sprzedawca : null,
    fa3_data: origin === 'ksef_inbox' ? { _source: 'inbox-metadata', seller: sprzedawca } : {},
    buyer_nip: NABYWCA.nip,
    buyer_data: { ...NABYWCA },
    is_b2c: false,
    payment_data: null,
    payment_due_date: null,
    payment_status: 'unpaid',
    paid_amount: 0,
    paid_at: null,
    created_at: date === kal.today ? kal.now.toISOString() : `${date}T08:00:00.000Z`,
  };
}

/** Koszt jak w KPiR: netto + VAT bez odliczenia (`kpirCostAmount`); firma zwolniona — brutto. */
function kosztKpir(d: DaneDostawcy, gross: number, zwolniony: boolean): number {
  return zwolniony || d.paragon || d.bezOdliczenia ? gross : gross / 1.23;
}

/**
 * Dokument kosztowy miesiąca `k`: wydatek, a dla faktur z KSeF także faktura
 * zakupu — ze Skrzynki z wydatkiem (ostatnie `MIESIACE_SKRZYNKI`) albo
 * z historii bez wydatku.
 */
function dokument(
  kal: Kalendarz,
  env: KsefEnvironment,
  k: number,
  slot: string,
  nr: number,
  d: DaneDostawcy,
  date: string,
  gross: number,
  net: number,
  zwolniony: boolean,
  reviewed: boolean,
  out: { expenses: Row[]; purchases: Row[] },
): void {
  const faktura = d.kanal === 'ksef'
    ? fakturaZakupu(kal, env, `z-${slot}`, nr, d, date, gross, net, k < MIESIACE_SKRZYNKI ? 'ksef_inbox' : 'ksef_import')
    : null;
  const row = wydatek(kal, `w-${slot}`, nr, d, date, gross, net, zwolniony, reviewed, faktura);
  if (faktura) out.purchases.push(faktura);
  if (!faktura || faktura.origin === 'ksef_inbox') out.expenses.push(row);
}

/**
 * Koszty brutto miesiąca `k` (zł, przed skalą firmy zwolnionej): ostatnie
 * siedem miesięcy z `KOSZTY_FINORY`, starsze — część sprzedaży brutto roku.
 */
function celKosztow(kal: Kalendarz, k: number, brutto: readonly number[]): number {
  const stala = KOSZTY_FINORY[k];
  if (stala !== undefined) return stala * 1000;
  const udzial = UDZIAL_KOSZTOW_LAT[rokWstecz(kal, k)] ?? UDZIAL_KOSZTOW_LAT.at(-1)!;
  return (brutto[k] ?? 0) * udzial * FALA_KOSZTOW[k % FALA_KOSZTOW.length]!;
}

function wydatki(
  kal: Kalendarz,
  env: KsefEnvironment,
  brutto: readonly number[],
  netto: readonly number[],
  opcje: OpcjePrzykladu,
): { expenses: Row[]; purchases: Row[] } {
  const skala = opcje.zwolnionyZVat ? 0.45 : 1;
  const zwolniony = opcje.zwolnionyZVat === true;
  const out = { expenses: [] as Row[], purchases: [] as Row[] };
  for (let k = 0; k < kal.miesiace; k++) {
    const aktywni = DOSTAWCY.map((d, i) => ({ d, i })).filter(({ d }) => d.aktywny(k));
    const stale = aktywni.map(({ d }) => d.gross(k) * SKALA_DOSTAWCOW * skala);
    const cel = celKosztow(kal, k, brutto) * skala;
    // Stali dostawcy mieszczą się w celu (słaby miesiąc — mniejsze kwoty), resztę dopełnia podwykonawca.
    const zmniejsz = Math.min(1, cel / suma(stale));
    const reszta = cel - suma(stale) * zmniejsz;
    const podwykonawca = reszta >= MIN_PODWYKONAWCA * skala ? reszta : 0;
    // Żaden miesiąc nie kończy się stratą — koszty najwyżej 90% przychodu netto.
    const kpir = suma(aktywni.map(({ d }, j) => kosztKpir(d, stale[j]! * zmniejsz, zwolniony)))
      + kosztKpir(PODWYKONAWCA, podwykonawca, zwolniony);
    const ogranicz = Math.min(1, (MAKS_UDZIAL_KOSZTOW * (netto[k] ?? 0)) / kpir);
    aktywni.forEach(({ d, i }, j) => {
      const date = dzien(kal, k, d.day);
      const gross = r2(stale[j]! * zmniejsz * ogranicz);
      dokument(kal, env, k, `${k}-${pad(i)}`, 100 + i, d, date, gross, r2(gross / 1.23), zwolniony, !(k === 0 && d.doOpisania), out);
    });
    if (podwykonawca > 0) {
      // Dwie faktury w miesiącu (`PODWYKONAWCA_FAKTURY`) — jedna duża dawała na krzywej
      // kafla „Koszty w tym miesiącu” (sumy tygodni) pojedynczy szpic.
      const razem = r2(podwykonawca * ogranicz);
      let reszta = razem;
      PODWYKONAWCA_FAKTURY.forEach(({ day, udzial }, j) => {
        const gross = j === PODWYKONAWCA_FAKTURY.length - 1 ? r2(reszta) : r2(razem * udzial);
        reszta -= gross;
        dokument(kal, env, k, `${k}-9${j}`, 23 + j, PODWYKONAWCA, dzien(kal, k, day), gross, r2(gross / 1.23), zwolniony, true, out);
      });
    }
  }
  return out;
}

// ─── Firma ────────────────────────────────────────────────────────────────

function firma(kal: Kalendarz, opcje: OpcjePrzykladu): Row {
  return {
    id: T,
    vat_exemption_basis: opcje.zwolnionyZVat ? 'art. 113 ust. 1 ustawy o VAT' : null,
    // Działalność od 5 lat (przed najstarszą fakturą) — limit VAT bez proporcji, cały rok w historii.
    business_started_on: `${shiftMonthKey(kal.month, -12 * (LATA_HISTORII + 1))}-01`,
  };
}

/**
 * Tabele atrapy bazy: `tenants`, `invoices` (sprzedaż i faktury zakupu
 * z KSeF), `invoice_line_items` (sprzedaż), `expenses`.
 */
export function danePrzykladowe(now: Date, env: KsefEnvironment, opcje: OpcjePrzykladu = {}): Tables {
  const kal = kalendarz(now);
  const { invoices, lines, brutto, netto } = faktury(kal, env, opcje);
  const { expenses, purchases } = wydatki(kal, env, brutto, netto, opcje);
  return {
    tenants: [firma(kal, opcje)],
    invoices: [...invoices, ...purchases],
    invoice_line_items: lines,
    expenses,
  };
}
