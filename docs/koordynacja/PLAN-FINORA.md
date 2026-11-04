# Plan wdrożenia szablonu Finora w FaktWay

> **„Kontynuuj plan Finora”** — sesja czyta ten plik od góry, robi checklistę
> startową (sekcja 0) i pracuje od wiersza „Następny krok” w dzienniku
> (sekcja 12). Po każdym etapie dopisuje wiersz w dzienniku i aktualizuje
> „Następny krok”. Ten plik jest jedynym źródłem prawdy o przenosinach na
> Finorę.

Audyt: 17.10.2026, sesja lokalna z przeglądarką (każda strona demo Finory
otwarta i spisana) + odczyt kodu `main` @ `1ded2147`.

---

## 0. Start sesji — checklista

1. `git fetch origin && git log --oneline -1 origin/main`. Gałąź etapu zawsze
   od świeżego `origin/main`: `claude/finora-eN-<temat>`.
2. **Kod Finory.** Szablon jest płatny (79 $, shadcn/studio, licencja
   pozwala na płatny SaaS i open source jako część produktu, NIE pozwala
   udostępniać samego szablonu osobno). Bartosz trzyma go w PRYWATNYM repo
   (krok 0.1). Sesja klonuje je obok, NIGDY do katalogu repo aplikacji:
   `gh repo clone ezior8888-cpu/faktflow-finora-src ../finora-src`.
   Brak dostępu = STOP i prośba do Bartosza. Bez kodu nie zgadujemy wyglądu
   ze zrzutów.
3. Demo do porównań (zawsze dostępne):
   `https://shadcn-nextjs-finora-app-template.vercel.app` (np. `/dashboard/finance`).
4. Budżet chmury: **103 $ kredytów**. Po każdym etapie wpisz w dziennik
   rzeczywiste zużycie. Nie zaczynaj etapu, gdy zostaje mniej niż jego
   szacunek z §9 + 3 $ (i nigdy poniżej 12 $). Wtedy dokończ bieżący,
   wypchnij, zapisz „Następny krok” i stop. Dalej jadą sesje lokalne.
5. Sesja w chmurze NIE ma `.agents/infra.env` ani SSH: **nie wgrywa migracji
   i nie wdraża**. W opisie PR pisze „Do wgrania: 00NNN, przed wdrożeniem”.
   Numer migracji z rejestru w `docs/koordynacja/CLAUDE-DO-CODEXA.md`
   (wiersz „następny wolny”; 17.10 było to **00151**) — w tym samym PR
   dopisz wiersz do rejestru.
6. Przed każdym PR: `pnpm run ci && pnpm build`. Scalanie i wdrożenie robi
   Bartosz (AGENTS.md, „Scalanie PR”). W świeżym kontenerze najpierw
   `xmllint --version`. Jeśli go nie ma:
   `sudo apt-get update && sudo apt-get install -y libxml2-utils` (tak robi
   CI, `.github/workflows/ci.yml` 31–35). Bez niego pada test XSD w
   `pnpm test`, a Vitest w ogóle nie rusza. To nie jest błąd Twojej zmiany.

### 0.1. Krok 0 dla Bartosza (jednorazowo, przed pierwszą sesją)

1. ~~Kup Finorę (79 $)~~ — zrobione 17.10 (wersja 1.0.0): `https://shadcnstudio.com/templates/admin-dashboard/finora`.
2. ~~Utwórz prywatne repo~~ — zrobione 17.10: `ezior8888-cpu/faktflow-finora-src` (prywatne, oryginał bez zmian). Było: utwórz prywatne repo `faktflow-finora-src`, wrzuć rozpakowany szablon
   bez zmian, nadaj dostęp kontu, na którym działa sesja w chmurze.
3. ~~Wpisz właściciela repo~~ — zrobione (punkt 2 checklisty).
4. ~~Wybierz preset~~ — zrobione 17.10: Modern Minimal, Outfit, Light, Compact, SM, Inset, Default (D2).

---

## 1. Decyzje, które już zapadły (nie otwieraj ich ponownie)

| # | Decyzja |
|---|---|
| D1 | Jedyny szablon to **Finora**. NexaCRM porzucona — nie bierz z niej niczego. |
| D2 | **Konfiguracja Finory wybrana przez Bartosza 17.10.2026** (panel „Theme Customizer” w demo): **Theme Preset: Modern Minimal** (niebieski) · **Font: Outfit** · **Color Mode: Light** jako domyślny (Dark zostaje jako przełącznik użytkownika, System też) · **Content Layout: Compact** · **Scale: SM** · **Sidebar Variant: Inset** · **Sidebar Mode: Default**. E0 spisuje z `../finora-src` dokładne wartości tych ustawień (zmienne CSS presetu, font, klasy skali i układu) do §10, E1 ustawia je na stałe w kodzie. Panelu personalizacji klient NIE dostaje. |
| D3 | Układ stron bierzemy z Finory **prawie bez zmian**. Zmieniamy treść, dane i podpisy, nie siatkę. Każdy dolar za szablon ma pracować. |
| D4 | **FLO**: miejsce i forma przyjdą z projektu Claude Design. Do tego czasu obecne komponenty FLO stoją w wyznaczonym slocie u góry pulpitu bez zmian. `components/flo/*`, `app/(dashboard)/flo/*`, `content/flo/*`, `app/(dashboard)/settings/flo/*`, `e2e/tests/flo-*.spec.ts` należą do Masła — NIE edytuj ich. `lib/flo/*` należy do toru silnika — też nie. |
| D5 | Strona sprzedażowa (landing) — poza zakresem. |
| D6 | Nowe funkcje podpatrzone u konkurencji, które pasują do ekranów Finory, robimy (sekcja 8). Bez kombinowania: najprostsza poprawna wersja. |
| D7 | **Karty podatkowe na ekranach są dozwolone** (decyzja Bartosza 17.10.2026: „nie ma żadnych problemów z prawem”): licznik limitu zwolnienia z VAT, „Odłóż na podatek”, VAT należny. To liczniki faktów, nie porady. Wyłączniki `tax.*` w `lib/flo/flags.ts` dotyczą propozycji agenta FLO i zostają bez zmian (D4). Gdziekolwiek niżej karta podatkowa jest opisana jako „wstrzymana do opinii prawnika”, wygrywa D7. |
| D8 | **Produkt nazywa się FaktWay** (zmiana nazwy 17.10.2026, wcześniej FaktFlow). W interfejsie, mailach, PDF, pomocy i na nowych ekranach Finory piszesz tylko „FaktWay” (pilnuje tego `tests/unit/nazwa-produktu.test.ts`). Domeny `faktflow.pl`, adresy e‑mail, zmienne środowiskowe `FAKTFLOW_*`, adresy stron pomocy i identyfikatory techniczne (`ff-*`, `--ff-*`, `faktflow-original`) zostają bez zmian do osobnej decyzji. |

---

## 2. Audyt aplikacji — fakty z kodu (stan `main` 17.10.2026)

### 2.1. Stos i zgodność z Finorą

| | FaktWay | Finora (strona produktu) |
|---|---|---|
| Framework | Next.js 16.3, App Router, React 19.2 | Next.js 16 App Router |
| UI | shadcn/ui, styl `radix-nova`, pakiet `radix-ui`, Tailwind v4 | shadcn/ui + Tailwind v4 |
| Formularze | React Hook Form + Zod | React Hook Form + Zod |
| Motywy | własny `lib/theme/theme.ts` (klasa `dark` na `<html>`, klucz `theme`, `THEME_BOOT_SCRIPT`, domyślnie jasny, bez trybu systemowego); `next-themes` jest w `package.json`, ale nieużywany | `next-themes` (`defaultTheme` system) + provider ustawień w ciasteczku |
| Wykresy | **brak biblioteki** — wykres sprzedaży to ręczny SVG (`components/dashboard/sales-chart-card.tsx`) | wykresy shadcn (sprawdź w `../finora-src`: najpewniej `recharts` + `components/ui/chart.tsx`) |
| Ikony | `lucide-react`, ale menu używa nazw Material Symbols (`'description'`, `'receipt_long'` w `lib/dashboard-nav-config.ts`) | **Remix Icon** (w demo każde `svg` ma klasę `remixicon`; pakiet potwierdza E0 w `../finora-src/package.json`) |
| Prymitywy | `radix-ui` (`asChild`) | **Base UI** (w demo `id='base-ui-…'`; `render` zamiast `asChild`), styl ostry: `rounded-none`, `text-xs`, `ring-1`, przycisk `h-8` |
| Komponenty `components/ui` | 19 (badge, button, card, checkbox, dialog, dropdown-menu, empty-state, input, label, select, separator, sheet, skeleton, sonner, table, tabs, textarea, tooltip, drawn-video) | znacznie więcej (sidebar, chart, command, avatar, progress, popover, calendar…) |
| Motyw | `app/globals.css` — 1642 linie, własne tokeny `--ff-*`, efekty „glass” (`components/glass-card.tsx`) | zmienne shadcn + presety |

**Wniosek:** przenosimy kod, nie odtwarzamy go. Zależności Finory (wykresy,
`cmdk`, ikony, `date-fns`, `react-day-picker` itd.) **dodajemy bez dyskusji** —
to nie są „inne biblioteki UI” w rozumieniu AGENTS.md, tylko części shadcn.

**Pułapka stylu.** Nadpisujemy tylko prymitywy shadcn o tej samej nazwie:
badge, button, card, checkbox, dialog, dropdown-menu, input, label, select,
separator, sheet, skeleton, table, tabs, textarea, tooltip. `empty-state.tsx`
i `drawn-video.tsx` są nasze i zostają (drawn-video to landing, D5).
`sonner.tsx` też zostaje (zob. Motyw w E1). Finora stoi na Base UI, więc
nadpisanie to migracja: `asChild` → `render` w 11 miejscach
(`grep -rn asChild app components`); zmiany API Select, DropdownMenu i Dialog
łapie `pnpm typecheck`. Do nowego `button.tsx` dopisz tymczasowe warianty
`glass` (wygląd `outline` Finory) i `glass-primary` (wygląd `default`), żeby
61 użyć w 31 plikach przeszło bez ręcznej przeróbki. Etapy ekranów zamieniają
je potem na warianty Finory. Rozmiary Finory zostają, ale przy
`[@media(pointer:coarse)]` przycisk ma co najmniej 44 px wysokości (dopisz to
do `buttonVariants`). `components/ui/sheet.tsx` podmieniasz tylko wtedy, gdy
`components/flo/flo-queue-sheet.tsx` działa BEZ edycji (`side='bottom'`,
`onOpenChange={setOpen}`). Sprawdź na 375 px, że kolejka Flo otwiera się od
dołu. Ostre rogi to wygląd Finory, nie błąd, więc nie dopisuj `rounded-*`.
Nowe zależności (`@remixicon/react`, `recharts`, Base UI, `cmdk` …) muszą
przejść `pnpm audit --prod --audit-level=high` (CI) i trafiają do
`experimental.optimizePackageImports` w `next.config.ts`. Sprawdź też, czy
`app/globals.css` nie nadpisuje komponentu po `data-slot` albo `[class*=…]`.
Te reguły wygrywają z klasami Finory.

### 2.2. Obecne trasy i to, co na nich stoi

| Trasa | Co jest | Logika, którą zostawiamy |
|---|---|---|
| `/dashboard` | ekran FLO (`components/flo/flo-screen`, `flo-composer`, `scheduled-panel`, `flo-welcome`) + `MonthlyFiguresCard` | `lib/dashboard/monthly-figures.ts` (`getMonthlyFigures`, `getSalesSeries`) |
| `/przeplywy` | `MonthlyFiguresCard`, `SalesChartCard`, `VatSummaryCard`, `CashFlowDashboard` (z szacunkiem podatku) | `lib/dashboard/monthly-figures.ts`, `lib/dashboard/tax-estimate.ts` (`estimateIncomeTaxThisYear`), `lib/accounting/read-complete-pages.ts`, `lib/invoices/settled-advances.ts`, `lib/exports/currency-guard.ts`, `lib/expenses/ksef-currency-review.ts`, `lib/expenses/ksef-environment.ts`, `lib/ksef/claim-environment.ts` |
| `/invoices` | lista | `lib/invoices/list-query.ts`, `components/invoices/batch-pdf-download`, `invoice-row-types` |
| `/invoices/[id]` | szczegóły | `components/invoices/invoice-detail-view` + polityki KSeF (`ksef-send-policy`, duplikaty, ponowienia) |
| `/invoices/new` (+ `regular`, `advance`, `correction`, `final`) | formularze | `components/invoices/invoice-type-selector` i formularze w `components/invoices/*` |
| `/payments/overdue` | przeterminowane + przypomnienia | `components/reminders/overdue-dashboard`, `lib/reminders/*`, `lib/invoices/amount-due.ts` |
| `/inbox` | faktury kosztowe z KSeF | `components/dashboard/responsive-table` |
| `/expenses`, `/expenses/[id]` | wydatki | `components/expenses/expenses-list`, `capture-button`, `lib/expenses/month.ts` |
| `/contractors` | kontrahenci | `responsive-table`, `bulk-validate-button`, `vat-status-badge`, `contractor-reminder-toggle`, `contractor-row-actions` |
| `/reports`, `/reports/kpir`, `/reports/exports` | raporty (`/reports` to przekierowanie na `/dashboard` i tak zostaje) | `components/expenses/kpir-view`, `lib/exports/*` |
| `/import-danych` | import | `lib/import/*` |
| `/settings/*` | account, accountant, audit, billing, flo, ksef, notifications, reminders, security, team + strona główna (profil firmy, zwolnienie z VAT, metoda kasowa, usunięcie konta) | formularze w `components/settings/*` |
| `/flo`, `/flo/wrapped` | `/flo` przekierowuje na `/dashboard`; podsumowanie roku | **nie ruszać** (D4) |
| `(auth)` | login, rejestracja, reset hasła, MFA | akcje w `app/(auth)/*/actions.ts` |
| `/expenses/[id]` | edycja wydatku (`ExpenseEditForm`, zdjęcie) | logika bez zmian; E6, karta Finory |
| `/onboarding/*` (4 ekrany), `/invite/[token]` | kreator firmy po rejestracji, zaproszenie | akcje w `app/actions/organizations.ts`; E10, styl karty P15 |
| `/accountant/[token]` | portal księgowej (oglądają go ludzie spoza firmy) | E8 obok Eksportu, tylko Card/Table Finory; `referrer: 'no-referrer'` z `app/accountant/layout.tsx` zostaje |
| `/auth/finish`, `/gdpr/cancel`, `/reset-password`, `/login/two-factor`, `/login/two-factor/setup` | ekrany auth spoza Finory | E10 |
| `app/(dashboard)/error.tsx`, `loading.tsx` | stany błędu i ładowania panelu | E2: `Skeleton` Finory w siatce kart; każda nowa strona z wykresami dostaje własny `Suspense` ze szkieletem |
| `not-found`, `global-error`, `/przerwa-techniczna` | rodzina landingu (`styles/zova.css`) | poza zakresem, jak D5 |
| `/admin/*` | panel operatora (tor C-22 Codexa) | poza zakresem; po E1 tylko sprawdzenie, że się renderuje |

Menu: `lib/dashboard-nav-config.ts` (sekcje „Dane”, „Księgowość”, dolny
pasek na telefonie: Flo / Faktury / Nowa / Miesiąc / Więcej). Szkielet:
`app/(dashboard)/layout.tsx` (`Sidebar`, `BottomNav`, `DashboardOrgHeader`,
`ThemeToggle`, `KsefHealthBanner`, `DashboardVerificationBannerSlot`,
`WelcomeModal`, `IdleWatcher`, `InstallPrompt`, `SupportWidget`,
`assertDashboardShellAccess`, `DashboardPageHeading`, `DashboardRouteFlags`,
`PrefetchDashboardRoutes`, `PrefetchExportsRoute`, `AnalyticsIdentify`).

### 2.3. Dane, z których zasilamy wykresy (schemat z `types/database.ts`)

| Źródło | Kolumny, które nas interesują |
|---|---|
| `invoices` | `direction` (**`'outgoing'` = sprzedaż, `'incoming'` = koszt z KSeF**), `invoice_kind`, `invoice_type`, `issue_date`, `sale_date`, `payment_due_date`, `days_to_payment`, `net_total`, `vat_total`, `gross_total`, `currency`, `paid_amount`, `paid_at`, `payment_status` (`unpaid`/`partial`/`paid`/`overdue`), `ksef_status`, `ksef_number`, `ksef_environment`, `ksef_accepted_at`, `buyer_nip`, `buyer_data`, `seller_nip`, `seller_data`, `internal_number`, `parent_invoice_id`, `reminders_paused`, `origin` |
| `invoice_line_items` | `invoice_id`, `name`, `quantity`, `unit`, `unit_price_net`, `net_amount`, `vat_rate`, `vat_amount`, `gross_amount`, `kpir_category` |
| `products` | `name`, `unit`, `default_price_net`, `default_vat_rate`, `gtu_code`, `category`, `use_count`, `last_used_at` |
| `contractors` | `name`, `nip`, `email`, `phone`, `vat_status`, `payment_terms_days_avg`, `late_payment_count` (nikt ich nie wypełnia, zawsze puste), `last_used_at`, `reminder_excluded` |
| `expenses` | `issue_date`, `seller_name`, `seller_nip`, `document_type`, `document_number`, `net_amount`, `vat_amount`, `gross_amount`, `vat_deductible_amount`, `category_label`, `kpir_column`, `is_reviewed`, `is_deductible`, `source` (`ocr_photo`/`ksef_inbox`/`manual`/`import`), `ksef_invoice_id` |
| `payments` | `invoice_id`, `amount`, `payment_date`, `payment_method`, `bank_payer_name`, `bank_payer_account`, `bank_import_id`, `is_auto_matched`, `match_confidence`, `match_method`, `is_confirmed`. **Rola `authenticated` nie ma do tej tabeli żadnych uprawnień (00074, `REVOKE ALL`): zapytanie z klienta sesji zwraca 42501, nie pustą listę.** Wpłaty zapisuje dziś wyłącznie potwierdzenie FLO (`lib/flo/functions/payment-confirm.ts`, klient administracyjny), proponowane tylko dla faktur sprzedaży po terminie. `payment_date` to dzień kliknięcia, nie dzień przelewu. `invoices.paid_amount` to suma `payments` liczona wyzwalaczem 00073, a `paid_at` to chwila, w której wyzwalacz zobaczył pełną wpłatę (00145). Żadne z nich nie jest osobnym źródłem. |
| `payment_imports` | **gotowy schemat pod wyciągi bankowe, bez interfejsu**: `account_iban`, `bank_name`, `booking_date`, `transaction_date`, `amount`, `currency`, `counterparty_name`, `counterparty_account`, `counterparty_nip`, `title`, `is_matched`, `matched_payment_id`, `ignored`, `provider`. **Rola `authenticated` nie ma do tej tabeli żadnych uprawnień (00074), tak jak do `payments`: zapytanie z klienta sesji zwraca 42501.** |
| `payment_reminders` | `invoice_id`, `stage` (`stage_1`–`stage_4`), `channel` (`email`/`sms`/`both`), `status` (`pending`/`sent`/`failed`/`cancelled`), `scheduled_for`, `sent_at`, `opened_at`, `clicked_at`, `days_overdue_at_send` |
| `reminder_settings` | progi etapów, godzina wysyłki, nadawca |
| `kpir_entries` | `entry_date`, `category`, `net_amount`, `vat_amount` |
| widok `invoices_overdue` | `amount_due`, `days_overdue`, `buyer_name`, `buyer_nip`, `payment_due_date`, `reminders_sent_count` |
| widoki `mv_tenant_monthly_stats`, `mv_tenant_dashboard_summary` | **NIE UŻYWAĆ:** od AUD-118 (02.10.2026) nikt ich nie odświeża (`RETIRED_CRON_QUEUES` w `lib/jobs/queues.ts`), mieszają kierunki, szkice i środowiska KSeF, nie podlegają RLS (00044) |

### 2.4. Zasady liczenia — ŁAMANIE ICH TO BŁĄD KRYTYCZNY

1. **Kierunek:** `direction` ma tylko `'outgoing'` i `'incoming'`. Nigdy
   `'issued'` (ten błąd zerował kiedyś wszystkie kafelki pulpitu).
2. **Proweniencja:** kwoty sprzedaży i VAT liczymy WYŁĄCZNIE z faktur
   przyjętych w aktywnym środowisku KSeF — tak jak robią to
   `getMonthlyFigures`/`getSalesSeries` i strona `/przeplywy`. Szkice mają
   osobny licznik. Nowe agregaty składaj z tych funkcji albo z ich filtrów
   1:1 — nie pisz „gołego” `sum(gross_total)`.
3. **Widoków `mv_*` nie używamy wcale** (§2.3). Liczby bierzemy
   z `getMonthlyFigures`, `getSalesSeries` i funkcji z pkt 11–13.
4. **Zaliczki i faktury końcowe:** `lib/invoices/settled-advances.ts` —
   faktura końcowa nie dubluje sprzedaży zaliczki.
5. **Korekty:** korekta to osobny wiersz w `invoices`
   (`invoice_kind='correction'`). Jej `net_total` / `vat_total` /
   `gross_total` to RÓŻNICA (00200), więc w sumach sprzedaży i VAT bierzemy ją
   bez zmian, w jej miesiącu. Nie jest osobną należnością (pkt 11). Jej
   pozycje to przy `before_after` stan PO, a przy korekcie kwotowej jedna
   sztuczna pozycja, więc do rankingów produktów korekt nie bierzemy
   (pkt 13).
6. **Waluty:** `lib/exports/currency-guard.ts` i
   `lib/expenses/ksef-currency-review.ts` — nie sumuj EUR z PLN.
7. **Paginacja:** sumy po wielu wierszach zawsze przez
   `lib/accounting/read-complete-pages.ts`. PostgREST ucina wynik po 1000
   wierszy — „goły” select da za małą sumę bez żadnego błędu.
8. **Kwota do zapłaty:** `lib/invoices/amount-due.ts` (uwzględnia częściowe
   wpłaty).
9. **RLS:** strony i akcje używają klienta z sesji (`lib/supabase/server.ts`),
   nie `service_role`.
10. **Daty i liczby:** `lib/format/pl.ts`, `lib/format/warsaw-date.ts`,
    `lib/i18n/plural.ts`. Miesiąc liczony w strefie `Europe/Warsaw`.
    `getMonthlyFigures` i `getSalesSeries` liczą dziś miesiąc w strefie
    serwera (UTC). Przed E4 osobny mały PR według protokołu napraw: obie
    funkcje wyznaczają klucze miesięcy i granice okna z `todayInWarsaw(now)`
    (jak `/przeplywy`). Czerwony test przed naprawą: 1. dzień miesiąca,
    00:30 czasu polskiego. Wszystkie nowe agregaty biorą „dziś”
    z `todayInWarsaw`.
11. **Należności** liczy jedna funkcja `lib/dashboard/receivables.ts`. Tworzy
    ją E3, pierwszy etap, który jej potrzebuje; E4, E5 i E8 tylko ją
    importują. Warunki są te same co w `invoices_overdue` (00145) i na
    stronie `/payments/overdue`, ale bez warunku daty: `direction='outgoing'`,
    `origin='app'`, `ksef_status='accepted'`, `ksef_environment` = środowisko
    aktywne (przyjęta faktura bez środowiska oznacza błąd, jak
    w `getMonthlyFigures`), PLN, rodzaje VAT/UPR, ZAL, ROZ,
    `gross_total > 0`, bez faktur z dziećmi (`parent_invoice_id` /
    `advance_invoice_ids`), `payment_status` ∈ (`unpaid`, `partial`,
    `overdue`). Kwota przez `outstandingOf`, nie `amountDueOf`. Odczyt przez
    `readCompletePages`. Korekt, szkiców i importów nie liczymy nigdy. „Po
    terminie” liczymy z daty (`payment_due_date < dziś`, Europe/Warsaw),
    NIGDY z `payment_status = 'overdue'`, bo wyzwalacz ustawia go tylko przy
    zapisie wiersza. Każda karta z tą sumą ma podpis „Bez importów i faktur
    skorygowanych” (jak `/payments/overdue`). Test: szkic, import, korekta
    in minus, oryginał z korektą, ROZ z zaliczkami, inne środowisko, faktura
    po terminie ze statusem `unpaid`. Filtr płatności listy faktur (P3)
    stosuje te warunki przez PostgREST (`receivableBaseFilterOps`) bez
    warunku dzieci — PostgREST nie wyrazi NOT EXISTS na wierszu rodzica, więc
    oryginał z korektą zostaje w wyniku filtra z „—” w kolumnie płatności
    (E3, przegląd C1).
12. **Koszty** czytamy jedną drogą, tak jak `/przeplywy` i eksport
    (`fetchExpensesForExport` w `lib/exports/data-fetcher.ts`): `expenses`
    z `is_deductible = true` → `readCompletePages` →
    `filterExpensesForKsefEnvironment` → `assertKsefExpensesReadyForPln`.
    Kwota kosztu = `kpirCostAmount` (netto + VAT bez prawa do odliczenia).
    Kwota wypływu = `gross_amount` z TEGO SAMEGO zbioru. VAT do odliczenia
    = `vat_deductible_amount` tylko dla `document_type`
    z `VAT_DEDUCTIBLE_DOCUMENTS` (`lib/categorization/kpir-cost.ts`; ta sama
    reguła co w JPK_V7M). Faktura `incoming` i jej wydatek to jeden koszt
    (00121), więc nigdy nie sumuj obu. E4 wyciąga to do
    `lib/dashboard/costs.ts` z testem (paragon, koszt KSeF w EUR bez kursu,
    `is_deductible = false`, inne środowisko). P1, P2, P8, P10 i N3 tylko ją
    importują.
13. **Pozycje faktur (rankingi):** `invoice_line_items` złączone (`!inner`)
    z fakturami z pkt 2, czytane przez `readCompletePages`, **tylko
    `invoice_kind IN ('regular','final')`**. Zaliczki pomijamy, bo ich
    wartość jest w pozycjach ROZ albo czeka na ROZ. Korekty pomijamy. Podpis
    karty: „Bez korekt i nierozliczonych zaliczek”. Grupowanie po
    `lower(trim(name))` + `unit`. Test: zaliczka 1 000 zł + ROZ 3 000 zł na
    tę samą usługę daje 3 000 zł, nie 4 000 zł; korekta `before_after`
    10 → 9 szt. nie dodaje sprzedaży.
14. **Wpłaty:** stron nie zasilamy z `payments` ani `payment_imports`.
    Wpływy to `invoices.paid_amount > 0` faktur sprzedaży z pkt 11 według
    `paid_at`, czyli dnia potwierdzenia, nie przelewu — z warunkami
    faktury z pkt 11, ale **bez warunku dzieci i bez warunku
    `payment_status`**. Wpłacone pieniądze nie znikają, gdy faktura dostanie
    korektę, a ROZ płaci resztę po zaliczkach, więc wpłata zaliczki i wpłata
    ROZ to osobne wpływy (E3, przegląd C2: zaliczka 1 000 zł + ROZ
    3 000 zł = 4 000 zł). Wzór: `paidThisMonth` w `lib/invoices/list-stats.ts`. Podpis karty:
    „według oznaczonych wpłat”. Gdy w okresie nie ma żadnej opłaconej
    faktury, pokazujemy pusty stan „Oznaczaj wpłaty, a pokażemy wpływy”,
    nigdy „0 zł”. Daty `paid_at` nie porównujemy z terminem płatności.
15. **Jedna karta = jedno źródło awarii.** Strażniki z pkt 2, 6 i 7 RZUCAJĄ
    wyjątek (faktura w EUR, przyjęta faktura bez środowiska, niepełna
    strona). Każda karta z danymi to osobny asynchroniczny Server Component,
    który sam pobiera dane. Owijamy go w `<Suspense>` i `SectionErrorBoundary`
    (`components/dashboard/section-error-boundary.tsx`) z komunikatem dla tej
    jednej karty: treść wyjątku, np. „Przyjęte faktury wymagają uzgodnienia
    środowiska KSeF”, i link do `/przeplywy`. Strona `/dashboard` nie woła na
    swoim poziomie żadnej funkcji z §2.4, więc slot FLO działa także wtedy,
    gdy padną wszystkie karty. To samo dotyczy `/przeplywy` i `/analizy/*`.

Każda nowa funkcja agregująca dostaje test Vitest z danymi brzegowymi:
korekta, zaliczka z fakturą końcową, faktura w EUR, szkic, faktura
z innego środowiska KSeF, > 1000 wierszy (protokół napraw, AGENTS.md pkt 2).

---

## 3. Audyt Finory — strona po stronie (co jest w demo)

Werdykty: **BIERZEMY** = strona wchodzi prawie 1:1; **CZĘŚCIOWO** = bierzemy
wskazane karty; **ODPADA** = nie wchodzi, ewentualnie pojedynczy komponent.

| Strona Finory | Zawartość (tytuły kart z demo) | Werdykt → u nas |
|---|---|---|
| Szkielet | pasek boczny z grupami, nagłówek: wyszukiwarka „Type to search…”, paleta poleceń, dzwonek, przełącznik motywu, ustawienia/personalizacja, avatar; stopka | **BIERZEMY** (bez panelu personalizacji i bez „Buy Now”) |
| `/dashboard/finance` | Finance (3 serie w stosie: profit/income/expense, 7 miesięcy, bez legendy), Report (Monthly Avg; Total Profit / Income / Expense; View Report), kafel Total Orders (+22%, „Last 4 months”), kafel Total Profit (−16%, „Last One year”), Total Revenue (mini‑słupki), Impression (linia, +24%), Total visitors (Desktop/Tablet/Mobile), Top Products by Sales, Top Products by Volume, tabela użytkowników (filtry Role/Plan/Status, paginacja) | **BIERZEMY** → Pulpit (P1) |
| `/dashboard/cash-flow` | Cash Flow (Weekly/Monthly/Yearly), Savings goal (pierścień), Income this month, Expense this month, Top Cash Flow Sources, Upcoming Bills, Recent Activity, tabela Counterparty/Category/Amount/Status/Actions z filtrami | **BIERZEMY** → Przepływy (P2) |
| `/dashboard/net-worth` | Net Worth, Assets vs Liabilities, Liquidity Snapshot, Asset Allocation, Top Holdings, Liabilities, Net Worth Growth Rate, Debt Payoff Progress, tabela aktywów | **CZĘŚCIOWO** → 2 karty do Przepływów (P2) + wykres kołowy Asset Allocation do Analizy sprzedaży (P11) |
| `/transactions` | 4 kafle (Money In, Money Out, Net, Upcoming), tabela Date/Merchant/Group/Category/Account/Method/Amount/Status/Actions, filtry grup/kategorii/statusów, „+ Add Transaction” | **BIERZEMY** → Wydatki (P8) i Skrzynka KSeF (P9) |
| `/money-management/monthly-analytics` | kafle (Total spent, dzienna średnia, vs poprzedni miesiąc, top kategoria), Spend Trend, Spend by Category, Top Categories, Recent Expenses, Spending Streaks, Income vs Expense, Subscriptions, Daily Spend (mapa ciepła, 180 dni), wybór miesiąca | **BIERZEMY dwa razy** → Analiza kosztów (P10) i Analiza sprzedaży (P11) |
| `/money-management/budget` | Budget by Category, Budgeted vs Actual, Needs Attention, Upcoming Bills, Total Budget Used, Ideal/Actual Pace, Budget Adherence History | **ODPADA** (mikrofirmy nie budżetują; „Upcoming Bills” mamy z Cash Flow) |
| `/accounts` | kafle (saldo, liczba kont, portfele, zmiana), karty rachunków | **CZĘŚCIOWO, później** → Rachunki bankowe (P12, po imporcie wyciągów) |
| `/cards` | karty płatnicze | **ODPADA** |
| `/investments/*` (equities, F&O, crypto, mutual funds, bonds) | portfele, alokacje, Top Gainers/Losers, holdingi | **ODPADA**; bierzemy listy Top Gainers/Losers → Analiza sprzedaży (P11) |
| `/insurance-premiums`, `/emis` | ubezpieczenia, raty kredytów | **ODPADA** |
| `/invoices/list` | kafle (Clients, Invoices, Paid, Unpaid), tabela #/Status/Client/Total/Issued Date/Due/Balance/Actions, „Show 10”, „Create Invoice”, wyszukiwarka, filtr statusu | **BIERZEMY** → Faktury (P3) |
| `/invoices/view/[id]` | dokument (logo, sprzedawca, Invoice To, Bill To, pozycje Item/Description/Hours/Qty/Total, Salesperson, Subtotal/Discount/Tax/Total, Note) + prawa kolumna: Send Invoice / Download / Print | **BIERZEMY** → Podgląd faktury (P4) |
| `/invoices/create` | formularz wyglądający jak faktura + prawa kolumna Send Invoice / Save | **BIERZEMY wygląd** → Wystaw fakturę (P5) |
| `/invoices/recurring` | tabela ID/Client/Frequency/Next Run/Amount/Status/Actions, „+ New Recurring Invoice” | **BIERZEMY** → Faktury cykliczne (P6, **nowa funkcja**) |
| `/invoices/reminders` | tabela ID/Invoice/Client/Due Date/Remind On/Status/Actions, „+ New Reminder” | **BIERZEMY** → Przypomnienia (P7) |
| `/settings` | zakładki w lewej kolumnie: General, Profile, Security, Notifications, Connected Accounts, Privacy & Data | **BIERZEMY układ** → Ustawienia (P14) |
| `/login`, `/register`, `/forgot-password` | formularz po lewej (Google, Facebook, e‑mail), po prawej animowane tło ze znakami + karta z hasłem | **BIERZEMY** → (auth) (P15) |
| Landing Page | osobny szablon strony sprzedażowej | poza zakresem (D5) |

---

## 4. Docelowa mapa aplikacji

**Zasada: obecne adresy URL zostają** (zakładki, maile z linkami, PWA).
Nowe strony dostają nowe adresy.

```
PULPIT
  Pulpit                     /dashboard              ← Finance        (FLO w slocie, D4)
  Przepływy                  /przeplywy              ← Cash Flow (+2 karty Net Worth)
SPRZEDAŻ
  Faktury                    /invoices               ← Invoice List
  Wystaw fakturę             /invoices/new           ← Create Invoice
  Faktury cykliczne   NOWE   /invoices/recurring     ← Recurring Invoices
  Przypomnienia              /payments/overdue       ← Invoice Reminders
  Kontrahenci                /contractors            ← tabela z Invoice List
KOSZTY
  Wydatki                    /expenses               ← Transactions
  Skrzynka KSeF              /inbox                  ← Transactions
ANALIZY
  Analiza sprzedaży   NOWE   /analizy/sprzedaz       ← Monthly Analytics
  Analiza kosztów     NOWE   /analizy/koszty         ← Monthly Analytics
KSIĘGOWOŚĆ
  KPiR                       /reports/kpir           ← tabela z Transactions
  Eksport                    /reports/exports        ← karty z Settings/Accounts
  Import danych              /import-danych          (styl kart, bez zmian logiki)
BANK (etap późniejszy)
  Rachunki            NOWE   /bank                   ← Accounts
  Operacje bankowe    NOWE   /bank/operacje          ← Transactions
──────
Ustawienia                   /settings/*             ← Settings
```

Telefon i tablet: zostaje nasz dolny pasek
(`components/dashboard/bottom-nav.tsx`, pozycje bez zmian: Flo / Faktury /
Nowa / Miesiąc / Więcej), przestylowany tokenami Finory. **Jeden próg: `lg`
(1024 px).** W demo pasek boczny Finory zamienia się w szufladę dopiero
poniżej 1280 px (hook z `matchMedia('(max-width: 1279px)')`). Bez zmiany
między 1024 a 1279 px nie byłoby żadnej stałej nawigacji. W kodzie
z `../finora-src` ustaw próg hooka mobilnego na 1024 i klasę kontenera paska
na `lg:flex`. Dolny pasek zostaje `lg:hidden`. „Więcej” zostaje naszym
arkuszem z `bottom-nav.tsx`, przestylowanym na Finorę: sekcje
z `getDashboardMoreSections()`, Ustawienia, Pomoc (`OTWORZ_POMOC`)
i Wyloguj (`signOut`). To jedyne miejsce tych pozycji na telefonie. Poniżej
`lg` szuflada `Sidebar` Finory się nie montuje, a `SidebarTrigger` jest
ukryty, bo inaczej telefon dostaje dwa menu.

Nawigację zmieniasz w `lib/dashboard-nav-config.ts` (właściciel: §11).
**Zasada wpinania:** E2 wpina do menu i do ⌘K tylko trasy, które już istnieją
w `main`. Etap, który tworzy stronę (E7: `/analizy/*`, E9:
`/invoices/recurring`, Bank lokalnie), w tym samym PR dopisuje jej pozycję
w menu i w ⌘K. „Importuj wyciąg” wchodzi do ⌘K razem z N5.
W `isActiveNavPath` `/analizy/*` obsługuje już reguła ogólna. Zmieniasz trzy
rzeczy: `/invoices` NIE jest aktywne dla `/invoices/new/*` ani
`/invoices/recurring*`; `/invoices/new` jest aktywne także dla
`/invoices/new/*`; `/bank` jest aktywne tylko dla dokładnego adresu. Do tego
test Vitest na te przypadki. Strony z ciężkimi agregatami (`/analizy/*`,
`/bank/*`) wyłącz z `getDashboardPrefetchHrefs` i daj im `prefetch={false}`
w `NavRow` (pole `prefetch?: false` w `DashboardNavItem`).
Zmień typ `icon` w `DashboardNavItem` i `DashboardMobileTab` ze `string`
(ligatura) na komponent ikony Remix i renderuj `<Icon className='size-5' />`
w `Sidebar` i `BottomNav`. Material Symbols w pozostałych plikach zostaje do
etapu, który przerabia daną stronę, a we FLO na stałe (§11). Zmiana nazw
w menu oznacza, że ten sam PR poprawia nazwy ekranów w `content/help/*.mdx`,
skróty w `app/manifest.ts` i wpisy w `lib/support/contextual-help.ts`
(z nowymi trasami). Etykiety w `lib/flo/functions/*` („Przeterminowane”,
„Skrzynka odbiorcza”) zostają; wpisz je w opis PR jako zadanie dla toru
silnika.

---

## 5. Strona po stronie: karty, podpisy i dane

Konwencja: **[Finora] → [u nas, po polsku] · dane · uwagi**. Pusty stan
każdej karty: komunikat z §7.3, nigdy pusty wykres z osiami.

### P0. Szkielet (każdy ekran)

- Pasek boczny Finory z grupami z §4; logo FaktWay (`components/brand/brand-wordmark`).
- Nagłówek: przycisk zwijania menu · **paleta poleceń** w miejscu „Type to
  search…” („Szukaj lub przejdź… ⌘K”, §8 N4) · **dzwonek usuwamy** w E2, bo
  w aplikacji nie ma listy powiadomień (`DashboardOrgHeader` to wyłącznie
  przełącznik firmy) · **przełącznik firmy** (`OrgSwitcher`, nazwa + NIP)
  stoi widocznie w nagłówku Finory, przed przełącznikiem motywu, a na
  telefonie jako pigułka z arkuszem, jak dziś. Aktywna firma musi być zawsze
  widoczna · przełącznik motywu (nasz `ThemeToggle`) · avatar z menu:
  Ustawienia, Przełącz firmę (otwiera ten sam przełącznik), Wyloguj
  (`signOut`). „Profil” wylatuje (P14). Telefon: ikona lupy w nagłówku
  otwiera paletę N4, bo Finora chowa tam przycisk „Type to search…”.
- Wyrzucamy: panel personalizacji, „Buy Now”, linki stopki do shadcn/studio.
  Stopka: „© FaktWay · Regulamin · Polityka prywatności · Pomoc”.
- Banery (`KsefHealthBanner`, weryfikacja, brak firmy) zostają nad treścią
  strony, w stylu `Alert` Finory.
- Wszystko z `layout.tsx` (IdleWatcher, InstallPrompt, SupportWidget,
  AnalyticsIdentify, prefetch) zostaje.

### P1. Pulpit `/dashboard` ← Finance

Siatka Finory bez zmian.

**Slot FLO (od `lg`).** Pełna szerokość nad siatką, kontener o stałej
wysokości `h-[min(640px,70dvh)]` z `overflow-hidden`
w `app/(dashboard)/dashboard/page.tsx` (to nie jest plik FLO). W środku te
same trzy gałęzie co dziś (`!agent.ok` / brak propozycji / `FloScreen`),
z tymi samymi propsami. Wątek FLO przewija się w sobie, strona pod nim
normalnie. Szyna 320 px w `FloScreen` (Zatwierdzone, historia) zostaje.
Do `aside` trafia tylko `DashboardVerificationBanner` w wariancie `rail`.
`MonthlyFiguresCard` wylatuje, baner certyfikatu zostaje, więc zostaje też
reguła chowająca `.ff-shell-banner` od `lg`. Blokadę przewijania
(`DashboardRouteFlags` i reguły `html.ff-route-dashboard .ff-shell-scroll`
w `globals.css`) E4 ogranicza do `max-width: 1023.98px`. W gałęzi awarii
tekst „Liczby miesiąca obok są aktualne” zmień na „Liczby miesiąca są
w kartach poniżej”. Na 1440×900 górna krawędź pierwszego rzędu kart ma być
widoczna bez przewijania. **Poniżej `lg`** `/dashboard` zostaje
pełnoekranowym FLO jak dziś, z blokadą. Siatka Finance jest tam ukryta
(`hidden lg:grid`), a liczby miesiąca na telefonie są na `/przeplywy` (P2).
O innym miejscu siatki na telefonie decyduje Bartosz. Jeśli FLO wygląda źle
w tej wysokości, zgłoś to Masłu i nie ruszaj `components/flo/*`. Przed E4
przeczytaj `docs/flo/UKLAD-DASHBOARDU.md` i zaktualizuj go w tym samym PR.

Karty buduj według §2.4 pkt 15.

| Karta Finory | U nas | Dane |
|---|---|---|
| Finance („Yearly report overview”, 3 serie w stosie, bez legendy) | **Przychody i koszty** · „Ostatnie 12 miesięcy” | sprzedaż netto: `getSalesSeries` z nowymi parametrami opcjonalnymi `{ months = 6, withPrevYear = true }`, która zwraca też per miesiąc `net` i `vat` (`remainder(…, 'net' \| 'vat')`) z tych samych wierszy. Wywołanie bez parametrów zwraca dokładnie to co dziś (brutto, 6 mies. + rok wcześniej), więc `SalesChartCard` i jego testy się nie zmieniają. Pulpit woła `{ months: 12, withPrevYear: false }` i bierze `net`. Koszty: §2.4 pkt 12 (`kpirCostAmount`). Dwie serie OBOK SIEBIE, nie w stosie: w `BarChart` usuń `stackId` (to konfiguracja, nie siatka). Kolory `chart-1` (przychody) i `chart-5` (koszty), bo w niebieskich presetach `chart-3` i `chart-4` prawie się nie różnią. Dodaj `ChartLegend` z podpisami „Przychody netto” / „Koszty”. Przy 12 grupach `barSize` ≤ 10. Jeśli słupek wyjdzie węższy niż 6 px, pokaż 6 miesięcy i zmień podpis. Testy: wywołanie bez parametrów = dziś; okno przez przełom roku; ROZ z zaliczką sprzed okna; „Zysk” miesiąca na Pulpicie = „Dochód” tego miesiąca na `/przeplywy` dla tych samych danych |
| Report („Monthly Avg.”, Total Profit / Income / Expense, „View Report”) | **Ten miesiąc** · „Średnio miesięcznie: X zł” · Zysk / Przychody / Koszty · przycisk **„Zobacz przepływy”** → `/przeplywy` | `getMonthlyFigures` + koszty miesiąca z §2.4 pkt 12. Średnio miesięcznie = średnia `net` z 11 pełnych miesięcy, bez bieżącego |
| Kafel Total Orders (+22%, „Last 4 months”) | **Faktury** · % vs poprzedni · plakietka „Ten miesiąc” (okres niesie plakietka, jak „Last 4 months” u Finory) | `getMonthlyFigures().acceptedCount` / `prevAcceptedCount`; % tylko przy `hasPrevMonth = true`, inaczej podpis „Brak poprzedniego miesiąca” (`momCountPct` zwraca wtedy 0) |
| Kafel Total Profit (−16%, „Last One year”) | **Należności** · „X faktur nieopłaconych” | §2.4 pkt 11 |
| Total Revenue (mini‑słupki, w Finorze 5 × 2 serie, %) | **Przychód netto** · mini‑słupki 6 mies. · % vs poprzedni | `getSalesSeries(…).net`, ostatnie 6 z 12 miesięcy |
| Impression (linia, „Last year”, +24%) | **VAT należny** · linia, „6 mies.” | `getSalesSeries(…).vat`, czyli dokładnie ta liczba, którą `VatSummaryCard` pokazuje dla bieżącego miesiąca · stopka: termin VAT z `getMonthlyFigures`. Bez VAT naliczonego i bez „do zapłaty”. **Firma zwolniona podmiotowo** (`isSubjectiveVatExemption`) widzi w tym miejscu **Limit zwolnienia z VAT**: linia sprzedaży narastająco od 1 stycznia + pozioma linia limitu, kwota „X zł z 240 000 zł”, stopka z prognozą daty przekroczenia — dane jak w P2 („Savings goal”) |
| Total visitors (Desktop/Tablet/Mobile + słupki) | **Należności według terminu** · Przed terminem / Do 30 dni po terminie / Ponad 30 dni po terminie (% kwoty) · przycisk „Szczegóły” → `/payments/overdue` | §2.4 pkt 11. Podziału „zapłacone w terminie / po terminie” nie robimy, bo `paid_at` to dzień potwierdzenia, nie przelewu (§2.4 pkt 14) |
| Top Products by Sales | **Najlepiej sprzedające się** · nazwa, j.m., kwota netto | §2.4 pkt 13, 12 mies., top 5 (GTU wylatuje, bo pozycje go nie mają) |
| Top Products by Volume (ilość + plakietka %) | **Najwięksi klienci** · nazwa, NIP, kwota netto, plakietka % zmiany | faktury `outgoing` z §2.4 pkt 2 po `buyer_nip`, 12 mies. vs poprzednie 12. Klucz `buyer_nip`, a gdy go brak `buyer_data->>name`; nabywcy B2C (`is_b2c`) jako jedna pozycja „Konsumenci” |
| Tabela użytkowników (filtry Role/Plan/Status) | **Ostatnie faktury** · Kontrahent / Numer / Brutto / Termin / Płatność / KSeF · bez filtrów: 5 ostatnich wierszy + „Wszystkie faktury” | `lib/invoices/list-query.ts` |

`MonthlyFiguresCard` znika z Pulpitu. Szkice (`draftCount`) idą jako dopisek
„+ N szkiców poza KSeF” na kafel „Faktury”, a termin VAT (`vatDueLabel`,
`daysToVatDue`) jako stopka karty „VAT należny”. Wykresu SVG na Pulpicie nie
ma: `SalesChartCard` stoi na `/przeplywy`.

### P2. Przepływy `/przeplywy` ← Cash Flow (+ 2 karty z Net Worth)

| Karta Finory | U nas | Dane |
|---|---|---|
| Cash Flow (Weekly/Monthly/Yearly, wpływy/wypływy) | **Wpływy i wydatki** · przełącznik Tydzień / Miesiąc / Rok · nagłówki „Wpłynęło” i „Wydano” | wpływy: §2.4 pkt 14; wydatki: `gross_amount` z §2.4 pkt 12 |
| Savings goal (pierścień 68%, „$6.8k of $10k”) | **Firma zwolniona z VAT → „Limit zwolnienia z VAT”** · pierścień = % wykorzystanego limitu · w środku „X zł z 240 000 zł” · podpis z prognozą („przy obecnym tempie limit skończy się ok. 14.11”) · kolor wg progów 60/80/90/100%. **Płatnik VAT → „Odłóż na podatek”** · w środku kwota z `estimateIncomeTaxThisYear` z jej zastrzeżeniami („szacunek od 1 stycznia”, „19% liniowy”), pierścień jako pełny łuk bez procentu (nie znamy kwoty już odłożonej) | Limit: **gotowe czyste funkcje** `vatLimitState`, `proratedLimit` (limit proporcjonalny, gdy firma ruszyła w trakcie roku), `forecast`, `THRESHOLDS` z `lib/flo/functions/vat-limit.ts` — tylko IMPORT, plik zostaje nietknięty (D4); kwota limitu `vatExemptionLimit` z `lib/flo/tax-params.ts` (240 000 zł od 1.01.2026). Jeśli import ciągnie kod serwerowy FLO do komponentu klienta — licz na serwerze i podaj do karty gotowy wynik. Wejście: sprzedaż netto faktur `outgoing` wg §2.4 (środowisko, korekty, zaliczki) z datą sprzedaży, z bieżącego roku. Test: firma założona w trakcie roku, korekta in minus, przekroczenie 100%. „Odłóż na podatek”: `estimateIncomeTaxThisYear` — **już liczone na tej stronie**, przenosimy z `CashFlowDashboard` |
| Income this month (+% vs last month) | **Wpłynęło w tym miesiącu** | jak wpływy wyżej |
| Expense this month | **Wydano w tym miesiącu** | jak wydatki wyżej |
| Top Cash Flow Sources (lista z +/− i paskami) | **Skąd i dokąd płyną pieniądze** · top 5: klienci (+), dostawcy (−) | klienci (+): opłacone faktury po nabywcy (§2.4 pkt 14); dostawcy (−): wydatki z §2.4 pkt 12 po `seller_nip` |
| Upcoming Bills („Next 30 days”, „Due in X days”) | **Spodziewane wpływy** · „Najbliższe 30 dni” · „za X dni” | należności z §2.4 pkt 11 z `payment_due_date` od dziś do +30 dni (Europe/Warsaw), kwota `outstandingOf` |
| Recent Activity | **Ostatnie operacje** | ostatnie faktury z `paid_at` + ostatnie wydatki z §2.4 pkt 12, 5 pozycji |
| Tabela Counterparty/Category/Amount/Status/Actions | **Wszystkie operacje** · Kontrahent / Kategoria / Kwota / Status · filtry „Kategoria”, „Status” | jak wyżej, paginacja Finory |
| Net Worth → Assets vs Liabilities | **Należności** · „Przed terminem / po terminie” | dwie kwoty z §2.4 pkt 11 |
| Net Worth → Liquidity Snapshot | **Zaległości** · „Po terminie: X% należności” | iloraz dwóch liczb wyżej; przy zerowych należnościach pusty stan |
| — (zostaje nasze) | **Podsumowanie VAT** | `VatSummaryCard`, sama treść bez zmian |

**Układ:** rzędy Cash Flow zostają bez zmian. Przed tabelą „Wszystkie
operacje” dochodzi jeden rząd skopiowany z pierwszego rzędu strony Net Worth.
Po lewej karta szerokości karty Net Worth z **Podsumowaniem VAT**. Po prawej
kolumna z dwiema kartami połówkowej wysokości (jak Assets vs Liabilities
i Liquidity Snapshot): **Należności** u góry, **Zaległości** na dole.
**Faktury kosztowe z KSeF nie mają w bazie terminu płatności ani statusu
zapłaty** (`inbox-polling` zapisuje same metadane, a `payment_status` ma
domyślne `'unpaid'`). Dlatego kart „Nadchodzące płatności”, „Zobowiązania”
i „Płynność” nie budujemy (N7).

Poniżej `lg`, nad siatką Przepływów, stoją karty P1 „Ten miesiąc”
i „Przychody i koszty” (te same komponenty, `lg:hidden`). Na telefonie Pulpit
to sam FLO, a „Miesiąc” w dolnym pasku prowadzi tutaj. `MonthlyFiguresCard`
i `SalesChartCard` usuwasz w E5 dopiero wtedy, gdy ich liczby (przyjęte,
szkice, VAT należny, sprzedaż brutto, termin VAT) są w tych kartach.

### P3. Faktury `/invoices` ← Invoice List

- Kafle: Clients / Invoices / Paid / Unpaid → **Kontrahenci** / **Faktury
  w tym miesiącu** / **Opłacone** (kwota) / **Do zapłaty** (kwota,
  §2.4 pkt 11).
- Pasek: „Show 10” → „Pokaż 10” · „Create Invoice” → **„Wystaw fakturę”**
  (→ `/invoices/new`) · „Search by ID or client” → „Szukaj po numerze lub
  kontrahencie” · filtr statusu „All” → „Wszystkie” + **„Status KSeF”**,
  **„Rodzaj”** (VAT / zaliczkowa / korygująca / końcowa).
- Kolumny: ID → **Numer** (`internal_number`) · Status (ikona) → **Płatność**
  (ikona z `payment_status` i daty: opłacona; termin minął → po terminie;
  w pozostałych przypadkach nieopłacona) + plakietka **KSeF**
  (`ksef_status`) · Client (avatar + nazwa + podpis) → **Nabywca** (inicjały
  firmy + nazwa + NIP; nie zdjęcia) · Total → **Brutto** · Issued Date →
  **Wystawiona** · Due → **Termin** · Balance → **Do zapłaty**
  (`outstandingOf` z `lib/invoices/amount-due.ts`; 0 = plakietka
  „Opłacona”). Kolumna „Do zapłaty” i ikona płatności tylko dla faktur
  spełniających §2.4 pkt 11 (bez warunku statusu). Szkice, importy, korekty
  i faktury w walucie obcej dostają „—”, nigdy plakietkę „Opłacona”. ·
  Actions → **Podgląd, PDF, ⋯**. W menu: **Korekta** →
  `/invoices/new/correction?parentId=<id>`, tylko dla faktur, które formularz
  korekty przyjmuje (warunki z `new/correction/page.tsx`); **Pobierz XML**;
  **Usuń** tylko dla szkicu. „Oznacz jako zapłaconą” nie istnieje (N6).
  „Duplikuj” i „Ustaw jako cykliczną” dodaje E9 (N1).
- **Kosz z akcji Finory: tylko dla szkiców.** Faktury wysłanej do KSeF nie
  usuwamy nigdy.
- Zaznaczanie wierszy + „Pobierz PDF zaznaczonych” (`batch-pdf-download`).
- Dane: `lib/invoices/list-query.ts` (filtry i paginacja na serwerze).
  Rozszerz go (czyste funkcje + test w `tests/unit/lista-faktur-filtry.test.ts`,
  w PR E3) o parametry adresu: `platnosc` (`oplacone` / `nieoplacone` /
  `po_terminie`; ten ostatni z daty: `payment_due_date < dziś`
  w Europe/Warsaw i `payment_status <> 'paid'`), `rodzaj` (`invoice_kind`)
  i `na_stronie` (10/25/50, domyślnie 50, żeby stare linki działały).
  Obecne parametry (`q`, `status`, `od`, `do`, `strona`) się nie zmieniają.
  Filtry i „Pokaż 10” Finory sterują adresem przez `invoiceListHref`, nie
  stanem w przeglądarce.
- Telefon: karty jak dziś (§7.2).

### P4. Podgląd faktury `/invoices/[id]` ← View Invoice

- Lewa kolumna = dokument w układzie Finory, treść jak polska faktura:
  logo + dane sprzedawcy · **Faktura VAT nr …** · Data wystawienia, Data
  sprzedaży, Termin płatności · **Nabywca** (nazwa, adres, NIP) zamiast
  „Invoice To” · „Bill To” → **Płatność** (do zapłaty, forma, rachunek, MPP
  jeśli jest) — SWIFT tylko dla walut obcych · pozycje: **Lp. / Nazwa /
  Ilość / J.m. / Cena netto / VAT / Netto / Brutto** · podsumowanie per
  stawka VAT, Razem netto / VAT / **Brutto** · „Note” → **Uwagi** ·
  **Numer KSeF** i kod QR (jeśli faktura je ma) · „Salesperson” wylatuje.
- Prawa kolumna: Send Invoice / Download / Print → **Wyślij e‑mailem /
  Pobierz PDF / Drukuj**, a pod nimi istniejące akcje i panel statusu KSeF
  z `invoice-detail-view`. Istniejące akcje: Pobierz PDF, Wyślij e‑mailem
  (`EmailInvoiceButton`), Pobierz XML, wysyłka i usunięcie szkicu, UPO,
  decyzja o duplikacie KSeF (440), komunikat błędu KSeF; plus link Korekta
  jak w P3. „Drukuj” otwiera PDF z `/api/invoices/[id]/pdf` w nowej karcie.
  Dokumentem jest PDF, a `window.print()` wydrukowałby szkielet panelu. Kod
  QR w podglądzie to KOD I z `lib/ksef/qr-verification.ts`, ten sam co
  w PDF (`lib/ksef/qr-codes.ts` to podpisany KOD II dla faktur offline, poza
  ścieżką produkcyjną; poprawione w E3). Telefon (poniżej
  `lg`): plakietka statusu KSeF i główna akcja („Wyślij do KSeF” albo
  „Pobierz UPO”) stoją NAD dokumentem (`order-first`), reszta prawej kolumny
  pod nim. **Logiki i zasad zgody nie zmieniamy** — przenosimy JSX.

### P5. Wystaw fakturę `/invoices/new/*` ← Create Invoice

- Formularz wygląda jak dokument (układ Finory): u góry sprzedawca +
  **Numer faktury** (podpowiedź z `suggestNextInvoiceNumberForTenant`, pole
  edytowalne, `id='internalNumber'` zostaje) + daty; niżej **Nabywca** (wyszukiwarka
  kontrahenta + NIP z GUS — istniejące); pozycje w wierszach jak w Finorze;
  podsumowanie po prawej na dole.
- Pola i walidacja zostają NASZE (RHF + Zod, GTU, MPP, VAT per pozycja,
  waluta/NBP, zaliczki, korekty, faktura końcowa). „Hours” → **Ilość + J.m.**,
  „Cost” → **Cena netto**, „Salesperson”, SWIFT, „Discount %” (jeśli go nie
  obsługujemy) — wylatują.
- Prawa kolumna: Send Invoice / Save → **„Wystaw i wyślij do KSeF”**
  (główny), **„Zapisz szkic”**, **„Podgląd”**.
- To najbardziej ryzykowny ekran — robi się go po stronach tylko do odczytu
  (sesja lokalna, §9). Każdy z 4 rodzajów (`regular`, `advance`, `correction`, `final`)
  musi przejść istniejące testy.

### P6. Faktury cykliczne `/invoices/recurring` ← Recurring Invoices — NOWE (N1)

- Kolumny: ID → **Szablon** (nazwa) · Client → **Kontrahent** · Frequency →
  **Częstotliwość** (co miesiąc / co kwartał / co rok) · Next Run →
  **Następne wystawienie** · Amount → **Kwota brutto wzoru** · Status →
  **Aktywna / Wstrzymana / Do wystawienia** · Actions: Generate now →
  **Wystaw teraz** (link z N1), Delete → **Usuń**, ⋯ → **Wstrzymaj/Wznów,
  Edytuj** (nazwa, częstotliwość, dzień, wzór; nigdy treść faktury‑wzoru).
- „+ New Recurring Invoice” → **„+ Nowa faktura cykliczna”** (tworzy się
  z istniejącej faktury: wybór faktury-wzoru spełniającej warunki z N1 +
  częstotliwość + dzień).
- Baner na `/invoices`: „N faktur cyklicznych czeka na wystawienie” (N1).

### P7. Przypomnienia `/payments/overdue` ← Invoice Reminders

- Wiersz = faktura po terminie (jak dziś z `invoices_overdue`, warunki
  z §2.4 pkt 11). Nad tabelą kafle w stylu P3: **Po terminie** (kwota),
  **Faktur po terminie**, **Przypomnień wysłanych w miesiącu**,
  **Wstrzymanych** (`reminders_paused = true`).
- Kolumny: ID → (bez) · Invoice → **Faktura** · Client → **Kontrahent** · Due
  Date → **Termin płatności** · Remind On → **Przypomnienie** (ostatni wpis
  z `payment_reminders` tej faktury: `scheduled_for` + etap 1–4) · Status →
  **Zaplanowane / Wysłane / Nieudane / Anulowane**. Kolumny „Kanał” nie ma,
  dopóki nie ma SMS. Actions → **Przygotuj przypomnienie** (istniejący
  podgląd i `ReminderConsentDialog`; zgoda zostaje) oraz **Wstrzymaj /
  Wznów** (`toggleInvoiceRemindersAction`). „Wyślij teraz” bez okna zgody,
  osobne „Wezwanie do zapłaty (PDF)” i planowanie na wybraną datę wylatują.
  PDF wezwania jest załącznikiem etapu (`lib/reminders/prepare-delivery.ts`),
  a terminy wyznacza `cron.reminder-scheduler`.
- „+ New Reminder” → **„Ustawienia przypomnień”** → `/settings/reminders`
  (tylko dla właściciela).
- Dane: `invoices_overdue`, `payment_reminders`, logika i zabezpieczenia
  z `components/reminders/overdue-dashboard` i `lib/reminders/*` bez zmian.

### P8. Wydatki `/expenses` ← Transactions

- Kafle: Money In / Money Out / Net / Upcoming → **Wydatki w miesiącu**
  (brutto) / **VAT do odliczenia** (`vat_deductible_amount`) / **Do opisania**
  (liczba `is_reviewed = false`) / **Stałe koszty** (N3). Kafle liczy osobne
  zapytanie z §2.4 pkt 12 dla miesiąca, nie lista (lista `/expenses` ma
  `limit(500)` i nie filtruje środowiska). „VAT do odliczenia” według reguły
  z §2.4 pkt 12.
- Telefon: karty jak dziś (§7.2).
- Kolumny: Date → **Data** · Merchant → **Sprzedawca** (nazwa + NIP) · Group →
  **Źródło** (KSeF / Zdjęcie / Ręcznie / Import) · Category → **Kategoria**
  (`category_label`) · Account → **Kolumna KPiR** (`kpir_column`) · Method →
  **Dokument** (rodzaj + numer) · Amount → **Brutto** · Status → **Opisany /
  Do opisania** · Actions → **Szczegóły, ⋯**.
- Filtry „All groups / categories / statuses” → **„Wszystkie źródła /
  kategorie / statusy”**. „+ Add Transaction” → **„+ Dodaj wydatek”**
  (istniejący `capture-button`, z aparatem na telefonie).

### P9. Skrzynka KSeF `/inbox` ← Transactions (ten sam komponent tabeli)

- Kafle: **Nowe faktury** (wydatek `is_reviewed = false`), **Faktury
  kosztowe w miesiącu** (brutto, §2.4 pkt 12), **Do opisania** (liczba),
  **Ostatnie pobranie z KSeF**.
- Kolumny: **Data wystawienia · Sprzedawca (NIP) · Numer · Numer KSeF ·
  Brutto · Status** (Nowa / Opisana) · Akcje. Kolumna „Termin płatności”
  wylatuje: termin i zapłata faktur kosztowych to N7.
- Telefon: karty jak dziś (§7.2).

### P10. Analiza kosztów `/analizy/koszty` ← Monthly Analytics — NOWE

| Karta Finory | U nas | Dane |
|---|---|---|
| Wybór miesiąca („October 2026”) | **„Październik 2026”** (nazwy miesięcy po polsku) | — |
| 4 kafle (Total spent, Avg daily, vs last month, top category) | **Wydano** / **Średnio dziennie** / **vs poprzedni miesiąc** / **Największa kategoria** | `expenses` w miesiącu (§2.4 pkt 12) |
| Spend Trend | **Trend wydatków**: 6 ostatnich miesięcy, jedna seria (jak w Finorze) | `expenses` po `issue_date` (§2.4 pkt 12) |
| Spend by Category | **Wydatki według kategorii** (top 5 + „Pozostałe”) | `category_label` |
| Top Categories (paski) | **Największe kategorie** | j.w. |
| Recent Expenses | **Ostatnie wydatki** | 5 ostatnich |
| Spending Streaks | **VAT z wydatków**: ten sam komponent (3 wiersze liczb): VAT naliczony w miesiącu / VAT do odliczenia (§2.4 pkt 12) / Dokumenty do opisania (`is_reviewed = false`). Siatka zostaje pełna. | §2.4 pkt 12 |
| Income vs Expense | **Przychody a koszty** · Przychody / Koszty / Wynik | jak P1 |
| Subscriptions | **Stałe koszty** · dostawca, średnia kwota, „zwykle około X dnia miesiąca” | N3 |
| Daily Spend (mapa ciepła, 180 dni) | **Kalendarz wydatków**: ostatnie 180 dni, mapa ciepła jak w Finorze, niezależnie od wybranego miesiąca | suma `expenses` na dzień |

### P11. Analiza sprzedaży `/analizy/sprzedaz` ← Monthly Analytics (drugi raz) — NOWE

Ten sam układ co P10, dane sprzedaży (faktury `outgoing` wg §2.4):

| Karta Finory | U nas |
|---|---|
| 4 kafle | **Sprzedano** / **Średnio na fakturę** / **vs poprzedni miesiąc** / **Najlepszy klient** |
| Spend Trend | **Trend sprzedaży**: 6 ostatnich miesięcy, jedna seria (jak w Finorze) |
| Spend by Category | **Sprzedaż według produktów** (§2.4 pkt 13, top 5 + „Pozostałe” w kolorze `muted-foreground`, jak w Finorze). „Pozostałe” = suma pozostałych pozycji, NIE sprzedaż ogółem minus top 5 |
| Top Categories | **Najlepsze produkty i usługi** |
| Recent Expenses | **Ostatnie faktury** |
| Spending Streaks | **Należności**: 3 wiersze: Do zapłaty / Po terminie / Najstarsza zaległość (dni), z §2.4 pkt 11 |
| Income vs Expense | **Przychody a koszty** |
| Subscriptions | **Stali klienci** — fakturowani w ≥ 3 z ostatnich 4 miesięcy; przy każdym przycisk **„Zrób fakturę cykliczną”** → N1 (przycisk dodaje E9) |
| Daily Spend | **Kalendarz sprzedaży**: ostatnie 180 dni, mapa ciepła jak w Finorze, niezależnie od wybranego miesiąca |
| + Asset Allocation (z Net Worth) | **Udział klientów w przychodach** (wykres kołowy, top 5 + „Pozostali”); gdy jeden klient > 50% — podpis „Uwaga: jeden klient to ponad połowa przychodu” |
| + Top Gainers / Top Losers (z inwestycji) | **Klienci: rośnie / spada** — zmiana sprzedaży 3 mies. vs poprzednie 3 |

Te trzy karty idą osobnym rzędem 3 × 1/3 pod siatką, jak rząd
Watchlist | Top Gainers | Top Losers na `/investments/equities`: **Udział
klientów w przychodach** | **Klienci: rośnie** | **Klienci: spada** (Top
Gainers i Top Losers to dwie osobne karty). Klient we wszystkich kartach
klientów (Najlepszy klient, Udział, rośnie / spada, Stali klienci): klucz
`buyer_nip`, a gdy go brak `buyer_data->>name`; nabywcy B2C (`is_b2c`) jako
jedna pozycja „Konsumenci”. Karty produktów mają podpis „Bez korekt
i nierozliczonych zaliczek” (§2.4 pkt 13).

### P12. Bank `/bank`, `/bank/operacje` ← Accounts + Transactions — NOWE (N5, etap późniejszy)

- `/bank` (układ Accounts): kafle **Wpływy w miesiącu / Wypływy / Rachunki /
  Niedopasowane operacje**; karty rachunków (`account_iban`, `bank_name`,
  liczba operacji, data ostatniego importu). „Add Account” → **„Importuj
  wyciąg”**.
- `/bank/operacje` (układ Transactions): **Data · Kontrahent · Tytuł ·
  Rachunek · Kwota · Dopasowanie** (Dopasowano do FV … / Do sprawdzenia /
  Pominięte) · Akcje: **Potwierdź, Zmień fakturę, Pomiń**.
- Salda Finory wylatują — wyciąg nie daje pewnego salda.
- Dostęp do danych (job z `service_role`, RPC `SECURITY DEFINER`),
  potwierdzenie przed zapisem wpłaty i duplikaty: N5. Baner na `/bank`
  i `/payments/overdue`: „Przypomnienia ruszą DD.MM HH:MM — sprawdź nowe
  wpłaty z wyciągu”.

### P13. Kontrahenci, KPiR, Eksport, Import

- **Kontrahenci** — tabela i kafle z P3: kafle **Kontrahenci / Aktywni
  (90 dni) / Z zaległościami / Status VAT do sprawdzenia**. „Aktywni
  (90 dni)” to kontrahenci z co najmniej jedną fakturą z §2.4 pkt 2
  w ostatnich 90 dniach (po `buyer_nip`), nie z `last_used_at`. „Z
  zaległościami” to liczba kontrahentów z fakturą po terminie z §2.4 pkt 11.
  Kolumny: **Nazwa · NIP · Status VAT · Należności** (§2.4 pkt 11, po
  `buyer_nip`) · **Po terminie** (liczba faktur kontrahenta po terminie,
  §2.4 pkt 11) · Przypomnienia (przełącznik) · Akcje. „Śr. czas zapłaty”
  i „Spóźnienia” wylatują: kolumny w bazie są puste (00023), a ocena
  terminowości konkretnego kontrahenta to K-03 (`payment.score`), wstrzymana
  do opinii prawnika. Logika z obecnej strony bez zmian. Telefon: karty jak
  dziś (§7.2).
- **KPiR** — tabela Transactions: **Lp. · Data · Nr dowodu · Kontrahent ·
  Opis · Kolumna · Kwota**; logika `kpir-view` bez zmian.
- **Eksport** i **Import danych** — karty z ikonami w stylu Accounts; logika
  bez zmian.

### P14. Ustawienia `/settings/*` ← Settings

Układ Finory (zakładki po lewej, treść po prawej, sekcje „etykieta + opis po
lewej, kontrolka po prawej”), ale zakładki to `<Link>`
w `app/(dashboard)/settings/layout.tsx`, aktywne według `usePathname()`,
a nie stan komponentu. Menu ☰ na telefonie też składa się z linków. Adresy
`/settings/*` się nie zmieniają, bo prowadzą do nich maile (`TrialEnding`,
`PaymentFailed`), powrót ze Stripe i FLO. Listę zakładek liczy layout na
serwerze z roli (`getPageContext`), tak jak dziś `settings/page.tsx`:
Przypomnienia tylko właściciel, Zespół i Abonament właściciel albo
administrator.

| Finora | U nas (istniejąca trasa) |
|---|---|
| General | **Firma** (`/settings`: profil firmy, zwolnienie z VAT, metoda kasowa) |
| Profile | wylatuje (nie mamy profilu użytkownika) |
| Security | **Bezpieczeństwo** (`/settings/security`, MFA) |
| Notifications | **Powiadomienia** (`/settings/notifications`) |
| Connected Accounts | **KSeF** (`/settings/ksef`) + logowanie Google |
| — | **Przypomnienia** (`/settings/reminders`), **Księgowa** (`/settings/accountant`), **Zespół** (`/settings/team`), **Abonament** (`/settings/billing`), **FLO** (`/settings/flo` — tylko ramka, treść Masła), **Dziennik zdarzeń** (`/settings/audit`) |
| Privacy & Data | **Konto i dane (RODO)** = `/settings/account` (dziś „Konto i firma”: eksport z art. 15, usunięcie konta, usunięcie firmy) |

Usunięcie firmy zostaje w jednym miejscu: `DeleteAccountSection` znika
z `/settings`.

Wylatują z General: język, waluta, strefa czasowa, początek roku obrotowego
(zawsze PL / PLN / Europe/Warsaw / rok kalendarzowy).

### P15. Logowanie `(auth)` ← Login / Register / Forgot Password

- Lewa połowa: formularz Finory. „Login with Google” → **„Zaloguj przez
  Google”**; Facebook wylatuje; „Or continue with Email” → **„lub e‑mailem”**;
  „Remember me” wylatuje: nie mamy tej funkcji, a `IdleWatcher` wylogowuje po
  60 min bezczynności; „Forgot Password?” → **„Nie pamiętasz hasła?”**; „New
  on our platform? Create an account” → **„Nie masz konta? Utwórz konto”**.
- Prawa połowa: animowane tło Finory zostaje; karta z hasłem →
  **„Faktury w KSeF bez stresu. FLO pilnuje terminów, płatności i VAT‑u za
  Ciebie.”** (treść do akceptacji Masła). Do komponentu tła przekaż kolory
  z presetu D2 (Finora ma na sztywno zieleń `#5ee9b5`/`#00bc7d`/`#009966` na
  czarnym) i zestaw znaków z „zł” na początku. Na telefonie prawa połowa jest
  ukryta, więc slogan stoi nad formularzem, w jednej linii.
- Akcje serwerowe, MFA, Google OAuth i reset hasła są nasze i się nie
  zmieniają. `TurnstileWidget` zostaje w formularzach logowania, rejestracji
  i resetu hasła, bo akcje go weryfikują. Układ karty Finory dostają: `login`,
  `register`, `forgot-password`, `reset-password` (dziś bez `AuthPageShell`),
  `login/two-factor`, `login/two-factor/setup`, `gdpr/cancel`. Ekranów 2FA
  i nowego hasła Finora nie ma, więc składasz je z jej Card i Input.
  `styles/zova.css` zostaje (landing, 404, przerwa techniczna).

---

## 6. Słownik tłumaczeń (EN z Finory → PL)

| EN | PL | EN | PL |
|---|---|---|---|
| Dashboard | Pulpit | Finance | Przychody i koszty |
| Cash Flow | Przepływy | Report | Ten miesiąc |
| Transactions | Wydatki / Operacje | Monthly Analytics | Analiza |
| Invoices / Invoice List | Faktury | Create Invoice | Wystaw fakturę |
| View Invoice | Podgląd faktury | Recurring Invoices | Faktury cykliczne |
| Invoice Reminders | Przypomnienia | Send Invoice | Wyślij e‑mailem |
| Download / Print | Pobierz PDF / Drukuj | Save | Zapisz szkic |
| Invoice To / Bill To | Nabywca / Płatność | Item / Qty / Price | Nazwa / Ilość / Cena netto |
| Subtotal / Tax / Total | Razem netto / VAT / Razem brutto | Discount | Rabat |
| Balance / Total Due | Do zapłaty | Paid / Unpaid | Opłacona / Nieopłacona |
| Issued Date / Due Date | Wystawiona / Termin płatności | Client(s) | Kontrahent(ci) |
| Merchant | Sprzedawca | Counterparty | Kontrahent |
| Category / Group | Kategoria / Źródło | Status / Actions | Status / Akcje |
| Upcoming Bills | Spodziewane wpływy | Recent Activity | Ostatnie operacje |
| Top Cash Flow Sources | Skąd i dokąd płyną pieniądze | Savings goal | Limit zwolnienia z VAT / Odłóż na podatek |
| Income / Expense this month | Wpłynęło / Wydano w tym miesiącu | Income vs Expense | Przychody a koszty |
| Spend Trend | Trend wydatków | Spend by Category | Wydatki według kategorii |
| Top Categories | Największe kategorie | Subscriptions | Stałe koszty |
| Daily Spend | Kalendarz wydatków | Frequency / Next Run | Częstotliwość / Następne wystawienie |
| Monthly / Quarterly / Yearly | Co miesiąc / Co kwartał / Co rok | Weekly / Monthly / Yearly (przełącznik) | Tydzień / Miesiąc / Rok |
| Show 10 / Showing 1 to 10 of 25 entries | Pokaż 10 / Pozycje 1–10 z 25 | Previous / Next | Poprzednia / Następna |
| Search… / Type to search… | Szukaj… / Szukaj lub przejdź… ⌘K | All | Wszystkie |
| Details / View Report | Szczegóły / Zobacz przepływy | Settings / Security | Ustawienia / Bezpieczeństwo |
| Notifications / Connected Accounts | Powiadomienia / KSeF i połączenia | Privacy & Data | Konto i dane (RODO) |
| Welcome Back / Login / Sign up | Witaj ponownie / Zaloguj się / Utwórz konto | Last month / vs last month | Poprzedni miesiąc / vs poprzedni miesiąc |
| Light / Dark | Jasny / Ciemny | Log out | Wyloguj |

---

## 7. Formaty, długość tekstów, puste stany

### 7.1. Format liczb i dat
- Kwoty: `12 345,67 zł` (spacja nierozdzielająca) przez `formatPlMoney`.
  Kwoty czterocyfrowe są bez spacji (`1234,56 zł`), bo tak działa polski
  CLDR; NIE zmieniaj tego. W małych kaflach Pulpitu i na osiach wykresów
  używasz nowego helpera `formatPlCompactMoney` w `lib/format/pl.ts`
  („45,6 tys. zł”, „1,2 mln zł”), z pełną kwotą w `title` i testem Vitest.
  Nigdy `$` ani `K`.
- Daty: `17.10.2026`; miesiące słownie po polsku („październik 2026”);
  strefa `Europe/Warsaw` (`lib/format/warsaw-date.ts`).
- Liczebniki: `lib/i18n/plural.ts` (1 faktura / 2 faktury / 5 faktur).
- Procent zmiany: „+12%” zielony, „−8%” czerwony (minus typograficzny).

### 7.2. Długość tekstów
Polskie podpisy są o 20–40% dłuższe. Każdą kartę sprawdź na 375 px, 768 px
(tablet) i 1440 px; ucinamy wielokropkiem z `title`, nie łamiemy siatki.

**Tabele na telefonie:** tabela Finory tylko od `lg`. Poniżej `lg` zostaje
nasz wzorzec kart (`components/dashboard/responsive-table.tsx`; na liście
faktur `SwipeableInvoiceRow` z `invoice-list.tsx`), przestylowany kartą
Finory. Przewijanie tabeli w bok na 375 px to błąd, nie wygląd szablonu.

Nazwy kontrahentów w listach kart 1/3: jedna linia, `truncate` + `title`,
forma prawna skrócona („spółka z ograniczoną odpowiedzialnością” → „sp.
z o.o.”, „spółka akcyjna” → „S.A.”), bo KSeF daje pełne formy.

### 7.3. Puste stany (zamiast pustych wykresów)
- Brak danych w ogóle: „Pokażemy to, gdy wystawisz pierwszą fakturę” +
  przycisk „Wystaw fakturę”.
- Za mało danych na trend (< 2 mies.): wartość liczbowa bez wykresu
  + „Wykres pojawi się po drugim miesiącu”.
- Koszty bez KSeF: „Podłącz KSeF, a faktury kosztowe pobierzemy same”
  → `/settings/ksef`.
- Na `/invoices`, `/inbox` i `/contractors` zostają dzisiejsze puste stany
  (np. „Brak faktur wystawionych” z linkami „Wystaw pierwszą fakturę”
  i „Importuj historię”), bo pilnuje ich `e2e/tests/04-empty-states.spec.ts`.

---

## 8. Nowe funkcje (podpatrzone u konkurencji, pasują do ekranów Finory)

Kolejność = opłacalność. Każda to osobny PR z testami.

### N1. Faktury cykliczne (inFakt, wFirma, Fakturownia mają; my nie)
- **Zasada:** bez człowieka nic nie tworzy faktury ani szkicu. Szkic
  z wczorajszą datą nie wyjdzie do KSeF (`issueDateNotTodayError`, edycji
  szkicu nie ma), a numer zapisany przy szkicu psuje ciągłość serii. Pozycja
  cykliczna tylko **przypomina** i **wypełnia formularz**.
- **Migracja `00151_recurring_invoices`** (numer z rejestru), addytywna, więc
  „przed wdrożeniem”. Tabela `recurring_invoices`: `id`, `tenant_id`,
  `template_invoice_id` z kluczem `FOREIGN KEY (tenant_id,
  template_invoice_id) REFERENCES public.invoices (tenant_id, id)` (wzór:
  00121), `name`, `frequency` (`monthly` / `quarterly` / `yearly`; bez
  `weekly`, bo nie pasuje do `day_of_month`), `day_of_month` 1–28,
  `next_run_date`, `active`, `created_by`, znaczniki czasu. Do tego
  `UNIQUE (tenant_id, id)` i indeks `(tenant_id, active, next_run_date)`.
  `ENABLE ROW LEVEL SECURITY`, polityki SELECT/INSERT/UPDATE/DELETE
  z `tenant_id = public.get_current_tenant_id()` (z `WITH CHECK`), jawne
  `REVOKE ALL … FROM PUBLIC, anon` i `GRANT` dla `authenticated`
  i `service_role` (wzór: 00150, 00061). W `invoices` dochodzą dwie kolumny
  NULL: `recurring_invoice_id` (FK złożony do `recurring_invoices (tenant_id,
  id)`) i `recurring_period` (np. '2026-11'), z unikalnym indeksem
  częściowym `(tenant_id, recurring_invoice_id, recurring_period) WHERE
  recurring_invoice_id IS NOT NULL`. Test `tests/rls-faktury-cykliczne.test.ts`
  (izolacja firm i unikalność okresu) dopisz do `include`
  w `vitest.rls.config.ts`. Bez tego job CI „RLS isolation” go nie
  uruchomi.
- **Wzór:** tylko faktura `direction='outgoing'`, `origin='app'`,
  `invoice_kind='regular'`, `invoice_type='VAT'`, `ksef_status='accepted'`,
  w PLN. Sprawdza to akcja, która tworzy pozycję.
- **Stan „Do wystawienia”** liczy się przy odczycie: `active AND
  next_run_date <= dziś` (Europe/Warsaw). Pokazuje go P6 i baner na
  `/invoices` („N faktur cyklicznych czeka na wystawienie”). W wersji 1 nie
  ma crona ani joba.
- **„Wystaw teraz”** (P6) otwiera `/invoices/new/regular?cykliczna=<id>`.
  Formularz wypełnia nowa akcja `prefillFromInvoiceAction(invoiceId)`, czyli
  uogólnienie `prefillFromLastInvoiceAction` na wskazaną fakturę. Zasady są
  te same: bez numeru i bez dat. Numer podpowiada
  `suggestNextInvoiceNumberForTenant`, data wystawienia to dziś, termin to
  dziś + `days_to_payment` wzoru. Klient może poprawić treść i klika „Wystaw
  i wyślij do KSeF”. Zasada zgody się nie zmienia.
- **Idempotencja (zajęcie okresu):** zapis faktury z parametrem `cykliczna`
  wpisuje `recurring_invoice_id` i `recurring_period` w tym samym INSERT
  (`insertInvoiceAndLines`). 23505 na tym indeksie (odróżnij go po nazwie od
  `uq_invoices_tenant_internal_number`) daje komunikat „Faktura za ten okres
  jest już wystawiona: FV …”. Po zapisie idzie `UPDATE recurring_invoices
  SET next_run_date = <następna> WHERE id = $1 AND next_run_date = <stara>`.
  Jeśli ten UPDATE się nie uda, następna próba trafi w 23505 i sama
  przesunie `next_run_date`. Testy: dwa równoległe zapisy, ponowienie po
  zapisie faktury, ponowienie po nieudanym UPDATE. W każdym przypadku
  powstaje jedna faktura na okres.
- **Duplikuj** (P3) to link `/invoices/new/regular?wzor=<id>`: ta sama akcja
  podkładu, bez pozycji cyklicznej.
- **N1b (opcjonalnie, osobny PR):** przypomnienie e‑mailem albo pushem
  o pozycji „Do wystawienia”. Wtedy: kolumna `notified_for date` w migracji
  tego PR; cron `cron.recurring-invoices` (`0 6 * * *`, `tz: TZ`)
  w `CRON_JOBS` w `lib/jobs/queues.ts`; rejestracja w istniejącej paczce
  `lib/jobs/handlers/package-b.ts` (worker i test rejestru widzą ją bez
  nowych importów). Liczby w testach zmieniasz świadomie, z komentarzem,
  licząc od `main` w chwili rozgałęzienia: `tests/unit/jobs-foundation.test.ts`
  27 → 28, `tests/unit/jobs-registry.test.ts` paczka B 17 → 18 i KOMPLET
  48 → 49. Pozycję zajmuje `UPDATE … SET notified_for = next_run_date WHERE
  id = $1 AND notified_for IS DISTINCT FROM next_run_date RETURNING id`.
  Wysyła tylko zwycięzca, więc ponowienie nie wyśle drugi raz. W opisie PR
  napisz Bartoszowi, że kontrola po wdrożeniu w AGENTS.md (plik
  z CODEOWNERS) zmienia się na „28/28 cronów”.
- **UI:** P6. Przyciski „Ustaw jako cykliczną” (P3/P4), „Duplikuj” (P3)
  i „Zrób fakturę cykliczną” (P11) dodaje dopiero E9.

### N2. Analiza sprzedaży i kosztów
P10 i P11 — bez nowych tabel. Agregaty w `lib/analytics-finance/*.ts`
(czyste funkcje + test) zasilane przez istniejące zapytania i
`readCompletePages`. Jeśli strona robi > 3 zapytania po pełnej historii —
dopiero wtedy RPC w migracji.

### N3. Stałe koszty i stali klienci
Funkcja czysta: dostawca (`seller_nip`) z wydatkami (§2.4 pkt 12) w ≥ 3
z ostatnich 4 miesięcy = stały koszt (średnia kwota, typowy dzień). To samo
dla nabywców (`buyer_nip`) = stały klient; klucz klienta: `buyer_nip`, a gdy
go brak `buyer_data->>name`, nabywcy B2C (`is_b2c`) jako jedna pozycja
„Konsumenci”. Zasila P8, P10, P11.

### N4. Paleta poleceń ⌘K (Finora ma komponent)
Pozycje: trasy generowane z `dashboardNavSections` (więc ⌘K nie wskaże
trasy, której nie ma) + akcje „Wystaw fakturę” i „Dodaj wydatek” („Importuj
wyciąg” dopiero z N5) + wyszukiwanie faktur (numer, nabywca) i kontrahentów
(nazwa, NIP) przez istniejące zapytania listy, z opóźnieniem 250 ms.

### N5. Import wyciągu bankowego + automatyczne parowanie (inFakt, wFirma, iFirma mają)
- **Wyzwalacz już jest:** `recalculate_invoice_paid_amount` (00073) liczy
  `paid_amount` z `payments`, a `update_invoice_payment_status` (00145)
  ustawia status. Liczą się wpłaty z `is_auto_matched = false OR
  is_confirmed = true`, więc domyślne wartości kolumn (oba FALSE) ZALICZAJĄ
  wpłatę. Dlatego kandydat „Do sprawdzenia” NIE trafia do `payments`.
  Zostaje w `payment_imports` (`is_matched = false`, propozycja faktury
  w nowej kolumnie albo liczona przy odczycie). Wiersz w `payments` powstaje
  dopiero po kliknięciu „Potwierdź” (pojedynczo albo „Potwierdź dopasowane
  (N)”), z `is_confirmed = true`, `bank_import_id` i `match_method`. Potem
  emitujemy `invoicePaymentReceived`, którego dziś nikt nie emituje.
- **Dostęp:** `authenticated` nie ma do `payments` ani `payment_imports`
  żadnych uprawnień (00074). Zapis wyciągu robi job pg-boss z
  `service_role`, z tenantem z `requireUserAndActiveOrg` w payloadzie.
  Odczyt P12, potwierdzenie i pominięcie idą przez RPC `SECURITY DEFINER`
  z `public.get_current_tenant_id()`, w migracji z rejestru, z testem
  w `tests/rls-*.test.ts` dopisanym do `vitest.rls.config.ts`.
- **Duplikaty:** `transaction_id` to identyfikator z pliku, a gdy go brak,
  SHA‑256 z (IBAN, data księgowania, kwota, rachunek kontrahenta, tytuł,
  numer kolejny identycznej operacji w pliku). `provider` to `'csv_mbank'`,
  `'mt940'` itd. (domyślne `'gocardless'` nie pasuje). Zapis `ON CONFLICT
  (tenant_id, provider, transaction_id) DO NOTHING` i komunikat „Pominięto
  N operacji zaimportowanych wcześniej”.
- Parsery w `lib/import/bank/`: CSV mBank, PKO BP, ING, Santander, Pekao,
  Millennium + MT940. Każdy z plikiem przykładowym (zanonimizowanym)
  w testach.
- **Parowanie** tylko przy dokładnie jednej kandydatce i tylko dla uznań
  (`amount > 0`). Kwota = `outstandingOf` ORAZ numer faktury w tytule daje
  „Dopasowano do FV …”, które czeka na „Potwierdź”. „Do sprawdzenia”
  dostają: sam NIP albo rachunek bez numeru, kilka faktur na tę samą kwotę
  (faktury cykliczne!), a także kwota mniejsza od `outstandingOf` z numerem
  w tytule (propozycja wpłaty częściowej).
- **Blokada przypomnień:** import bez poprawnego NIP-u kontrahenta wstrzymuje
  przypomnienia firmy na 48 h (`lib/reminders/delivery-safety.ts`). Baner na
  `/bank` i `/payments/overdue`: „Przypomnienia ruszą DD.MM HH:MM — sprawdź
  nowe wpłaty z wyciągu”.
- UI: P12. To duży etap — **w chmurze tylko jeśli zostaje budżet**, inaczej
  pierwszy etap lokalny.

### N6. Do decyzji Bartosza (NIE robić bez zgody)
- Link do zapłaty na fakturze (BLIK / przelew online) — wymaga Stripe
  Connect i weryfikacji firm; poza budżetem tego planu.
- **Ręczne oznaczenie wpłaty poza FLO.** 00074 celowo zamknęło klientowi
  `payments`, więc decyduje Bartosz. Technicznie: migracja z RPC
  `record_manual_payment(p_invoice_id, p_amount, p_payment_date)`
  `SECURITY DEFINER`, z tenantem z `public.get_current_tenant_id()`, kwotą
  ≤ `outstandingOf`, wierszem z `is_confirmed = true` i `match_method =
  'manual'`, oraz test w `tests/rls-*.test.ts`. Alternatywa: `GRANT SELECT ON
  public.payments TO authenticated` (polityka SELECT już jest), też tylko
  za zgodą Bartosza. Dopiero po tej decyzji „Oznacz jako zapłaconą” wraca do
  P3/P4.
- Saldo VAT (należny − naliczony) — dozwolone (D7), ale wymaga zgodności
  z JPK_V7 (odliczenia, metoda kasowa), więc to osobny etap lokalny po E10.
  „Odłóż na podatek” i limit zwolnienia z VAT są już w P1/P2 (D7).

### N7. Termin i zapłata faktur kosztowych (do decyzji Bartosza)
Najprościej: `inbox-backfill`, po pobraniu XML, czyta
`Platnosc/TerminPlatnosci` (parser jest w `lib/import/fa3-parser.ts`,
`parsePlatnosc`, do wyeksportowania) i zapisuje `payment_due_date`.
Oznaczanie zapłaty kosztów przychodzi razem z N5 albo z RPC z N6. Dopiero po
N7 wracają karty „Nadchodzące płatności”, „Zobowiązania” i „Płynność”.

### Czego NIE robimy
Budżety, karty płatnicze, inwestycje, ubezpieczenia, raty, „Spending
Streaks” jako gra (komponent zostaje z inną treścią), panel personalizacji
motywu dla klienta, cokolwiek z NexaCRM.

---

## 9. Etapy, kolejność i budżet (103 $)

Jeden etap = jedna gałąź `claude/finora-eN-<temat>` od `origin/main` = jeden
PR. Szacunki są orientacyjne — po każdym etapie wpisz rzeczywiste zużycie.
Tabela jest w kolejności wykonania (numery etapów się nie zmieniają).

| Etap | Zakres | Gotowe, gdy | ~$ |
|---|---|---|---|
| **E0** | Plan: sklonuj `../finora-src`, spisz w §10 „Inwentarz Finory” (plik komponentu → karta z §5, zależności z `package.json`, `components.json`, preset z D2: dokładne zmienne CSS, font, mono dla liczb, ikony, prymitywy). Popraw ten plan, jeśli kod przeczy audytowi. PR tylko z dokumentem. | §10 wypełniony, decyzje E1 jasne | 4 |
| **E1** | Fundament: zależności Finory, `components/ui/*` Finory (wg §2.1, migracja na Base UI), `components/ui/chart.tsx`, font, **zmienne motywu z presetu z D2** w `app/globals.css`; stare `--ff-*` jako aliasy nowych zmiennych NA STAŁE (§11); usunięcie martwych efektów „glass” tylko jeśli nic ich nie używa. Nadpisania w `globals.css`, motyw i font: „Dodatki do zakresu etapów” niżej. | `pnpm run ci && pnpm build` zielone, wszystkie stare ekrany działają w nowych kolorach; `/admin` i `/onboarding` renderują się bez błędów (lista sprawdzonych stron w PR); `/admin` nie przechodzi na układ Finory; `/dashboard` w obu motywach: żadna ikona FLO nie wyświetla się jako słowo, kolory wątku bez zmian | 13 |
| **E2** | Szkielet P0 + nawigacja §4 (wpina tylko trasy istniejące w `main`) + dolny pasek + N4 (⌘K) + `error.tsx` / `loading.tsx` panelu (§2.2). Etap stoi na E1 (stos, „Wdrożenia”). Dodatki: niżej. | menu, nagłówek, telefon, ⌘K działają; trasy bez zmian; nowy szkielet zachowuje klasy `ff-dashboard` (korzeń), `ff-shell-scroll` (kontener treści) i `ff-shell-banner` (baner weryfikacji) oraz `DashboardRouteFlags`; do E4 `/dashboard` działa po staremu; `/dashboard` w obu motywach: żadna ikona FLO nie wyświetla się jako słowo, kolory wątku bez zmian; pasek akcji formularzy faktur, „Dodaj wydatek”, bąbelek pomocy i baner PWA stoją poprawnie przy pasku rozwiniętym i zwiniętym | 12 |
| **Punkt kontrolny** | Po E1+E2 sesja lokalna: Bartosz albo Masło ogląda panel (zob. niżej). | decyzja „idź dalej” do E3 | — |
| **E3** | P3 Faktury + P4 Podgląd faktury + `lib/dashboard/receivables.ts` (§2.4 pkt 11) + rozszerzenie `lib/invoices/list-query.ts`. Dodatki: niżej. | lista i podgląd w układzie Finory, wszystkie akcje działają; testy `receivables` i `lista-faktur-filtry` | 12 |
| **E4** | P1 Pulpit (z slotem FLO) + funkcje agregujące z testami + `lib/dashboard/costs.ts` (§2.4 pkt 12) + rozszerzenie `getSalesSeries` (P1). Poprzedza go osobny mały PR strefy czasowej (§2.4 pkt 10). | karty z danymi, puste stany, testy §2.4; konto bez certyfikatu KSeF widzi ostrzeżenie na `/dashboard` przy 1440 px i 375 px; test: faktura w EUR wyłącza karty sprzedaży, a slot FLO się renderuje | 12 |
| **E5** | P2 Przepływy. | wszystkie karty z §P2, stare komponenty usunięte; żadna liczba z obecnego `/przeplywy` nie znika; odczyt danych `/przeplywy` przeniesiony do funkcji w `lib/dashboard/` (np. `getCashFlowData`), asercje z `przeplywy-ksef-environment`, `przeplywy-kafelek-podatku` i `kpir-cost-nondeducted-vat` przepisane na tę funkcję. Stare komponenty usuwasz dopiero potem | 10 |
| **E6** | P8 Wydatki + P9 Skrzynka KSeF + N3 + `/expenses/[id]` (§2.2). | tabele, kafle, filtry | 9 |
| **E8** | P7 Przypomnienia + P13 Kontrahenci/KPiR/Eksport/Import + portal księgowej `/accountant/[token]` (§2.2). | układ Finory, logika bez zmian; odczyt `/reports/kpir` przeniesiony do funkcji, asercje `kpir-roz-zaliczki` przepisane na nią | 8 |
| **E10** | P14 Ustawienia + P15 Logowanie + onboarding i zaproszenie w stylu kart P15 (§2.2). | wszystkie zakładki i ekrany auth | 9 |
| **E7** (warunkowo) | P10 + P11 Analizy (N2) + pozycje `/analizy/*` w menu i ⌘K (§4). W chmurze tylko jeśli po E10 zostaje 10 $ + 3 $; inaczej pierwsza sesja lokalna. Nie wliczone do sumy niżej. | obie strony z danymi i testami | 10 |
| **E9** (warunkowo) | N1 Faktury cykliczne (migracja, `prefillFromInvoiceAction`, P6, przyciski „Duplikuj”, „Ustaw jako cykliczną”, „Zrób fakturę cykliczną”, pozycja w menu i ⌘K). Tak samo: w chmurze tylko jeśli zostaje budżet. Nie wliczone do sumy niżej. | faktura za okres powstaje najwyżej raz (testy z N1), test RLS na liście w `vitest.rls.config.ts` | 10 |
| **Lokalnie** | P5 Wystaw fakturę (ryzyko!), N5 Bank (P12), poprawki z przeglądu wizualnego Bartosza/Masła. | — | — |
| | **Rezerwa** na czerwone CI, aktualizację gałęzi (BEHIND) i poprawki z punktu kontrolnego | | 10 |
| | **Razem w chmurze** (E0–E6, E8, E10 + rezerwa) | | **~99** |

Najpierw domykamy wygląd istniejących ekranów, potem nowe strony. Nowa strona
nie tworzy stanu mieszanego, niedokończony stary ekran tak. Gdy budżet
topnieje szybciej, E7 i E9 przechodzą do sesji lokalnych. Jeśli zostanie
zapas, P5 idzie przed N5.

**Punkt kontrolny:** po E1+E2 Bartosz albo Masło ogląda panel lokalnie (jasny
i ciemny motyw; 375, 768 i 1440 px; obok demo Finory) i dopiero wtedy rusza
E3. Poprawki fundamentu idą osobnym PR przed E3. Dalej każdy etap ekranów
odbiera lokalnie Bartosz albo Masło przed scaleniem.

### Każdy PR etapu zawiera
1. Opis wg `.github/pull_request_template.md`: zakres, tabela weryfikacji,
   migracje „Do wgrania: …”. Sesja w chmurze NIE uruchomi panelu: proxy
   potrzebuje `NEXT_PUBLIC_SUPABASE_URL`, a każda trasa panelu wymaga
   zalogowanego użytkownika. Zrzutów nie robi i nie próbuje. Zamiast nich:
   test `renderToStaticMarkup` każdej nowej karty dla stanu z danymi i stanu
   pustego (wzór: `tests/unit/ui-responsive-table.test.tsx`; karta =
   komponent prezentacyjny z propsami + osobny loader danych) oraz w opisie PR
   tabela „karta → plik w `../finora-src` → nasz plik”. Wygląd sprawdza
   sesja lokalna.
2. Testy nowych funkcji danych (§2.4), `pnpm run ci && pnpm build` zielone.
3. Wiersz w dzienniku (§12) i nowy „Następny krok”.
4. **Testy istniejące.** Przed zmianą zrób `grep -l` po `tests/unit` dla
   każdego ruszanego pliku i wpisz listę tych testów do opisu PR. Testy
   pilnujące danych (`przeplywy-*`, `szczegoly-faktury-*`,
   `lista-faktur-filtry`, `overdue-*`, `ksef-*-environment`, `kpir-*`)
   przenosisz na nowy komponent bez osłabiania asercji. Wolno zmienić
   selektor albo ścieżkę w drzewie, nie warunek. Żaden przypadek testowy nie
   znika. Specy e2e (`e2e/tests/0*.spec.ts`, `e2e/pages/*`) poprawiasz
   w tym samym PR co ekran, bo CI pull requestów ich nie uruchamia
   (`e2e-staging.yml`: tylko ręcznie na `main`). Zmienione specy wypisz
   w opisie PR. `e2e/tests/flo-*` należą do Masła. Formularze auth zachowują
   `id='email'`, `id='password'`, przycisk „Zaloguj się” i przycisk
   rejestracji „Utwórz konto” (wzorzec w `e2e/pages/auth-page.ts`). Akcent
   z białym tekstem przycisku ma kontrast ≥ 4,5:1 (WCAG AA,
   `e2e/tests/06-accessibility.spec.ts`).
5. Na ekranach przeniesionych w etapie `rg -e 'rgba[(]15,10,30' -e 'white/55'
   -e backdrop-blur -e ff-glass-pane` daje 0 trafień; sprawdzone też
   w ciemnym motywie.

### Wdrożenia
E1 i E2 idą stosem (gałąź E2 od gałęzi E1) i Bartosz scala je razem jednym PR
„Scalenie E1, E2”. Pierwsza widoczna zmiana na produkcji to więc cały nowy
szkielet, a nie same kolory na starym układzie. `main` wdraża też plan zero
zgubionych faktur, więc pojedynczo scalony E1 poszedłby na produkcję
z najbliższą poprawką KSeF. Każdy kolejny etap przenosi cały ekran, więc stan
mieszany (część ekranów jeszcze w starym wyglądzie) jest akceptowalny. Flag
funkcji nie robimy. PR, który dotyka ścieżek z `.github/CODEOWNERS`
(`package.json`, `pnpm-lock.yaml`, `next.config.ts`, `supabase/migrations/`,
`lib/jobs/`, `lib/exports/`, `proxy.ts`, `app/admin/`), zaznacza to w opisie.
Jeśli commity sesji idą jako `claude[bot]`, agent-guard wymaga etykiety
`zgoda:obszar-wrazliwy` od Bartosza.

### Oszczędzanie
1. Kod Finory czytasz tylko z plików wskazanych w §10 dla danego etapu,
   nigdy całego katalogu. `app/globals.css` (1642 linie) czytasz fragmentami
   (`grep -n`, `sed -n`).
2. W trakcie pracy `pnpm typecheck` i `pnpm vitest run <plik>`. Pełne
   `pnpm run ci && pnpm build` raz przed PR, z wyjściem przez `| tail -40`.
3. Etapy mechaniczne (E1, E2, E3, E6, E8, E10) mogą iść na Sonnecie,
   a etapy z agregatami, migracjami i prawem VAT (E0, E4, E5, E7, E9) na
   Opusie (zasada Bartosza z 10.10.2026). Model ustawia Bartosz przy starcie
   sesji.

### Dodatki do zakresu etapów
- **E1, nadpisania w `app/globals.css`.** Reguły `.ff-dashboard
  [data-slot='card' | 'card-footer' | 'button']` (ok. linie 831–889)
  i `html:not(.dark) .ff-dashboard [data-slot='card' | 'card-footer']` (ok.
  1101–1112) usuń. Nadawały wygląd prototypu starym prymitywom, które E1
  wymienia, a bez usunięcia karta Finory traci obwódkę (`ring-1` to
  `box-shadow`). Reguły `html:not(.dark) .ff-dashboard [class*='…white/…']`
  (ok. 1119–1158) zmień na dopasowanie całej klasy, np.
  `[class~='bg-white/5']`, bo `*=` łapie też `dark:bg-white/5`
  i `dark:hover:…` z komponentów Finory. `tbody tr[class*='hover:bg-']:hover`
  ogranicz do `tbody tr:not([data-slot])`. Toaster w `app/layout.tsx`
  (`toastOptions` z `backdrop-blur` i `rgba(15,10,30,…)`) przestyluj na
  tokeny Finory już w E1, bo toasty widać na każdym ekranie.
- **E1, motyw i font.** Nie przenosimy `ThemeProvider` ani providera
  ustawień Finory, panelu Theme Customizer, ciasteczka
  `shadcn-next-admin-settings`, BroadcastChannel ani skrótu klawisza „d”
  (Finora przełącza nim motyw przy każdym „d” wpisanym poza polem
  tekstowym). Wartości presetu z D2 wpisz na sztywno do `:root` (jasny)
  i `.dark` w `app/globals.css`, 1:1 z obiektu `themePresets`
  w `../finora-src`. Komponenty Finory, które czytają ustawienia
  z kontekstu, dostają stałe z D2: układ `compact`, skala `sm`, wariant paska
  `inset`, pasek otwarty ze zwijaniem do ikon (`collapsible: 'icon'`). Gdzie
  ustawić skalę: §10.1. Motywem dalej rządzi `lib/theme/theme.ts` i nasz
  `ThemeToggle`. Komponent Finory, który woła `useTheme()`, przepnij na
  `readStoredTheme`/`applyTheme` albo na odczyt klasy `dark` z `<html>`.
  **Font:** tylko rodzina z presetu (+ jej mono), przez `next/font/google`
  z `subsets: ['latin', 'latin-ext']`. Reguły `--font-geist-sans`
  i `font-family` w `.ff-dashboard` (globals.css ok. 610–612) podmień na nią.
  Pozostałych fontów panelu personalizacji nie przenosimy. Kwoty, NIP‑y
  i numery zostają w foncie o stałej szerokości: reguła
  `.ff-dashboard .font-mono` zostaje, a gdy preset nie ma mono, zostaje IBM
  Plex Mono. Geist zostaje dla `styles/zova.css` (auth, 404, landing).
  **PWA:** po zmianie `--background` zaktualizuj `viewport.themeColor`
  w `app/layout.tsx` oraz `background_color` i `theme_color`
  w `app/manifest.ts` (jasny i ciemny). Po E1 zrób twarde przeładowanie
  z wolnym CPU w DevTools: pierwsza klatka ma kolory presetu, bez mignięcia
  innym motywem.
- **E2, rozmiary paska.** Pasek Finory ma 256 px (`--sidebar-width: 16rem`)
  i zwija się do ikon (`3rem`), a nasz token `--ff-sidebar-w` to stałe
  280 px od `lg`. Ustaw `--ff-sidebar-w` z `--sidebar-width` /
  `--sidebar-width-icon` według `data-state` wrappera paska, a
  `--ff-header-h` na wysokość nagłówka Finory. Przy pasku rozwiniętym
  i zwiniętym sprawdź: pasek akcji formularzy faktur (`.ff-sticky-actions`),
  „Dodaj wydatek”, bąbelek pomocy i baner instalacji PWA. Nie zmieniaj
  `animation … backwards` w `.ff-route-template`, bo `both` przypina paski
  `fixed` do pudełka trasy.
- **E3, podgląd faktury.** `invoice-detail-view.tsx` przenosimy przez
  opakowanie: nowy układ w `[id]/page.tsx`, środek bez zmian. Przed startem
  `gh pr list --state open`. Jeśli otwarty PR planu zero zgubionych faktur
  dotyka `components/invoices/*` albo `app/(dashboard)/invoices/*`, zapytaj
  Bartosza o kolejność.

---

## 10. Inwentarz Finory (E0, 17.10.2026, Finora 1.0.0)

Źródło: `ezior8888-cpu/faktflow-finora-src` @ `56394ef` (oryginał bez zmian).
Ścieżki niżej są względem katalogu klonu (`../finora-src` albo
`../faktflow-finora-src`). Kod Finory czytasz tylko z plików wskazanych dla
etapu (§9 „Oszczędzanie”).

### 10.1. Fundament (E1)

| Element | Wartość w Finorze | Co robi E1 |
|---|---|---|
| `components.json` | `style: 'base-lyra'`, `baseColor: 'mist'`, `iconLibrary: 'remixicon'`, `menuColor: 'default'`, `menuAccent: 'subtle'` | nasz `components.json` przestawić na te wartości (styl `base-lyra` daje ostre rogi: `rounded-none`, `text-xs`, przycisk `h-8`) |
| Prymitywy | **Base UI** `@base-ui/react` 1.5.0. W `src/components/ui` nie ma ani jednego `asChild` ani importu Radix; wywołania używają `render={<Link />}` z `nativeButton={false}` | migracja `asChild` → `render` (§2.1) |
| Ikony | **Remix Icon** `@remixicon/react` 4.9.0 (komponenty `Ri…`) | dodać |
| Wykresy | **recharts** 3.8.0 + `src/components/ui/chart.tsx` (ChartContainer, ChartTooltip, ChartLegend) | dodać |
| Paleta ⌘K | `cmdk` 1.1.1 przez `src/components/ui/command.tsx` | dodać (E2) |
| Tabele | `@tanstack/react-table` 8.21.3 | NIE dodajemy (decyzja E3, 17.10): tabela P3 stoi na prymitywach `ui/table` + stan z adresu; E6 i E8 robią tak samo |
| Daty w formularzach | `date-fns` 4.4.0, `react-day-picker` 10.0.1 (`ui/calendar.tsx`, `src/views/pages/invoices/invoice-date-field.tsx`) | dodać dopiero w etapie, który ich użyje (P5, filtry dat) |
| NIE dodajemy | `next-themes` (u nas jest w `package.json`, ale motywem rządzi `lib/theme/theme.ts`), `nuqs` (filtry przez adres i `invoiceListHref`), `zustand` i `src/store/*` (dane z serwera), `react-use` (tylko ciasteczko ustawień), `motion` (tylko listy z inwestycji; animację daje nasz `framer-motion`: `AnimatePresence` ma to samo API), `react-19-credit-card`, `geist` (Geist mamy z `next/font`) | — |
| `globals.css` Finory (247 linii) | `@import 'shadcn/tailwind.css'` (nasz `shadcn` 4.3.0 ma ten eksport), `@custom-variant dark (&:is(.dark *))` (zgodne z klasą `dark` z `lib/theme/theme.ts`), `@theme inline` z `--font-heading: var(--font-sans)` i skalą promieni od `--radius: 0.625rem`, klasy `.input-default/-lg/-sm`, odstępy przycisków `[data-slot='button'].h-9/.h-10:not(.px-6)`, kursory `cursor: pointer` dla przycisków, opcji i pozycji menu, reguły druku | przenieść te bloki; reguły `.rccs` (karty płatnicze) i `[data-theme-scale='lg']` pominąć |
| Nieużywane w Finorze | `ui/circular-progress.tsx`, `ui/bg-silk.tsx` (zero importów) | nie przenosić |

**Preset Modern Minimal** (`src/utils/theme-presets.ts`, linie 456–526).
Preset ma tylko kolory. **Nie ma kluczy `shadow-*`, `radius` ani fontów**, więc
`--radius` zostaje `0.625rem` z `globals.css` Finory, a cienie są z Tailwinda.
Wartości 1:1 (jasny → `:root`, ciemny → `.dark`):

| Zmienna | Jasny | Ciemny |
|---|---|---|
| `background` | `oklch(1.00 0 0)` | `oklch(0.20 0 0)` |
| `foreground` | `oklch(0.32 0 0)` | `oklch(0.92 0 0)` |
| `card` / `popover` | `oklch(1.00 0 0)` | `oklch(0.27 0 0)` |
| `card-foreground` / `popover-foreground` | `oklch(0.32 0 0)` | `oklch(0.92 0 0)` |
| `primary` | `oklch(0.62 0.19 259.76)` | `oklch(0.62 0.19 259.76)` |
| `primary-foreground` | `oklch(1.00 0 0)` | `oklch(1.00 0 0)` |
| `secondary` | `oklch(0.97 0 0)` | `oklch(0.27 0 0)` |
| `secondary-foreground` | `oklch(0.45 0.03 257.68)` | `oklch(0.92 0 0)` |
| `muted` | `oklch(0.98 0 0)` | `oklch(0.27 0 0)` |
| `muted-foreground` | `oklch(0.55 0.02 264.41)` | `oklch(0.72 0 0)` |
| `accent` | `oklch(0.95 0.03 233.56)` | `oklch(0.38 0.14 265.59)` |
| `accent-foreground` | `oklch(0.38 0.14 265.59)` | `oklch(0.88 0.06 254.63)` |
| `destructive` | `oklch(0.64 0.21 25.39)` | `oklch(0.64 0.21 25.39)` |
| `border` / `input` | `oklch(0.93 0.01 261.82)` | `oklch(0.37 0 0)` |
| `ring` | `oklch(0.62 0.19 259.76)` | `oklch(0.62 0.19 259.76)` |
| `chart-1` | `oklch(0.62 0.19 259.76)` | `oklch(0.71 0.14 254.69)` |
| `chart-2` | `oklch(0.55 0.22 262.96)` | `oklch(0.62 0.19 259.76)` |
| `chart-3` | `oklch(0.49 0.22 264.43)` | `oklch(0.55 0.22 262.96)` |
| `chart-4` | `oklch(0.42 0.18 265.55)` | `oklch(0.49 0.22 264.43)` |
| `chart-5` | `oklch(0.38 0.14 265.59)` | `oklch(0.42 0.18 265.55)` |
| `sidebar` | `oklch(0.98 0 0)` | `oklch(0.21 0.01 285.93)` |
| `sidebar-foreground` | `oklch(0.14 0 0)` | `oklch(0.99 0 0)` |
| `sidebar-primary` | `oklch(0.20 0 0)` | `oklch(0.49 0.24 264.40)` |
| `sidebar-primary-foreground` | `oklch(0.98 0 0)` | `oklch(0.99 0 0)` |
| `sidebar-accent` | `oklch(0.97 0 0)` | `oklch(0.27 0.01 286.10)` |
| `sidebar-accent-foreground` | `oklch(0.20 0 0)` | `oklch(0.99 0 0)` |
| `sidebar-border` | `oklch(0.92 0 0)` | `oklch(1.00 0 0 / 10%)` |
| `sidebar-ring` | `oklch(0.71 0 0)` | `oklch(0.55 0.02 285.93)` |

Preset nie ma `destructive-foreground`; Finora go nie używa (wariant
`destructive` to `bg-destructive/10 text-destructive`).

**Font:** Outfit (`next/font/google`, zmienna `--font-outfit`; `font-data`
Next.js potwierdza podzbiory `latin` i `latin-ext`, więc polskie znaki są,
wagi 100–900 i `variable`). Finora ustawia go przez `--font-sans`
i `font-family` na `<html>` (`src/contexts/settingsContext.tsx` 300–316);
u nas na stałe w `@theme inline`: `--font-sans: var(--font-outfit)`.
**Mono:** preset go nie ma, domyślne Finory to Geist Mono. Zostaje nasz IBM
Plex Mono (§9 „Dodatki”), czyli `--font-mono: var(--font-ibm-plex-mono)`.

**Ustawienia z D2 w kodzie** (domyślne z `src/configs/themeConfig.ts`,
odczyt w `src/contexts/settingsContext.tsx`):

| Panel | Klucz | Wartość D2 | Gdzie działa |
|---|---|---|---|
| Content Layout: Compact | `layout: 'compact'` | jak domyślne | `<main>` w `src/app/(pages)/layout.tsx`: `mx-auto size-full flex-1 px-4 py-6 sm:px-6` + `max-w-360`; nagłówek `max-w-348` (`Header.tsx`); stopka (`Footer.tsx`) |
| Scale: SM | `scale: 'sm'` | **inna niż domyślna `md`** | atrybut `data-theme-scale='sm'` na `<html>`; `globals.css`: `--text-sm: 0.75rem`, `--text-base: 0.85rem`, `--text-lg: 1.05rem`, `--spacing: 0.222222rem` (domyślnie 0.25rem). To zmienia WSZYSTKIE odstępy Tailwinda i `text-sm` = `text-xs` = 12 px |
| Sidebar Variant: Inset | `variant: 'inset'` | **inna niż domyślna `default`** | prop `variant` komponentu `Sidebar` (`src/components/layout/Sidebar.tsx`) |
| Sidebar Mode: Default | `sidebarOpen: true`, `collapsible: 'icon'` | jak domyślne | „Default” w panelu = pasek rozwinięty, przycisk zwija go do ikon (`ThemeCustomizer.tsx` 59–63, 324–340) |
| Color Mode: Light | `mode` | `light` (domyślne Finory to `system`) | u nas `lib/theme/theme.ts`, domyślnie jasny (§9) |

**Gdzie ustawić skalę SM (decyzja E1).** Atrybut na `<html>` zmniejszyłby też
landing, logowanie (`styles/zova.css`) i `/admin`. Zmienne skali definiuj więc
pod `.ff-dashboard[data-theme-scale='sm']` (korzeń szkieletu), a nie pod
samym atrybutem. Portale Base UI (Dialog, Sheet, Popover, Menu, Select,
Tooltip) renderują się w `body`, poza korzeniem: ich zawartość dostaje klasę
`ff-dashboard` i atrybut skali tak jak `flo-queue-sheet.tsx`, albo E1 ustawia
`container` portalu na element wewnątrz korzenia. Sprawdź w E1: FLO w slocie
też dostaje mniejsze odstępy (D4: kolory wątku bez zmian, odstępy ocenia
Masło na punkcie kontrolnym).

### 10.2. Konflikty z planem, które E0 znalazło w kodzie

1. **Kontrast przycisku głównego (blokuje E1).** Biały tekst na
   `primary` presetu (`oklch(0.62 0.19 259.76)`, ok. `#3981f6`) ma
   **3,73:1**, a §9 pkt 4 i `e2e/tests/06-accessibility.spec.ts` (axe,
   WCAG 2.1 AA) wymagają 4,5:1. To samo `primary` jako tekst (wariant
   `link`, aktywne pozycje) na białym: 3,73:1. `destructive` jako tekst na
   białym: 3,72:1. Wyliczone z oklch → sRGB, wzór WCAG. **Propozycja (do
   potwierdzenia Bartosza przed E1):** jasny motyw `--primary:
   oklch(0.55 0.22 262.96)` (to `chart-2` tego samego presetu, ok.
   `#2463ef`: 5,10:1 z białym, 4,81:1 na `muted`) i `--destructive:
   oklch(0.577 0.245 27.325)` (domyślny shadcn, 4,76:1). Ciemny motyw:
   `--primary: oklch(0.71 0.14 254.69)` (`chart-1` presetu) z
   `--primary-foreground: oklch(0.20 0 0)` (ciemny tekst na jasnoniebieskim
   przycisku, 5,85:1 jako tekst na karcie). `--ring` i `chart-*` bez zmian.
   Bez decyzji E1 bierze tę propozycję, bo inaczej CI dostępności padnie.
   **Wykonane w E1 (bez osobnej decyzji):** `--primary` jak w propozycji.
   `--destructive` ciemniej/jaśniej niż w propozycji, bo przycisk
   i plakietka `destructive` mają tekst na WŁASNYM półprzezroczystym tle
   (jasny /10, ciemny /20), także na karcie i w oknie dialogowym: jasny
   `oklch(0.53 0.21 27)` (4,95:1), ciemny `oklch(0.8 0.14 22)` (4,85:1).
   `--ff-accent-tint` = 6% (jasny) / 10% (ciemny) `--primary` na karcie,
   bo akcent jako tekst na `--accent` presetu miał 4,43:1. Wszystko liczy
   `tests/unit/finora-motyw.test.ts`. Stany najechania (hover) zostają jak
   w Finorze.
2. **§9 „Dodatki”, motyw i font** pisał „skala `md`, pasek `default`”.
   D2 to skala **`sm`** i wariant **`inset`**. Poprawione niżej w §9.
3. **„Komplet zmiennych … (z `shadow-*`)”** — preset Modern Minimal nie ma
   cieni, promienia ani fontów (10.1).
4. **Asset Allocation** nie jest na `/investments/*`, tylko na
   `/dashboard/net-worth` (`src/views/dashboards/charts/chart-asset-allocation.tsx`).
   Top Gainers / Top Losers są na `/investments/equities`
   (`mover-list-card.tsx`, z `motion/react`). Poprawione w §3 i P11.
5. **⌘K Finory otwiera się też klawiszem `/`** (`CommandMenu.tsx` 49–63,
   z pominięciem pól tekstowych). Zostawiamy oba skróty: pole FLO to
   `textarea`, więc `/` w nim nie otwiera palety.
6. **Pasek boczny Finory zapisuje ciasteczko `sidebar_state`, ale nikt go nie
   czyta** (`ui/sidebar.tsx`). E2 czyta je w `app/(dashboard)/layout.tsx`
   (serwer) jako `defaultOpen`, żeby po przeładowaniu nie mignął pasek
   rozwinięty.
7. **Nagłówek Finory nie ma stałej wysokości**: przyciski `h-8` + `py-2` +
   obramowanie ≈ 49 px (przy skali SM mniej, bo `py-2` liczy się z
   `--spacing`). `--ff-header-h` (§9 „Dodatki” E2) bierz z wyrenderowanej
   wysokości, nie z tej liczby.
8. **`NotificationDropdown.tsx` i `src/app/server/actions.ts` importują
   strony, które odpadają** (raty, ubezpieczenia, karty). Dzwonek i tak
   usuwamy (P0), a dane z `actions.ts` zastępują nasze loadery: nie przenosić
   żadnego z nich. `ProfileDropdown.tsx` linkuje do `/cards`, `/accounts`,
   `/money-management/budget` — E2 zostawia w menu avatara tylko pozycje
   z P0.
9. **Finora: „Print” to `window.print()`, „Download” nie ma obsługi**
   (`invoice-actions.tsx`). P4 i tak każe drukować PDF — bez zmian w planie.
10. **„Add Transaction” to Sheet, nie Dialog**
    (`create-transaction-sheet.tsx`). P8 używa naszego `capture-button` —
    bez zmian w planie.
11. **Zakładki ustawień Finory to stan komponentu** (`useState` w
    `src/views/settings/index.tsx`). P14 i tak robi z nich `<Link>` — bez
    zmian w planie.

### 10.3. Szkielet (E2)

| Element | Plik | Uwagi |
|---|---|---|
| Układ panelu | `src/app/(pages)/layout.tsx` | `Sidebar` w `Suspense` → `SidebarInset` → `Header` → `<main>` → `Toaster` → `Footer` |
| Providery | `src/components/Providers.tsx`, `src/components/ThemeProvider.tsx` | NIE przenosimy (`next-themes`, `SettingsProvider`); bierzemy tylko `SidebarProvider defaultOpen` i `TooltipProvider` |
| Prymityw paska | `src/components/ui/sidebar.tsx` (683 linie) | `SIDEBAR_WIDTH = '16rem'`, `SIDEBAR_WIDTH_MOBILE = '18rem'`, `SIDEBAR_WIDTH_ICON = '3rem'` (→ `--sidebar-width`, `--sidebar-width-icon`); skrót ⌘/Ctrl+B; poniżej progu mobilnego Sheet; kontener `md:flex` → u nas `lg:flex` (§4) |
| Próg mobilny | `src/hooks/use-mobile.ts` | `MOBILE_BREAKPOINT = 1280` → u nas 1024 (§4) |
| Pasek z menu | `src/components/layout/Sidebar.tsx` + `src/configs/navConfig.tsx` | menu z grupami i `Collapsible`; u nas pozycje z `lib/dashboard-nav-config.ts` |
| Nagłówek | `src/components/layout/Header.tsx` | `sticky top-0 z-50 border-b px-4 sm:px-6`, wiersz `py-2`; kolejność: SidebarTrigger, Separator, CommandMenu, Notification (usuwamy), ModeToggle (nasz `ThemeToggle`), link Ustawienia, ThemeCustomizer (usuwamy), ProfileDropdown |
| ⌘K | `src/components/layout/CommandMenu.tsx`, dane `src/assets/data/search.ts` | u nas pozycje z `dashboardNavSections` (N4) |
| Przełącznik motywu | `src/components/layout/ModeToggle.tsx` | woła `useTheme()`; przepiąć na `lib/theme/theme.ts` (§9) |
| Menu avatara | `src/components/shared/ProfileDropdown.tsx` | tylko pozycje z P0 |
| Stopka | `src/components/layout/Footer.tsx` | linki shadcnstudio.com wylatują (P0) |
| Logo | `src/components/shared/Logo.tsx` → `src/assets/svg/logo.tsx`; na auth `src/assets/svg/logo-vector.tsx` | u nas `components/brand/brand-wordmark` |
| Skrót „d” | `src/contexts/settingsContext.tsx` 250–268 | NIE przenosimy (§9) |
| Do góry | `src/components/layout/ScrollToTop.tsx` | opcjonalnie; bez zależności |

### 10.4. Ekrany (karta → plik)

Wspólne: nagłówek karty z menu `src/views/dashboards/card-header-with-menu.tsx`;
kafle z liczbą `src/views/stats-cards.tsx` (Card + Separator) — używają ich
Transactions, Monthly Analytics, Accounts i Invoice List.

| Nasza karta / ekran (§5) | Plik Finory | Prymitywy | Uwagi |
|---|---|---|---|
| P1 siatka | `src/app/(pages)/dashboard/finance/page.tsx` | `grid grid-cols-6 gap-6` | dane przykładowe w pliku strony |
| P1 Przychody i koszty + Ten miesiąc | `src/views/dashboards/charts/chart-finance.tsx` (jedna karta) | `BarChart`, `barSize={12}`, trzy `Bar stackId='a'` (chart-2/3/4), Avatar, `Button size='lg'` | `col-span-full xl:col-span-4`; usuń `stackId`, dwie serie (P1) |
| P1 Faktury / Należności (kafle) | `src/views/dashboards/statistics/statistics-card-03.tsx` | Avatar, Badge | opakowanie `col-span-full grid grid-cols-2 gap-6 lg:col-span-3 xl:col-span-2` |
| P1 Przychód netto | `src/views/dashboards/statistics/statistics-total-revenue-card.tsx` | `BarChart` `barSize={12}`, dwie serie obok siebie | u nas jedna seria (6 mies.) |
| P1 VAT należny / Limit zwolnienia | `src/views/dashboards/statistics/statistics-impression-card.tsx` | `LineChart`, `Line type='linear'` | — |
| P1 Należności według terminu | `src/views/dashboards/charts/chart-total-visitors.tsx` | bez recharts: słupki CSS (`h-[17%]`), Avatar, Badge, Separator | — |
| P1 Najlepiej sprzedające się / Najwięksi klienci | `src/views/dashboards/widgets/widget-top-products.tsx` | jedna karta, dwie listy rozdzielone `Separator` | — |
| P1 Ostatnie faktury | `src/views/dashboards/datatables/datatable-user.tsx` | `@tanstack/react-table`, `ui/table`, `ui/pagination`, `src/hooks/use-pagination.ts`, `pageSize = 5` | bez filtrów (P1) |
| P2 siatka | `src/app/(pages)/dashboard/cash-flow/page.tsx` | — | — |
| P2 Wpływy i wydatki | `src/views/dashboards/charts/chart-cash-flow.tsx` | `ui/tabs` + `BarChart` (dwie serie, `barGap={4}`) | `xl:col-span-4` |
| P2 Limit zwolnienia z VAT / Odłóż na podatek | `src/views/dashboards/statistics/statistics-savings-goal-card.tsx` | `RadialBarChart` (PolarGrid, PolarRadiusAxis, Label) | `xl:col-span-2` |
| P2 Wpłynęło / Wydano w tym miesiącu | `src/views/dashboards/statistics/statistics-area-stat-card.tsx` | `AreaChart`, Badge | `sm:col-span-3` każda |
| P2 Skąd i dokąd płyną pieniądze | `src/views/dashboards/widgets/widget-top-cash-flow-sources.tsx` | Avatar, `ui/progress` | `lg:col-span-2` |
| P2 Spodziewane wpływy | `src/views/dashboards/widgets/widget-upcoming-bills.tsx` | lista z Avatar | — |
| P2 Ostatnie operacje | `src/views/dashboards/widgets/widget-recent-activity.tsx` | lista z Avatar | — |
| P2 Wszystkie operacje | `src/views/dashboards/datatables/datatable-transaction.tsx` | tanstack, filtry kategorii i statusu, `pageSize = 5` | — |
| P2 rząd z Net Worth | `src/app/(pages)/dashboard/net-worth/page.tsx` (pierwszy rząd) | lewa karta `col-span-full lg:col-span-4`; prawa kolumna `col-span-full flex flex-col gap-6 sm:max-md:flex-row md:col-span-3 lg:col-span-2` | lewa: Podsumowanie VAT w miejscu `chart-net-worth.tsx` |
| P2 Należności / Zaległości | `src/views/dashboards/statistics/statistics-assets-liabilities.tsx`, `statistics-liquidity-snapshot.tsx` | zwykły Card, `flex-1` | — |
| P3 Faktury | `src/views/pages/invoices/invoices-list/{index,stats-cards}.tsx`, `invoice-table/{index,data-table}.tsx` (607 linii) | tanstack; kolumny select/ID/Status/Client/Total/Issued/Due/Balance/Actions; „Show” 5/10/25/50, domyślnie 10 | nasze `na_stronie` 10/25/50 (P3) |
| P4 Podgląd faktury | `src/views/pages/invoices/invoices-view/{index,invoice-document,invoice-actions}.tsx`; wysyłka `src/views/pages/invoices/send-invoice-sheet.tsx` | siatka `grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem] print:block`; nieznany numer → `ui/empty` | 10.2 pkt 9 |
| P5 Wystaw fakturę | `src/views/pages/invoices/invoices-create/{index,invoice-form,invoice-line-items,invoice-create-actions,add-customer-dialog,create-invoice-schema}.tsx` | RHF + zod, `useFieldArray`, `lg:grid-cols-[1fr_18rem]`, `invoice-date-field.tsx` (react-day-picker) | sesja lokalna (§9) |
| P6 Faktury cykliczne | `src/views/pages/invoices/invoices-recurring/recurring-invoice-table/{index,data-table}.tsx`, `create-recurring-invoice-sheet.tsx` (601 linii) | tanstack, filtr statusu | arkusz tworzenia zastępuje wybór faktury‑wzoru (N1) |
| P7 Przypomnienia | `src/views/pages/invoices/invoices-reminders/reminder-table/{index,data-table}.tsx`, `create-reminder-sheet.tsx` | tanstack, filtr statusu | arkusz tworzenia odpada (P7: link do ustawień) |
| P8 Wydatki / P9 Skrzynka KSeF | `src/views/pages/transactions/{index,transaction-stats-cards}.tsx`, `transaction-table/{index,data-table,transaction-detail-sheet}.tsx` (669 linii) | tanstack, wyszukiwarka `InputGroup`, filtry grup/kategorii/statusów, `pageSize = 10` | 10.2 pkt 10 |
| P10 / P11 Analizy | `src/views/pages/money-management/monthly-analytics/`: `index.tsx` (`grid gap-6 md:grid-cols-4`), `monthly-stats-cards.tsx`, `spend-trend-chart.tsx` (`BarChart`), `category-breakdown-chart.tsx` (`PieChart`, `innerRadius=60`), `category-ranked-list.tsx` (`ui/progress`), `recent-expenses-feed.tsx`, `spending-streaks-card.tsx`, `income-expense-summary.tsx`, `subscriptions-card.tsx`, `spend-heatmap.tsx` (siatka CSS + Tooltip), `month-selector.tsx` | wybór miesiąca w Finorze przez `nuqs` (`useQueryState('month')`) | u nas `searchParams` strony + linki, bez `nuqs` |
| P11 Udział klientów w przychodach | `src/views/dashboards/charts/chart-asset-allocation.tsx` (z `/dashboard/net-worth`) | `PieChart`, `innerRadius=60`, `ChartLegend` | 10.2 pkt 4 |
| P11 Klienci: rośnie / spada | `src/views/pages/investments/mover-list-card.tsx` (przez `equities/equities-movers.tsx`) | Card, Avatar, `AnimatePresence` z `motion/react` | import z `framer-motion`; rząd `col-span-full md:col-span-3 lg:col-span-2` ×3 w siatce 6 kolumn |
| P12 Bank | `src/views/pages/accounts/{index,account-stats-cards,account-grid,account-card,account-detail-sheet,add-account-dialog}.tsx` | — | etap lokalny |
| P14 Ustawienia | `src/views/settings/{index,settings-nav}.tsx` + `general/`, `security/`, `notifications/`, `connected-accounts/`, `privacy/` | na telefonie menu w Sheet | `profile/` odpada (P14) |
| P15 Logowanie | `src/app/(blank)/(auth)/{login,register,forgot-password}/page.tsx` → `src/views/pages/auth/{login,register,forgot-password}/{index,*-form,*-schema}` | RHF + zod, `ui/field`, `ui/input-group`, `ui/checkbox`; prawa kolumna `max-lg:hidden` | formularze pchają do `/dashboard/finance` — u nas nasze akcje |
| P15 tło | `src/components/ui/letter-glitch.tsx` (canvas, bez zależności) | kolory w linii 93 (`['#5ee9b5', '#00bc7d', '#009966']`), znaki w linii 99 (`'र€£¥₽₩₺₴₦₱₲₵₡₢₭'`), tło kontenera `#000000` w linii 62 | podać kolory presetu i znaki od „zł” (P15) |

**Pliki publiczne Finory:** 96 × `.webp`, 5 × `.svg` (szablon Next.js),
2 × `.png`: awatary (`images/avatars/`), logo marek (`images/brand-logos/`),
`images/og-image.png`, `images/qr-code.webp`. Wszystko to dane przykładowe —
**nie przenosimy nic z `public/`**, więc `proxy.ts` (§11) się nie zmienia.

---

## 11. Pułapki znane z tego repo

- **`proxy.ts` przepuszcza bez logowania tylko pliki z rozszerzeniem
  z wzorca** (dziś: svg, png, jpg, jpeg, gif, webp, avif, ico, mp4, webm,
  mov, woff, woff2) oraz ścieżki `_next/static`, `_next/image` i `icons/`.
  Rozszerzenie dopisz TYLKO wtedy, gdy Finora wnosi do `public/` inny typ
  (np. `.ttf`, `.otf`, `.json`). Fonty z `next/font` tego nie wymagają.
  `proxy.ts` jest w CODEOWNERS. Nowe trasy panelu (`/analizy/*`, `/bank/*`,
  `/invoices/recurring`) są chronione automatycznie, bo proxy przepuszcza
  tylko ścieżki z `isPublicPath`.
- Plik `'use server'` eksportuje tylko funkcje asynchroniczne — łapie to
  `pnpm build`, nie `pnpm typecheck`.
- Wyłącznie klasy Tailwind; żadnych `.module.css` ani CSS‑in‑JS (AGENTS.md).
  Style Finory przenosimy jako klasy i zmienne w `app/globals.css`.
- Server Components domyślnie; `"use client"` tylko dla wykresów, filtrów,
  ⌘K i przełączników.
- Dane przykładowe Finory (avatary ludzi, logo marek, kwoty w $) nie mogą
  zostać nigdzie w produkcji — grep `\$[0-9]` i `images/avatars` przed PR.
- Atrapy przy `isLocalDevEnv()` są tylko dla danych agenta FLO i działają
  tylko po zalogowaniu do bazy deweloperskiej. Bez bazy żadna strona panelu
  się nie otworzy. Nowe karty nie dostają atrap w produkcji, mają puste stany
  z §7.3.
- **FLO (D4) zależy od szkieletu.** (1) Tokeny `--ff-*` zostają NA STAŁE, bo
  FLO używa ich 211 razy w 22 plikach. Aliasy z E1 (mapowane w
  `.ff-dashboard` na zmienne presetu) nie są tymczasowe i żaden etap ich nie
  usuwa. (2) Korzeń szkieletu i każdy portal z treścią FLO noszą klasę
  `ff-dashboard` (wzór: `flo-queue-sheet.tsx`). (3) `<link>` Material Symbols
  w `app/layout.tsx` i reguła `.ff-dashboard .material-symbols-outlined`
  w `globals.css` zostają. FLO używa ligatur w 8 plikach, marketing też.
  Ikony Material obok Remix w slocie FLO to świadomy kompromis do decyzji
  Masła. (4) Po nadpisaniu `components/ui/sheet.tsx` uruchom
  `tests/unit/ui-flo-*` i obejrzyj kolejkę FLO. Zmianę wyglądu zgłaszasz
  Masłu, jego pliku nie edytujesz. (5) Poza katalogami z D4 nie edytujesz
  `app/(dashboard)/settings/flo/*` ani `e2e/tests/flo-*.spec.ts`,
  a `lib/i18n/plural.ts` tylko importujesz. `lib/dashboard-nav-config.ts`
  według `docs/flo/UKLAD-DASHBOARDU.md` należy do Masła. E2 zmienia go po
  potwierdzeniu Bartosza w czacie i w tym samym PR aktualizuje mapę własności
  w tym dokumencie.
- Nie edytuj `components/flo/*`, `app/(dashboard)/flo/*`, `content/flo/*`,
  `app/(dashboard)/settings/flo/*`, `e2e/tests/flo-*.spec.ts`, `lib/flo/*`
  (D4).

---

## 12. Dziennik

| Data | Etap | PR | Zużycie $ | Stan | Wdrożone (SHA) | Uwagi |
|---|---|---|---|---|---|---|
| 17.10.2026 | Audyt | (ten dokument) | — | gotowe | — | audyt demo Finory (22 strony + auth + ustawienia) i kodu `main` @ `1ded2147` |
| 17.10.2026 | Krytyka planu | (ten dokument) | — | gotowe | — | 5 krytyków (dane, wykonalność, wizualna, produkt, kompletność) + sędzia: przyjęto 37 poprawek, odrzucono 1 |
| 17.10.2026 | Decyzja D7 | (ten dokument) | — | gotowe | — | karty podatkowe dozwolone: przywrócony licznik limitu zwolnienia z VAT (240 000 zł, gotowe funkcje z `vat-limit.ts`) w P1/P2, „Odłóż na podatek” w P2 |
| 17.10.2026 | E0 + nazwa FaktWay | #278 | ok. 10 (szacunek sesji w chmurze, bez wglądu w rozliczenie) | scalone 17.10 | — | §10 wypełniony z `faktflow-finora-src` @ `56394ef`; konflikty z planem w §10.2 (kontrast `primary` 3,73:1 blokuje E1); D8 i zmiana nazwy w kodzie aplikacji ze strażnikiem `nazwa-produktu.test.ts`. Teksty z bazy (abonament, odmowy 00148) i pliki FLO zostają z FaktFlow do osobnego PR |
| 17.10.2026 | E1 | #282 (szkic, E2 dojdzie do tego PR) | brak wglądu w rozliczenie; agenci: mapowanie 1,7 mln tokenów (mocny model — za drogo, od teraz tańsze), porty 0,3 mln (Sonnet), przegląd 0,5 mln | gotowe, czeka na E2 w tym samym PR (stos, §9 „Wdrożenia”) | — | prymitywy Finory na Base UI (16 + `chart`), preset z poprawkami kontrastu, aliasy `--ff-*`, wątek FLO przypięty do dawnych kolorów (`.ff-flo-legacy` + arkusz kolejki), skala SM na `.ff-dashboard`, Outfit, `.zova` odizolowana, Select z `items`, linki bez `asChild`, usunięte `radix-ui` i `next-themes`. Przegląd: 3 soczewki, 1 potwierdzona usterka (kontrast `destructive` na karcie w ciemnym) — poprawiona |
| 17.10.2026 | E2 | #282 (razem z E1) | brak wglądu w rozliczenie; agenci: mapowanie 0,37 mln (Sonnet), budowa 0,55 mln (Sonnet + szkielet na mocnym modelu), przegląd 1,24 mln (szukanie Sonnet, weryfikacja mocny model), poprawki (Sonnet) | gotowe, czeka na punkt kontrolny | — | szkielet Finory (pasek inset zwijany do ikon, stan z ciasteczka, nagłówek z przełącznikiem firmy, menu avatara, stopka), nawigacja §4 z istniejących tras (zgoda Bartosza na zmianę `dashboard-nav-config.ts`: „kontynuuj wszystko”, 17.10), dolny pasek na ikonach Remix, ⌘K z wyszukiwaniem faktur i kontrahentów, portale Base UI w kontenerze `.ff-dashboard`, banery jako Alert, `error`/`loading` bez szkła; znak marki w panelu „Fakt\|Way” (był rozbity „Fakt\|Flow” — strażnik nazwy łapie teraz i taki zapis). Przegląd: 9 usterek średnich (bąbelek pomocy nad oknami, podświetlenie po „Wstecz”, kontrast paska i awatara, zdublowana pozycja ⌘K) + 5 drobnych — poprawione z testami |
| 17.10.2026 | E3 | #282 (razem z E1 i E2) | brak wglądu w rozliczenie; agenci: budowa (dane na mocnym modelu, lista i podgląd na Sonnecie), przegląd 1,38 mln (szukanie Sonnet + dane na mocnym modelu, weryfikacja mocny model), poprawki 0,71 mln (dane mocny model, UI Sonnet, weryfikacja mocny model) | gotowe, czeka na punkt kontrolny | — | P3 lista faktur (kafle, pasek filtrów `platnosc`/`rodzaj`/`na_stronie`, tabela z zaznaczaniem i PDF zaznaczonych, paginacja Finory, karty na telefonie), P4 podgląd (dokument + karty „Status” i „Dokument”, VAT per stawka w walucie faktury, kod QR KOD I, „Korekta”, „Drukuj” jako PDF w nowej karcie), `lib/dashboard/receivables.ts`, `list-row-facts`, `list-stats`, `batch-pdf ?ids=`; bez `@tanstack/react-table` (tabela na prymitywach, decyzja przed E6). Karty UPO, błędu KSeF i e-maila bez szkła. Przegląd: 10 potwierdzonych (2 to ten sam `limit(50)` formularza korekty — osobna sesja z sugerowanego zadania, nie w tym PR), 3 obalone; 8 poprawionych z czerwonymi testami + 6 drobnych z weryfikacji poprawek. Filtr `not.eq.{}` i kilka `or()` naraz sprawdzone na prawdziwym PostgREST (job RLS) |
| 19.10.2026 | §2.4 pkt 10 (strefa czasowa) | #284 | sesja lokalna (bez kredytów chmury); agenci: przegląd wszystkich `getMonth`/`getFullYear` 0,53 mln (szukanie Sonnet, weryfikacja mocny model) | scalone 19.10 (przez #290), wdrożone | `19bbe9cc` | `getMonthlyFigures`, `getSalesSeries` i 4 miejsca z tą samą przyczyną (rok legendy na `/przeplywy`, okno `CashFlowDashboard`, rok szacunku podatku, domyślny miesiąc i granice KPiR) liczą „dziś” z `todayInWarsaw`. Czerwone przed naprawą: 6 + 5 + 1. Obalone: eksporty (stan liczy się ponownie w przeglądarce), stopka, blog, klucze S3 |
| 19.10.2026 | E4 | #287 (stos na #284) | sesja lokalna; agenci: mapowanie 0,28 mln (Sonnet), budowa 0,53 mln (dane mocny model, karty Sonnet), przegląd 2,77 mln (szukanie: dane i strona mocny model, karty i testy Sonnet; weryfikacja mocny model), poprawki 0,23 mln (dane mocny model, karty Sonnet) | scalone 19.10 (przez #290), wdrożone | `19bbe9cc` | P1 Pulpit: slot FLO `min(640px,70dvh)` od `lg` nad siatką Finance (poniżej `lg` FLO na pełny ekran, blokada przewijania tylko do 1023,98 px), 8 kart w `components/dashboard/pulpit/` (każda w `Suspense` + `SectionErrorBoundary`, treść wyjątku przez filtr `pulpitErrorMessage`), `lib/dashboard/costs.ts` (§2.4 pkt 12), `getSalesSeries({ months, withPrevYear })` z `netSeries`/`vatSeries` w groszach, rankingi (§2.4 pkt 13), należności według terminu, ostatnie faktury, `formatPlCompactMoney`, `shortCompanyName`. Przegląd: 25 znalezisk, 18 potwierdzonych (w tym duplikaty) — poprawione z czerwonymi testami, 7 obalonych. Konflikt planu z D4: wariant „Limit zwolnienia z VAT” (niżej) |
| 19.10.2026 | E4: limit zwolnienia z VAT (decyzja „Opcja A”) | #290 (stos na #287) | sesja lokalna; agenci: budowa 0,33 mln (funkcja limitu mocny model, ustawienia i karta Sonnet), przegląd (szukanie: prawo/dane i migracja mocny model, karta i testy Sonnet; weryfikacja mocny model) | scalone 19.10, migracja 00153 wgrana na db-1, wdrożone (worker i aplikacja) | `19bbe9cc` | znacznik NIEAKTYWNE zdjęty z `vat-limit.ts`; migracja **00153** (`tenants.business_started_on`, przed wdrożeniem); pole w `/settings`; `getVatLimit` + `VatLimitCard`; test na bazie `rls-data-rozpoczecia` (grant z 00112, CHECK, izolacja) |
| 19.10.2026 | Pulpit = Finance Finory 1:1 (decyzja Bartosza, wieczór) | #292 | sesja lokalna | scalone i wdrożone 19.10 ok. 23:36 | `67251ef6` | `/dashboard` to strona `dashboard/finance` Finory przeniesiona plikami (`components/dashboard/finora/*`: wykresy, kafle, odwiedzający, produkty, tabela z filtrami i paginacją, `@tanstack/react-table` 8.21.3), teksty po polsku, **dane przykładowe**, animacje recharts jak w szablonie. **FLO usunięty z Pulpitu w UI** (komponenty FLO zostają w kodzie). Usunięta blokada przewijania `/dashboard` i ukrywanie banera certyfikatu; dolny pasek: „Pulpit” zamiast „Flo”. Karty E4 na prawdziwych danych (`components/dashboard/pulpit/*`, `lib/dashboard/*`) zostają do podpięcia w miejsce danych przykładowych |
| 20.10.2026 | Prymitywy UI Finory dla E5–E10 | #293 | sesja lokalna | scalone 20.10 | — | `alert-dialog`, `empty`, `field`, `letter-glitch`, `popover`, `progress`, `radio-group`, `scroll-area`, `switch` z szablonu bez zmian; portale w `.ff-dashboard` |
| 20.10.2026 | E3b + E5 + E6 + E7 + E8 + E10a + E10b (decyzja Bartosza 20.10: „cały layout z Finory przetłumaczony bez kombinowania”) | #294 | sesja lokalna, Bartosz poza domem ~9 h z poleceniem „wdrożyć jak najwięcej”; agenci (mocny model, izolowane worktree): 7 etapów równolegle, przegląd adwersaryjny 2 soczewki na etap (logika — mocny model, wierność Finorze i WCAG — Sonnet; weryfikacja mocny model), poprawki per obszar | scalone i wdrożone 20.10 (pierwsze wdrożenie aplikacji padło na pamięci builda — #297) | `cfceeaa5` | **E3b** lista i podgląd faktur 1:1 (kafle `stats-cards`, pasek narzędzi, tabela, plakietki, paginacja, dokument, arkusz „Wyślij e‑mailem”, `Empty` dla nieznanej faktury); **E5** `/przeplywy` = Cash Flow + rząd Net Worth na prawdziwych danych (`getCashFlowData`, `getInflows`, `cash-movements`), karta „Przychody i koszty / Ten miesiąc” nad siatką na każdej szerokości (Pulpit ma dane przykładowe); **E6** `/expenses` i `/inbox` = Transactions (kafle z §2.4 pkt 12, N3 stałe koszty), `/expenses/[id]` w karcie Finory; **E7** nowe `/analizy/koszty` i `/analizy/sprzedaz` = Monthly Analytics (+ Udział klientów, Klienci rośnie/spada), sekcja „Analizy” w menu i ⌘K; **E8** `/payments/overdue` = Invoice Reminders, `/contractors` w stylu Invoice List, KPiR = tabela Transactions, Eksport i Import = karty Accounts, portal księgowej; **E10a** `/settings/*` = Settings (zakładki-linki w `settings/layout.tsx` liczone z roli); **E10b** logowanie, rejestracja, reset, 2FA, RODO, onboarding, zaproszenie = auth Finory z tłem LetterGlitch (czarne jak w szablonie, znaki presetu). Przegląd: fala 1 — 36 znalezisk, 26 potwierdzonych (1 krytyczne: import serwerowy w komponencie klienckim — `next build` padał; naprawione przy scaleniu); fala 2 — 11, 9 potwierdzonych. Przy scaleniu: CodeQL (js/incomplete-multi-character-sanitization) na trzech testach zdzierających znaczniki wyrażeniem — wspólny pomocnik `tests/unit/helpers/tekst-html.ts`; hasło logowania bez obietnicy FLO (agent niewdrożony) |
| 20.10.2026 | P5 Wystaw fakturę (`/invoices/new/*`) ← Create Invoice | #295 | sesja lokalna; agenci: budowa (mocny model, izolowany worktree), przegląd 2 soczewki (logika mocny model, wierność Finorze i WCAG Sonnet; weryfikacja mocny model), poprawki w sesji | scalone i wdrożone 20.10 | `cfceeaa5` | oprawa dokumentu Finory dla zwykłej, zaliczkowej i rozliczającej (`components/invoices/finora/invoice-document.tsx`, karta akcji 18rem, pasek na telefonie bez zmian), korekta tylko w ramce (`correction-form.tsx` nietknięty — #283), wybór rodzaju w kartach; logika pól, walidacji i wysyłki bez zmian. Przegląd: 9 znalezisk, 5 potwierdzonych (etykiety pól bez `htmlFor`, nagłówek dokumentu ucięty na 375 px, wiersze pozycji szersze od karty przy 1280 px → próg 1360 px, etykieta zaliczki, odstępstwo kolumn Nabywca/Płatność od `xl` opisane) — poprawione z czerwonymi testami |
| 20.10.2026 | Build produkcyjny: pamięć sterty | #297 | sesja lokalna | scalone i wdrożone 20.10 ok. 23:07 | `cfceeaa5` | wdrożenie #294 padło: `next build --webpack` „JavaScript heap out of memory” (exit 134) przy pułapie 3072 MB; Coolify zostawił starą aplikację, worker był już na nowym kodzie (stan mieszany ok. 45 min). Przyczyna: mapy źródeł dla Sentry (token jest, mapy zostają) urosły z kodem — pomiar lokalny szczytu sterty kompilacji 67251ef6 3296 MB → main 4365 MB → z `experimental.webpackMemoryOptimizations` 3526 MB. Poprawka: ta opcja + pułap 3584 MB w `Dockerfile`, strażnik `build-pamiec-sterty`. Szczyt swapu `app-1` w udanym buildzie 6,2 z 8 GB — zapas mały, przy dalszym wzroście aplikacji patrzeć na swap |
| 20.10.2026 | CI: pułap sterty jak na produkcji | #298 | sesja lokalna | **czeka na Bartosza** (zmiana w `.github/`) | — | job „Next build” budował z domyślną stertą runnera (~4 GB) i przepuścił regresję; `NODE_OPTIONS=--max-old-space-size=3584` w kroku Build + strażnik równości z `Dockerfile` |
| 20.10.2026 | E9 faktury cykliczne (N1 v1) | #296 | sesja lokalna; agenci: dane (mocny model), ekran (Sonnet, przerwany limitem → dokończony mocnym modelem), przegląd 4 soczewki + krytyk kompletności (weryfikacja mocny model), poprawki 2 obszary + weryfikacja adwersaryjna | scalone 20.10, migracja 00154 wgrana na db-1 przed wdrożeniem, wdrożone ok. 23:53 (worker i aplikacja) | `eb5b1620` | migracja **00154** (`recurring_invoices`, `invoices.recurring_invoice_id`/`recurring_period`, `uq_invoices_recurring_period`, UNIQUE wzoru, wyzwalacz blokujący przepięcie), `lib/invoices/recurring/*`, akcje, `/invoices/recurring` w układzie Recurring Invoices, baner na `/invoices`, „Duplikuj”, „Ustaw jako cykliczną”, „Zrób fakturę cykliczną”, menu i ⌘K. Przegląd: 12 potwierdzonych + 3 z krytyka (2 krytyczne: build padał na typach strony; formularz z dwóch kart dawał drugą fakturę w miesiącu) — poprawione z czerwonymi testami; weryfikacja poprawek znalazła 2 kolejne (zaległy okres przy kwartał → miesiąc, zmiana samego wzoru) — poprawione |
| 20.10.2026 | Typy bazy z produkcji po 00154 | #299 | sesja lokalna | scalone i wdrożone 21.10 ok. 00:23 | `9e66ddbe` | `types/database.ts` z postgres-meta na db-1 (diff tylko obiekty 00154), `lib/invoices/recurring/db.ts` bez rozszerzenia `Database` i rzutowania przez `unknown` (`toRecurringRow` zawęża `frequency`); rejestr: 00154 wgrana |
| 21.10.2026 | Kontrast tekstu na tle primary (WCAG 1.4.3) | #300 | sesja lokalna; agenci: poprawki (mocny model), weryfikacja adwersaryjna (mocny model) | scalone i wdrożone 21.10 ok. 00:53 | `b2c595c4` | tekst `text-primary` na `bg-primary/10`–`/30` (paginacje, plakietki Pulpitu, KPiR „Kol. 13” i „Przychód”, „Zwolniony VAT”, aktywna zakładka ustawień w ciemnym, opis formatu eksportu) miał 3,4–4,44:1 → `text-accent-foreground` 6,1–9,0:1 w obu motywach; ikony (3:1) bez zmian; wspólny pomocnik `tests/unit/helpers/kontrast.ts`. Weryfikacja znalazła 3 przeoczone miejsca — poprawione w tym samym PR |
| 21.10.2026 | Poprawki Bartosza: pasek górny 1:1 z Finory, bez banera weryfikacji | (gałąź `claude/finora-poprawki-pasek-gorny`, PR po kolejnych poprawkach) | sesja lokalna; przegląd 2 soczewki (funkcje mocny model, wierność Finorze Sonnet; weryfikacja mocny model) | na gałęzi, niewdrożone (Bartosz: „jeszcze nie wdrażaj”) | — | pasek = `Header.tsx` Finory: zwijanie · wyszukiwarka | dzwonek („Wkrótce w tym miejscu: FLO”) · motyw · zębatka `/settings` · profil (szary ludzik; w menu e‑mail, firma, „Moje firmy” z przełączaniem, Ustawienia, Analiza sprzedaży, Wyloguj). Bez palety kolorów szablonu, bez tytułu strony, przełącznika firmy w pasku i wordmarku. Baner „Organizacja niezweryfikowana” usunięty (klient dowie się inaczej) — klasa `.ff-shell-banner` i `DismissibleBanner` przestają być częścią szkieletu (§9 E2 nieaktualne w tym punkcie). Na telefonie nadal bez przycisku paska bocznego (nawigacją jest dolny pasek) |
| 21.10.2026 | Poprawki Bartosza: Faktury z zakładkami, pełny arkusz, stopka na dole | (gałąź `claude/finora-poprawki-pasek-gorny`, PR po kolejnych poprawkach) | sesja lokalna | na gałęzi, niewdrożone (Bartosz: „jeszcze nie wdrażaj”) | — | ekran „Faktury” ma zakładki Wystawione `/invoices` · Cykliczne `/invoices/recurring` · Po terminie `/payments/overdue` (`components/invoices/invoices-tabs.tsx`, wygląd zakładek „line” Finory jako pierwszy rząd karty, semantyka `<nav>` + `aria-current`); „Faktury cykliczne” i „Przypomnienia” wychodzą z menu, „Faktury” świecą dla wszystkich zakładek, ⌘K prowadzi do nich wprost (`PALETTE_EXTRA_NAV`). Karta z tabelą sięga do stopki pustym arkuszem (`ff-page-fill`, łańcuch flex przez `:has` tylko na tych stronach) — bez dorysowanych pustych wierszy (`minRows` usunięte). Stopka zawsze na dole (`.ff-shell-scroll` kolumną flex, kontener treści `grow`). Cykliczne dostają kafle „Wystawionych”; Po terminie bez widocznego nagłówka (zastrzeżenie „stan orientacyjny” w nocie) |
| 21.10.2026 | Poprawki Bartosza: Koszty z zakładkami, bez noty o 100 fakturach, „+” w dolnym pasku | (gałąź `claude/finora-poprawki-pasek-gorny`, PR po kolejnych poprawkach) | sesja lokalna; workflow: 3 agentów wdrażających (rozłączne pliki), przegląd 4 soczewki + sceptyk na każde ustalenie (7 ustaleń, 3 potwierdzone i poprawione) | na gałęzi, niewdrożone (Bartosz: „jeszcze nie wdrażaj”) | — | ekran „Koszty” = zakładki Wydatki `/expenses` · Skrzynka KSeF `/inbox` (wspólny `components/lists/section-tabs.tsx`, z którego korzystają też zakładki Faktur — znaczniki bez zmian); w menu jedna pozycja „Koszty”, ⌘K zna „Wydatki” i „Skrzynka KSeF”. Przełącznik „Miesiąc / Do opisania” i wybór miesiąca nad kaflami (sterują i kaflami, i tabelą), karty do stopki, puste stany na środku arkusza, limit 200 w Skrzynce tylko gdy osiągnięty, „co 15 minut” w kaflu także przed pierwszym pobraniem. „Po terminie”: stała nota o 100 fakturach usunięta — limit tylko przy ucięciu (pod „Faktur po terminie”), „stan orientacyjny” pod kaflem przypomnień, „sprawdź saldo” w oknie zgody. Telefon: koło „+” stoi w pasku na miejscu napisu „Nowa” (napis tylko dla czytników), z dolnym bezpiecznym obszarem jak pozostałe sloty |
| 21.10.2026 | Poprawki Bartosza: Księgowość od nowa (KPiR · Eksport) | (gałąź `claude/finora-poprawki-pasek-gorny`, PR po kolejnych poprawkach) | sesja lokalna; workflow 1: 4 agentów mapujących (logika KPiR, logika Eksportu, nieużywane ekrany Finory, krytyka), 3 niezależne projekty + sędzia; workflow 2: elementy wspólne → KPiR i Eksport równolegle → podgląd 56 zrzutów (1440/375, jasny/ciemny) → przegląd 5 soczewek → sceptyk na każde ustalenie (32 ustalenia, 29 potwierdzonych i poprawionych z testami) | na gałęzi, niewdrożone (Bartosz: „jeszcze nie wdrażaj”) | — | jedna pozycja menu „Księgowość” z zakładkami KPiR `/reports/kpir` · Eksport `/reports/exports` (adresy bez zmian, ⌘K zna „KPiR” i „Eksport”). KPiR: wynik miesiąca (Dochód/Strata, marża, wykres narastający przychodów i kosztów — wzór `chart-net-worth`), koszty według kolumn jako pierścień (wzór `insurance/premium/premium-breakdown-chart`, klik filtruje księgę), księga z przełącznikiem Wszystko/Przychody/Koszty/Do sprawdzenia, numer dowodu jako link (bez kolumny „Akcje”), plakietki „7 · Sprzedaż”, „13 · Pozostałe”, koszty bez kolumny jako „Poza sumą”; stan wstrzymany z linkami do faktur blokujących i przełącznikiem miesiąca; `error.tsx` i `loading.tsx`. Eksport: karta „Nowy plik” w trzech krokach (Format · Okres · Zakres, domyślnie KPiR Excel za poprzedni miesiąc, link z KPiR ustawia format i okres), wyłączone formaty jedną linią z „Dlaczego?” (naprawiony zdublowany klucz Reacta — nota JPK_V7M była dwa razy), historia z plakietkami stanu, „Pobierz”, przyciskami naprawy (Ustaw urząd, Wybierz CSV, Otwórz fakturę, Ponów…) i odświeżaniem w trakcie generowania. Logika `lib/**` bez zmian. Do decyzji (§7 specyfikacji): koszty bez kolumny/kol. 16 — ekran i plik liczą je różnie; „Kol. 15 — Koszty B+R” w formularzu wydatku |
| 21.10.2026 | Poprawki Bartosza: Analizy 1:1 z Finory (Monthly Analytics) z przełącznikiem Sprzedaż · Koszty | (gałąź `claude/finora-poprawki-pasek-gorny`, PR po kolejnych poprawkach) | sesja lokalna; wzorzec: Finora uruchomiona lokalnie (port 3001) i mierzona `getBoundingClientRect`; workflow: 2 agentów mapujących, 2 projekty dopasowania + sędzia, wdrożenie (szkielet ∥ przeniesienie komponentów, potem dane), zrzuty obok Finory, przegląd 4 soczewek + sceptycy (16 ustaleń, 14 potwierdzonych i poprawionych) | na gałęzi, niewdrożone (Bartosz: „jeszcze nie wdrażaj”) | — | obie strony to dokładnie 9 kart Monthly Analytics w kolejności i siatce Finory (`components/analizy/finora-1do1/**`, kopie 1:1 przetłumaczone; na 1440 px te same wysokości kart i wykresów co w Finorze, różnica szerokości −3,5 px to margines naszej ramki). Dane PRAWDZIWE z dotychczasowych loaderów `lib/analytics-finance/**` przez czyste adaptery (`components/analizy/adapters.ts`): Sprzedaż — sprzedano netto, średnio dziennie, vs poprzedni miesiąc, najlepszy klient, trend 6 mies., produkty (koło i ranking), ostatnie faktury, należności (w miejscu „Spending Streaks”), przychody a koszty, stali klienci (z „Zrób fakturę cykliczną”), kalendarz 180 dni; Koszty — analogicznie (kategorie, ostatnie wydatki, VAT z wydatków, stałe koszty). Menu: jedna pozycja „Analizy”, przełącznik „Sprzedaż · Koszty” w nagłówku obok miesiąca, `/analizy` → `/analizy/sprzedaz`, ⌘K zna obie analizy. Dodatkowy wiersz Sprzedaży (udział klientów, klienci rośnie/spada) nie jest renderowany — kod zostaje „na razie” (jak w Przepływach). Szkielety wczytywania mają rozmiary kart |

**Decyzje po E3 (Bartosz 17.10: „odpowiedz sam, ma być jak najbardziej
poprawnie”):** (1) lista `/invoices` dalej pokazuje faktury ze wszystkich
środowisk KSeF — to rejestr dokumentów, niczego nie chowamy; liczby (kafle,
płatność, filtr płatności) liczą tylko aktywne środowisko. (2) „Opłacone
w tym miesiącu” liczy faktury opłacone w całości (`paid_at`), bo §2.4 pkt 14
zabrania czytania `payments`. (3) „Faktury w tym miesiącu” już rozdziela
przyjęte i szkice — bez zmian. (4) Strażnik środowiska kafla „Do zapłaty”
tylko na otwartych należnościach, jak `/payments/overdue`. (5) Bez
`@tanstack/react-table` (§10.1). (6) Oryginał z korektą zostaje w wyniku
filtra płatności z „—”: lista po id dzieci w adresie nie skaluje się,
a widok w bazie to migracja bez zysku dla liczb (kafle liczą poprawnie).

**Dla Bartosza:** `lib/flo/wrapped.ts` czyta nieodświeżany
`mv_tenant_monthly_stats` (tor silnika). Zgłoszone, nie naprawiamy w tym
planie.

**Decyzja po E4 (Bartosz 19.10.2026: „Opcja A”) — „Limit zwolnienia z VAT”.**
Plan kazał importować `vatLimitState`, `proratedLimit` i `forecast`
z `lib/flo/functions/vat-limit.ts`, ale moduł miał znacznik NIEAKTYWNE
(AUD-115), a data rozpoczęcia działalności była tylko w profilu FLO.
Zrobione osobnym PR (stos na #287): znacznik zdjęty (wyjątek od D4, tylko
komentarz i lista w `tests/unit/flo-nieaktywne.test.ts`, logika modułu bez
zmian, przegląd modułu w tym PR), migracja **00153**
`tenants.business_started_on` (przed wdrożeniem, z `GRANT SELECT` — 00112),
pole „Data rozpoczęcia działalności” w `/settings` (sekcja VAT, kotwica
`#data-rozpoczecia`, właściciel i administrator), `lib/dashboard/vat-limit.ts`
(`getVatLimit`: sprzedaż §2.4 po dacie sprzedaży od 1 stycznia, proporcja
limitu, progi 60/80/90/100, prognoza) i karta „Limit zwolnienia z VAT” na
Pulpicie w miejscu „VAT należny” dla firmy zwolnionej podmiotowo. Bez daty
startu karta pokazuje sprzedaż i prosi o datę, bez procentu. E5 (P2
„Savings goal”) bierze `getVatLimit` do pierścienia.

**Dla Bartosza z przeglądu PR limitu (poza jego zakresem):**
(1) `app/actions/vat-exemption.ts` (i tak samo metoda kasowa) ma dwie luki
naprawione w akcji daty startu: zapis przed migracją dostaje od PostgREST-a
`PGRST204`, a nie `42703`, więc klient widzi ogólny błąd zamiast „czeka na
aktualizację bazy”; wyjątek z odczytu stanu „przed” wychodzi poza wynik
`{ success: false }` i przewraca `/settings` w `error.tsx` — osobny mały PR.
(2) Tor silnika: `crossedThreshold` i tytuł propozycji `tax.limit`
w `lib/flo/functions/vat-limit.ts` traktują sprzedaż RÓWNĄ limitowi jako
przekroczenie (`>= 100`), a art. 113 ust. 5 mówi „przekroczy”. Karta Pulpitu
liczy to ściśle; moduł FLO bez zmian (D4).
(3) Karta limitu liczy tylko faktury przyjęte w KSeF — mówi to wprost
(„sprzedaż bez faktury i z faktur spoza FaktWay dolicz sam”). Uwzględnienie
sprzedaży z kasy fiskalnej to osobna funkcja (dane z raportów kasy).

**Dla Bartosza (poza zakresem E4):** kafle listy faktur z E3
(`app/(dashboard)/invoices/_components/invoice-stat-tiles.tsx`, `TileError`)
pokazują `error.message` wprost, więc przy błędzie odczytu klient widzi
angielski ogon PostgREST-a. Pulpit filtruje to przez `pulpitErrorMessage`
— kafle E3 warto przepiąć na ten sam filtr osobnym małym PR. `/przeplywy`
nie ma strażnika przyjętej faktury bez środowiska, który mają Pulpit
i `getSalesSeries` (różnica sprzed E4, do przeniesienia w E5).

**Decyzja Bartosza 19.10.2026 (wieczór):** Pulpit 1:1 jak Finora
(siatka, karty, wykresy, animacje, odstępy, czcionki), po polsku, na danych
przykładowych; FLO poza Pulpitem (miejsce z projektu Claude Design). Wygląd
naszego projektu porzucamy — przyjmujemy wyłącznie Finorę. „Wrócimy do tego”:
podpięcie prawdziwych danych w karty Finory.

**Następny krok (21.10.2026):** na produkcji (`b2c595c4`, z typami po 00154 (#299) i kontrastem (#300)) są:
- Pulpit Finance (#292);
- ekrany E3b, E5, E6, E7, E8, E10a, E10b (#294);
- P5 „Wystaw fakturę” (#295);
- E9 faktury cykliczne (#296), z migracją 00154 wgraną na db-1.

Plan Finora ma w układzie Finory wszystkie istniejące ekrany. Zostaje:
- odbiór wizualny (niżej) i poprawki z niego osobnym PR;
- P12 Bank (N5, etap późniejszy);
- N1b (przypomnienie e‑mailem o „Do wystawienia”);
- podpięcie prawdziwych danych w karty Pulpitu (Bartosz: „wrócimy do tego”).

**Dla Bartosza:**
- (1) #298: ten sam pułap sterty w CI co na produkcji. To zmiana w
  `.github/`, więc czeka na Twoją decyzję.
- (2) Swap `app-1` w buildzie dochodzi do 6,2 z 8 GB. Przy dalszym wzroście
  kodu trzeba będzie albo dołożyć swap, albo zdecydować o mapach źródeł
  (−1250 MB sterty, ale bez czytelnych stosów w Sentry), albo budować poza
  `app-1`.
- (3) Dependabot zgłasza na `main` 10 podatności (1 krytyczna, 1 wysoka).
- (4) N5 Bank nie ruszony: plan wymaga parserów wyciągów 6 banków, każdy
  z prawdziwym, zanonimizowanym plikiem przykładowym. Takich plików nie mamy,
  a parser pisany z pamięci formatu to zgadywanie przy zapisie wpłat. N5
  potrzebuje też zgody na zmiany w `lib/jobs/` i na RPC `SECURITY DEFINER`
  (CODEOWNERS).
- (5) N1b (e-mail o „Do wystawienia”) dodaje 28. cron. Kontrola po
  wdrożeniu w `AGENTS.md` (CODEOWNERS) zmienia się wtedy na „28/28 cronów”.
  To decyzja Bartosza.

**Odbiór wizualny po wdrożeniu.** Każdy ekran obok demo Finory, w jasnym i
ciemnym motywie, przy 375 / 768 / 1440 px, z paskiem rozwiniętym i zwiniętym:
- `/invoices/new/*`: 4 rodzaje;
- `/invoices` i `/invoices/[id]`;
- `/invoices/recurring`, po E9;
- `/przeplywy`;
- `/expenses` i `/inbox`;
- `/analizy/*`;
- `/payments/overdue`;
- `/settings/*`;
- logowanie.

Poprawki z odbioru idą osobnym PR. Zostaje też P12 Bank (N5, etap
późniejszy) i podpięcie prawdziwych danych w karty Pulpitu (Bartosz:
„wrócimy do tego”).

**Bez zmian zostają:**
- #283 (`limit(50)` formularza korekty);
- #288 i #289 (kafle i alerty listy z E3). E3b przepisało listę, więc
  prawdopodobnie są nieaktualne — sprawdzić przed scaleniem;
- migracja nazwy FaktWay w bazie, po rozstrzygnięciu szkicu #248.
