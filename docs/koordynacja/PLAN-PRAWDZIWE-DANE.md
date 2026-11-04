# Plan „prawdziwe dane” — Pulpit, Przepływy, Analizy

> **„Kontynuuj plan prawdziwe dane”**: sesja czyta ten plik od góry, robi
> checklistę startową (sekcja 0) i pracuje od wiersza „Następny krok”
> w dzienniku (sekcja 14). Robi JEDEN etap, według „Protokołu naprawy błędu”
> z `AGENTS.md`, a na końcu dopisuje wiersz w dzienniku z numerem PR
> i nowym „Następnym krokiem”. Raport po etapie i stop.

Stan na 22.10.2026, `main` do #314 włącznie (#316 zmienia tylko usuwanie
firmy w `components/settings/`, plików planu nie dotyka). Podstawa:
`docs/koordynacja/AUDYT-DANYCH-PULPIT-ANALIZY-PRZEPLYWY.md` (dalej „audyt”,
mapowanie pól na prawdziwe dane, §1–§8). Ten plan mówi, *co* i *w jakiej
kolejności*. Protokół z `AGENTS.md` mówi, *jak*.

**Cel jednym zdaniem.** Dopóki aktywna firma nie potwierdziła KSeF, Pulpit,
Przepływy i Analizy wyglądają jak dziś: każda karta jest pełna danymi
przykładowymi. Po potwierdzeniu klient widzi WYŁĄCZNIE prawdziwe dane, żadna
liczba przykładowa nie przecieka, a każde pole pokazuje to, co mówi jego
podpis. Design zostaje: zmieniamy dane i podpisy, nie siatkę.

---

## 0. Start sesji — checklista

1. `git fetch origin && git log --oneline -1 origin/main`. Gałąź etapu zawsze
   od świeżego `origin/main`: `claude/dane-eN-<temat>`. Jeden etap = jedna
   gałąź = jeden PR, bez stosów (PLAN-ZERO-ZGUBIONYCH-FAKTUR §2 pkt 1).
2. Ten plan i audyt muszą być w `main`. Jeśli nie są (powstały na gałęzi
   `claude/design-audit-data-plan-67fc82`), pierwszy PR to same dokumenty.
3. Sprawdź w dzienniku (§14), czy decyzje blokujące Twój etap (§3, kolumna
   „blokuje”) mają odpowiedź Bartosza. Brak odpowiedzi = STOP i pytanie.
4. Przeczytaj audyt w części dotyczącej Twojego etapu oraz kod plików
   z karty etapu (§7). Numery linii w tym planie są ze stanu #314 i mogą się
   przesunąć.
5. Najpierw czerwony test (§8), potem zmiana. Przed PR: `pnpm typecheck`,
   `eslint` na zmienionych plikach, pełny `pnpm vitest run`, `pnpm build`
   (każdy etap dotyka `app/`). Brak `xmllint` lokalnie → PLAN-FINORA §0 pkt 6.
6. Zrzut ekranu Pulpitu i Przepływów w trybie przykładowym przy 1440 px
   i 375 px PRZED i PO zmianie (w opisie PR). Kryterium: ten sam wygląd
   kart, siatki i animacji; inne mogą być tylko liczby i podpisy.
7. Scalanie i wdrożenie robi Bartosz albo sesja na jego wyraźne polecenie
   (`AGENTS.md`, „Scalanie PR”). Etapy E0–E8 nie mają migracji.

---

## 1. Definicja sukcesu (do odhaczenia w §13)

1. **Zero przecieku.** Po weryfikacji w HTML żadnej z trzech stron nie ma
   żadnego znacznika przykładu (§8 T2), a moduły `lib/demo/*-przykladowe`
   i `lib/demo/fake-postgrest` nie są wołane (szpieg w teście).
2. **Pełne demo.** Przed weryfikacją każda karta wszystkich trzech stron ma
   dane: żadnego pustego stanu, każda lista ma tyle pozycji co w szablonie,
   każdy trend ma wartość (§8 T4).
3. **Spójne demo.** Liczby przykładowe zgadzają się ze sobą (zysk =
   przychód − koszty, suma kolumn = suma karty, kwota kafla = ostatni punkt
   wykresu) i przesuwają się z datą (§8 T5).
4. **Uczciwe podpisy.** Każde pole z audytu §1 ma tytuł i podpis zgodny ze
   źródłem; żadnego „Zamówienia”, „Odwiedzający”, „Wyświetlenia”,
   „Cel oszczędnościowy”, „Rachunek firmowy”, „nieudana”.
5. **Stany z §4** (A, B, B', C, D, E, F, G, G', G'', H) mają test i działają na produkcji (sprawdzone na
   koncie testowym przed i po wgraniu certyfikatu).
6. **Design bez zmian.** Ta sama siatka, liczba kart, typ wykresu, liczba
   pozycji, animacje (zrzuty z §0 pkt 6).
7. **Żadna atrapa interakcji.** Każdy przycisk, menu ⋯ i wiersz, który
   wygląda na klikalny, coś robi (audyt §3) albo przestaje wyglądać na
   klikalny.

---

## 2. Decyzje, które już zapadły (nie otwieraj ich ponownie)

| # | Decyzja | Źródło |
|---|---|---|
| D1 | **Design zostaje.** Żadna karta nie znika, siatka, typy wykresów, liczba pozycji i animacje bez zmian. Zmieniamy dane, tytuły, podpisy, ikony w kartach i cele linków. | polecenie Bartosza 22.10.2026; PLAN-FINORA D3 |
| D2 | Przed weryfikacją KSeF każda karta pełna danymi przykładowymi; po weryfikacji wyłącznie prawdziwe dane. | polecenie Bartosza 22.10.2026 |
| D3 | **Bramka = istniejący dowód**, bez nowej kolumny: `tenants.ksef_verified_at` i `ksef_verified_environment` równe `KSEF_ENV` (`hasConfiguredKsefProof`, `lib/ksef/claim-environment.ts:25`). Ustawia go tylko RPC `finalize_ksef_certificate_claim` (00117) z `uploadCertificateAction` (`components/settings/actions.ts`). | kod |
| D4 | **Błąd odczytu bramki → prawdziwe dane** (`lib/demo/kontekst-przykladowy.ts:8-17`). Przykład u zweryfikowanej firmy jest gorszy niż pusty pulpit u niezweryfikowanej. | kod, Analizy 21.10 |
| D5 | Analizy przed weryfikacją już działają na atrapie bazy przez te same loadery (`analizyKontekst`, `lib/demo/fake-postgrest.ts`, `lib/demo/analizy-przykladowe.ts`). To wzorzec dla całego planu. | poprawka Bartosza 21.10 |
| D6 | **FLO i własność plików** jak PLAN-FINORA D4 i §11: nie edytujesz `components/flo/*`, `app/(dashboard)/flo/*`, `content/flo/*`, `app/(dashboard)/settings/flo/*`, `e2e/tests/flo-*.spec.ts`, `lib/flo/*`; `lib/dashboard-nav-config.ts` tylko za zgodą. Pulpit nie ma slotu FLO (decyzja 19.10). | PLAN-FINORA |
| D7 | W tekstach dla klienta tylko **„FaktWay”** (strażnik `tests/unit/nazwa-produktu.test.ts`). | PLAN-FINORA D8 |
| D8 | **Karty podatkowe dozwolone** (VAT należny, limit zwolnienia, „Odłóż na podatek”). | PLAN-FINORA D7 |
| D9 | **Bez migracji w torze głównym** (E0–E8). Następny wolny numer to **00156** (`docs/koordynacja/CLAUDE-DO-CODEXA.md:98`); weźmie go dopiero tor uzupełniający (§10, K1 albo K2), jeśli Bartosz go zatwierdzi. | rejestr |
| D10 | Protokół naprawy z `AGENTS.md` bez wyjątków: jedna zmiana = jedna gałąź od `origin/main` = jeden PR, najpierw czerwony test, scalanie tylko na polecenie Bartosza. | AGENTS.md |

---

## 3. Decyzje do podjęcia (Bartosz)

Numeracja Z#, żeby nie mylić z D# wyżej. W nawiasie numer z audytu §7.

| # | Pytanie | Rekomendacja | Blokuje |
|---|---|---|---|
| Z1 (audyt D6) | Demo Pulpitu i Przepływów: (a) atrapa bazy czytana przez prawdziwe loadery (jak Analizy), (b) dzisiejsze stałe z szablonu przeniesione do `lib/demo` jako propsy | **(a).** Wygląd kart ten sam, ale liczby przestają sobie przeczyć (zysk 48 568 > przychód 38 453), daty idą z kalendarzem, a kształt danych jest z definicji ten sam co prawdziwy. (b) zostawia sprzeczności i drugi kod do utrzymania (§5.3) | E2, E5, E6 |
| Z2 | **Bezpiecznik w E1:** do czasu E5/E6 zweryfikowana firma widzi na Pulpicie i Przepływach stare karty na prawdziwych danych (`PulpitGrid`, `PrzeplywyGrid`) zamiast liczb z szablonu | **Tak.** Dziś zweryfikowany klient widzi Samsunga i Netflixa (audyt §0 pkt 1). Bezpiecznik zamyka przeciek w pierwszym PR, kosztem przejściowo innego wyglądu tylko dla zweryfikowanych firm (przed launchem: pojedyncze konta) | E1 |
| Z3 (audyt D7) | Linia stanu: jedna wąska linia tekstu nad siatką (`col-span-full`, `text-xs`) w stanach A, B, E; w Analizach w istniejącym nagłówku | **Tak.** To nie karta i nie zmienia siatki. Plakietka „Dane przykładowe” ma wyjaśnienie widoczne, nie tylko w `title` (audyt §3, `demo-badge.tsx:14`) | E3 |
| Z4 | Kiedy firma jest „w synchronizacji” (stan B) | **Gdy (1) strumień sprzedaży (`direction='outgoing'`) w `ksef_history_sync` istnieje i nie ma `backfill_completed_at`, albo (2) strumienia sprzedaży jeszcze nie ma, a weryfikacja była mniej niż 2 h temu.** Zakupy nie przedłużają stanu B, bo ich strumień czeka na HWM skrzynki (`ksef-history-sync.ts`). Błąd certyfikatu (stan E) i pauza klienta (B') mają pierwszeństwo przed B | E3 |
| Z5 (audyt D4) | Drugi kafel Pulpitu („Zysk łącznie”) | **„Średnia faktura”** (netto na fakturę, % m/m). Należności są już w karcie „według terminu”, zysk w Raporcie | E5 |
| Z6 (audyt D5) | Raport: bieżący miesiąc czy suma okresu wykresu | **Bieżący miesiąc**, podpis „Ten miesiąc” (gotowa logika `buildMonthReport`) | E5 |
| Z7 | Wykres „Finanse”: 7 miesięcy (jak dziś) czy 12 | **7**, podpis „Ostatnie 7 miesięcy · netto”. Ten sam wygląd, uczciwy podpis | E5 |
| Z8 (audyt D2) | Wpływy bez N6: co mówi pusty stan | **„Wpłat jeszcze nie oznaczono”** bez wezwania do czynności, której nie ma (`lib/invoices/paid-labels.ts:11` dziś każe „oznaczać”). Ten sam tekst jest dziś na produkcji w kaflu „Opłacone” listy faktur (`invoice-stat-tiles.tsx:145`), więc to osobny błąd: **E0, PR XS przed E1**. N6 osobno (K2), wtedy wraca przycisk | E0 |
| Z9 (audyt D1) | Koszty z historii zakupów KSeF | **Backfill `expenses` dla bieżącego roku podatkowego (K1)**, a do tego czasu podpis „Faktury kosztowe z KSeF od DD.MM” w kartach kosztów i zysku; data = `ksef_verified_at` (już w odczycie bramki, bez nowego zapytania; skrzynka sięga 48 h wcześniej, `inbox-polling.ts:58`) | E5, E6 (podpis) |
| Z10 (audyt D8) | „Odłóż na podatek” = 19% liniowo | Podpis „przy podatku liniowym 19%, bez ZUS — szacunek” | E6 |
| Z11 (audyt D9) | Wywołać `clearKsefHistoryCertificateErrors` w `uploadCertificateAction` | **Tak, E8** (dziś woła ją tylko test) | E8 |
| Z12 (audyt D10) | Czy historia sprzed rejestracji naprawdę przychodzi | Sprawdzić na koncie z realnymi fakturami, **zanim** linia B obieca „pobieramy historię od 2022” | tekst E3 |
| Z13 (audyt D11) | E-commerce | **Nie przed launchem** (audyt §5); wracamy przy ≥ 10 płacących chętnych albo ≥ 15% firm z PKD 47.91, wtedy przez BaseLinkera | — |
| Z14 | Stan E (certyfikat wygasł / unieważniony): wracać do przykładu? | **Nie.** Raz zweryfikowana firma w danym środowisku zostaje na prawdziwych danych (flaga się nie zeruje); dostaje linię „Certyfikat KSeF wygasł…” | E3 |
| Z15 | KPiR (`reports/kpir/page.tsx:37-45`) też przez nową funkcję trybu | **Tak, w E1b** (jedno miejsce decyzji, bez zmiany zachowania) | E1b |
| Z16 (audyt D12) | Należności do czasu K2 (N6): bez potwierdzania wpłat każda faktura z FaktWay wisi jako nieopłacona, więc „Należności według terminu”, „X% po terminie” i „Spodziewane wpływy” rosną z każdą fakturą (audyt §0 pkt 4) | **K2 przed launchem.** Do tego czasu podpis „Wpłat jeszcze nie potwierdzamy — zapłacone faktury też są tu liczone” w kartach Należności (Pulpit, Analizy) i Spodziewanych wpływów. Alternatywa: tytuł „Faktury według terminu płatności” | E4, E5, E6 (podpis) |
| Z17 (audyt D13) | „Finanse”: stos Koszty + Zysk (sylwetka słupka ta sama, 2 kolory) czy 3 słupki obok siebie (`stackId` usunięty, 3 kolory, inna sylwetka) | **Stos Koszty + Zysk** — bliżej obecnego wyglądu; przy stracie słupek = koszty, „Zysk” 0, strata w dymku i Raporcie | E5 |

**Rozstrzygnięcia Bartosza 23.10.2026.** Przyjęte rekomendacje Z1–Z17 z
następującymi zmianami (nadrzędna zasada: wszystko zostaje identyczne
rozmiarowo i designowo, zmieniają się tylko napisy i źródło danych):

- **Design identyczny:** bez Z3 (linii stanu nad siatką), bez Z2
  (bezpiecznika ze starymi kartami) i bez pkt 5–6 z E7. Żadnych nowych
  kart, linii ani wierszy; dłuższe wyjaśnienia tylko w `title` / `sr-only`.
- **Z17:** stos Koszty + Zysk + VAT = sprzedaż brutto.
- **D-P (druczek):** przed weryfikacją KSeF Pulpit i Przepływy mają
  plakietkę „Dane przykładowe” (ta sama co w Księgowości i Analizach).
- **D-W (wpłaty, zamiast N6 / Z16): ODWOŁANE 02.11.2026 na polecenie
  Bartosza** (FaktWay 1.0 §3 pkt 3, migracja 00158). Było: klient niczego nie
  oznacza, zakładamy zapłatę faktury sprzedaży w dniu terminu płatności (brak
  terminu: data wystawienia); prawdziwa data zapłaty (`invoices.paid_at` albo
  `Zaplacono` + `DataZaplaty` z FA(3)) ma pierwszeństwo; podpisy „według
  terminów płatności”; Należności nie twierdzą, że ktoś zalega. Jest: klient
  oznacza zapłatę jednym dotknięciem („Zapłacone”, RPC `mark_invoice_paid`).
  Wpływy to wyłącznie prawdziwe pieniądze (`paid_at` albo data z FA(3)),
  faktura bez wpłaty z minionym terminem to należność po terminie (Pulpit
  i Analizy znów na `getReceivables`), spodziewane wpływy to otwarte faktury
  z terminem dziś lub później. Pliki `lib/demo/*` bez zmian: w trybie
  `przyklad` miniony termin gra rolę wpłaty (`przykladoweWplywy`).
- **D-K (koszty):** wykresy i karty kosztów pokazują pełne koszty z KSeF
  (faktury zakupowe, także z archiwum historii, plus wydatki spoza KSeF
  bez powiązanej faktury, bez podwójnego liczenia). KPiR, JPK, eksporty
  i tabela `expenses` bez zmian (rozliczenie podatkowe klienta).
- **Wdrożenie:** zgoda na scalenie i wdrożenie w tej samej sesji.

---

## 4. Stany firmy i co widzi klient

Tryb liczy jedna funkcja (§5.1) na każde żądanie, dla firmy z
`getPageContext().tenantId`. Kolumna „warunek” to dokładna reguła.

| Stan | Warunek | Dane w kartach | Linia stanu (Z3) | Puste stany |
|---|---|---|---|---|
| **A** brak weryfikacji | `!hasConfiguredKsefProof(verified_at, verified_environment)` | **przykład** z atrapy bazy, każda karta pełna | plakietka „Dane przykładowe” + „Twoje liczby pojawią się po podłączeniu KSeF.” + link „Podłącz KSeF” → `/settings/ksef`. Rola inna niż właściciel: „Poproś właściciela firmy o podłączenie KSeF” (weryfikacja wymaga właściciela i MFA) | brak (demo jest pełne) |
| **B** weryfikacja jest, historia się pobiera | A nie zachodzi i reguła Z4 | **prawdziwe**, NIGDY przykład | „Pobieramy Twoje faktury z KSeF. Liczby będą rosły w miarę pobierania.” + link „Szczegóły” → `/import-danych` (tam pełny postęp z `readKsefHistorySyncStatus`) | „Pobieramy faktury z KSeF…” zamiast „Wystaw fakturę” |
| **C** prawdziwe dane | A, B, B', E, G'' nie zachodzą | prawdziwe | brak | puste stany z PLAN-FINORA §7.3 |
| **D** zweryfikowana, zero faktur | C i brak danych w kartach | prawdziwe zera / puste stany | brak | „Wystaw pierwszą fakturę” / „Dodaj wydatek”. Firma poniżej 10 tys. zł/mies. może mieć pustą historię i to nie jest błąd (audyt §4) |
| **B'** pobieranie wstrzymane przez klienta | jak B, ale strumień sprzedaży ma `client_paused_at` | prawdziwe | „Pobieranie historii z KSeF jest wstrzymane.” + link „Wznów” → `/import-danych` | jak C (bez „Pobieramy…”) |
| **E** certyfikat wygasł / unieważniony / brak uprawnień | weryfikacja jest, a strumień **sprzedaży** ma `last_error_code` z `KSEF_HISTORY_CERTIFICATE_ERRORS` (`lib/ksef/history-sync/client-pause.ts:89`: `certificate_expired`, `credentials`, `permission`) — ten sam strumień i lista, które czyści E8 | prawdziwe (Z14) | „Certyfikat KSeF wygasł albo stracił uprawnienia — nowe faktury nie dochodzą.” + link „Odnów certyfikat” → `/settings/ksef` | jak C |
| **F** wiele firm | tryb liczony per `tenantId` aktywnej firmy | przełączenie firmy zmienia tryb przy następnym żądaniu | wg stanu nowej firmy | — |
| **G** błąd odczytu bramki | wyjątek przy odczycie weryfikacji | **prawdziwe** (D4) | brak | jak C |
| **G''** brak `KSEF_ENV` (błąd konfiguracji) | `configuredKsefEnvironment()` = `null`; dziś `hasConfiguredKsefProof` daje wtedy `false`, czyli przykład u KAŻDEJ firmy | **prawdziwe** (karty pokażą błąd konfiguracji z `requireConfiguredKsefEnvironment`), jak G | brak | jak C |
| **G'** błąd odczytu stanu synchronizacji | wyjątek przy odczycie `ksef_history_sync` | prawdziwe, traktuj jak C | brak | jak C |
| **H** zmiana środowiska (TEST → PROD przy starcie) | `ksef_verified_environment ≠ KSEF_ENV` | **przykład** (to stan A); faktury TEST i tak nie wchodzą do kart, bo loadery filtrują środowisko | jak A | — |

**Skąd UI wie o stanie B.** Z istniejącej tabeli `ksef_history_sync`
(00155), bez nowej flagi. Jedno lekkie zapytanie sesją klienta (RLS, tak samo
czyta `lib/ksef/history-sync/status.ts:212`):
`select direction, created_at, backfill_completed_at, client_paused_at, last_error_code`
`where tenant_id = :t and environment = :env` (wszystkie te kolumny mają
`GRANT SELECT` dla `authenticated`, 00155:263-270). Tabeli nie ma w
`types/database.ts`, więc używamy `asHistoryClient`
(`lib/ksef/history-sync/db.ts:207`) jak `status.ts` (import, bez edycji
`lib/ksef/`). Pełnego `readKsefHistorySyncStatus` (ok. 7 zapytań) NIE
wołamy na Pulpicie, tylko na `/import-danych`. **Warunek wdrożenia E3:**
migracja 00155 wgrana na `db-1` (rejestr w `CLAUDE-DO-CODEXA.md:97` nie ma
jeszcze adnotacji „wgrana”); bez niej każdy odczyt trafia w G'.

**Uwaga do F.** Dziś `getDashboardActiveOrgVerified`
(`lib/dashboard-shell-data.ts:176-192`) czyta cookie sam, a dane czyta
`getPageContext` (`lib/supabase/page-context.ts:30`) przez
`getActiveOrgIdFromCookies`. Przy cookie z nieznanym UUID pierwsza daje
`true`, druga robi `redirect`. Nowa funkcja liczy weryfikację dla
**tego samego `tenantId`**, z którego czyta dane, z wierszy
`getCachedMembershipRowsWithTenants(user.id)` (React `cache()` na żądanie).
Komponenty klienckie ze stanem (zakładki, filtry tabeli) dostają
`key={tenantId}`, żeby przełączenie firmy nie zostawiło starego stanu.

---

## 5. Architektura

### 5.1. Jedna funkcja trybu: `lib/demo/tryb-danych.ts`

```ts
export type TrybDanych = 'przyklad' | 'synchronizacja' | 'prawdziwe';

export interface KontekstDanych {
  tryb: TrybDanych;
  supabase: PageContext['supabase'];  // prawdziwy albo atrapa
  tenantId: string;                   // prawdziwy albo DEMO_TENANT
  nowIso: string;                     // jedno „teraz” dla wszystkich kart
  linia: LiniaStanu | null;           // A, B, E → tekst + href; C/D/G → null
}

/** Czysta reguła z §4 — testowana tabelą stanów (§8 T3). */
export function rozstrzygnijTryb(w: {
  zweryfikowana: boolean; strumienie: StrumienHistorii[] | null;
  verifiedAt: string | null; now: Date;
}): { tryb: TrybDanych; linia: LiniaStanu['rodzaj'] | null };

/** Jedyne wejście stron do danych kart. */
export async function kontekstDanych(
  ctx: Pick<PageContext, 'supabase' | 'tenantId' | 'user' | 'role'>, now: Date,
): Promise<KontekstDanych>;
```

- `analizyKontekst` i `czyZweryfikowana` zostają jako cienkie nakładki na
  `kontekstDanych` do czasu przepięcia stron (E1b), potem znikają.
- Weryfikacja liczona przez `hasConfiguredKsefProof`, ale brak `KSEF_ENV`
  to stan G'' (prawdziwe), nie „niezweryfikowana” — inaczej błąd
  konfiguracji pokazałby przykład wszystkim firmom.
- Odczyt weryfikacji i odczyt strumieni idą równolegle (`Promise.all`); każdy
  w `try/catch` z wynikiem z §4 (G, G').
- Tryb `przyklad` nie czyta `ksef_history_sync` (atrapa go nie ma).

### 5.2. Granica „przykład ↔ prawda”

- Dane przykładowe żyją wyłącznie w `lib/demo/*`. **Jedynym** modułem
  spoza `lib/demo/`, który importuje `lib/demo/*-przykladowe` i
  `lib/demo/fake-postgrest`, jest `lib/demo/tryb-danych.ts` (wewnątrz
  `lib/demo/` importy są dozwolone: `analizy-przykladowe.ts` sam importuje
  `fake-postgrest`). Pilnuje tego reguła ESLint `no-restricted-imports`
  (wyjątek dla `lib/demo/**` i `tests/**`) oraz test T1. Dziś importują je
  bezpośrednio strony Analiz i KPiR — E1b to przepina.
- Strony nie wiedzą, skąd są dane: dostają `KontekstDanych` i przekazują
  `supabase`/`tenantId` do slotów. Jedyna różnica w UI to linia stanu
  i to, czy wiersze list są linkami (w trybie `przyklad` linki do
  `/invoices/<id-demo>` prowadziłyby do 404, więc adaptery dają `href: null`).
- `lib/demo` eksportuje `ZNACZNIKI_PRZYKLADU` (nazwy z dopiskiem
  „Przykład”, `DEMO_TENANT = 'przyklad-analizy'`, NIP-y demo zaczynające
  się od `000000` — dostawcy `0000000011`, klienci `0000002020`, oraz
  resztki szablonu: „Samsung”, „Netflix”, „Odwiedzający”, „Zamówienia”,
  „Wyświetlenia”, „Fundusz awaryjny”, „Rachunek oszczędnościowy”, domena
  `.example` w adresach e-mail (`@netflix.example`, `@media.example`…)
  i `/images/avatars/`). Test T2 szuka ich w HTML trybu prawdziwego.

### 5.3. Atrapa bazy vs adaptery propsów — wybór

| | Atrapa bazy (`fake-postgrest`) przez prawdziwe loadery | Stałe propsy w `lib/demo` |
|---|---|---|
| Kształt danych demo = prawdziwy | z definicji (ten sam kod) | trzeba pilnować testem typu i ręcznie |
| Spójność liczb (zysk = przychód − koszty) | z definicji | ręcznie, dziś złamana |
| Daty bieżące | `now` → okna przesuwają się same | stałe, dziś lipiec i 2025 |
| Pokrycie ścieżki prawdziwej testami | demo ćwiczy loadery na każdej stronie | brak |
| Koszt | rozszerzyć atrapę (§5.4) | mniej pracy dziś, dwa źródła prawdy na zawsze |
| Ryzyko przecieku | jedno miejsce podmiany klienta | stałe przy każdej karcie |

**Wybór: hybryda z przewagą atrapy (rekomendacja Z1 = a).** Warstwa danych:
atrapa bazy i te same funkcje `lib/dashboard/*`. Warstwa widoku: komponenty
Finory dostają **propsy** z czystych adapterów
(`components/dashboard/finora/adaptery.ts`,
`components/przeplywy/finora-1do1/adaptery.ts`; wzór
`components/analizy/adapters.ts`). Adapter jest jeden dla obu trybów, więc
demo i prawda mają ten sam kształt aż do propsów.

### 5.4. Rozszerzenie atrapy (E2)

Braki z audytu §0 pkt 6 i §7:
1. `maybeSingle()` w `lib/demo/fake-postgrest.ts` (czyta go
   `readTenantVatExemption`, `lib/invoices/vat-exemption.ts:72`).
2. Tabela `tenants` w zestawie (`vat_exemption_basis: null`,
   `business_started_on` 3 lata wstecz). Wariant „zwolniony z VAT” tylko
   w testach.
3. `paid_at` i `paid_amount` w opłaconych fakturach demo
   (`lib/demo/analizy-przykladowe.ts:101-180`), z datami w bieżącym
   miesiącu na kilka dni, żeby kafel „Wpłynęło” miał krzywą. `paid_at`
   tylko przy `paid_amount = gross_total` (tak działa wyzwalacz 00073).
4. `vat_total` w każdej fakturze demo (dziś brak; `getSalesSeries`
   i `getMonthlyFigures` go czytają, `monthly-figures.ts:163,413`) oraz
   `sale_date` dla wariantu limitu VAT.
5. **24 miesiące historii** zamiast 7 (ranking klientów porównuje 12 z 12,
   „rok wcześniej” w karcie przychodu).
6. Wymagania „pełnej karty” (test T4): 5 produktów (bez procentu — `TopProduct`
   go nie ma) i 5 klientów z niepustym `changePct`; należności we wszystkich 3 kubełkach terminu;
   ≥ 5 faktur z terminem w ciągu 30 dni (Spodziewane wpływy); ≥ 5 źródeł po
   każdej stronie; ≥ 8 operacji w 12 mies. (2 strony tabeli); koszty
   w bieżącym miesiącu; VAT w każdym z 12 miesięcy; 2 kategorie kosztów
   i jeden wydatek „do opisania” (już są).
7. Wszystkie nazwy z dopiskiem „Przykład”, NIP-y fikcyjne (zera) —
   zgodnie z AGENTS.md (nigdy prawdziwe NIP-y).
8. Analizy nie mogą się zmienić inaczej niż przez dłuższą historię: test
   z `tests/unit/dane-przykladowe.test.ts` i `analizy-*` zostają zielone.

### 5.5. Komponenty Finory dostają propsy

Dziś dane siedzą w plikach komponentów i muszą z nich wyjść (typ propsów
bez wartości domyślnych, żeby TS nie przepuścił „zapomnianej” stałej):

| Komponent | Stałe do usunięcia | Nowe propsy (kształt) |
|---|---|---|
| `components/dashboard/finora/chart-finance.tsx` | `financeChartData` (:17), `ReportData` (:42) | `months: {label, period, income, expense, profit}[]`, `report: {average: number \| null, rows: {kind, label, value}[]}`, `caption` |
| `statistics-card-03.tsx` | (już propsy) | `trend` liczone ze znaku `changePct`; `null` → „—” bez strzałki |
| `statistics-total-revenue-card.tsx` | `revenueChartData` (:14), `StatisticsCardData` (:33) | `value`, `changePct \| null`, `series: {label, current, previous}[]`, nazwy serii |
| `statistics-impression-card.tsx` | `impressionChartData` (:11), `StatisticsCardData` (:33) | `title`, `caption`, `points: {label, value}[]` (12), `value`, `changePct \| null` |
| `chart-total-visitors.tsx` | (już propsy) | + `icon`, `badgeLabel`, kolumny `{name, pct, amount, tone}` (wysokość z `pct` przez `style`, nie klasę) |
| `widget-top-products.tsx` | (już propsy) | `changePct: number \| null` (dziś typ `number`) |
| `components/przeplywy/finora-1do1/chart-cash-flow.tsx` | `weeklyData`, `monthlyData`, `yearlyData` (:17-44), sumy (:62-63) | `tabs: {week, month, year}: FlowBucket[]`; sumy liczone z aktywnej zakładki |
| `statistics-savings-goal-card.tsx` | `savingsGoalChartData` (:14), `StatisticsCardData` (:23) | `title`, `subtitle`, `pct \| null` (null → pełny łuk), `value`, `caption`, `footnote` |
| `statistics-area-stat-card.tsx`, `widget-*.tsx`, `datatable-transaction.tsx` | stałe w `app/(dashboard)/przeplywy/page.tsx:28-272` | dzisiejsze propsy + `href \| null` w wierszach |

Wartości wizualne (kolory `var(--chart-N)`, ikony, klasy) zostają w komponentach.
Formatowanie kwot i dat robi serwer (strefa Warszawa, `lib/format/pl`);
do komponentów klienckich idą gotowe napisy i liczby (bez `Date`, bez funkcji).
`components/dashboard/finora/datatable-user.tsx` nie jest renderowany —
poza zakresem (nie usuwamy, D1).

### 5.6. Sloty i odporność

Każda karta to osobny asynchroniczny Server Component w `<Suspense>`
i `SectionErrorBoundary`, z błędem przez `pulpitErrorMessage` — wzorzec
`components/analizy/card-slot.tsx` (`loadAnalizyCard`). Awaria jednej karty
(faktura w EUR, przyjęta faktura bez środowiska) zabiera tylko tę kartę.
Szkielet ma kształt karty Finory (bez skoku układu). Pulpit:
`components/dashboard/finora/sloty.tsx`; Przepływy:
`components/przeplywy/finora-1do1/sloty.tsx`. Istniejące sloty
`components/dashboard/pulpit/pulpit-grid.tsx` (`FinanceSlotCard:114`,
`NetRevenueSlotCard:187`, `VatSlotCard:209`, `AgingSlotCard:239`,
`TopListsSlotCard:254`) są wzorem logiki (rozgałęzienie VAT/limit, puste
stany), nie są renderowane w nowym układzie.

---

## 6. Mapowanie karta → slot → funkcja → podpis

Statusy jak w audycie: **mamy / policzymy / częściowo / nie_mamy**.

### 6.1. Pulpit (`app/(dashboard)/dashboard/page.tsx`)

| Karta (miejsce w siatce) | Komponent | Slot | Funkcja (`lib/…`) | Tytuł / podpis po zmianie | Status |
|---|---|---|---|---|---|
| Finanse (wykres, `xl:col-span-4`) | `chart-finance.tsx` lewa | `FinanseSlot` | `getSalesSeries({months:7}).netSeries` (`dashboard/monthly-figures.ts:336`), `getCosts` + `sumCostsByMonth` (`dashboard/costs.ts:75,159`), zysk = różnica | „Finanse” / „Ostatnie 7 miesięcy · netto”; legenda Przychody, Koszty, Zysk; słupki wg Z17 (stos Koszty + Zysk albo bez `stackId`), oś Y automatyczna „12 tys.” i szersza (dziś `margin left -30`), dymek „Paź · Przychody 12 345,67 zł” | mamy / częściowo (koszty) |
| Raport (ta sama karta, prawa) | `chart-finance.tsx` prawa | `FinanseSlot` | `buildMonthReport` (`dashboard/pulpit-report.ts:31-56`) | „Raport” / „Ten miesiąc” (Z6); „Średnio miesięcznie: X zł” (przy oknie 7 miesięcy to średnia z najwyżej 6 pełnych, nie z 11 jak w dawnej karcie) albo „Średnia po pierwszym pełnym miesiącu”; „Zysk” lub „Strata”, „Przychody”, „Koszty”; przycisk „Zobacz przepływy” | mamy / częściowo |
| Kafel 1 | `statistics-card-03.tsx` | `KafelFakturSlot` | `getMonthlyFigures().acceptedCount`, `hasPrevMonth`, `momCountPct` (`:242,290-292`) | „Faktury”, ikona `RiFileList3Line`, plakietka „Ten miesiąc”; brak poprzedniego → „—” | mamy |
| Kafel 2 | `statistics-card-03.tsx` | `KafelSredniejSlot` | `getSalesInvoices` (2 miesiące) → `salesMonthStats(bieżący)` i `(poprzedni)` `.avgPerInvoice` (`analytics-finance/sales.ts:57,119-135`) + czysta `zmianaProcentowa`. Uwaga: średnia liczy faktury bez korekt (`:126`), a Kafel 1 z korektami (`monthly-figures.ts:242`) — dymek kafla 2 mówi „bez korekt”; osobny strażnik waluty (`sales.ts:75`) | „Średnia faktura” (Z5), plakietka „Ten miesiąc” | policzymy |
| Przychód (mini słupki) | `statistics-total-revenue-card.tsx` | `PrzychodSlot` | `getSalesSeries({months:5, withPrevYear:true})` + **nowe `prevNetSeries`** (mapa `prevNetByMonth` obok `:411` + pole wyniku obok `:427` + pole w `SalesSeries`) | „Przychód netto w tym miesiącu”, % m/m (null → ukryty), serie „Ten rok” / „Rok wcześniej” (nazwy tylko w dymku — karta nie ma legendy i jej nie dodajemy); firma < 12 mies.: seria „Rok wcześniej” zerowa, dymek „brak danych sprzed roku” | policzymy |
| Wyświetlenia → VAT | `statistics-impression-card.tsx` | `VatSlot` | płatnik: `getSalesSeries({months:12}).vatSeries`; zwolniony: `readTenantVatExemption` + `getVatLimit` (`dashboard/vat-limit.ts:288`); rozgałęzienie jak `VatSlotCard` | „VAT należny” / „Ostatnie 12 miesięcy”, wartość = bieżący miesiąc, kolor % ze znaku; albo „Limit zwolnienia z VAT” / „Sprzedaż od 1 stycznia”, linia `cumulative` (tyle punktów, ile miesięcy roku minęło), wartość = `limit.pct`, a bez daty rozpoczęcia `lowerBound.pct` („co najmniej”) | mamy |
| Odwiedzający → Należności | `chart-total-visitors.tsx` | `NaleznosciSlot` | `getReceivables` → `receivablesAging` (`dashboard/receivables-aging.ts:31-64`) | „Należności według terminu” (albo tytuł z Z16), `RiTimeLine`, plakietka „X% po terminie”; kolumny Przed terminem / Do 30 dni po / Ponad 30 dni po; kwoty „12,4 tys. zł”; strzałka = ocena + `sr-only`; podpis „Faktury z FaktWay, według oznaczonych wpłat” (nowy tekst — dzisiejszy `RECEIVABLES_NOTE` brzmi „Bez importów i faktur skorygowanych”) + zdanie z Z16; „Szczegóły” → `/payments/overdue` | częściowo (zawyżone do K2, Z16) |
| Najlepiej sprzedające się | `widget-top-products.tsx` lewa | `RankingiSlot` | `getTopProducts` (`dashboard/rankings.ts:216`) | + podpis „Ostatnie 12 miesięcy · netto”; drugi wiersz „j.m.: godz.” albo pusty (nie „Usługa”); malejąco | mamy / częściowo |
| Najczęściej kupowane → Najwięksi klienci | `widget-top-products.tsx` prawa | `RankingiSlot` | `getTopClients` (`rankings.ts:323`) | „Najwięksi klienci”; drugi wiersz „NIP …”, dla grupy „Konsumenci” „Nabywcy bez NIP (B2C)”, inaczej pusty; % vs poprzednie 12 mies., `null` → „nowy” | mamy |

Podpisy kosztów na Pulpicie: „Koszty z dokumentów w FaktWay”, a do K1 także
„Faktury kosztowe z KSeF od DD.MM” (Z9).

### 6.2. Przepływy (`app/(dashboard)/przeplywy/page.tsx`)

Karty liczą się z ładowarek z React `cache()` jak dziś w
`components/przeplywy/przeplywy-grid.tsx:76-117`: `getInflows`
(`dashboard/inflows.ts:89`) i `getCosts` **osobno** (celowo: strażnik
jednej nie zabiera kart drugiej, `:89-95`), każda w dwóch oknach — 12
miesięcy (kafle, źródła, operacje, tabela) i 5 lat (wykres, zakładka
„Rocznie”); „Spodziewane wpływy” z `getReceivables`; karta limitu/podatku
z `readTenantVatExemption` + `getVatLimit` albo `getCashFlowData`. Logikę
ładowarek bierzemy z `przeplywy-grid.tsx` bez zmian.

| Karta | Komponent (`finora-1do1/`) | Funkcja | Tytuł / podpis po zmianie | Status |
|---|---|---|---|---|
| Przepływy pieniężne | `chart-cash-flow.tsx` | `buildCashFlowChart` (`:147`) | podtytuł „Wpływy według oznaczonych wpłat, wydatki brutto z kosztów” (`PAID_NOTE`); sumy „Suma wpłat” / „Suma kosztów (brutto)” z aktywnej zakładki; zakładka tygodniowa = 7 tygodni; oś Y „1,2 tys.” (`formatPlCompactMoney`); dymek z „zł”, `inflowCount=0` → „brak oznaczonych wpłat” | częściowo |
| Cel oszczędnościowy → Limit / Podatek | `statistics-savings-goal-card.tsx` | zwolniony: `getVatLimit`; płatnik: `estimateIncomeTaxThisYear` (`dashboard/tax-estimate.ts:55`) | „Limit zwolnienia z VAT” / „Sprzedaż narastająco w roku”, „X tys. zł z 240 tys. zł”, prognoza; albo „Odłóż na podatek” / „Szacunek PIT od początku roku”, pełny łuk, „przy podatku liniowym 19%, bez ZUS — szacunek” (Z10) | mamy / częściowo |
| Przychody w tym miesiącu | `statistics-area-stat-card.tsx` | `monthFlows(...).inflow` (`:239`) | „Wpłynęło w tym miesiącu”; % null → ukryty; kolor `chart-2` (E7); 1. dnia miesiąca `daily` ma 1 punkt — wykres obszarowy z jednego punktu nic nie rysuje, więc adapter dokłada punkt 0 zł na początku | częściowo |
| Wydatki w tym miesiącu | `statistics-area-stat-card.tsx` | `monthFlows(...).outflow` | „Koszty w tym miesiącu (brutto)”, „według daty dokumentu” | częściowo |
| Największe źródła | `widget-top-cash-flow-sources.tsx` | `topCashFlowSources` (`:297`) | + „Ostatnie 12 miesięcy”; nazwy kontrahentów (`shortCompanyName`), „Klient · 3 wpłaty” / „Dostawca · 5 dokumentów” (`lib/i18n/plural`); pasek = `share`; mniej niż 5 → mniej wierszy | częściowo |
| Nadchodzące rachunki → Spodziewane wpływy | `widget-upcoming-bills.tsx` | `upcomingInflows(getReceivables(…))` (`:385`, 30 dni) | „Spodziewane wpływy” / „Następne 30 dni”; „Termin dziś / jutro / za N dni”, rosnąco; kwota pozostała; zdanie z Z16 | częściowo (do K2 także zapłacone przed terminem) |
| Ostatnia aktywność | `widget-recent-activity.tsx` | `cashFlowOperations(...).slice(0,5)` (`:438`) | etykieta = kontrahent; podpis „Wpłata · FV/… · DD.MM.RRRR” / „Koszt · …”; korekta in minus przez `signedAmount` | częściowo |
| Tabela | `datatable-transaction.tsx` | `cashFlowOperations` | awatar = inicjały; druga linia „NIP … · numer”; Kategoria = `CashFlowOperation.category`; Status „Opłacona / Zatwierdzony / Do akceptacji”; menu wiersza „Otwórz fakturę / wydatek”; „1 wpis / 2 wpisy / 5 wpisów” | częściowo |

`components/przeplywy/finora/*` (prawdziwe karty E5) są wzorem logiki
i propsów; nie mają `CardHeaderWithMenu`, więc ich wprost nie podpinamy
(audyt §8).

### 6.3. Analizy (`/analizy/sprzedaz`, `/analizy/koszty`)

Dane się nie zmieniają (wszystkie 18 kart ma prawdziwe źródło, audyt §1.3).
Zmieniają się tylko podpisy i zachowanie demo:

| Karta | Zmiana | Plik |
|---|---|---|
| Wydatki miesiąca, Trend, Koło, Kalendarz | podpis „Koszty z dokumentów w FaktWay” (+ „od DD.MM” do K1) | `components/analizy/koszty-grid.tsx` |
| Przychody a koszty (obie strony) | „Koszty jak w KPiR, bez VAT do odliczenia”; „Wynik (netto)” | `sprzedaz-grid.tsx:189`, `koszty-grid.tsx:167`, `adapters.ts` |
| Należności | „Faktury z FaktWay, według oznaczonych wpłat” + zdanie z Z16 (dziś karta na produkcji pokazuje zapłacone faktury jako należne) | `sprzedaz-grid.tsx:173` |
| Stali klienci (demo) | link „Zrób fakturę cykliczną” ukryty w trybie `przyklad` (`action: null`) | `adapters.ts` (`toSubscriptionItems`) |
| Puste koszty po weryfikacji | zamiast martwego „Podłącz KSeF” (`koszty-grid.tsx:46-60`): „Pobierzemy faktury kosztowe z KSeF. Możesz też dodać wydatek ręcznie.” → `/expenses` | `koszty-grid.tsx`, `finora/empty.ts` |
| Nagłówek | plakietka + linia stanu z §4 (wspólny komponent) | `analizy-header.tsx:46`; ta sama plakietka w KPiR: `components/reports/kpir/kpir-toolbar.tsx:58` |

---

## 7. Etapy

Kolejność: najpierw bramka i strażnik przecieku, potem atrapa i stan
synchronizacji, potem strony od najprostszej. Każdy etap: gałąź
`claude/dane-eN-<temat>` od `origin/main`, jeden PR, bez migracji.

### E0 — Pusty stan wpływów bez ślepej uliczki (`claude/dane-e0-pusty-stan-wplat`) · rozmiar XS

- **Zakres:** Z8 — `PAID_EMPTY_STATE` (`lib/invoices/paid-labels.ts:11`)
  przestaje kazać „oznaczać wpłaty”. Tekst jest wspólny dla kafla
  „Opłacone” listy faktur (`invoice-stat-tiles.tsx:145`, dziś na
  produkcji) i dawnych kart Przepływów, więc to błąd niezależny od designu.
- **Czerwony test:** żaden tekst pustego stanu wpłat nie zawiera
  „Oznaczaj” (dziś zawiera).

### E1 — Bezpiecznik „zero przecieku” (`claude/dane-e1-bezpiecznik`) · rozmiar S

- **Zakres (tylko naprawa przecieku, bez refaktoru):** **bezpiecznik (Z2)**
  na istniejącej `czyZweryfikowana()` (`lib/demo/kontekst-przykladowy.ts:11`;
  błąd → `true`, czyli prawdziwe — kierunek bezpieczny): Pulpit i
  Przepływy zweryfikowanej firmy renderują `PulpitGrid`
  (`components/dashboard/pulpit/pulpit-grid.tsx:295`) i `PrzeplywyGrid`
  (`components/przeplywy/przeplywy-grid.tsx:431`), niezweryfikowanej —
  dzisiejsze strony bez zmian. Obie strony `export const dynamic =
  'force-dynamic'` i `async` z `getPageContext()`.
  `ZNACZNIKI_PRZYKLADU` (`lib/demo/znaczniki.ts`) dla testu.
- **Pliki:** `app/(dashboard)/dashboard/page.tsx`,
  `app/(dashboard)/przeplywy/page.tsx`, `lib/demo/znaczniki.ts`, testy.
- **Czerwony test przed zmianą:** T2 dla `/dashboard` i `/przeplywy`
  w trybie zweryfikowanym — dziś HTML zawiera „Samsung” i „Netflix” (czerwony).
- **Odbiór:** T2 (Pulpit, Przepływy) zielone;
  `tests/unit/pulpit-finora.test.tsx` i `przeplywy-strona.test.tsx`
  dostają tryb przykładowy jawnie; niezweryfikowana firma widzi strony
  identyczne z dzisiejszymi (zrzuty).
- **Ryzyko:** zweryfikowane firmy przejściowo widzą stary układ kart E4/E5 —
  akceptowane w Z2. Bez Z2 etap nie zamyka przecieku i E5/E6 muszą iść
  przed nim. Rozjazd cookie/`tenantId` (§4 „Uwaga do F”) zostaje do E1b,
  ale prowadzi do prawdziwych danych, nie do przykładu.

### E1b — Jedna funkcja trybu i granica importów (`claude/dane-e1b-tryb`) · rozmiar S/M

- **Zakres:** `lib/demo/tryb-danych.ts` z trybami `przyklad | prawdziwe`
  (bez `synchronizacja` — E3), `rozstrzygnijTryb` ze stanami A, C, F, G,
  G'', H; weryfikacja liczona dla `ctx.tenantId` (§4 „Uwaga do F”);
  `analizyKontekst` i `czyZweryfikowana` jako nakładki, potem usunięte;
  Analizy, KPiR (Z15), Pulpit i Przepływy przepięte na `kontekstDanych`.
  ESLint `no-restricted-imports` dla `lib/demo/*` (§5.2) i T1.
- **Pliki:** `lib/demo/tryb-danych.ts` (nowy), `lib/demo/kontekst-przykladowy.ts`,
  `lib/dashboard-shell-data.ts` (funkcja weryfikacji po `tenantId`), 5 stron,
  `eslint.config.mjs`, testy.
- **Czerwony test przed zmianą:** T3 dla G'' (dziś brak `KSEF_ENV` daje
  przykład każdej firmie, `claim-environment.ts:25-30`). F dziś działa
  (bramka i `getPageContext` czytają to samo cookie), więc jego test nie
  jest czerwony — dopisz jako strażnik, tak samo T1.
- **Odbiór:** T1, T2 (pięć stron), T3 (A, C, F, G, G'', H) zielone; zrzuty
  bez zmian.

### E2 — Atrapa bazy dla Pulpitu i Przepływów (`claude/dane-e2-atrapa`) · rozmiar M

- **Zakres:** §5.4 pkt 1–8. Zestaw danych demo rozpisany tak, żeby każda
  karta Pulpitu i Przepływów była pełna (wymagania pkt 5) i żeby liczby
  wyglądały jak firma usługowa (przychód ~25–45 tys. zł netto/mies.,
  koszty ~30–40% przychodu, 1–2 faktury po terminie).
- **Pliki:** `lib/demo/fake-postgrest.ts`, `lib/demo/analizy-przykladowe.ts`
  (ewentualnie rozbicie na `lib/demo/dane-przykladowe.ts` + cienki eksport
  dla zgodności), testy.
- **Czerwony test:** T4 dla loaderów Pulpitu i Przepływów na atrapie —
  dziś `readTenantVatExemption` rzuca (brak `maybeSingle`), `getInflows` daje
  pusto (brak `paid_at`), `vatSeries` same zera (brak `vat_total`),
  `getTopClients().changePct` = `null` (7 miesięcy).
- **Odbiór:** T4, T5 zielone; wszystkie `analizy-*` i `dane-przykladowe`
  zielone; atrapa rzuca na nieobsłużony operator (zostaje jak jest).
- **Ryzyko:** loadery używają operatora, którego atrapa nie zna (np. `or`,
  `ilike`) — test T4 to złapie; dopisujemy operator, nie obchodzimy loadera.

### E3 — Stan synchronizacji i linia stanu (`claude/dane-e3-stan`) · rozmiar S

- **Zakres:** tryb `synchronizacja` oraz stany B', D, E i G' w
  `rozstrzygnijTryb` (Z4, Z14); lekki odczyt `ksef_history_sync` (§4); komponent
  `components/dashboard/linia-stanu-danych.tsx` (plakietka `DemoBadge` +
  zdanie + link) nad siatką Pulpitu i Przepływów, w nagłówku Analiz
  i w pasku KPiR (`components/reports/kpir/kpir-toolbar.tsx:58`, ta sama
  plakietka); puste stany kart w trybie `synchronizacja` mówią „Pobieramy
  faktury z KSeF…”. Tekst B zgodny z Z12 (bez obietnicy zakresu dat, póki
  niesprawdzone).
- **Pliki:** `lib/demo/tryb-danych.ts`, `components/dashboard/demo-badge.tsx`,
  nowy komponent linii, `components/analizy/analizy-header.tsx`,
  `components/reports/kpir/kpir-toolbar.tsx`, strony, testy;
  test RLS w istniejącym `tests/rls-historia-ksef.test.ts` (już sprawdza
  izolację i `last_error_code`, `:156`; dopisać `backfill_completed_at`,
  `client_paused_at`, `created_at`).
- **Warunek:** 00155 wgrana na `db-1` (§4).
- **Czerwony test:** T3 dla B, B', E (dziś funkcja nie zna tych stanów);
  test komponentu: w trybie A tekst wyjaśnienia jest w DOM, nie tylko
  w `title` (dziś czerwony, `demo-badge.tsx:14`).
- **Odbiór:** T3 pełna tabela §4 (A, B, B', C, D, E, F, G, G', G'', H); test RLS: użytkownik firmy A nie widzi
  strumienia firmy B, a kolumny z §4 są czytelne dla `authenticated`;
  `tests/unit/nazwa-produktu.test.ts` zielony; kontrast linii w obu
  motywach (`tests/unit/helpers/kontrast.ts`).
- **Ryzyko:** firma zweryfikowana bez poświadczeń w bazie nigdy nie dostanie
  strumienia → reguła „< 2 h od weryfikacji” zamyka stan B po 2 h (Z4).

### E4 — Analizy: uczciwe podpisy i demo bez fałszywych linków (`claude/dane-e4-analizy`) · rozmiar S

- **Zakres:** §6.3.
- **Czerwony test:** w trybie `przyklad` karta „Stali klienci” nie ma linku
  `/invoices/recurring?wzor=` (dziś ma); podpisy z §6.3 obecne.
- **Odbiór:** `analizy-*` zielone; zrzut obu stron bez zmiany układu.
- **Ryzyko:** dłuższe podpisy na 375 px łamią się w dwie linie — trzymać
  się limitów PLAN-FINORA §7.2.

### E5 — Pulpit na prawdziwych danych w kartach Finory (`claude/dane-e5-pulpit`) · rozmiar L

- **Zakres:** §5.5 (komponenty Pulpitu na propsach), §6.1 (sloty,
  adaptery, podpisy), `prevNetSeries`, zmiany wizualne wymuszone danymi
  (bez nich prawdziwe kwoty rysują się źle): słupki wg Z17
  (`chart-finance.tsx:90-92`), oś Y bez `domain={[0,50]}` (`:81`) i z
  szerokością na „120 tys.” (`margin left -30`, `:70`), formatter
  dymków (wzór `components/dashboard/pulpit/finance-card.tsx:108-122`),
  strzałka i kolor ze znaku (`statistics-card-03.tsx:47-50`,
  `statistics-impression-card.tsx:68`), wysokość kolumn z `pct`. Usunięcie
  bezpiecznika E1 dla Pulpitu: oba tryby przez te same sloty, tryb
  `przyklad` z atrapą.
- **Dwa PR (L to za dużo na jeden):** **E5a** — komponenty na propsach,
  adaptery, sloty i `prevNetSeries`, podpięte TYLKO w trybie `przyklad`
  (bezpiecznik zostaje, prawdziwi klienci bez zmian); **E5b** — tryb
  `prawdziwe` przez te same sloty i usunięcie bezpiecznika (mały PR
  z T2 jako czerwonym testem). Przeciek może wrócić tylko w E5b.
- **Pliki:** `components/dashboard/finora/*` (bez `datatable-user.tsx`),
  `components/dashboard/finora/{sloty.tsx,adaptery.ts}` (nowe),
  `lib/dashboard/monthly-figures.ts` (jedna seria), strona, testy;
  przepisany `tests/unit/pulpit-finora.test.tsx`.
- **Czerwony test:** E5a — adapter Finansów: zysk = przychód − koszty
  w każdym miesiącu, a stos `chart-finance` zgodny z Z17 (dziś stałe i stos
  trzech serii); test „strzałka ze znaku” (dziś z literału). E5b — T2 dla
  Pulpitu bez bezpiecznika.
- **Odbiór:** T2, T4, T5 dla Pulpitu; stare testy `pulpit-*.test.ts`
  zielone (funkcje bez zmian poza `prevNetSeries`); zrzuty demo przed/po;
  na koncie zweryfikowanym liczby zgodne z listą faktur (ręcznie, 3 karty).
- **Ryzyko:** waluta obca lub brak środowiska zabiera karty (fail-closed) —
  zostaje, ale komunikat karty nazywa dokument (protokół pkt 4); jeśli
  dziś nie nazywa, zapisz jako osobne ustalenie, nie naprawiaj „przy okazji”.
  Wspólny odczyt najszerszego okna (§9) poszerza zasięg strażników: zła
  faktura sprzed 20 miesięcy zabrałaby też kafel bieżącego miesiąca —
  test na to w E5a.

### E6 — Przepływy na prawdziwych danych w kartach Finory (`claude/dane-e6-przeplywy`) · rozmiar L

- **Zakres:** §5.5 (komponenty Przepływów), §6.2; sumy z aktywnej zakładki
  (kontrolowane `Tabs`, wzór `components/przeplywy/finora/chart-cash-flow.tsx:63`);
  „Spodziewane wpływy”; karta limitu/podatku; tabela z prawdziwymi
  kategoriami i statusami; pusty stan wpływów z E0; usunięcie bezpiecznika
  E1 dla Przepływów; stałe z `page.tsx:28-272` znikają.
- **Dwa PR, jak E5:** **E6a** — komponenty `finora-1do1/*` na propsach,
  adaptery i sloty tylko w trybie `przyklad`; **E6b** — tryb `prawdziwe`
  i usunięcie bezpiecznika.
- **Pliki:** `components/przeplywy/finora-1do1/*`, nowe `sloty.tsx`,
  `adaptery.ts`, strona, przepisany `tests/unit/przeplywy-strona.test.tsx`
  (asercja „1:1 na danych przykładowych”, `:82`).
- **Czerwony test:** E6a — suma wpłat po przełączeniu na „Rocznie” = suma
  serii roku (dziś stała z miesięcy, `chart-cash-flow.tsx:62-63`); E6b — T2
  dla Przepływów bez bezpiecznika.
- **Odbiór:** T2, T4, T5 dla Przepływów; `przeplywy-*.test.ts*` zielone;
  zrzuty; filtr Kategoria pokazuje tylko wartości z danych (facety).
- **Ryzyko:** bez N6 wpływy u prawdziwych klientów są puste — świadomie,
  z uczciwym tekstem (Z8); po K2 wraca przycisk.

### E7 — Mikro-zmiany UI (`claude/dane-e7-mikro-ui`) · rozmiar S

Wszystkie z audytu §6, bez zmiany siatki i wyglądu kart:
1. Menu ⋯ (`components/dashboard/finora/card-header-with-menu.tsx:15,40-42`):
   `menuItems: {label, href?, akcja?: 'odswiez'}[]`; zostają „Odśwież”
   (`router.refresh`) i jeden link kontekstowy na kartę; „Udostępnij”
   i „Aktualizuj” znikają; ikona ⋯ zostaje. Plik nie ma dziś
   `'use client'`, a `router.refresh` go wymaga — propsy zostają
   serializowalne (`akcja` jako napis), więc karty serwerowe mogą go dalej
   używać.
2. „Zobacz raport” → `Link` „Zobacz przepływy” (`chart-finance.tsx:116`),
   „Szczegóły” → `Link` `/payments/overdue` (`chart-total-visitors.tsx:42-44`),
   wygląd przez `buttonVariants` (jeśli nie weszło w E5).
3. Wiersze list jako linki tylko w trybie prawdziwym: Spodziewane wpływy,
   Ostatnia aktywność → `/invoices/[id]`, `/expenses/[id]`; Źródła →
   `/contractors` (nie `/clients`, tej trasy nie ma); Analizy: „Ostatnie
   faktury / wydatki”, „Do opisania” → `/expenses?filter=unreviewed&miesiac=RRRR-MM`
   (`app/(dashboard)/expenses/page.tsx:33-34`; karta liczy wybrany miesiąc,
   `lib/analytics-finance/costs.ts:128-133`).
4. Menu wiersza tabeli: „Otwórz fakturę / wydatek” zamiast „Edytuj /
   Duplikuj / Usuń” (`datatable-transaction.tsx:406-420`).
5. Kafel wpłat w `var(--chart-2)` (`app/(dashboard)/przeplywy/page.tsx:285-292`
   lub slot po E6).
6. Dostępność: `aria-sort` i `role` w nagłówkach sortowania, `aria-label`
   numerów stron, kwota sortowana ze znakiem kierunku.

- **Czerwony test:** kliknięcie pozycji menu ⋯ ma `href` albo akcję (dziś
  żadna nie ma); menu wiersza nie zawiera „Usuń”.
- **Odbiór:** testy komponentów; zrzuty bez zmiany wyglądu.
- **Kolejność:** niezależny od E2–E6, może wejść w dowolnym momencie po E1.
  Punkty 1–2 dotykają tych samych plików co E5a/E6a — jeśli E5a jest
  w toku, wchodzą do niego zamiast tu (konflikty). Sześć punktów to sześć
  różnych miejsc; jeśli PR przekroczy ~400 linii, dzielić na E7a (Pulpit
  i Przepływy) i E7b (Analizy, dostępność).

### E8 — Czyszczenie błędów certyfikatu po wgraniu (`claude/dane-e8-certyfikat`) · rozmiar XS

- **Zakres:** Z11 — `uploadCertificateAction` woła
  `clearKsefHistoryCertificateErrors` (`client-pause.ts`) po udanym
  `finalize_ksef_certificate_claim`; dzięki temu stan E znika od razu,
  nie po najbliższym cronie.
- **Pliki:** `components/settings/actions.ts:125-150`, test akcji.
- **Uwaga własności:** wywołanie funkcji z `lib/ksef/` bez jej edycji;
  jeśli trzeba zmienić `lib/ksef/**`, to obszar CODEOWNERS (zgoda Bartosza).
- **Czerwony test:** po wgraniu certyfikatu strumień z
  `last_error_code='certificate_expired'` ma błąd wyczyszczony (dziś nie).

### E9–E12 — Zmiany po rozstrzygnięciach 23.10.2026 (zrobione na gałęzi `claude/dane-prawdziwe`)

- **E9 — nazwy produktów:** ranking produktów bez okresu w nazwie.
- **E10 — koszty z KSeF (D-K):** wykresy i karty kosztów liczą faktury
  zakupowe z KSeF plus wydatki spoza KSeF; KPiR bez zmian.
- **E11 — wpływy według terminów płatności (D-W):** zakładana zapłata
  w dniu terminu, prawdziwa data zapłaty ma pierwszeństwo; podpisy
  „według terminów płatności”. **Odwołane 02.11.2026** (patrz D-W wyżej).
- **E12 — druczek (D-P):** plakietka „Dane przykładowe” w nagłówku
  pierwszej karty Pulpitu („Finanse”) i Przepływów (wykres przepływów),
  tylko w trybie przykładu; wysokość nagłówka bez zmian.

---

## 8. Testy

| # | Test | Gdzie | Etap |
|---|---|---|---|
| T1 | **Granica importów:** spoza `lib/demo/` tylko `lib/demo/tryb-danych.ts` importuje `lib/demo/*-przykladowe` i `fake-postgrest` (skan plików `app/**`, `components/**`, `lib/**` bez `lib/demo/**` + reguła ESLint) | `tests/unit/dane-granica.test.ts` | E1b |
| T2 | **Zero przecieku w HTML:** każda z 5 stron (Pulpit, Przepływy, 2× Analizy, KPiR) w trybie `prawdziwe`, z klientem Supabase zwracającym puste zbiory → HTML bez żadnego `ZNACZNIKI_PRZYKLADU`; szpieg: `analizyDemoSupabase`/`kpirPrzykladowe` nie wołane. Render: strona z `Suspense` i asynchronicznymi slotami nie da się wprost `renderToStaticMarkup` — wzór `tests/unit/analizy-siatka.test.tsx:34` (render po `await` każdego slotu); czy wystarczy `prerender` z `react-dom/static`, niepewne | `tests/unit/dane-przeciek.test.tsx` | E1 (Pulpit, Przepływy), E1b (5 stron), E5b, E6b |
| T3 | **Stany §4:** tabela wejść `rozstrzygnijTryb` → tryb i linia; plus `kontekstDanych` z wyjątkiem odczytu (G, G') | `tests/unit/dane-tryb.test.ts` | E1b (A, C, F, G, G'', H), E3 (B, B', D, E, G') |
| T4 | **Pełne demo i kształt:** każdy slot Pulpitu i Przepływów na atrapie zwraca dane bez pustego stanu i z liczbą pozycji jak w szablonie; wynik przechodzi przez ten sam adapter co prawdziwy (typ wspólny, sprawdzany przez `tsc` w CI) | `tests/unit/dane-przykladowe-pelne.test.ts` | E2, E5, E6 |
| T5 | **Spójność demo:** zysk = przychód − koszty; suma kolumn należności = suma karty; kwota „Wpłynęło” = ostatni punkt krzywej; listy malejąco; daty względem `now` (stały `vi.setSystemTime`, strefa Warszawa) | jw. | E2 |
| T6 | **RLS:** odczyt `ksef_history_sync` sesją: izolacja firm i dostępność kolumn z §4 | `tests/rls-historia-ksef.test.ts` (job „RLS isolation”) | E3 |
| T7 | Przepisane testy stron: `pulpit-finora.test.tsx`, `przeplywy-strona.test.tsx` — oba tryby | `tests/unit/` | E1, E5, E6 |
| T8 | `nazwa-produktu.test.ts` i kontrast nowych tekstów w obu motywach (`helpers/kontrast.ts`) | istniejące | każdy etap z tekstem |
| T9 | **Liczba zapytań na stronę:** atrapa liczy odczyty (`reads` w `fakePostgrest`, `lib/demo/fake-postgrest.ts:21`); test zapisuje liczbę dla Pulpitu i Przepływów, wzrost wymaga świadomej zmiany liczby w teście (§9) | `tests/unit/dane-przykladowe-pelne.test.ts` | E5a, E6a |

Nowe zapytania do bazy w tym planie: tylko odczyt `ksef_history_sync` (T6).
Reszta to istniejące funkcje `lib/dashboard/*` i `lib/analytics-finance/*`,
już testowane (`pulpit-*.test.ts`, `przeplywy-*.test.ts*`, `analizy-*`).
`prevNetSeries` i `zmianaProcentowa` to czyste funkcje — test jednostkowy.

---

## 9. Wydajność

- **Liczba zapytań (szacunek z kodu, do zmierzenia T9).** Każda funkcja
  sprzedaży robi więcej niż jedno zapytanie: strażnik środowiska
  (`assertAcceptedEnvironmentKnown`), odczyt stron i zaliczki ROZ
  (`fetchSettledAdvancesTotals`). Pulpit: weryfikacja (React `cache()`,
  0–1), stan synchronizacji (1), `getSalesSeries` 12 mies. + rok wcześniej
  (ok. 5), `getMonthlyFigures` (ok. 4), `getSalesInvoices` dla średniej
  faktury (ok. 3), `getCosts` (2), `getReceivables` (2), rankingi (ok. 4),
  zwolnienie VAT (1) → **ok. 20–25 lekkich zapytań, równolegle w slotach**.
  Przepływy: weryfikacja, stan (1), wpłaty × 2 okna (2), koszty × 2 okna
  (4), należności (2), zwolnienie VAT (1), limit albo `getCashFlowData`
  (1–4) → **ok. 12–15**. Cel: nie więcej niż dziś `PulpitGrid`
  i `PrzeplywyGrid` (zmierzyć na atrapie przed E5a/E6a). Analizy bez zmian.
- **Deduplikacja w obrębie żądania:** loadery wołane przez kilka kart
  (`getSalesSeries` dla Finansów, Przychodu i VAT; `getCosts` dla Finansów
  i Raportu) idą przez moduł z React `cache()` (`lib/dashboard/na-zadanie.ts`)
  — argumenty prymitywne (`tenantId`, `nowIso`, liczba miesięcy), klient
  Supabase ten sam w żądaniu. Jeśli różne karty potrzebują różnych okien
  (7, 5+rok wcześniej, 12), czytamy raz `getSalesSeries({months:12,
  withPrevYear:true})` i tniemy w pamięci (ostatnie 7 / 5 miesięcy) —
  kosztem szerszego zasięgu strażników (E5, „Ryzyko”). Wpłat i kosztów
  nie łączymy w jedną ładowarkę (§6.2).
- **Bez cache między żądaniami** (`unstable_cache`, tagi). Powody: dane
  zmieniają się z każdą fakturą i każdym przebiegiem worker’a, a worker
  pg-boss to osobny proces, który nie może wywołać `revalidateTag` w Next.js;
  klucz cache bez `tenantId` + środowiska + trybu to przeciek między firmami.
  Wracamy do tematu dopiero przy zmierzonym p95 > 1,5 s.
- **Równoległość i odporność:** każdy slot w `Suspense` ładuje się sam
  (strumieniowanie), awaria jednej karty ≠ awaria strony (§5.6). Strona nie
  woła na swoim poziomie żadnej funkcji danych poza `kontekstDanych`.
- **Pomiar:** w opisie PR E5/E6 czas odpowiedzi strony lokalnie na atrapie
  i na koncie testowym; na produkcji po wdrożeniu (niepewne, ile faktur ma
  największa firma — sprawdzić przed oceną).

---

## 10. Czego świadomie NIE robimy teraz i jak karty o tym mówią

| Czego nie robimy | Dlaczego | Jak karta mówi to klientowi |
|---|---|---|
| Bank, saldo, konta (N5) | brak importu wyciągów; `payment_imports` bez zasilania | podtytuł Przepływów „Wpływy według oznaczonych wpłat…”; żadnych „Rachunek firmowy / oszczędnościowy”, statusu „nieudana”, kategorii „przelew” |
| E-commerce (Z13) | żadna karta tego nie wymaga; koszt integracji > wartość przy 29,99 zł | brak kart o zamówieniach i odwiedzających — tytuły zmienione (§6.1) |
| Kategorie AI dla sprzedaży | sprzedaż nie ma kategorii; produkty = nazwy pozycji | „Najlepiej sprzedające się” pokazuje nazwy pozycji faktur |
| Migawki należności (trend w czasie) | nie zapisujemy historii | plakietka „X% po terminie”, nie „−6% vs …” |
| Telemetria odsłon | nie dotyczy produktu | karta „Wyświetlenia” → VAT/limit |
| Forma opodatkowania | brak kolumny | „przy podatku liniowym 19%, bez ZUS — szacunek” |
| Panel personalizacji Finory | PLAN-FINORA D2 | — |

**Tor uzupełniający (poza E0–E8, każdy za osobną decyzją Bartosza i z
własnym planem):**

| # | Co | Wpływ na karty | Migracja |
|---|---|---|---|
| K1 | Koszty z historii zakupów KSeF (Z9): `expenses` z zakupów `origin='ksef_import'` bieżącego roku, `is_reviewed=false`, idempotentnie przez istniejący `uq_expenses_tenant_ksef_invoice` (00121) | znika podpis „Koszty od DD.MM”; zysk i „Odłóż na podatek” przestają być zawyżone | prawdopodobnie nie; **niepewne**, czy strażnik pochodzenia (00127/00128) przepuści zapis z workera dla `ksef_import` — jeśli nie, migracja **00156** |
| K2 | N6: „Oznacz jako zapłaconą” (RPC, test RLS). **Zrobione 02.11.2026: 00158, „Zapłacone” jednym dotknięciem** | wpływy i tabela operacji zaczynają być pełne; Należności, „% po terminie” i Spodziewane wpływy przestają liczyć zapłacone faktury (znika zdanie z Z16); wraca przycisk w pustym stanie | tak (00156 albo następny wolny) |
| K3 | N7: termin płatności kosztów z XML | „Nadchodzące rachunki” mogą wrócić jako prawdziwe rachunki do zapłaty | tak |
| K4 | N5: wyciąg bankowy | saldo, prawdziwe wpływy | tak |

`lib/jobs/**`, `lib/ksef/**`, `supabase/migrations/**` są w `.github/CODEOWNERS`
(obszary wrażliwe) — K1–K4 wymagają zgody Bartosza na obszar.

---

## 11. Ryzyka i pułapki

1. **Stałe w plikach komponentów Finory.** Dane siedzą nie tylko w
   `page.tsx`, ale w samych komponentach (§5.5). Usunięcie ich ze strony nie
   wystarcza. Propsy bez wartości domyślnych + T2.
2. **Cookie aktywnej firmy vs `tenantId`.** Dwie różne drogi odczytu (§4
   „Uwaga do F”). Tryb liczony zawsze dla `ctx.tenantId`.
3. **Cache między firmami.** Żadnego `unstable_cache` w tym planie (§9).
   React `cache()` żyje jedno żądanie — bezpieczny.
4. **Prerender.** Dzisiejsze `page.tsx` Pulpitu i Przepływów są
   synchroniczne i nie czytają nic dynamicznego (dynamiczność daje tylko
   `cookies()` w `app/(dashboard)/layout.tsx:62`). Po zmianie:
   `export const dynamic = 'force-dynamic'` jak Analizy
   (`analizy/sprzedaz/page.tsx:20`).
5. **Zmiana środowiska TEST → PROD** cofa wszystkie firmy do trybu
   przykładowego (stan H). To poprawne, ale trzeba to zapowiedzieć w runbooku
   przełączenia i w mailu do testerów.
6. **Linki w demo** do `/invoices/<id-demo>` dają 404 — adaptery dają
   `href: null` w trybie `przyklad` (§5.2); dotyczy też „Zrób fakturę cykliczną” (E4).
7. **Granica serwer–klient.** Do komponentów klienckich (recharts, `Tabs`,
   tabela) idą tylko liczby i gotowe napisy; daty formatuje serwer w strefie
   Warszawa (PLAN-FINORA §2.4 pkt 10), inaczej hydratacja i miesiąc przy
   północy się rozjadą.
8. **Teksty „FaktWay”.** Każdy nowy podpis przechodzi przez
   `tests/unit/nazwa-produktu.test.ts`; nie pisz „FaktFlow”.
9. **Ciemny motyw.** `--muted` w ciemnym to `oklch(0.27 0 0)`, a
   `--muted-foreground` `oklch(0.72 0 0)` (`app/globals.css:113-114`).
   Linia stanu, podpisy `text-muted-foreground` i blada seria „Rok wcześniej”
   muszą mieć kontrast ≥ 4,5:1 (tekst) i ≥ 3:1 (grafika) w obu motywach —
   sprawdź `helpers/kontrast.ts`, wzór #300 (`text-accent-foreground` na
   tłach `primary/10–30`). Blada seria to dziś `chart-2` w 20%
   (`statistics-total-revenue-card.tsx:29`) i prawie na pewno nie da 3:1;
   zamiast zmieniać kolor (D1) dodaj listę `sr-only` z kwotami obu serii,
   jak w Analizach — informacja nie zależy wtedy tylko od koloru.
10. **Fail-closed kart** (waluta obca, brak środowiska) w trybie
    `synchronizacja` może trafić wiele firm naraz, bo historia wnosi stare
    faktury. Komunikat karty musi nazywać dokument i wyjście (protokół pkt 4);
    jeśli nie nazywa — osobne ustalenie w dzienniku.
11. **Rozbieżność filtrów `origin`.** Przychód liczy historię KSeF, należności
    i wpływy nie (`receivables.ts:266`, `inflows.ts:105`). Podpis przy
    należnościach to wyjaśnia; nie „naprawiamy” filtrów w tym planie.
12. **Testy liczb na sztywno.** Zmiana zestawu demo (E2) przesuwa liczby
    w testach Analiz — zmieniaj je świadomie, z komentarzem (protokół pkt 6).
13. **Własność plików.** Nie dotykamy plików FLO (D6). `lib/ksef/**`,
    `lib/jobs/**`, `lib/supabase/**` (m.in. `page-context.ts`,
    `active-org.ts`), `lib/exports/**` (strażnik waluty), `app/api/**`,
    `supabase/migrations/**`, `next.config.ts`, `package.json` to CODEOWNERS
    (`.github/CODEOWNERS`) — E0–E8 ich nie zmieniają (tylko importują).
    Reguła ESLint to zmiana `eslint.config.mjs`, nie `.github/`.

---

## 12. Własność i podział pracy

- Strony `app/(dashboard)/{dashboard,przeplywy,analizy,reports/kpir}` oraz
  `components/dashboard/finora/*`, `components/przeplywy/finora-1do1/*`,
  `components/analizy/*`, `lib/demo/*`, `lib/dashboard/*`,
  `lib/analytics-finance/*` — tor Bartosza (sesje agenta), poza CODEOWNERS.
- Komponent linii stanu i `DemoBadge` — wspólne dla trzech stron; zmiana
  wyglądu plakietki w nagłówku szkieletu (pasek górny) NIE wchodzi w plan
  (pasek to PLAN-FINORA, poprawki 21.10).
- FLO: bez zmian (D6). Dzwonek „Wkrótce w tym miejscu: FLO” zostaje.

---

## 13. Odhaczanie definicji sukcesu

| # | Kryterium (§1) | Etap | Stan |
|---|---|---|---|
| 1 | zero przecieku | E1 (bezpiecznik), E1b, E5b, E6b | — |
| 2 | pełne demo | E2, E5a, E6a | — |
| 3 | spójne demo | E2 | — |
| 4 | uczciwe podpisy | E0, E4, E5, E6 | — |
| 5 | stany §4 | E1b, E3 | — |
| 6 | design bez zmian | każdy | — |
| 7 | żadnej atrapy interakcji | E7 | — |

---

## 14. Dziennik

| Data | Etap | PR | Stan | Wdrożone (SHA) | Uwagi |
|---|---|---|---|---|---|
| 22.10.2026 | Audyt danych | (`docs/koordynacja/AUDYT-DANYCH-PULPIT-ANALIZY-PRZEPLYWY.md`) | gotowe, na gałęzi `claude/design-audit-data-plan-67fc82` | — | mapowanie wszystkich pól Pulpitu, Przepływów i Analiz na prawdziwe dane; co da KSeF; e-commerce nie przed launchem |
| 22.10.2026 | Plan | (ten dokument) | gotowe, na tej samej gałęzi | — | E0–E8 bez migracji; tor K1–K4 za osobnymi decyzjami |
| 22.10.2026 | Krytyka audytu i planu | — | gotowe, ta sama gałąź | — | poprawki z kodu: `paid_at` z wyzwalacza, Należności zawyżone bez N6 (Z16), `vat_total` w demo, dwa okna i osobne ładowarki Przepływów, stany B' i G'', podział E1/E1b, E5a/b, E6a/b, E0 jako osobny błąd, Z17 (stos „Finanse”) |

**Następny krok (22.10.2026):** Bartosz odpowiada na **Z1, Z2, Z3, Z4,
Z8, Z16** (blokują E0–E3 i podpisy należności) i opcjonalnie Z5–Z7, Z9,
Z17 (blokują E5–E6). Potem PR z audytem i planem do `main`, a następna
sesja robi **E0** (XS) i **E1 — bezpiecznik „zero przecieku”**. E7
(mikro-UI) i E8 mogą iść równolegle po E1.
| 23.10.2026 | E9–E12 | (PR w tej sesji) | gotowe na gałęzi `claude/dane-prawdziwe` | — | commity: patrz niżej |

Commity (`git log --oneline origin/main..HEAD`, 23.10.2026):

- `6098dbf4` Prawdziwe dane E12: plakietka „Dane przykładowe” na Pulpicie i Przepływach (D-P)
- `8d4a2a4a` Prawdziwe dane E11: wpływy według terminów płatności (D-W)
- `da1c5ac8` Prawdziwe dane E10: koszty z KSeF na wykresach (D-K)
- `67f0cb49` Prawdziwe dane: poprawki z recenzji
- `fdb66a99` Prawdziwe dane E9: ranking produktów bez okresu w nazwie
- `57a8a5ab` Prawdziwe dane E8: czyszczenie błędów certyfikatu po wgraniu
- `9a4c9b0c` Prawdziwe dane E7: wiersze Analiz jako linki do dokumentów
- `bd639ece` Prawdziwe dane E4: uczciwe podpisy w Analizach, demo bez fałszywych linków
- `65c2bebe` Prawdziwe dane E6: Przepływy na prawdziwych danych w kartach Finory
- `7dd17440` Prawdziwe dane E5: Pulpit na prawdziwych danych w kartach Finory
- `7cb60e6d` Prawdziwe dane E2: atrapa bazy zasila loadery Pulpitu i Przepływów
- `76387a49` Prawdziwe dane E1b: jedna funkcja trybu danych i granica importów lib/demo
- `73228880` Prawdziwe dane E0: pusty stan wpłat bez wezwania do oznaczania
- `eeb2a285` Audyt danych Pulpitu, Analiz i Przepływów + plan prawdziwych danych

**Następny krok (23.10.2026):** PR, CI, scalenie, wdrożenie (ta sesja).

---

## 15. Następne (poza tym planem)

- „Na rękę” — wymaga ekranu ustawień podatkowych (forma opodatkowania, ZUS).
- „Twój rok w KSeF” — podsumowanie roku do udostępnienia.
- Adres e-mail do faktur zagranicznych + OCR.
- Import wyciągu (N5) i open banking — wymaga firmy i umowy z pośrednikiem.
- Koszty z historii KSeF w KPiR (K1) — decyzja podatkowa.
- Automatyczne „Zapłacono” w wystawianym XML — zmiana treści faktury.
- FLO — tor Bartosza.
