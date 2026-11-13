# Przełączenie KSeF z TEST na PROD

Plan „zero zgubionych faktur”, karta F1, część dokumentowa (11.11.2026).
Wykonuje Bartosz: zmienne w Coolify, wdrożenie i SQL jako `postgres` to jego
część pracy. Ten plik sam niczego nie zmienia.

- **Kontrola, tylko odczyt, jedna linia:** `./scripts/ops/kontrola-go-live-ksef.sh`
  (sam ładuje `.agents/infra.env`). Oczekiwane wartości są w etykietach wyniku.
- **Dowody** `plik:linia` sprawdzone na `origin/main` z 13.11.2026 (`f84bf6c2`).
  Gdy plik się zmieni, szukaj nazwy funkcji, nie numeru linii.
- **Powiązane runbooki:** [hamulce-ksef.md](./hamulce-ksef.md) (wyłącznik
  i przerwa techniczna), [wdrozenie-produkcji.md](./wdrozenie-produkcji.md),
  [coolify-pulapki.md](./coolify-pulapki.md),
  [ksef-error-codes.md](./ksef-error-codes.md) (kody błędów, `ENV_MISMATCH`),
  [offline24-zalegle.md](./offline24-zalegle.md),
  [synchronizacja-historii-ksef.md](./synchronizacja-historii-ksef.md),
  [lejek-faktway.md](../analytics/lejek-faktway.md).

## W skrócie

| Krok | Co | Kiedy |
|---|---|---|
| 0 | Decyzje D1–D8 (§1) i komunikat do klientów | dni przed oknem |
| 1 | Kontrola startowa, sprawy wymagające klienta | dni przed oknem |
| 2 | `maintenanceMode` włączone | początek okna |
| 3 | Zaległości z TEST dokończone przy **zdjętym** wyłączniku | okno |
| 4 | `killAllKsefSubmissions` włączone | okno |
| 5 | Bramka zero; gdy nie jest zerem, wróć do kroku 3 | okno |
| 6 | Pozostałe flagi | okno |
| 7 | `KSEF_ENV=production` w obu aplikacjach, wdrożenie: worker, potem aplikacja | okno |
| 8 | Sprawdzenie zmiennych i objawy złego `KSEF_ENV` | okno |
| 9 | Lejek: zerowanie i przeliczenie daty pierwszej faktury | okno |
| 10 | Weryfikacja po przełączeniu | okno |
| 11 | Wyłącznik zdjęty, potem przerwa techniczna | koniec okna |
| 12 | Obserwacja po otwarciu | pierwsze dni |

**Najważniejsze:** kod nie pilnuje, żeby faktura z czasów TEST nie poszła na
PROD. Każde ponowienie bierze bieżące `KSEF_ENV`, nie środowisko pierwszej
próby (§2.1, zasada 3). Przed zmianą zmiennej nie może więc zostać nic, co
cron albo przycisk wyśle ponownie. Pilnuje tego bramka w kroku 5.

## 1. Decyzje przed oknem (Bartosz)

| # | Decyzja | Dlaczego | Bez decyzji |
|---|---|---|---|
| D1 | Co z fakturami przyjętymi na TEST w bazie produkcyjnej: zostają, są oznaczone albo przeniesione (F2). Zmienić zapisane `ksef_environment` może tylko rola `postgres` (`supabase/migrations/00117_ksef_certificate_claim_guard.sql:152–157`) | KPiR, eksporty i Księgowość JDG odmawiają okresu, w którym jest przyjęta faktura z innego środowiska (§2.2) | firma z fakturami TEST nie wygeneruje KPiR ani eksportu za te okresy |
| D2 | PDF faktur z TEST po przełączeniu (ustalenie F1-a) | PDF dostaje kod QR do weryfikacji PROD i traci znak wodny „WERSJA TESTOWA” | PDF faktury testowej wygląda jak prawdziwa faktura |
| D3 | `SystemInfo` w XML: zostaje `KSeF SaaS v1.0` czy zmiana przed pierwszą wysyłką na PROD (punkt -SYS rejestru, opis w `ksef-error-codes.md`, „D-A4-1b-3-SYS”) | to jedyna podstawa powodu duplikatu `faktflow-original` (`lib/ksef/duplicate-verdict.ts:22`). Zmiana wymaga migracji i kodu. Zmiana po starcie PROD oznacza, że rozpoznawanie musi znać obie wartości; dziś zna `KSeF SaaS v1.0` i `FaktFlow <cyfra>` (`lib/ksef/duplicate-decision-jsonb.ts:64`, `:69–70`) | PROD startuje z `KSeF SaaS v1.0` (`lib/xml/fa3-generator.ts:32`, `:193`) |
| D4 | Korekty i faktury rozliczeniowe na PROD (C4) | KOR jest wstrzymana przy `KSEF_ENV=production` (`lib/ksef/kind-holds.ts:18–20`), ROZ zawsze (`lib/invoices/ksef-submit-enqueue.ts:211–218`) | po przełączeniu każda korekta i ROZ zostaje szkicem |
| D5 | Zakupy z PROD sprzed przełączenia | kursor skrzynki jest jeden na firmę, bez środowiska (§2.2, wiersz „Skrzynka”) | zakupy PROD starsze niż ostatni HWM skrzynki z TEST (mniej więcej chwila przełączenia) przyjdą tylko do archiwum historii, bez kosztów i KPiR |
| D6 | Komunikat do klientów (treść niżej) | po przełączeniu firma widzi dane przykładowe, dopóki nie zweryfikuje się na PROD (§2.1, zasada 2) | klienci zobaczą zmienione liczby i odmowy bez wyjaśnienia |
| D7 | Okno, `maintenanceMode` i pierwsza faktura na PROD (kto i jaka) | pierwsza wysyłka na PROD to prawdziwy dokument z prawdziwym NIP-em | — |
| D8 | Zmienne sąsiednie: `GUS_API_KEY` (bez klucza JPK_FA na PROD odmawia, `lib/exports/issuer-address.ts:77–80`), `JPK_MF_ENV` (osobny przełącznik bramki JPK, `.env.example:94–97`), `KSEF_PROD_URL` nieustawione albo dokładnie `https://api.ksef.mf.gov.pl/v2`, bez ukośnika na końcu; puste `KSEF_PROD_URL=` też psuje środowisko (§2.3) | każda z nich zmienia się osobno od `KSEF_ENV` | bez klucza GUS JPK_FA na PROD nie powstanie; zły `KSEF_PROD_URL` to zły `KSEF_ENV` (§2.3) |

**D6, co powiedzieć klientom** (do wyboru przez Bartosza, punkty z kodu):

- Po przełączeniu trzeba zweryfikować certyfikat KSeF **produkcyjny**
  w Ustawieniach → KSeF. Do tego czasu pulpit, KPiR, przepływy i analizy
  pokazują dane przykładowe, a wysyłka odmawia.
- Faktury wystawione na KSeF TEST nie są fakturami. Ich PDF nie jest
  dokumentem (D2).
- Szkic sprzed przełączenia wysłany po przełączeniu idzie już na PROD jako
  prawdziwa faktura.
- Miesiące z fakturami TEST w KPiR i eksportach: zależnie od D1.
- Zakupy z PROD sprzed przełączenia: zależnie od D5.

## 2. Co zmienia przełączenie (stan kodu z 12.11.2026)

### 2.1 Trzy zasady

1. **Środowisko faktury zapisuje się tylko przy przyjęciu:** wysyłka
   (`lib/jobs/runners/submit-invoice/save-accepted.ts:17`), skrzynka
   (`lib/jobs/runners/inbox-polling.ts:432`). Statusu przyjętej faktury ani
   zapisanego środowiska nie zmieni nikt poza rolą `postgres`
   (`00117_ksef_certificate_claim_guard.sql:142–146`, `:152–157`).
2. **Weryfikacja certyfikatu jest osobna dla każdego środowiska:**
   `ksef_verified_environment` musi równać się bieżącemu `KSEF_ENV`
   (`lib/auth/ksef-verification-guard.ts:61–65`, w jobach `:123–127`). Po
   przełączeniu każda firma jest niezweryfikowana, dopóki nie zweryfikuje się
   na PROD. Pulpit i raporty pokazują wtedy dane przykładowe (stan H,
   `lib/demo/tryb-danych.ts:96`).
3. **Ponowienie bierze bieżące środowisko:** przycisk klienta
   (`lib/invoices/ksef-submit-enqueue.ts:336`, zdarzenie `:428`), panel
   operatora (`app/admin/ksef/actions.ts:185`, `:220`), cron I5–I7
   (`lib/jobs/runners/ksef-lifecycle-reconcile.ts:187`, `:539`, `:564`).
   Cron wybiera faktury `failed` bez filtra środowiska (`:269–275`).

Skąd ryzyko: faktura z błędem z czasów TEST po przełączeniu pójdzie na PROD,
jeśli wznowi ją cron (I6: kody przejściowe po co najmniej 1 h, najwyżej 24
razy, `ksef-lifecycle-reconcile.ts:83`, `:85`, `:344–348`, kody w
`lib/ksef/send-error-classes.ts:108–113`; I7: `KSEF_PAUSED`,
`ksef-lifecycle-reconcile.ts:403–410`)
albo kliknie ją klient lub operator. Klient może ponowić `failed` klasy
transient i setup oraz `failed` bez kodu; nigdy `rejected` ani klas terminal,
reconcile i hold, więc `KSEF_PAUSED` wznawia tylko I7 albo operator
(`lib/invoices/ksef-send-policy.ts:262–266`, `:277–313`). Droga
okrężna: cron wznawia fakturę przejściową z TEST już ze zdarzeniem PROD,
a job odmawia z `NOT_VERIFIED`, bo firma nie jest jeszcze zweryfikowana na
PROD (`lib/jobs/runners/submit-invoice.ts:405–417`, kod
`lib/ksef/send-error-codes.ts:192`). To klasa setup
(`send-error-classes.ts:104`): cron jej więcej nie wznawia, klient może. Po
weryfikacji na PROD klient klika „Wyślij ponownie” i faktura idzie na PROD.

### 2.2 Gdzie co widać

„Przed weryfikacją” to firma, która po przełączeniu nie zweryfikowała jeszcze
certyfikatu na PROD. „Po weryfikacji” to firma zweryfikowana na PROD, która
ma w bazie przyjęte faktury z TEST.

| Miejsce | Przed weryfikacją | Po weryfikacji | Wyjście | Dowód |
|---|---|---|---|---|
| Wysyłka i „Wyślij ponownie” | odmowa: „Twoja organizacja musi najpierw zweryfikować certyfikat KSeF w Ustawieniach → KSeF.” | wysyłka idzie na PROD, także faktur sprzed przełączenia | bramka zero przed przełączeniem (kroki 3–5) | `ksef-submit-enqueue.ts:287–301`, `:428` |
| Pulpit, przepływy, analizy | dane przykładowe (stan H) | faktury z TEST pominięte bez słowa; faktura bez środowiska kończy się wyjątkiem | D6; komunikaty zamiast wyjątków to osobna sesja F1 | `tryb-danych.ts:96`; `lib/dashboard/monthly-figures.ts:144`, `:150–152`, `:173`; podobnie `lib/dashboard/vat-limit.ts:329`, `lib/dashboard/receivables.ts:174`, `lib/analytics-finance/sales.ts:88`, `lib/contractors/overview.ts:133` |
| KPiR (`/reports/kpir`) | dane przykładowe | miesiąc z przyjętą fakturą sprzedaży z TEST: „Nie udało się wczytać KPiR”; koszty z zakupów z TEST wypadają bez słowa | D1 | `app/(dashboard)/reports/kpir/page.tsx:51`; `lib/reports/kpir-data.ts:84–86`, `:97–99`; `lib/ksef/accounting-provenance.ts:33`, `:42–44`; `app/(dashboard)/reports/kpir/error.tsx:77–78`; `lib/expenses/ksef-environment.ts:58–60` |
| Eksporty (JPK_FA, CSV) | okres z przyjętą fakturą z TEST: odmowa (eksport nie czeka na weryfikację); job ponawia ją dwa razy, potem „Nie udało się wygenerować pliku. Spróbuj ponownie albo napisz do nas.” | to samo | D1; ustalenie F1-e | `lib/exports/data-fetcher.ts:86`, `:95–102`; `lib/jobs/handlers/package-c.ts:87–91`; `lib/jobs/runners/exports-generate.ts:244–255`, `:266–280` |
| Księgowość JDG (pilotaż, `ksiegowosc_enabled`) | odmowa od razu | ewidencja odmawia **całego roku** z przyjętą fakturą z TEST i każdego wcześniejszego, bo sprawdza faktury wystawione od początku roku do dziś; VAT odmawia miesiąca. Oba mówią o braku zapisanego środowiska, choć faktury mają zapisane `test` | D1; do tego czasu `killKsiegowosc` albo wyłączenie pilotażu u firm z TEST | `lib/ksiegowosc/ewidencja-dane.ts:58–60`, `:274–275`, `:280–281`, `:283–296`; `lib/ksiegowosc/vat-dane.ts:59–61`, `:82`, `:97–101` |
| Zaległości (`/payments/overdue`, „Moi klienci”) | faktury z TEST znikają z listy i z liczby zaległych w „Moich klientach” | to samo; faktura bez środowiska: „Zaległe faktury wymagają uzgodnienia środowiska KSeF” | D6 | `app/(dashboard)/(faktury)/payments/overdue/page.tsx:104–113`; `lib/dashboard/moi-klienci.ts:246`; `supabase/migrations/00185_my_organizations_summary.sql:133` |
| Przypomnienia o płatności | wychodzą dalej do nabywców z faktur TEST: harmonogram nie patrzy na środowisko | to samo | D1 (np. wstrzymanie przypomnień faktur TEST); ustalenie F1-f | `lib/reminders/scheduler.ts:333–347`, `lib/reminders/prepare-delivery.ts:65–66` |
| Korekty | faktury z TEST nie da się wskazać jako korygowanej | to samo | D4 | `lib/invoices/correction-parents.ts:98–100`, `lib/invoices/correction-picker.ts:77` |
| PDF | faktura z TEST: kod QR do weryfikacji PROD, bez znaku wodnego; stary plik z pamięci nie wraca, bo klucz zależy od treści QR | to samo | D2; ustalenie F1-a | `lib/pdf/invoice-pdf.ts:89–94`, `:237`; `lib/ksef/qr-verification.ts:27–29`; `lib/pdf/pdf-storage.ts:51–55` |
| UPO | UPO faktur z TEST nie są już ponawiane ani wydawane klientowi | to samo | dociągnij zaległe UPO przed przełączeniem, jeśli są potrzebne | `lib/jobs/runners/upo-retry-stale.ts:129`, `:228`; `lib/jobs/runners/upo-identity.ts:26–29`; `app/(dashboard)/invoices/[id]/upo-actions.ts:67–70` |
| Skrzynka (zakupy bieżące) | firma nie jest odpytywana | pierwsze okno PROD zaczyna się od HWM z czasów TEST, bo kursor jest jeden na firmę | D5 | `inbox-polling.ts:167`, `:182`, `:345`, `:88–96`; `lib/flo/functions/inbox-cursor.ts:47–51`; `lib/ksef/inbox-schedule-db.ts:96–97`; `supabase/migrations/00160_ksef_inbox_schedule.sql:86–96`, `:123`; `supabase/migrations/00063_flo_inbox_and_rules.sql:18–19` |
| Historia KSeF | firma nie jest obsługiwana | sprzedaż z PROD wraca z historii; zakupy z PROD do HWM skrzynki trafiają do archiwum bez kosztów | D5 | `lib/jobs/runners/ksef-history-sync.ts:255`, `:269–290`; `synchronizacja-historii-ksef.md`, „Jak to działa” |
| Offline24 | wpisy z TEST w kolejce zostają; cron loguje je przy każdym przebiegu | to samo | kolejka pusta przed przełączeniem ([offline24-zalegle.md](./offline24-zalegle.md)) | `lib/jobs/runners/process-offline-queue.ts:43–56` |
| „Tylko uzgodnij” i I5 | uzgadnia w **bieżącym** środowisku, więc wpisu sprzed przełączenia tak nie uzgadniaj | to samo | zero otwartych wpisów przed przełączeniem (krok 5) | `app/admin/ksef/actions.ts:185`, `:220`; `ksef-lifecycle-reconcile.ts:187`, `:504`, `:564` |
| Lejek (`first_invoice_accepted_at`) | data z TEST zostaje, więc pierwsza faktura PROD nie wyśle `first_invoice_sent` | to samo | krok 9 | `lib/analytics/funnel.ts:146–151`; `lejek-faktway.md`, „Przełączenie TEST → PROD” |
| Identyfikatory zbiorcze, uprawnienia biura w KSeF | zapisane na TEST znikają: odczyt i zapis idą po bieżącym środowisku. Uprawnienia biura nadane na TEST nie działają na PROD, więc nadaje się je od nowa | to samo | D6; uprawnienia stoją za flagą `ksefPermissionsEnabled` (krok 6) | `lib/expenses/identyfikator-zbiorczy-dane.ts:35`; `app/actions/identyfikator-zbiorczy.ts:141`, `:155`; `lib/accountant/uprawnienia-ksef-dane.ts:32`, `:62`; `app/actions/uprawnienia-ksef.ts:392`, `:399` |

### 2.3 Zły `KSEF_ENV` (literówka, brak zmiennej, puste albo nieoficjalne `KSEF_PROD_URL`)

`configuredKsefEnvironment()` zwraca wtedy `null`: `KSEF_ENV` spoza `test`,
`demo`, `production` albo `production` z `KSEF_PROD_URL` innym niż oficjalny
adres co do znaku (`lib/ksef/claim-environment.ts:14`, `:16`, `:18–20`;
`lib/ksef/client.ts:33–35`). Puste `KSEF_PROD_URL=` też: `??` zastępuje
tylko brak zmiennej, a z pustego napisu nie powstaje adres
(`lib/ksef/client.ts:18`, `:20–26`). Co kto widzi:

| Kto | Co widzi | Dowód |
|---|---|---|
| Klient, faktura z błędem | bez przycisku ponowienia: „Nie możemy teraz potwierdzić środowiska KSeF po stronie FaktWay — tej faktury teraz nie wyślemy…” | `app/(dashboard)/invoices/[id]/page.tsx:99`, `:271`; `ksef-send-policy.ts:53`, `:303–305` |
| Klient, pierwsza wysyłka szkicu | „Twoja organizacja musi najpierw zweryfikować certyfikat KSeF…”, bo weryfikacja odmawia przy braku środowiska, zanim kod sprawdzi środowisko. Ustalenie F1-b | `ksef-verification-guard.ts:61–65`; `ksef-submit-enqueue.ts:287–301` przed `:336` |
| Klient, KPiR i zaległości | wyjątek `KSeF environment is not safely configured`, ogólny błąd strony | `claim-environment.ts:33–37`; `kpir-data.ts:81`; `overdue/page.tsx:56` |
| Operator, `/admin/ksef/<id>` | „KSEF_ENV aplikacji: nieustawione”; przyciski odmawiają: „Środowisko KSeF nie jest poprawnie skonfigurowane (KSEF_ENV)…” | `app/admin/ksef/[id]/page.tsx:179`; `ksef-operator-policy.ts:86` |
| Worker | crony cyklu życia, skrzynki, historii i UPO padają przy każdym przebiegu; job wysyłki odmawia zdarzenia | `ksef-lifecycle-reconcile.ts:187`; `inbox-polling.ts:167`; `ksef-history-sync.ts:209`; `upo-retry-stale.ts:124`; `submit-invoice.ts:127–130` |

**Worker i aplikacja w różnych środowiskach** (`ENV_MISMATCH`): job odrzuca
zdarzenie z innego środowiska (`submit-invoice.ts:127–130`), faktura kończy
jako `failed ENV_MISMATCH` (`lib/ksef/send-error-codes.ts:188`, klasa
terminal, `send-error-classes.ts:97`). Klient
widzi: „Tej wysyłki nie wykonaliśmy: zlecenie dotyczyło innego środowiska
KSeF… Wróć do szkicu i zdecyduj…” (`ksef-send-policy.ts:58`). Naprawa
i alarm Sentry: `ksef-error-codes.md`, sekcja o D-A4-2.

## 3. Kroki

### Krok 0. Decyzje i komunikat (dni przed oknem)

D1–D8 z §1. Komunikat D6 wysłany klientom przed oknem.

### Krok 1. Kontrola startowa (dni przed oknem)

```bash
./scripts/ops/kontrola-go-live-ksef.sh
```

Skrypt sprawdzono na atrapach i z migracjami, nie na bazie produkcyjnej.
Wiersz „zapytanie nieudane” przy działającym połączeniu to błąd zapytania do
poprawki przed oknem.

Z wyniku: liczba faktur w sekcjach 3–5 (to trzeba rozstrzygnąć), firmy
z fakturami spoza PROD w sekcji 7 (to obejmuje D1 i D6). Sprawy, które
wymagają klienta, załatw teraz, bo w oknie panel jest zamknięty:

- decyzje I5D przy duplikatach (`KSEF_DUPLICATE_RECONCILE`, panel decyzji
  klienta, `ksef-error-codes.md`);
- faktury `NOT_VERIFIED` i `NO_CERTIFICATE`: klient weryfikuje certyfikat na
  TEST i wysyła albo wraca do szkicu;
- faktury `KSEF_DUPLICATE_RECONCILE` i `RESULT_UNCERTAIN` z otwartym wpisem:
  „Tylko uzgodnij” jeszcze na TEST.

### Krok 2. Przerwa techniczna

`maintenanceMode` włączasz tym samym `UPDATE` co wyłącznik
([hamulce-ksef.md](./hamulce-ksef.md), „Rejestracja i przerwa techniczna”).
Panel zalogowanego klienta i onboarding przekierowują na
`/przerwa-techniczna`, prywatne API zwraca 503. Działają `/admin`, joby
i strony publiczne (`lib/supabase/middleware.ts:305–311`). Publiczne API
z kluczem (`/api/v1`, `/api/mcp`) też zwraca 503 (`lib/api/v1/auth.ts:132–137`;
MCP przechodzi przez tę samą bramkę, `lib/api/mcp/server.ts:185`), a do
udostępnienia API i tak zamyka flaga `publicApiEnabled`
(`lib/api/v1/auth.ts:129–131`; `lib/api/v1/availability.ts:3–15`). API aplikacji
na telefon (`/api/mobile`) proxy przepuszcza bez sesji z ciasteczek
(`lib/supabase/middleware.ts:139`, `:195`), więc przerwę sprawdza jego własna
bramka: 503 `maintenance`, zanim odczyta token (`lib/api/mobile/auth.ts:205–210`).
Dziś są tam dwie trasy, konto i sesja, obie wołają tę bramkę na starcie
(`app/api/mobile/v1/konto/route.ts:14`, `app/api/mobile/v1/sesja/route.ts:15`)
i żadna nie tworzy ani nie wysyła faktur. Włączenie dociera
do każdego procesu web w najwyżej 30 s (`lib/feature-flags/maintenance.ts:22`).
Błąd odczytu flagi zostawia panel otwarty (`maintenance.ts:9–11`), więc po
włączeniu sprawdź na koncie klienta, że przekierowanie działa.

Przerwa idzie **przed** wyłącznikiem, żeby klienci nie tworzyli nowych
wysyłek, kiedy kończysz zaległości.

### Krok 3. Zaległości z TEST, wyłącznik zdjęty

`KSEF_ENV` jest jeszcze `test`, więc wszystko, co teraz pójdzie, idzie na
TEST. Cel: każda faktura sprzedaży z czasów TEST kończy jako `accepted`,
szkic, `rejected` albo `failed` klasy terminal, zawsze bez otwartego wpisu
wysyłki.

| Stan | Co zrobić |
|---|---|
| `queued`, `sending` | czekać; utknięte (I1, I2): `./scripts/ops/zwolnij-utknieta-wysylke.sh <id-faktury>` ([hamulce-ksef.md](./hamulce-ksef.md), „Faktura utknęła w wysyłce (I1/I2)”). Po 429 z KSeF firma czeka w pauzie (L1a, w logu workera `KSEF_RATE_LIMIT_PAUSE`, `lib/jobs/runners/submit-invoice/rate-limit.ts:23`): faktura wraca do `queued` (`rate-limit.ts:52–69`), a zlecenie czeka w pg-boss jako zadanie z opóźnionym startem, bez zużywania prób (`lib/jobs/run-job.ts:116–124`; `lib/jobs/retry.ts:22–25`). Jedna pauza trwa najwyżej dobę (`lib/ksef/rate-limit-pause.ts:51`). Pauza jest zapisana osobno dla środowiska (`rate-limit-pause.ts:104–105`), więc nie przechodzi na PROD, ale bramka liczy taką fakturę i jej zlecenie: zaplanuj okno z zapasem albo poczekaj. Ile jeszcze potrwa, pokaże `./scripts/ops/ksef-pauza.sh stan test <nip>`. Skrypt tylko czyta Redis (`GET`, `PTTL`, `ZCOUNT`; `scripts/ops/ksef-pauza.sh:158–182`, `:185–186`), ale nie był jeszcze uruchomiony na serwerze (`:6–7`). Pauzy nie zdejmuj przed końcem blokady MF: żądanie przed jej końcem dostaje znów 429, a powtórki ją wydłużają (`:22–26`; [hamulce-ksef.md](./hamulce-ksef.md), „Pauza firmy po 429 (L1a)”) |
| `failed` przejściowe | I6 ponawia po 1 h (`ksef-lifecycle-reconcile.ts:83`, `:344–348`); szybciej: `/admin/ksef/<id>` → „Wyślij ponownie” |
| `failed KSEF_PAUSED` | I7 wznawia po zdjęciu wyłącznika (`ksef-lifecycle-reconcile.ts:403–410`), albo operator |
| `failed` setup (`NOT_VERIFIED`, `NO_CERTIFICATE`) | krok 1; bez klienta: operator „Wróć do szkicu” |
| `failed` hold (`KOR_HOLD`, `ROZ_HOLD_RECONCILE`) | cron i klient ich nie wysyłają (I7 tylko `KSEF_PAUSED`; `ksef-send-policy.ts:306–311`), ale bramka je liczy: po zdjęciu blokady (C4) ponowienie wysłałoby je już na PROD. Operator „Wróć do szkicu” (D6); korektę na TEST może też wysłać ponownie, jeśli panel na to pozwala (`lib/admin/ksef-operator-policy.ts:409–430`) |
| `failed` reconcile, otwarty wpis | „Tylko uzgodnij” w `/admin/ksef/<id>` na TEST; I5 robi to sam po 48 h (`ksef-lifecycle-reconcile.ts:36`) |
| `failed` reconcile bez otwartego wpisu | `ENQUEUE_LOST`, `INVALID_EVENT`, `RESULT_UNCERTAIN`: operator „Wyślij ponownie” na TEST (`ksef-operator-policy.ts:64–68`); `KSEF_DUPLICATE_RECONCILE`: decyzja klienta (krok 1) |
| `offline_queued` | [offline24-zalegle.md](./offline24-zalegle.md) |

„Wróć do szkicu” operatora (`app/admin/ksef/actions.ts:235–262`) zmienia dane
klienta, więc to decyzja z D6. RPC odmawia, gdy faktura mogła dotrzeć do KSeF
albo ma kod klasy reconcile
(`supabase/migrations/00131_ksef_send_lifecycle.sql:354`, `:358`, `:363`).
Wtedy najpierw „Tylko uzgodnij”.

### Krok 4. Wyłącznik

`killAllKsefSubmissions` = `true` ([hamulce-ksef.md](./hamulce-ksef.md),
„Wyłącznik wszystkich wysyłek”). Od tej chwili kolejkowanie odmawia, zanim
sprawdzi weryfikację i środowisko (`ksef-submit-enqueue.ts:244–265`), a cron
pomija I5, I6 i I7. Pomija je także wtedy, gdy nie może odczytać flagi
(`ksef-lifecycle-reconcile.ts:278–284`, `:337–341`).

Pułapka: zlecenie, które było jeszcze w kolejce, kończy jako `failed
KSEF_PAUSED` (`lib/jobs/runners/submit-invoice/shared.ts:134–135`), a z włączonym
wyłącznikiem operator nie zleci ani ponownej wysyłki, ani „Tylko uzgodnij”
(`app/admin/ksef/actions.ts:210–217`). Dlatego krok 3 idzie przed 4, a krok 5
może odesłać z powrotem do 3.

### Krok 5. Bramka zero

Kontrola, sekcje 3–5. Wszystkie wiersze bramki muszą mieć 0:

| Wiersz | Dlaczego zero |
|---|---|
| faktury `queued`, `sending`, `offline_queued` | są w drodze ze zdarzeniem TEST; po przełączeniu skończą jako `ENV_MISMATCH` albo zostaną bez wyjścia |
| zlecenia pg-boss wysyłki (`created`, `retry`, `active`) | jak wyżej |
| wpisy `ksef_offline_queue` `queued`, `sending` | [offline24-zalegle.md](./offline24-zalegle.md) |
| `failed` poza klasą terminal (także bez kodu i z kodem spoza katalogu) | po przełączeniu wznowi je cron albo przycisk, już na PROD (§2.1); kody hold: krok 3 |
| otwarte wpisy `ksef_submissions` (`sent`, `intent`) przy `failed`/`rejected` | po przełączeniu uzgodnienie pytałoby PROD o wysyłkę z TEST |

Gdy coś nie jest zerem: zdejmij wyłącznik, wróć do kroku 3, potem 4 i znowu 5.

### Krok 6. Flagi

| Flaga | W oknie | Po oknie | Dowód |
|---|---|---|---|
| `killAllKsefSubmissions` | włączona (krok 4) | zdjęta w kroku 11 | `lib/feature-flags/types.ts:9`; odczyt fail-closed `submission-holds.ts:50–52` |
| `maintenanceMode` | włączona (krok 2) | zdjęta w kroku 11, po wyłączniku | `types.ts:10` |
| `disableSignups` | bez zmian, chyba że D7 mówi inaczej | — | `types.ts:11` |
| `killKsiegowosc` | rozważ (Księgowość JDG u firm z TEST, §2.2) | do D1 | `types.ts:17` |
| `killFloAgent`, `requireMfaForSensitive` | bez zmian | — | `types.ts:13`, `:15` |
| `publicApiEnabled`, `ksefPermissionsEnabled` | bez zmian; to włączniki, brak wiersza albo błąd odczytu zamyka. Gdy `ksefPermissionsEnabled` jest włączona, uprzedź biura (§2.2) | — | `types.ts:18–22`, `:23–27` |
| `WORKER_DISABLE_SCHEDULES` | **nie ustawiaj**: worker kasuje wtedy cały harmonogram, który trzeba potem odtworzyć | — | `lib/jobs/worker.ts:114–121`; `joby-pg-boss.md` |

### Krok 7. `KSEF_ENV` obu aplikacji

W Coolify, w obu aplikacjach produkcyjnych (worker `id=2`, aplikacja `id=1`,
`is_preview = false`, [coolify-pulapki.md](./coolify-pulapki.md)):

- `KSEF_ENV=production`;
- `KSEF_PROD_URL` usunięte albo dokładnie `https://api.ksef.mf.gov.pl/v2`,
  bez ukośnika na końcu (puste i każda inna wartość dają zły `KSEF_ENV`, §2.3);
- D8: `GUS_API_KEY`, `JPK_MF_ENV`.

Potem wdrożenie, worker przed aplikacją:

```bash
./scripts/ops/wdroz-produkcje.sh
```

Między wdrożeniem workera a aplikacją worker jest już na PROD, a aplikacja
jeszcze na TEST. Zlecenie z tego czasu skończyłoby jako `ENV_MISMATCH`. Nie
powstanie żadne, bo wyłącznik odmawia przed odczytem środowiska (krok 4),
a przerwa zamyka panel (krok 2).

### Krok 8. Zmienne

Kontrola, sekcja 1: oba kontenery mają `KSEF_ENV=production`, `KSEF_PROD_URL`
nie ma albo jest oficjalne, a wierszy „UWAGA” nie ma. W `/admin/ksef/<id>`
dowolnej faktury napis
„KSEF_ENV aplikacji: production” (`app/admin/ksef/[id]/page.tsx:179`). Objawy
złej wartości są w §2.3. W logu workera nie może być
`KSeF environment is not safely configured`.

### Krok 9. Lejek

SQL z [lejek-faktway.md](../analytics/lejek-faktway.md), „Przełączenie TEST →
PROD”, jako `postgres` (wyzwalacz blokuje tylko role klienta,
`supabase/migrations/00161_analytics_consent_funnel.sql:122`), w jednej
transakcji (`psql -1`). Wyłącznik jest jeszcze włączony, więc między zerowaniem
a przeliczeniem nie przybędzie żadna faktura. Na PROD nie ma jeszcze faktur,
więc drugie `UPDATE` zmienia 0 wierszy. Data ustawi się przy pierwszej
fakturze PROD (`funnel.ts:146–151`). Kontrola, sekcja 8: oba wiersze 0.

W PostHogu pierwsza faktura PROD to drugie zdarzenie `first_invoice_sent`
tej firmy z tym samym uuid, ale innym `timestamp`, więc osobny wiersz
(`funnel.ts:169–170`; `lib/analytics/server.ts:35–39`). Czytaj je po
`ksef_env = production` (`funnel.ts:168`).

### Krok 10. Weryfikacja po przełączeniu (wyłącznik dalej włączony)

| Sprawdzenie | Oczekiwane |
|---|---|
| `./scripts/ops/kontrola-go-live-ksef.sh` | sekcje 1–5 i 8 jak w etykietach |
| `./scripts/ops/kontrola-faktur-ksef.sh` | bez nowych błędów |
| crony | 29/29 ([wdrozenie-produkcji.md](./wdrozenie-produkcji.md)) |
| `/api/health` | 200 |
| firma z D7 weryfikuje certyfikat PROD w Ustawieniach → KSeF | `ksef_verified_environment = production` (kontrola, sekcja 6) |

### Krok 11. Wyłącznik, potem przerwa

Najpierw `killAllKsefSubmissions` = `false`. Przy bramce zero I7 nie ma czego
wznawiać. Potem pierwsza faktura z D7 i sprawdzenie, że jest przyjęta na PROD
z UPO (kontrola, sekcja 10). Na końcu `maintenanceMode` = `false`.

### Krok 12. Pierwsze dni

Kontrola raz dziennie, sekcja 10: `ENV_MISMATCH` = 0, `NOT_VERIFIED` rośnie
tylko przy firmach przed weryfikacją PROD, przyjęte na PROD rosną. Sentry:
alarm środowiska wysyłki z `ksef-error-codes.md` (D-A4-2). Szum oczekiwany,
gdy w kolejce zostały zlecenia z TEST (kontrola, sekcja 3c):

- skrzynka: `KSeF inbox event environment does not match configured environment`
  (`inbox-polling.ts:230–232`);
- historia: `KSeF history sync event environment does not match configured environment`,
  bez ponowień (`ksef-history-sync.ts:448–450`);
- UPO: `KSeF UPO event environment requires reconciliation`, bez ponowień
  (`lib/jobs/runners/download-upo.ts:54–55`).

## 4. Wycofanie

Powrót do `KSEF_ENV=test` to ten sam krok 7 w drugą stronę (worker, potem
aplikacja) przy włączonym wyłączniku. Bez decyzji Bartosza **tylko przed
pierwszą fakturą przyjętą na PROD**. Później faktury PROD stają się „innym
środowiskiem”: KPiR i eksporty odmówią ich okresów (`accounting-provenance.ts:33`),
a firmy zweryfikowane na PROD znowu będą niezweryfikowane (§2.1, zasada 2).
Lejek przelicz wtedy z `ksef_environment = 'test'`.

## 5. Nowe ustalenia (do rejestru planu)

| Kod | Co | Dowód | Kierunek |
|---|---|---|---|
| F1-a | PDF faktury z TEST po przełączeniu: kod QR do weryfikacji PROD i brak znaku wodnego, bo oba biorą bieżące `KSEF_ENV`, nie środowisko faktury | `invoice-pdf.ts:89–94`, `:237`; `qr-verification.ts:27–29` | QR i znak wodny ze środowiska faktury (`lib/pdf`) |
| F1-b | Zły `KSEF_ENV`: pierwsza wysyłka mówi „zweryfikuj certyfikat”, a nie „nie możemy potwierdzić środowiska” | `ksef-verification-guard.ts:61–65`; `ksef-submit-enqueue.ts:287–301` | sprawdzenie środowiska przed weryfikacją |
| F1-c | Księgowość JDG: ewidencja (rok z fakturą z TEST i każdy wcześniejszy) i VAT (miesiąc) mówią „nie ma zapisanego środowiska KSeF” także dla faktur z zapisanym `test` | `ewidencja-dane.ts:58–60`, `:280–281`, `:283–296`; `vat-dane.ts:59–61`, `:99` | komunikat z nazwą środowiska i tym, co zrobić |
| F1-d | Pulpit, analizy, zaległości i koszty w KPiR pomijają faktury z TEST bez słowa | §2.2 | komunikat zamiast ciszy (osobna sesja F1) |
| F1-e | Eksport: blokada środowiska jest ponawiana i kończy ogólnym komunikatem | `package-c.ts:88`; `exports-generate.ts:244–255`, `:266–280` | blokada jako błąd bez ponowienia z komunikatem |
| F1-f | Przypomnienia o płatności nie patrzą na środowisko: po przełączeniu faktura z TEST znika ze strony zaległości, a przypomnienia do jej nabywcy dalej wychodzą | `scheduler.ts:333–347`; `prepare-delivery.ts:65–66`; `overdue/page.tsx:111–113` | filtr środowiska w harmonogramie albo D1 |

## 6. Poza zakresem (osobne sesje karty F1)

- Kolumna albo filtr faktur TEST per firma (migracja, Bartosz). To D1, karta F2.
- Komunikaty zamiast wyjątków na pulpicie (kod w `app/`).
- Próba przełączenia na kopii bazy (Bartosz, I3). To warunek „gotowe” karty
  F1: przełączenie bez „Coś poszło nie tak”.
