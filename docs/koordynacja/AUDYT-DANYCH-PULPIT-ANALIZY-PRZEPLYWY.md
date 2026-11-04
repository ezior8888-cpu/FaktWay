# Audyt danych: Pulpit, Analizy, Przepływy (22.10.2026)

Stan kodu: `main` do #314 włącznie. Tylko odczyt kodu, bez builda i testów.
Każda karta zostaje na swoim miejscu. Siatka się nie zmienia. W każde pole
wstawiamy prawdziwą daną w tym samym kształcie. Statusy pól: **mamy**
(funkcja już to liczy), **policzymy** (dane są w bazie, brakuje zapytania),
**częściowo** (dane obejmują tylko część firmy), **nie_mamy** (bez nowej
integracji nie będzie).

---

## 0. Najważniejsze w 10 punktach

1. **Pulpit i Przepływy mają dane wpisane na sztywno i nie sprawdzają
   weryfikacji KSeF.** Klient po wgraniu certyfikatu dalej widzi Samsunga
   i Netflixa. Dotyczy to `app/(dashboard)/dashboard/page.tsx:34-130` oraz
   `app/(dashboard)/przeplywy/page.tsx:28-272`. Analizy przełączają się
   poprawnie przez `lib/demo/kontekst-przykladowy.ts:26-36` i ten wzorzec
   wystarczy powtórzyć.
2. **Żadna karta nie wymaga e-commerce ani banku.** Każda ma uczciwy
   zamiennik w tym samym kształcie i gotową funkcję w `lib/dashboard/*`.
   Z karty Finory nie da się przenieść treści: zamówień, odwiedzających,
   wyświetleń, marki produktu, celu oszczędnościowego, kont bankowych,
   e-maila kontrahenta, statusu „nieudana” ani kategorii „przelew”.
3. **Po wgraniu certyfikatu największą dziurą są koszty.** Synchronizacja
   historii pobiera zakupy z KSeF jako archiwum, bez wierszy `expenses`
   (`lib/jobs/runners/ksef-history-sync.ts:23`). Koszty zakłada wyłącznie
   `auto-categorize-inbox` dla `origin='ksef_inbox'` (`:311`), a skrzynka
   przy pierwszym uruchomieniu sięga tylko 48 h wstecz
   (`lib/jobs/runners/inbox-polling.ts:58`). Sprzedaż z historii wpada od
   razu (`ksef-history-sync.ts:906-907`, `accepted` + środowisko). Przez
   pierwsze tygodnie zysk wychodzi więc mniej więcej równy przychodowi,
   a „Odłóż na podatek” jest zawyżone.
4. **Wpływy będą prawie zawsze puste, a Należności zawyżone.** `paid_at`
   ustawia wyzwalacz bazy dopiero, gdy potwierdzone `payments` pokryją
   brutto (`update_invoice_payment_status`, 00073, poprawka 00145; wpłata
   częściowa nie ma `paid_at`). Jedyny kod, który wstawia `payments`, to
   potwierdzenie przez FLO (`lib/flo/functions/payment-confirm.ts:481`),
   a FLO nie jest udostępniony klientom. Ręcznego „Oznacz jako zapłaconą”
   nie ma, to decyzja N6 (`docs/koordynacja/PLAN-FINORA.md:936-950`). Mimo
   to pusty stan każe klientowi „Oznaczaj wpłaty, a pokażemy wpływy”
   (`lib/invoices/paid-labels.ts:11`), czyli prowadzi go w ślepą uliczkę.
   Ten sam tekst stoi już dziś na produkcji w kaflu „Opłacone” listy faktur
   (`app/(dashboard)/invoices/_components/invoice-stat-tiles.tsx:145`).
   Skutek dla Należności: każda faktura wystawiona w FaktWay zostaje
   „nieopłacona” na zawsze. „Należności”, „% po terminie”, kubełek „Ponad
   30 dni po terminie” i „Spodziewane wpływy” rosną więc z każdą fakturą,
   także zapłaconą. Tak liczy już karta Należności w Analizach. Faktury
   z historii KSeF Należności pomijają (`lib/dashboard/receivables.ts:266`).
5. **Dane przykładowe przeczą same sobie.** W Raporcie zysk 48 568 zł jest
   większy niż przychód 38 453 zł. Liczby na kartach nie zgadzają się ze
   słupkami. Daty kończą się w lipcu albo w 2025 roku. Rekomendacja: demo
   przez te same loadery i atrapę bazy co Analizy. Wygląd zostaje ten sam,
   a liczby zaczynają się zgadzać i przesuwać z datą.
6. **Atrapę bazy trzeba rozszerzyć, zanim obsłuży Pulpit i Przepływy.**
   Czego brakuje:
   - `maybeSingle()`: `lib/demo/fake-postgrest.ts` go nie ma, a czyta go
     `readTenantVatExemption` (`lib/invoices/vat-exemption.ts:72`). Karty
     VAT i „Cel” w trybie przykładowym by padły.
   - tabeli `tenants`;
   - `paid_at` w fakturach przykładowych (`lib/demo/analizy-przykladowe.ts:101-180`),
     bez którego wpływy w demo są puste;
   - `vat_total` w fakturach przykładowych: `getSalesSeries` i
     `getMonthlyFigures` czytają `vat_total` (`monthly-figures.ts:163,413`),
     a wiersze demo mają tylko `net_total` i `gross_total`, więc karta VAT
     w demo pokaże zera;
   - dłuższej historii: dziś jest 7 miesięcy, a ranking klientów porównuje
     12 z 12, więc przy 7 miesiącach procent zmiany zawsze wyjdzie `null`
     (ranking produktów procentu nie ma, `TopProduct`, `rankings.ts:30-38`).
7. **Wykres „Finanse” źle łączy serie.** `stackId='a'` układa zysk, przychód
   i koszty w jeden słupek (`components/dashboard/finora/chart-finance.tsx:90-92`),
   choć zysk jest częścią przychodu. Oś `domain={[0,50]}` (`:81`) utnie
   prawdziwe kwoty. Każda poprawka stosu zmienia wygląd słupka (D13).
8. **Funkcjonalność:**
   - Analizy działają. Atrapami są tylko 2 listy bez linków i wiersz
     „Do opisania”.
   - Pulpit ma 3 atrapy: menu ⋯ w 4 nagłówkach, „Zobacz raport” i „Szczegóły”.
   - Przepływy mają menu ⋯ w 4 kartach i wiersze list. Do tego dochodzi
     mylące menu wiersza tabeli „Edytuj / Duplikuj / Usuń”, które sugeruje
     kasowanie faktury.
   - Zakładki, filtry, sortowanie i paginacja działają.
9. **Po weryfikacji brakuje stanu przejściowego.** Bramka przełącza się na
   prawdziwe dane natychmiast, bez cache między żądaniami
   (`lib/dashboard-shell-data.ts:176-192`). Historia dochodzi z cronem co
   15 min (`lib/jobs/queues.ts:115`), w tempie około 20–40 faktur na
   godzinę: 5 pobrań XML na przebieg w dzień, 10 w nocy
   (`lib/ksef/history-sync/constants.ts:33-35`), od najnowszych wstecz
   (`windows.ts`). Pulpit pokaże więc
   zera bez wyjaśnienia. Odczyt postępu już istnieje
   (`readKsefHistorySyncStatus`, `lib/ksef/history-sync/status.ts:212`),
   ale czyta go tylko Import danych.
10. **E-commerce: nie przed launchem.** Najpierw N6 (oznaczanie wpłat),
    koszty z historii zakupów, N7 (terminy kosztów), a potem N5 (wyciąg
    z banku). Wracamy do tematu, gdy o sklep poprosi co najmniej 10
    płacących klientów (szczegóły w sekcji 5).

---

## 1. Czego nie możemy śledzić i co dajemy w zamian

### 1.1 Pulpit (`/dashboard`)

| Karta | Pole | Teraz (przykład) | Dlaczego nie da się | Co dajemy w zamian (ten sam kształt) | Źródło prawdziwej danej | Status |
|---|---|---|---|---|---|---|
| Finanse | podpis | „Przegląd roczny”, a dane z 7 mies. | podpis kłamie o zakresie | „Ostatnie 7 miesięcy” (7 słupków jak dziś) | `getSalesSeries(…,{months:7,withPrevYear:false}).months`, `lib/dashboard/monthly-figures.ts:336` | mamy |
| Finanse | oś X | Sty…Lip na sztywno | w październiku kończy się w lipcu | `months[].label` (np. „Kwi…Paź”) | jw. | mamy |
| Finanse | seria Przychody | 0–22 bez jednostki | — | przychód netto miesiąca w zł | `netSeries` (`monthly-figures.ts:429`, złote zaokrąglone do groszy) | mamy |
| Finanse | seria Koszty | 0–13 | koszty bez faktury (ZUS, zagraniczne SaaS, gotówka) i zakupy z historii KSeF nie wpadają | koszty KPiR z FaktWay; podpis „Koszty z dokumentów w FaktWay” | `getCosts` `lib/dashboard/costs.ts:75` + `sumCostsByMonth` `:159` | częściowo |
| Finanse | seria Zysk | 20–25 w stosie z przychodem | stos sumuje rzeczy, które się zawierają | zysk = przychód − koszty; stos Koszty + Zysk albo słupki obok siebie (pkt 6.4, D13) | `buildMonthReport`-owa różnica, `lib/dashboard/pulpit-report.ts:56` | policzymy |
| Finanse | oś Y / dymek | 0–50, liczby bez „zł” i bez miesiąca | zakres ucina złotówki | oś automatyczna „12 tys.”, dymek „Paź · Przychody 12 345,67 zł” | wzór: `components/dashboard/pulpit/finance-card.tsx:108-122` | policzymy |
| Raport | „Średnio miesięcznie” | 45,6 tys. zł | — | średnia netto pełnych miesięcy; `null` → „Średnia po pierwszym pełnym miesiącu” | `buildMonthReport().monthlyAverageNet`, `pulpit-report.ts:46-51` | mamy |
| Raport | Zysk / Przychody / Koszty „łącznie” | 48 568 > 38 453 (zysk > przychód) | liczby fikcyjne i sprzeczne | „Zysk” albo „Strata”, „Przychody”, „Koszty” **tego miesiąca**; podpis karty „Ten miesiąc” | `buildMonthReport` (`revenue`, `costs`, `profit`) | mamy, koszty częściowo |
| Kafel „Zamówienia” | tytuł, ikona, wartość | 155 tys. | brak sklepu i zamówień | „Faktury”: przyjęte w KSeF w tym miesiącu, ikona `RiFileList3Line` | `getMonthlyFigures().acceptedCount`, `monthly-figures.ts:242` | mamy |
| Kafel „Zamówienia” | trend, plakietka | +22% ↑, „Ostatnie 4 miesiące” | strzałka z literału (`statistics-card-03.tsx:49`) | % m/m; bez poprzedniego miesiąca „—” bez strzałki; plakietka „Ten miesiąc” | `momCountPct` + `hasPrevMonth` (`:290-292`; uwaga: przy braku podstawy `momCountPct=0`, decyduje `hasPrevMonth`) | mamy |
| Kafel „Zysk łącznie” | tytuł, wartość, trend, plakietka | 89,34 tys. zł, −16%, „Ostatni rok” | zysk z niepełnych kosztów to druga, sprzeczna liczba obok Raportu | **„Średnia faktura”**: netto na fakturę w tym miesiącu, % m/m, plakietka „Ten miesiąc” (alternatywa w D4) | `salesMonthStats().avgPerInvoice` i `changePct` średniej (policzymy z dwóch miesięcy), `lib/analytics-finance/sales.ts:111-130` | policzymy |
| Przychód łącznie | wartość, % | 42,5 tys. zł, −22% bez koloru | — | „Przychód netto” bieżącego miesiąca, % m/m (null → ukryte) | `netSeries.at(-1)`, wzór `components/dashboard/pulpit/net-revenue-card.tsx:33` | mamy |
| Przychód łącznie | 2 serie × 5 mies. | „Komputer” / „Telefon” | brak danych o urządzeniach | „Ten rok” / „Rok wcześniej” (blady), 5 miesięcy | `getSalesSeries({months:5,withPrevYear:true})`: `currentSeries`/`prevSeries` są brutto, więc dodać `prevNetSeries` (1 linia obok `:427`) | policzymy |
| Wyświetlenia | tytuł, linia 12 pkt, wartość, % | 175 tys., +24% zawsze zielone | brak telemetrii odsłon | płatnik VAT: „VAT należny”, linia 12 mies., wartość = VAT bieżącego miesiąca, % m/m z kolorem ze znaku; zwolniony: „Limit zwolnienia z VAT”, linia `cumulative` od stycznia (w październiku 10 punktów, nie 12), wartość = `limit.pct`, a bez daty rozpoczęcia działalności `lowerBound.pct` z dopiskiem „co najmniej” | `vatSeries` (`:430`); `getVatLimit` `lib/dashboard/vat-limit.ts:288` (`VatLimitOverview.cumulative`, `limit`, `lowerBound`, `:63-111`); rozgałęzienie jak `VatSlotCard` `components/dashboard/pulpit/pulpit-grid.tsx:209-236` | mamy |
| Odwiedzający | tytuł, ikona | „Odwiedzający”, `RiGroupLine` | brak ruchu na stronie | „Należności według terminu”, `RiTimeLine` | — | mamy |
| Odwiedzający | suma, plakietka % | 23,02 tys. (≠ suma kolumn), −6% | brak historii należności (nie zapisujemy migawek); **bez N6 nikt nie potwierdza wpłat**, więc suma obejmuje też faktury zapłacone (§0 pkt 4) | suma należności w zł; plakietka „18% po terminie” (bez udawania zmiany w czasie); podpis z D12 | `receivablesAging().total`, `lib/dashboard/receivables-aging.ts:64`; % = (upTo30+over30)/total | częściowo (zawyżone do N6) |
| Odwiedzający | 3 kolumny | Komputer/Tablet/Telefon, wysokość wpisana ręcznie | jw.: zapłacone faktury przechodzą z czasem do „Ponad 30 dni” | Przed terminem / Do 30 dni po / Ponad 30 dni po; wysokość `style={{height}}` z `pct` | `BUCKETS` `receivables-aging.ts:31-35`, `largestRemainderPercents` `:47` | częściowo (zawyżone do N6) |
| Odwiedzający | kwota i strzałka w kolumnie | „23.8”, ↗/↙ z literału | brak trendu | „12,4 tys. zł”; strzałka = ocena (↗ w terminie, ↙ zaległe) + `sr-only` | `buckets[].amount` | mamy |
| Najlepiej sprzedające się | nazwa, kwota | Samsung Galaxy S25, 32 203 zł (nieposortowane) | — | 5 pozycji faktur, netto 12 mies., malejąco | `getTopProducts` `lib/dashboard/rankings.ts:216` | mamy |
| Najlepiej sprzedające się | podpis (marka) | Samsung, Apple | faktura nie niesie marki | „j.m.: godz.” jak w dawnej karcie (`components/dashboard/pulpit/top-lists-card.tsx:82`); bez jednostki pusty podpis (nie zgadujemy „Usługa”, `TopProduct` nie ma liczby faktur) | `TopProduct.unit` (`rankings.ts:35`) | częściowo |
| Najczęściej kupowane | tytuł, wolumen | „Najczęściej kupowane”, 200 tys. | ilości w szt. i godz. nie sumują się sensownie | „Najwięksi klienci”, netto 12 mies. w zł | `getTopClients` `rankings.ts:323` | mamy |
| Najczęściej kupowane | podpis, plakietka % | marka, +5% | — | „NIP 123…”; grupa „Konsumenci” → „Nabywcy bez NIP (B2C)”; nabywca bez NIP spoza B2C → pusty podpis; % vs poprzednie 12 mies., `null` → „nowy” (`top-lists-card.tsx:111,126`) | `TopClient.nip`, `consumers`, `changePct` (`rankings.ts:40-52`) | mamy |

Podpisy uczciwości (jedna linia `CardDescription`, bez zmiany układu):
- przy kosztach: „Koszty z dokumentów w FaktWay”;
- przy należnościach: „Faktury z FaktWay, według oznaczonych wpłat”
  (nowy tekst; dzisiejszy `RECEIVABLES_NOTE` w
  `lib/dashboard/receivables-note.ts:2` brzmi „Bez importów i faktur
  skorygowanych”), a do N6 także zdanie z D12;
- przy sprzedaży: „Faktury przyjęte w KSeF”.

### 1.2 Przepływy (`/przeplywy`)

| Karta | Pole | Teraz (przykład) | Dlaczego nie da się | Co dajemy w zamian | Źródło | Status |
|---|---|---|---|---|---|---|
| Przepływy pieniężne | 2 sumy | 22 300 / 17 470 zł z `monthlyData`, niezależnie od zakładki (`chart-cash-flow.tsx:62`) | brak salda i przelewów z banku | „Suma wpłat” i „Suma kosztów (brutto)” z **aktywnej** zakładki | `getInflows` `lib/dashboard/inflows.ts:89` + `getCosts().outflow` → `buildCashFlowChart` `lib/dashboard/cash-movements.ts:147` | częściowo |
| Przepływy pieniężne | podtytuł | „Wpływy i wydatki w czasie” | sugeruje konto bankowe | „Wpływy według oznaczonych wpłat, wydatki brutto z kosztów” (już jest w `components/przeplywy/finora/chart-cash-flow.tsx:74`) | `PAID_NOTE` | mamy |
| Przepływy pieniężne | zakładki, oś X | pon…nie / sty…lip / 2021…2025 | — | 7 tygodni / 7 miesięcy / do 5 lat; etykiety z `FlowBucket.label` | `CASH_FLOW_CHART_*` `cash-movements.ts:105-107` | mamy |
| Przepływy pieniężne | seria Wpływy | słupki zielone | zapłatę zna tylko FLO; ręcznie nie da się oznaczyć (N6) | wpłaty po `paid_at`; `inflowCount=0` → w dymku „brak oznaczonych wpłat” | `FlowBucket.inflow` | częściowo |
| Przepływy pieniężne | seria Wydatki | słupki | koszty nie mają dnia zapłaty | koszty brutto według daty dokumentu; legenda „Koszty (brutto)” | `FlowBucket.outflow` | częściowo |
| Cel oszczędnościowy | tytuł, podtytuł | „Cel oszczędnościowy / Fundusz awaryjny” | brak salda i celów (wymaga N5) | zwolniony z VAT: „Limit zwolnienia z VAT”; płatnik: „Odłóż na podatek” | `VatLimitGoalCard` / `TaxSavingsGoalCard`, `components/przeplywy/finora/statistics-savings-goal-card.tsx:156,249` | mamy |
| Cel oszczędnościowy | % w pierścieniu, kwota, „z celu” | 68%, 6,8 / 10 tys. zł | — | limit: „% limitu”, „X tys. zł z 240 tys. zł”; płatnik: pełny łuk, kwota szacunku, „19% liniowy · szacunek” | `getVatLimit`; `estimateIncomeTaxThisYear` `lib/dashboard/tax-estimate.ts:55` (stała 19%, `:17`; brak w bazie formy opodatkowania) | mamy (limit) / częściowo (podatek) |
| Cel oszczędnościowy | linia „+68% wobec poprz. mies.” | kopia procentu | nic nie znaczy | limit: prognoza przekroczenia; płatnik: „bez ZUS i kosztów spoza FaktWay” | `VatLimitOverview.forecast`; `TaxEstimate.subtitle` | częściowo |
| Przychody w tym miesiącu | tytuł, kwota, %, wykres | 34 600 zł (wartość z 2025), 8 pkt z lipca | to nie przychód, tylko wpłaty | „Wpłynęło w tym miesiącu”, suma narastająca dzień po dniu, % m/m (null → ukryj) | `monthFlows(...).inflow`, `cash-movements.ts:239` | częściowo |
| Wydatki w tym miesiącu | tytuł, kwota, %, wykres | 26 180 zł | koszty bez dnia zapłaty | „Koszty w tym miesiącu (brutto)” według daty dokumentu | `monthFlows(...).outflow` | częściowo |
| Największe źródła przepływów | 5 pozycji | „Wynagrodzenia”, „Czynsz” | kategorie wymyślone, płac nie ma w KSeF | kontrahenci: klienci (+) z wpłat, dostawcy (−) z kosztów; podpis „Klient · 3 wpłaty”; podtytuł „Ostatnie 12 miesięcy” | `topCashFlowSources` `cash-movements.ts:297` (`share` = % swojej strony) | częściowo |
| Nadchodzące rachunki | tytuł, 5 pozycji | czynsz, internet, prąd | koszty nie mają terminu (N7) ani statusu zapłaty | **„Spodziewane wpływy”**: faktury z terminem w 30 dni, „Termin dziś / za N dni”, kwota pozostała; do N6 lista obejmuje też faktury zapłacone przed terminem | `upcomingInflows(getReceivables(…))` `cash-movements.ts:385` (`UPCOMING_DAYS=30`), osobny odczyt należności, nie wpłat | częściowo |
| Ostatnia aktywność | etykieta, podpis | „Czynsz za biuro · Rachunek firmowy” | brak kont bankowych (`payment_imports` bez zasilania) | kontrahent; podpis „Wpłata · FV/10/2026/099 · 21.10.2026” albo „Koszt · …” | `cashFlowOperations(...).slice(0,5)` `cash-movements.ts:438` | częściowo |
| Tabela | awatar, e-mail | `/images/avatars/*.webp` (plików brak), `@przyklad.example` | e-maila nabywcy nie ładujemy do operacji | inicjały; druga linia „NIP … · numer dokumentu” | `CashFlowOperation.counterparty`, `reference` | mamy |
| Tabela | Kategoria | przychód/rachunki/zakupy/przelew/subskrypcja | brak kategorii „przelew” i subskrypcji prywatnych | wpłaty: Sprzedaż/Zaliczka/Faktura końcowa; koszty: `category_label` albo „Bez kategorii” | `CashFlowOperation.category` | częściowo |
| Tabela | Status | zrealizowana/oczekująca/**nieudana** | brak operacji bankowych | „Opłacona” / „Zatwierdzony” / „Do akceptacji” (dla kosztu to opisanie, nie zapłata); „nieudana” znika sama z facetów | `OperationStatus` `cash-movements.ts:412` | częściowo |
| Tabela | Akcje wiersza | Edytuj / Duplikuj / Usuń bez działania | przyjętych faktur nie wolno usuwać | jedna pozycja „Otwórz fakturę / wydatek” | `/invoices/[id]`, `/expenses/[id]` (istnieją) | mamy |

### 1.3 Analizy (`/analizy/sprzedaz`, `/analizy/koszty`)

Strona jest uczciwa: wszystkie 18 kart ma prawdziwe źródło, a do tego tryb
przykładowy. Pola częściowe:

| Karta | Pole | Dlaczego częściowo | Krótki podpis dla klienta | Źródło | Status |
|---|---|---|---|---|---|
| Wydatki miesiąca, Trend, Koło kategorii, Kalendarz | kwoty kosztów | tylko `expenses`: skrzynka KSeF od chwili podłączenia, OCR i wpisy ręczne; bez historii zakupów KSeF i kosztów bez faktury | „Koszty z dokumentów w FaktWay” | `getCosts` `costs.ts:75` | częściowo |
| Koło / Największe kategorie | kategorie | wolny tekst `category_label`, techniczne „Do weryfikacji waluty” (`auto-categorize-inbox.ts:285`) | — (na pustą kategorię zachęta „Opisz koszty”) | `costCategoryBreakdown` | częściowo |
| Przychody a koszty | Koszty, Wynik | koszt KPiR obok kafla „Wydano (brutto)”, a do tego to nie dochód podatkowy | „Koszty jak w KPiR, bez VAT do odliczenia” · etykieta „Wynik (netto)” | `costOfMonth`, `incomeExpenseNet` | częściowo |
| Należności | Do zapłaty, Po terminie, Najstarsza zaległość | tylko faktury z FaktWay (`origin='app'`); wpłatę potwierdza wyłącznie FLO, którego klienci nie mają, więc zapłacone faktury też wiszą (§0 pkt 4) | „Faktury z FaktWay, według oznaczonych wpłat” + zdanie z D12 | `getReceivables` `receivables.ts:249,266` | częściowo (zawyżone do N6) |

Rozbieżność, którą trzeba nazwać na ekranie: przychód w Analizach liczy też
faktury z historii KSeF (`lib/analytics-finance/sales.ts:65-70`, bez filtra
`origin`), a Należności i Wpływy je pomijają (`receivables.ts:266`,
`inflows.ts:105`). Podpis przy Należnościach to wyjaśnia.

---

## 2. Pola, które już dziś da się śledzić

| Dana | Funkcja | Tabela / kolumny |
|---|---|---|
| Sprzedaż netto/brutto/VAT miesiąca, liczba faktur, szkice | `getMonthlyFigures` `monthly-figures.ts:205` | `invoices` (`outgoing`, `accepted`, `ksef_environment`) |
| Serie 1–N miesięcy, rok wcześniej | `getSalesSeries` `:336` | jw. |
| Koszty KPiR, wypływ brutto, VAT, kategoria, opisanie | `getCosts` `costs.ts:75` | `expenses` (`is_deductible=true`) |
| Zysk / średnia miesięczna | `buildMonthReport` `pulpit-report.ts:31` | wynik dwóch powyższych |
| Należności i struktura wieku (do N6 zawyżone, §0 pkt 4) | `getReceivables` `receivables.ts:249`, `receivablesAging` `receivables-aging.ts:64` | `invoices.payment_status`, `paid_amount`, `payment_due_date` |
| Wpłaty | `getInflows` `inflows.ts:89` | `invoices.paid_at`, `paid_amount` |
| Top produkty / klienci (12 vs 12 mies.) | `getTopProducts` `rankings.ts:216`, `getTopClients` `:323` | `invoice_line_items`, `invoices.buyer_*` |
| Wykres przepływów, kafle miesiąca, źródła, spodziewane wpływy, operacje | `cash-movements.ts:147/239/297/385/438` | wynik `getInflows` + `getCosts` |
| Limit zwolnienia z VAT, szacunek PIT | `getVatLimit` `vat-limit.ts:288`, `estimateIncomeTaxThisYear` `tax-estimate.ts:55` | `invoices`, `tenants.vat_exemption_basis` |
| Stali klienci / dostawcy | `recurringClients`, `recurringSuppliers` (`lib/analytics-finance/recurring.ts`), `findRecurringCosts` `recurring-costs.ts:45` | jw. |
| Wydatki do opisania | `countExpensesToReview` `expense-stats.ts:103` | `expenses.is_reviewed` |
| Postęp historii KSeF | `readKsefHistorySyncStatus` `status.ts:212` | `ksef_history_sync`, `ksef_history_items` |

---

## 3. Czy design jest funkcjonalny

| Strona | Element | Plik:linia | Stan | Najmniejsza poprawka |
|---|---|---|---|---|
| Pulpit, Przepływy | menu ⋯ (Udostępnij/Aktualizuj/Odśwież) w 8 nagłówkach | `components/dashboard/finora/card-header-with-menu.tsx:15,40-42` | atrapa | `menuItems: {label, href?}[]`; zostają „Odśwież” (`router.refresh`) i jeden link kontekstowy (np. „Otwórz przepływy”, „Wszystkie faktury”); ikona ⋯ bez zmian |
| Pulpit | „Zobacz raport” | `chart-finance.tsx:116` | atrapa | `<Link href="/przeplywy" className={buttonVariants({size:'lg'})}>Zobacz przepływy` (jak `pulpit/finance-card.tsx:181`) |
| Pulpit | „Szczegóły” | `chart-total-visitors.tsx:42-44` | atrapa | link do `/payments/overdue` (jak `receivables-aging-card.tsx:55`) |
| Pulpit | strzałka trendu w kaflach | `statistics-card-03.tsx:47-50` | myląca | strzałka ze znaku liczby; brak podstawy → „—” |
| Pulpit | dymki 3 wykresów | `chart-finance.tsx:89`, `statistics-total-revenue-card.tsx:51`, `statistics-impression-card.tsx:47` | częściowo | miesiąc + „zł” w formatterze |
| Pulpit | % „Wyświetleń” zawsze zielony | `statistics-impression-card.tsx:68` | myląca | kolor ze znaku |
| Przepływy | 2 sumy nad wykresem | `finora-1do1/chart-cash-flow.tsx:62` | myląca | sumy z aktywnej zakładki (kontrolowane `Tabs`, jak w `finora/chart-cash-flow.tsx`) |
| Przepływy | zakładki Tydz./Mies./Rok | `chart-cash-flow.tsx` (Tabs) | działa | — |
| Przepływy | dymek wykresu | `chart-cash-flow.tsx:113` | częściowo | okres już jest (brak `hideLabel`), brakuje „zł” |
| Przepływy | dymek kafli obszarowych | `statistics-area-stat-card.tsx:66` | częściowo | data + „zł” |
| Przepływy | filtry Kategoria/Status, paginacja | `datatable-transaction.tsx` | działa | numery stron z `aria-label` |
| Przepływy | sortowanie kwoty | `datatable-transaction.tsx` | częściowo | `accessorFn` ze znakiem kierunku |
| Przepływy | menu wiersza Edytuj/Duplikuj/Usuń | `datatable-transaction.tsx:406-420` | **myląca** | jedna pozycja „Otwórz fakturę / wydatek” |
| Przepływy | wiersze list (Źródła, Rachunki, Aktywność) | `finora-1do1/widget-*.tsx` | atrapa | nazwa jako `Link` do `/invoices/[id]`, `/expenses/[id]`, kontrahent do `/contractors` (nie `/clients`, bo tej trasy nie ma) |
| Przepływy | awatary w tabeli | `datatable-transaction.tsx:22,52`; brak `public/images/avatars` | atrapa (404) | same inicjały |
| Analizy | wybór miesiąca, przełącznik Sprzedaż/Koszty, `/analizy` → przekierowanie | `month-selector.tsx`, `analizy-mode-switch.tsx` | działa | — |
| Analizy | „Ostatnie faktury” / „Ostatnie wydatki” | `finora-1do1/recent-expenses-feed.tsx` (brak `href`) | atrapa | nazwa jako `Link` (FeedItem ma `id`) |
| Analizy | „Do opisania” | `spending-streaks-card.tsx` | atrapa | link `/expenses?filter=unreviewed&miesiac=RRRR-MM` (filtr i miesiąc istnieją, `app/(dashboard)/expenses/page.tsx:33-34`; bez `miesiac` lista pokaże bieżący miesiąc, a karta liczy wybrany) |
| Analizy | „Zrób fakturę cykliczną” w demo | `subscriptions-card.tsx` | myląca (niepewne) | w trybie demo `action: null` |
| Analizy | „Podłącz KSeF” w pustych kosztach | `components/analizy/koszty-grid.tsx:48-51` | martwa gałąź (przed weryfikacją i tak jest demo) | dla zweryfikowanego bez kosztów: „Pobierzemy faktury kosztowe z KSeF; możesz dodać wydatek ręcznie” |
| Analizy | plakietka „Dane przykładowe” | `components/dashboard/demo-badge.tsx:14` | częściowo | wyjaśnienie tylko w `title`, którego nie widać na dotyku; zob. pkt 6.5 |
| Przepływy (prawdziwe) | pusty stan wpływów | `lib/invoices/paid-labels.ts:11` | **ślepa uliczka** | do decyzji N6; do tego czasu „Wpłaty pojawią się, gdy potwierdzisz je FLO” albo „Wpłat jeszcze nie oznaczono” |

**Werdykt:**
- **Analizy:** funkcjonalne. Trzy atrapy wierszy da się naprawić linkiem.
- **Pulpit:** wizualnie gotowy, funkcjonalnie atrapa: dane fikcyjne i 3 przyciski bez celu. Po podpięciu danych i poprawie 3 przycisków będzie funkcjonalny, z jednym zastrzeżeniem: Należności są zawyżone do N6 (D12).
- **Przepływy:** wizualnie gotowe. Atrapami są dane, menu i akcje wiersza. Karty wpływów zostaną puste, dopóki nie rozstrzygniemy N6.

---

## 4. Jakie dane naprawdę wyciągniemy z KSeF

**W bazie (kolumny):**
- daty: `issue_date`, `sale_date`;
- numery: `internal_number`, `ksef_number`;
- strony: `seller_nip`, `seller_data`, `buyer_nip`, `buyer_data`, `buyer_pesel`;
- sumy: `net_total`, `vat_total`, `gross_total`, `currency`;
- rodzaj faktury: `invoice_kind`, `invoice_type`, `correction_type`;
- płatność: `payment_due_date`, `payment_data` (forma, rachunek), czytane przez `parsePlatnosc` (`lib/import/fa3-parser.ts:697`);
- pozycje: `invoice_line_items` (`name`, `unit`, `quantity`, `net_amount`, `vat_rate`).

**W JSON-ie faktury (`invoices.fa3_data`), bez osobnych kolumn:**
- FP, TP, podmiot upoważniony, GTU i procedury jako `fa3_data.ksefMarkers`
  dla faktur z importu i historii (`lib/import/imported-invoice-row.ts:406`,
  typ `fa3-parser.ts:73`); czy skrzynka zapisuje je tak samo, niepewne.

**Tylko w XML (archiwum):**
- PKWiU i CN pozycji (niepewne, czy parser je czyta);
- `Zaplacono` i `DataZaplaty`, czyli deklarację wystawcy (parser ich nie
  czyta, `parsePlatnosc` `fa3-parser.ts:697` bierze tylko termin, formę
  i rachunek);
- `Zamowienie` i `WarunkiTransakcji` (niepewne);
- kurs waluty (niepewne).

**Zakupy:**
- **Zakupy ze skrzynki** zapisujemy najpierw jako stub z samych metadanych (`inbox-polling.ts`), więc pozycje i termin pojawiają się dopiero po pobraniu pełnego XML. Czy to pobranie zawsze uzupełnia pozycje, jest niepewne.
- **Zakupy z historii** to archiwum bez `expenses`, więc nie trafiają do kosztów (pkt 0.3).
- **Termin płatności zakupu** jest w XML, ale nie trafia do `expenses`. To N7 (`PLAN-FINORA.md:952-957`).

**Metadane API** (`POST /invoices/query/metadata`):
- dają numery, daty, strony, netto/brutto/VAT, walutę, tryb, `hasAttachment`;
- nie dają pozycji, terminu ani zapłaty;
- limity: 20 zapytań o metadane na godzinę, 64 pobrania na godzinę, `pageSize` ≤ 250, 10 000 rekordów na zapytanie. Źródło: CIRFMF ksef-docs, *limity-api.md*.

**Czego KSeF nie da:**

| Brak | Przykład | Co z tym na ekranie |
|---|---|---|
| Rzeczywiste wpłaty i saldo | kto i kiedy zapłacił, stan konta | „według oznaczonych wpłat”, a docelowo N5 (wyciąg) |
| Zagraniczni dostawcy | Google Ads, Meta, AWS, Apple (MF Q&A KSeF 2.0) | wpis ręczny lub OCR; podpis „Koszty z dokumentów w FaktWay” |
| Koszty bez faktury | ZUS, PIT/CIT, wynagrodzenia, najem od osoby prywatnej | jw.; szacunek PIT to „bez ZUS” |
| Paragony, kasa fiskalna | fryzjer, sklep; paragony z NIP do 450 zł poza KSeF do końca 2026 (MF Q&A) | DISCLAIMER w karcie limitu VAT już to mówi |
| Sprzedaż B2C bez faktury | sklep internetowy | poza zakresem (sekcja 5) |
| Firmy poniżej 10 tys. zł miesięcznie | obowiązek od 1.01.2027 (MF, „poniżej 10 000 zł”) | historia może być pusta, a to nie jest błąd |
| Faktury ukryte przez nabywcę | iFirma (źródło branżowe, niezweryfikowane w MF) | lista zakupów nie musi być pełna |

Faktury sprzed rejestracji w FaktWay powinny przychodzić, bo historia sięga
od `max(2022-01-01, business_started_on)`
(`lib/ksef/history-sync/constants.ts:19`). Że KSeF udostępnia je po NIP-ie
niezależnie od daty nadania uprawnień, to **niepewne, bez źródła**. Trzeba
to sprawdzić na koncie z realnymi fakturami, zanim obiecamy to w UI.

---

## 5. Integracja z e-commerce

**Rekomendacja: nie przed launchem (luty 2027).**

**Dlaczego:**
1. Żadna karta jej nie wymaga. Każdą da się uczciwie wypełnić z faktur i kosztów.
2. Brakuje tańszych rzeczy, które dotyczą każdego klienta, nie tylko sklepów:
   - oznaczanie wpłat (N6);
   - koszty z historii zakupów;
   - termin kosztów (N7);
   - wyciąg z banku (N5; schemat `payment_imports` już jest).
3. Każda integracja to:
   - OAuth i tokeny;
   - zmiany w API platform;
   - dane konsumentów (RODO);
   - podwójne liczenie, gdy zamówienie ma też fakturę.

   Przy jednym planie za 29,99 zł to się nie zwróci.

**Co zamiast, w kolejności:**
1. N6;
2. koszty z historii KSeF;
3. N7;
4. N5: import wyciągu CSV/MT940 do `payment_imports` z dopasowaniem po
   numerze faktury, a od 2027 roku po numerze KSeF w tytule przelewu.

**Kiedy wrócić do tematu:** gdy o sklep poprosi co najmniej 10 płacących
klientów albo co najmniej 15% aktywnych firm będzie handlem wysyłkowym
(PKD 47.91). Wtedy jedna integracja przez BaseLinkera (hub zamiast pięciu
konektorów), a nie bezpośrednio z Allegro czy Shopify. Rzeczywiste wpłaty
online dałyby Przelewy24 albo Stripe, ale to inny temat niż e-commerce.

---

## 6. Mikro-zmiany UI (bez usuwania kart, bez zmiany siatki)

1. **Menu ⋯ z prawdziwymi pozycjami.**
   - Plik: `components/dashboard/finora/card-header-with-menu.tsx:15-42`.
   - Zmiana: `menuItems` jako `{label, href}`; domyślnie „Odśwież” i jeden
     link kontekstowy. „Udostępnij” i „Aktualizuj” znikają z listy, ikona ⋯
     zostaje.
   - Dlaczego: 8 menu nic nie robi.
2. **„Zobacz raport” → „Zobacz przepływy”.**
   - Plik: `components/dashboard/finora/chart-finance.tsx:116`.
   - Zmiana: `Link` z `buttonVariants`, wygląd identyczny.
   - Dlaczego: przycisk nie ma celu.
3. **„Szczegóły” jako link, ikona zegara.**
   - Plik: `components/dashboard/finora/chart-total-visitors.tsx:37,42`.
   - Zmiana: `Link` do `/payments/overdue`, ikona przez props
     (`RiTimeLine` zamiast `RiGroupLine`).
   - Dlaczego: karta pokaże należności, a nie ludzi.
4. **Słupki „Finanse”: uczciwy stos albo słupki obok siebie (D13).**
   - Plik: `components/dashboard/finora/chart-finance.tsx:90-92`.
   - Zmiana: (a) usunąć `stackId='a'` — 3 kolory zostają, ale słupek
     skumulowany zamienia się w trzy cienkie obok siebie, czyli widać to na
     pierwszy rzut oka; (b) zostawić stos z dwóch serii: Koszty + Zysk, razem
     wysokość = przychód; „Przychody” zostają w legendzie i dymku, sylwetka
     słupka bez zmian, ale znika trzeci kolor, a przy stracie zysk schodzi
     pod oś. W obu wariantach oś Y bez `domain/ticks`, `tickFormatter`
     „12 tys.” i szersza oś (dziś `margin={{ left: -30 }}`, `:70`, utnie
     „120 tys.”).
   - Dlaczego: stos zysku z przychodem jest błędem znaczeniowym, a stały
     zakres utnie kwoty. To nie jest mikro-zmiana wyglądu, stąd D13.
5. **Widoczne „Dane przykładowe” na Pulpicie i Przepływach.**
   - Pliki: `components/dashboard/demo-badge.tsx` i nagłówki stron.
   - Zmiana: plakietka jak w Analizach, a obok jedna linia „Twoje liczby
     pojawią się po podłączeniu KSeF” z linkiem `/settings/ksef` zamiast
     samego `title`.
   - Dlaczego: na telefonie wyjaśnienia nie widać, a demo nie może udawać
     prawdy.
6. **Jedna linia podpisu uczciwości.**
   - Pliki: karty kosztów, wpływów i należności.
   - Zmiana: `CardDescription`, np. „Koszty z dokumentów w FaktWay”,
     „Według oznaczonych wpłat”, „Faktury z FaktWay”.
   - Dlaczego: klient musi wiedzieć, że to nie saldo konta ani pełne koszty.
7. **Kafel przychodów w innym kolorze.**
   - Plik: `app/(dashboard)/przeplywy/page.tsx:285-292`.
   - Zmiana: `color='var(--chart-2)'` i
     `badgeClassName='bg-chart-2/10 text-chart-2'`.
   - Dlaczego: dziś oba kafle mają `chart-4` i nie da się ich odróżnić;
     `chart-2` to kolor serii „Wpływy”.
8. **Wiersze list jako linki, menu wiersza tabeli „Otwórz”.**
   - Pliki: `finora-1do1/widget-*.tsx`, `datatable-transaction.tsx:406-420`,
     `components/analizy/finora-1do1/recent-expenses-feed.tsx`,
     `spending-streaks-card.tsx`.
   - Zmiana: nazwa jako `Link` do dokumentu; w menu wiersza „Otwórz fakturę”
     zamiast „Edytuj / Duplikuj / Usuń”; „Do opisania” →
     `/expenses?filter=unreviewed&miesiac=RRRR-MM`.
   - Dlaczego: listy wyglądają na klikalne, a „Usuń” sugeruje kasowanie
     faktury z KSeF.

---

## 7. Decyzje dla Bartosza

| # | Pytanie | Rekomendacja |
|---|---|---|
| D1 | Koszty z historii zakupów KSeF: (a) tworzyć `expenses` z zakupów `ksef_import` (jako „do opisania”, `is_reviewed=false`), (b) tylko podpis „Koszty od DD.MM”, (c) liczyć je na Pulpicie bez KPiR | **(a) dla bieżącego roku podatkowego**, a do czasu wdrożenia (b). Wariant (c) tworzy drugą drogę kosztów wbrew PLAN-FINORA §2.4 pkt 12 |
| D2 | N6: ręczne „Oznacz jako zapłaconą” (RPC `record_manual_payment`, migracja + test RLS) | **Tak, przed podpięciem Przepływów i karty Należności na Pulpicie.** Bez tego połowa Przepływów jest pusta, Należności są zawyżone (§0 pkt 4), a pusty stan każe robić coś niemożliwego |
| D3 | N7: termin płatności kosztów z XML | Tak, ale po D1 i D2. Do tego czasu karta „Nadchodzące rachunki” pokazuje „Spodziewane wpływy” |
| D4 | Drugi kafel Pulpitu („Zysk łącznie”): Średnia faktura, Należności czy Zysk od początku roku | **Średnia faktura.** Należności już są w karcie „Odwiedzający”, a zysk w Raporcie |
| D5 | Raport: bieżący miesiąc czy suma 7 miesięcy z wykresu | **Bieżący miesiąc**, podpis „Ten miesiąc” (gotowa logika) |
| D6 | Pulpit i Przepływy przed weryfikacją: zostawić dzisiejsze liczby czy demo z atrapy bazy | **Atrapa bazy.** Wygląd ten sam, liczby spójne, daty bieżące |
| D7 | Linia „Pobieramy historię z KSeF: X z Y, koniec ok. DD.MM” na 3 stronach po weryfikacji | **Tak, jedna linia w nagłówku, nie nowa karta** (`readKsefHistorySyncStatus`) |
| D8 | „Odłóż na podatek” liczy 19% liniowo dla każdego, a forma opodatkowania nie jest zapisana | Na razie podpis „przy podatku liniowym 19%, bez ZUS”. Kolumna formy opodatkowania później |
| D9 | Wywołać `clearKsefHistoryCertificateErrors` w `uploadCertificateAction` (dziś wywołują ją tylko testy; `components/settings/actions.ts:149`) | Tak, osobny mały PR |
| D10 | Sprawdzenie na koncie z realnymi fakturami, czy historia sprzed rejestracji przychodzi | Tak, przed obietnicą w UI i w mailu |
| D11 | E-commerce | Nie przed launchem (sekcja 5) |
| D12 | Należności do czasu N6 (Pulpit „według terminu”, Analizy „Należności”, Przepływy „Spodziewane wpływy”): każda faktura z FaktWay wygląda na nieopłaconą | **N6 przed launchem.** Do tego czasu jedno zdanie w podpisie: „Wpłat jeszcze nie potwierdzamy — zapłacone faktury też są tu liczone”. Alternatywa: na Pulpicie przemianować kartę na „Faktury według terminu płatności” (te same liczby, bez słowa „należności”) |
| D13 | Wykres „Finanse”: słupki obok siebie (3 kolory, inna sylwetka) czy stos Koszty + Zysk (sylwetka ta sama, 2 kolory) | **Stos Koszty + Zysk**, bo Bartosz chce zachować wygląd; przy stracie słupek „Zysk” = 0, a strata tylko w dymku i w Raporcie |

**Do planu przełącznika (technicznie, dla następnej sesji):**
- Atrapa bazy (`lib/demo/fake-postgrest.ts`) potrzebuje:
  - `maybeSingle()`;
  - tabeli `tenants` (`vat_exemption_basis: null`);
  - `paid_at` w opłaconych fakturach przykładowych;
  - `vat_total` (i `sale_date` dla limitu VAT) w fakturach przykładowych;
  - 24 miesięcy historii, żeby rankingi i „rok wcześniej” miały podstawę.
- Pulpit: użyć slotów z `components/dashboard/pulpit/pulpit-grid.tsx`
  (`FinanceSlotCard:114`, `NetRevenueSlotCard:187`, `VatSlotCard:209`,
  `AgingSlotCard:239`, `TopListsSlotCard:254`), ale renderować komponenty
  Finory z `components/dashboard/finora/*` z danymi w propsach.
- Przepływy: brać tylko sloty odpowiadające 8 kartom 1:1. Cała
  `PrzeplywyGrid` (`components/przeplywy/przeplywy-grid.tsx:431`) dokłada
  karty, których dziś nie ma: „Przychody i koszty”, VAT, Należności,
  Zaległości i alert. Prawdziwe `components/przeplywy/finora/*` nie mają
  menu ⋯, więc trzeba je dodać, żeby wygląd się nie zmienił.
- Testy do przepisania: `tests/unit/pulpit-finora.test.tsx` i
  `tests/unit/przeplywy-strona.test.tsx:82` (asercja „dane przykładowe 1:1”).

---

## 8. Poprawki do skanów

- **Jednostka serii sprzedaży.** `getSalesSeries` zwraca **złote**
  zaokrąglone do groszy (`roundToCents`, `monthly-figures.ts:421-430`).
  Komentarz „w groszach” (`:304`) mówi o zaokrągleniu, nie o jednostce.
- **Brak poprzedniego miesiąca.** Przy zerowej podstawie `momCountPct`
  wynosi `0`, a nie `null` (`monthly-figures.ts:290`). Brak podstawy trzeba
  rozpoznawać po `hasPrevMonth`.
- **Kafle statystyk** nie mają stanu hover ani wyglądu linku
  (`statistics-card-03.tsx`). Mylący jest tylko trend z literału.
- **Dymek wykresu Przepływów** pokazuje okres (`chart-cash-flow.tsx:113`,
  bez `hideLabel`). Brakuje tylko „zł”.
- **Historia sprzedaży z KSeF** ma `accepted` i środowisko
  (`ksef-history-sync.ts:906-907`), więc liczy się w przychodzie, rankingach
  i VAT. Ryzyko braku środowiska dotyczy tylko starszych ścieżek importu
  (niepewne).
- **„Klient oznacza płatności”** jest nieprawdą: klient nie ma takiego
  przycisku (N6). Jedyną drogą jest FLO, a czy FLO pyta klientów na
  produkcji, jest niepewne (pamięć projektu: silnik FLO niewdrożony).
- **„Cel oszczędnościowy: mamy”** dotyczy tylko limitu VAT. Szacunek podatku
  to stałe 19% bez formy opodatkowania i bez ZUS, więc status to
  **częściowo**.
- **Atrapa bazy** nie obsłuży kart VAT i „Cel” (brak `maybeSingle`).
  Skany zakładały, że wystarczy dodać `paid_at`.
- **Trasa `/clients` nie istnieje.** Kontrahenci to `/contractors`.
- **Numer linii:** `defaultMenuItems` jest w `card-header-with-menu.tsx:15`,
  a nie `:13`.
- **Prawdziwe karty Przepływów** (`components/przeplywy/finora/*`) nie
  używają `CardHeaderWithMenu`. Podpięcie ich 1:1 usunęłoby menu ⋯.
- **Kafel „Zysk łącznie” → „Należności”** (propozycja skanu) dublowałby
  kartę „Odwiedzający” → „Należności według terminu” (ta sama suma).
  Dlatego proponuję „Średnią fakturę” (D4).
- **`paid_at` nie ustawia FLO wprost.** `payment-confirm.ts:481` wstawia
  wiersz `payments`; `paid_at` ustawia wyzwalacz 00073/00145 przy pełnej
  zapłacie. Wpłata częściowa nie trafia do wpływów.
- **„Należności: mamy”** było za mocne: bez N6 są zawyżone (D12).
- **Przepływy nie liczą się z jednego odczytu.** Wpłaty i koszty mają
  osobne ładowarki, celowo („żeby strażnik kosztów nie zabierał kafla
  wpływów”, `components/przeplywy/przeplywy-grid.tsx:89-95`), w dwóch
  oknach: 12 miesięcy i 5 lat (wykres roczny). „Spodziewane wpływy” czytają
  należności, a „Odłóż na podatek” — `getCashFlowData`.
- **Najlepiej sprzedające się** nie mają procentu zmiany ani liczby faktur
  (`TopProduct`, `rankings.ts:30-38`); podpis „Usługa” przy pustej
  jednostce byłby zgadywaniem.
