# Centrum dowodzenia FaktFlow — brief dla Codexa i Masła

Napisał: Claude (tor napraw wysyłki), 04.10.2026, na prośbę Bartosza.
Dla kogo: Masło i Codex (tor obserwowalności). Sprawa koordynacyjna:
`CLAUDE-DO-CODEXA.md` → **C-22**. Odpowiedź Codexa: pod C-22.

Ten dokument mówi, **co już istnieje**, **co buduje równolegle plan
„zero zgubionych faktur”** i **co z tego wynika dla centrum dowodzenia**,
żeby nic nie powstało dwa razy i żeby żadna z dwóch linii sesji nie
dotykała plików drugiej.

---

## 0. W jednym akapicie

Bartosz chce jednego miejsca, w którym widać dosłownie wszystkie
statystyki i logi FaktFlow, a w nim: wizualny przepływ **każdej faktury
z osobna** (od utworzenia do UPO), statystyki wysyłki, gdy ruszy
prawdziwy ruch (np. „99,5 % skuteczności”), magazyn **wszystkich** błędów
podpięty pod logi, który przy każdej nieudanej próbie mówi, co poszło nie
tak — i docelowo warstwę AI, która uczy się na tysiącach faktur
i podpowiada, co w systemie doprecyzować. Prawie wszystkie **dane** do
tego już są (sekcja 3) albo powstają w planie (sekcja 4). Brakuje
**jednego widoku**, **definicji metryk**, **śladu per próba dla porażek
sprzed wysyłki** (sekcja 5) i **warstwy wyjaśniającej** (sekcje 6.4–6.5).

---

## 1. Cel i nie-cel

**Cel:** operator (Bartosz, Masło) w jednym miejscu odpowiada w minutę
na pięć pytań: *co się dzieje z tą fakturą?*, *ile faktur dziś poszło
dobrze, a ile nie i dlaczego?*, *czy coś stoi?*, *czy to się już
zdarzało i jak często?*, *co z tym zrobić?*

**Nie-cel:** drugi mechanizm decyzyjny. Centrum **czyta i tłumaczy**;
**nie zmienia** `ksef_status`, nie kolejkuje, nie resetuje, nie pisze do
klientów. Działania pozostają tam, gdzie są dziś: RPC z migracji 00131,
cron cyklu życia i przyciski w `/admin/ksef`. Centrum do nich **linkuje**.

---

## 2. Nazwy — żeby nie było dwóch „strażników”

| Nazwa | Co to | Stan |
|---|---|---|
| **Strażnik cyklu życia** | `ksef_lifecycle_violations()` (inwarianty I1–I9), cron `cron.ksef-lifecycle-reconcile` (co 15 min: naprawia I1, ponawia klasę transient, wznawia po hamulcu), alarm `checkKsefLifecycleViolations` w monitorze alarmów. **Działa** (deterministycznie). | istnieje (#202, #211) |
| **Centrum dowodzenia** | jeden widok w `/admin` (propozycja: `/admin/centrum`): oś czasu faktury, pulpit SLI, magazyn błędów i wzorców, stan jobów i KSeF, odnośniki. **Pokazuje.** | do zbudowania (ten brief) |
| **Analityk wysyłki** | warstwa AI nad magazynem błędów: wyjaśnia próbę prostym językiem, grupuje wzorce, co tydzień proponuje, co doprecyzować. **Tłumaczy i proponuje**, nigdy nie działa. | do zbudowania (faza 5) |

W kodzie i w UI proszę trzymać się tych trzech nazw. „Strażnik faktur”
w słowach Bartosza = Centrum + Analityk; **nie** nowy cron.

---

## 3. Inwentarz: co już jest (źródła danych i widoki)

### 3.1 Tabele i funkcje w bazie

| Źródło | Co zawiera | Kto pisze | Luka dla centrum |
|---|---|---|---|
| `invoices` | `ksef_status`, `last_error_code`, `last_error`, `last_error_field`, `last_error_suggestion`, `ksef_send_owner`, `submitted_to_ksef_at`, `ksef_accepted_at`, `ksef_number`, `ksef_environment` | RPC 00131 + worker (klient nigdy, 00132) | `last_error*` to **ostatnia** porażka — każda kolejna próba nadpisuje poprzednią |
| `ksef_submissions` | jeden wiersz na próbę, która doszła do KSeF: `status` (`sent`/`accepted`/`rejected`/`duplicate`, miejscami `failed`), `error_code`, `error_message`, `invoice_reference_number`, `session_reference_number`, `request_payload_hash`, `retry_count`, `attempted_at`, `completed_at`, `xml_storage_path` (D5: plik XML **tej** próby) | worker (`lib/ksef/submission-log.ts`) | **brak wiersza dla porażek PRZED POST** (poświadczenia, XML, upload, przejęcie); brak `send_attempt_id`, etapu, SHA workera → sekcja 5 |
| `audit_logs` | `invoice.send_enqueued`, `send_requeued` (`user_id NULL` = automat), `send_reset`, `enqueue_released`, `operator_requeue`/`operator_reconcile`/`operator_reset`; `metadata` z `sendAttemptId`, `previousStatus`, `previousCode` | RPC `ksef_send_audit` (00131), akcje operatora | retencję sprawdź w `cron.cleanup-audit-logs` zanim policzysz 30 dni wstecz |
| `inngest_run_log` (nazwa historyczna; to log przebiegów pg-boss) | `event_name` = kolejka, `run_id` = **id joba pg-boss**, `status`, `duration_ms`, `error_message` (po `scrubTelemetryText`, 500 znaków) | `lib/jobs/run-log.ts`, pisze od 01.10.2026 | **celowo** bez `tenant_id`/`invoice_id`/payloadu; z próbą wysyłki łączy się przez `run_id` ↔ `pgboss.job.id` ↔ `data.sendAttemptId` |
| `pgboss.job`, `pgboss.archive`, `pgboss.schedule`, `pgboss.queue` | stan kolejek, ponowienia, `output` jobów, crony | pg-boss | schemat niewidoczny dla PostgREST; wzorzec dostępu: funkcje `ops.*` z 00100 (czytają `pgboss.job`), tylko dla roli serwisowej |
| `ksef_error_codes` | 19 kodów: `class` (terminal/transient/hold/reconcile/setup), `auto_requeue`, `client_message` | 00131 | — (źródło prawdy dla etykiet i klas; **nie kopiować** do kodu UI) |
| `ksef_lifecycle_violations()` | naruszenia I1–I9 z `invoice_id`, `invariant`, szczegóły | 00131/00132 | — |
| `ksef_health_log` | pingi KSeF: `level`, `consecutive_failures`, `response_time_ms`, `is_mf_outage` | **nikt** (sonda pisze tylko do Redisa — S2) | wypełni sesja **B3** planu |
| `upo_receipts`, `xml_documents` | dowody per faktura | worker | — |
| `ksef_offline_queue` | kolejka Offline24 (wyłączona na PROD, AUD-14) | worker | — |

### 3.2 Widoki i kanały, które już istnieją

| Gdzie | Co pokazuje | Uwaga |
|---|---|---|
| `/admin/ksef` (`lib/admin/ksef-lifecycle.ts`) | naruszenia strażnika per inwariant, faktury `failed`/`rejected` per kod, karta faktury `/admin/ksef/[id]` (`getInvoiceLifecycle`: historia `ksef_submissions` + ślad `audit_logs` + przyciski operatora wg `lib/admin/ksef-operator-policy.ts`) | **tu** ma mieszkać oś czasu faktury (rozbudowa karty, nie druga strona) |
| `/admin/system` (`lib/admin/system.ts`) | rozmiar bazy, statystyki jobów z `inngest_run_log` (etykieta „Inngest aktywność” — nazwa historyczna), historia zdrowia KSeF, migawka kolejki offline | do wchłonięcia przez centrum albo przemianowania; nie dublować |
| `/admin/audit`, `/admin/flo`, `/admin/flags`, `/admin/users`, `/admin/support` | log audytu, FLO, flagi, użytkownicy, wsparcie | zostają; centrum linkuje |
| `cron.ksef-lifecycle-report` (07:30, Slack `metrics`) | liczby per stan, naruszenia per inwariant, akcje ludzi/automatu z doby, ponowienia automatu | **ta sama agregacja** ma zasilać pulpit (sekcja 6.2) |
| `cron.critical-alerts-monitor` (Slack `urgent` + Telegram) | 18 kontroli, m.in. zalegające `sending`, naruszenia strażnika, UPO, skrzynka > 6 h, kopie zapasowe | centrum pokazuje **historię** tych alarmów (klucz alarmu + czas) |
| `cron.daily-summary-email`, `cron.weekly-business-review` (`lib/observability/business-metrics.ts`) | metryki biznesowe (rejestracje, faktury, błędy jobów) | nie dublować liczb; centrum = operacje, PostHog = produkt |
| `/api/status/components` | publiczny status per komponent (baza, KSeF, Stripe, joby) | zostaje jako strona statusu dla klientów |
| `scripts/ops/kontrola-faktur-ksef.sh` | 8 sekcji: kontenery i SHA, log workera, `/api/health`, faktury wychodzące, UPO, skrzynka, pg-boss, migracje | to **dzisiejsze** centrum dowodzenia w terminalu; UI ma pokazywać te same rzeczy |
| Sentry (`lib/observability/sentry-context.ts`, `scrub.ts`) | wyjątki z tagami `tenantId`/`userId`, odciski per obszar, filtr prywatności | centrum linkuje do zdarzenia (po `sentry_event_id` — sekcja 5) |
| PostHog (chmura EU) | zdarzenia produktowe, lejki | **nie** przenosić do centrum |
| Slack `urgent`/`bugs`/`metrics`, Telegram (`lib/alerts/slack.ts`), bramka `/wdroz` (00100) | kanały alarmów i operacji | centrum pokazuje, co wysłano, nie wysyła samo |

### 3.3 Czego nie ma

- Jednego widoku łączącego powyższe.
- Definicji metryk (co to „skuteczność wysyłki”, jaki mianownik, jakie okno).
- Wiersza per próba dla porażek **przed** wysłaniem do KSeF (dziś tylko
  `invoices.last_error*`, Sentry i stdout kontenera).
- Historii alarmów monitora w bazie (dziś tylko klucz deduplikacji).
- Wyjaśnienia „co poszło nie tak” innego niż `client_message` kodu.
- Jakiejkolwiek agregacji wzorców błędów w czasie.
- Logów poza stdout kontenerów (`docker logs`) i Sentry — Loki/Grafana
  były w planie przeprowadzki jako „po powiększeniu `ops-1`”, nie stoją.

---

## 4. Co robi plan „zero zgubionych faktur” — granica toru

Plan (`PLAN-ZERO-ZGUBIONYCH-FAKTUR.md`) prowadzi **jedna linia sesji**,
bo bloki A i H zmieniają runner wysyłki. Codex **nie dotyka**
`lib/jobs/runners/submit-invoice.ts`, `lib/ksef/submit-invoice-full.ts`,
`lib/ksef/submission-log.ts`, `lib/jobs/runners/ksef-lifecycle-*.ts`,
migracji dotyczących `invoices`/`ksef_submissions` ani
`critical-alerts-monitor.ts`. Potrzeby centrum wobec tych plików idą
przez sesję **A5** (sekcja 5), którą plan dostaje w tym samym PR co brief.

Sesje planu, których wynik centrum **konsumuje** (nie buduje):

| Sesja planu | Co dostarcza | Centrum robi z tym |
|---|---|---|
| A2 | wiersz `intent` w `ksef_submissions` PRZED POST (00136) | pokazuje etap „zamiar wysyłki” na osi czasu |
| A3 | automatyczne „tylko uzgodnij” dla zalegających `sent`, wpisy STALE w `/admin/ksef` | pokazuje, nie liczy drugi raz |
| A4 | `docs/runbooks/ksef-error-codes.md`: kod → kto ma wyjście → gdzie przycisk → test; dane dokumentów specjalnych (00137) | wyjaśnienie per próba **linkuje** do sekcji runbooka |
| **A5 (nowa)** | ślad per próba: wiersz dla każdej próby, także porażek sprzed POST, z etapem, klasą, id joba, SHA workera, id zdarzenia Sentry; log strukturalny per etap | **kontrakt danych centrum** — sekcja 5 |
| B3 | sonda KSeF pisze do `ksef_health_log`; baner awarii dla klientów | panel „dostępność KSeF” z tej tabeli |
| D1 | limit prób UPO, I3 rozdzielone na < 24 h / > 24 h | panel „dowody” |
| H1 | cotygodniowe E2E na KSeF TEST w CI (12 scenariuszy) | panel „ostatni przebieg E2E” (wynik + data; z API GitHuba albo z tabeli, do uzgodnienia) |
| H2 | game day: tabela „awaria → sygnał ≤ 15 min → wyjście” | centrum jest **miejscem, gdzie ten sygnał ma być widać**; H2 używa centrum jako kryterium |
| I2 | runbook operatora per kod + ćwiczenie | odnośniki |

Z sekcji 10 planu („nie dodawać funkcji w tej rundzie”) wynika, że
centrum to **osobny tor** Masła/Codexa, a nie sesja planu. Jedyny punkt
styku w kodzie to A5.

---

## 5. Kontrakt danych: ślad per próba (sesja A5 planu)

> **Aktualizacja 13.10.2026 — wykonane inaczej niż niżej.** Kontrakt
> zatwierdzony z poprawką po A2: zamiast kolumn w `ksef_submissions`
> z `UNIQUE (send_attempt_id)` powstała osobna tabela `ksef_send_attempts`
> (migracja 00150, `lib/ksef/send-attempt-ledger.ts`) — wiersz na każde
> **wykonanie** joba wysyłki (ponowienie = nowy wiersz) i na każdą odmowę
> przed kolejką. Po A2 jedna próba (`sendAttemptId`) ma kilka sesji KSeF
> i kilka wykonań, więc jeden wiersz na próbę nadpisywałby wcześniejsze
> porażki, a wiersze porażek sprzed POST w `ksef_submissions` mieszałyby się
> z dowodem kontaktu. Kolumny: `send_attempt_id`, `job_id`, `execution`,
> `stage`, `error_code`, `error_class`, `error_message`, `ksef_http_status`,
> `ksef_code`, `retryable`, `worker_sha`, `status`, `result`. Bez
> `sentry_event_id` (Sentry pomija `NonRetriableError`). Punkt 3 niżej
> nieaktualny: `findOpenKsefSubmission` zostaje przy `sent`, zamiary obsługuje
> `findOpenKsefSubmissionIntents` (A2).

Dziś `ksef_submissions` jest już „per próba”, ale tylko od momentu POST.
Centrum potrzebuje jednego wiersza na **każdą** próbę (`sendAttemptId`
zdarzenia), niezależnie od tego, na którym etapie padła. Zamiast nowej
tabeli — rozszerzenie `ksef_submissions` (ma już `attempted_at`,
`completed_at`, `error_code`, `error_message`, `retry_count`,
`xml_storage_path`):

| Kolumna (A5) | Typ | Znaczenie |
|---|---|---|
| `send_attempt_id` | `uuid` | właściciel próby = `sendAttemptId` zdarzenia (ten sam, który jest w `invoices.ksef_send_owner` i w `audit_logs.metadata`) |
| `stage` | `text` | etap, na którym próba skończyła: `claim`, `credentials`, `xml`, `upload`, `post`, `status`, `reconcile`, `upo` |
| `error_class` | `text` | klasa z katalogu w chwili zapisu (`ksef_error_class(code)`), żeby historia nie zmieniała się po zmianie katalogu |
| `job_id` | `uuid` | id joba pg-boss (= `inngest_run_log.run_id`) — łącznik do przebiegu i `pgboss.archive` |
| `worker_sha` | `text` | SHA obrazu workera (`docker ps` pokazuje go w tagu obrazu; do przekazania przez zmienną środowiskową w Dockerfile) |
| `sentry_event_id` | `text` | id zdarzenia Sentry z `captureException`/`captureMessage` tej próby, jeśli było |
| `ksef_http_status` | `integer` | kod HTTP z KSeF przy `post`/`status`, jeśli był |

Zasady kontraktu (dla A5 i dla czytających):

1. Wiersz powstaje **na początku** próby (`stage = claim`, status
   `intent` z A2 albo `started`) i jest **uzupełniany**, nie dublowany.
   Jedna próba = jeden wiersz; `UNIQUE (send_attempt_id)`.
2. Porażka przed POST = ten sam wiersz ze `status = failed`, `stage`,
   `error_code`. Porażka po POST = jak dziś (`sent` → `rejected`/`accepted`/`duplicate`).
3. `findOpenKsefSubmission` i uzgadnianie filtrują po `status IN ('sent','intent')`
   — wiersze `failed` sprzed POST **nie** są „otwartą wysyłką”.
4. Treści klienta (NIP, nazwy, kwoty) **nie** trafiają do `error_message`
   — nadal `scrubTelemetryText`.
5. Log strukturalny: runner pisze jedną linię JSON per etap
   (`{"ksef":"send","invoiceId","sendAttemptId","stage","code","ms"}`),
   żeby `docker logs | grep <sendAttemptId>` i przyszły Loki dawały
   pełną ścieżkę próby bez bazy.

Do czasu A5 centrum buduje się na dzisiejszych danych (`ksef_submissions`
od POST + `invoices.last_error*` + `audit_logs`) i ma w kodzie jedno
miejsce, w którym te źródła są składane (`lib/admin/centrum/attempts.ts`),
tak żeby po A5 zmienił się jeden plik.

---

## 6. Zakres dla Codexa — fazy

Każda faza = osobna gałąź od `origin/main`, 1 PR (wyjątkowo 2, gdy
migracja idzie osobno), według „Protokołu naprawy błędu” z `AGENTS.md`
w części, która dotyczy nowego kodu: czyste moduły z testami, funkcje
SQL z testami na bazie, `pnpm run ci && pnpm build`, szablon PR, raport
i stop. Numery migracji zarezerwowane w rejestrze: **00138–00140**.

### 6.1 Faza 0 — definicje metryk (bez UI)

- `docs/architecture/centrum-dowodzenia-metryki.md`: tabela z sekcji 8
  (SLI, definicja, mianownik, okno, cel), zatwierdzona przez Bartosza.
- `lib/admin/centrum/sli.ts` (czysty): definicje jako dane
  (`id`, `nazwa`, `cel`, `kierunek`, `okno`) + `evaluateSli(value, def)`
  → `ok | warn | breach`. Test: każda definicja ma cel i kierunek; progi
  z sekcji 8.
- Dlaczego najpierw: bez uzgodnionego mianownika „99,5 %” nic nie znaczy
  (patrz pułapki w sekcji 10).

### 6.2 Faza 1 — pulpit SLI (`/admin/centrum`)

- Funkcja SQL `ksef_send_metrics(p_from timestamptz, p_to timestamptz)`
  (00138; `SECURITY DEFINER`, `EXECUTE` tylko `service_role`, jak RPC
  z 00131): liczniki potrzebne do SLI z sekcji 8 w jednym zapytaniu.
  Test na bazie w `tests/rls-centrum-metryki.test.ts` (job CI „RLS
  isolation”): faktury w znanych stanach → znane liczby; rola klienta
  nie wykona funkcji.
- **Wspólna agregacja z raportem dziennym:** zbieranie danych
  z `ksef-lifecycle-report.ts` przenieść do `lib/admin/ksef-lifecycle-metrics.ts`
  (czysty kontrakt wejścia `LifecycleReportInput` już istnieje) i użyć
  w obu miejscach. Raport na Slacku i pulpit mają pokazywać **te same
  liczby** z tej samej funkcji; to jedyna zmiana w pliku runnera i jest
  czysto mechaniczna (przeniesienie zapytań), bez zmiany treści raportu
  — test `cykl-zycia-raport-i-alarm` ma przejść bez zmian.
- Strona: okna 24 h / 7 d / 30 d (dni w `Europe/Warsaw`), każda metryka
  z celem i kolorem `ok/warn/breach`, link „pokaż faktury” do `/admin/ksef`
  z filtrem. Sekcje z sekcji 7.
- Wykresy: komponent `chart` z shadcn (jego zależność to `recharts`)
  **albo** proste słupki w Tailwind/SVG — decyzja Masła; żadnej innej
  biblioteki (AGENTS.md).

### 6.3 Faza 2 — oś czasu faktury

- Funkcja SQL `ksef_invoice_timeline(p_invoice_id uuid)` (00139; tylko
  `service_role`): `UNION ALL` zdarzeń z `audit_logs` (kolejkowanie,
  ponowienia, resety, akcje operatora), `ksef_submissions` (próby
  i ich przejścia), `invoices` (znaczniki `submitted_to_ksef_at`,
  `ksef_accepted_at`), `upo_receipts`, `xml_documents`, `inngest_run_log`
  (po `job_id`/`send_attempt_id` — pełne po A5). Kolumny: `at`, `source`,
  `kind`, `send_attempt_id`, `stage`, `code`, `class`, `detail` (bez
  danych klienta), `ref` (id wiersza źródłowego).
- Komponent `InvoiceTimeline` (Server Component) w **istniejącej**
  karcie `/admin/ksef/[id]`, ponad tabelami historii: pionowa oś
  z fazami *utworzona → zakolejkowana → przejęta → XML → POST → status
  KSeF → UPO*, grupowanie po próbie (`send_attempt_id`), czas trwania
  między fazami, przy porażce: kod, klasa, komunikat z fazy 3 i **jakie
  wyjście zadziałało** (automat ponowił / klient kliknął / operator /
  nikt — czerwono). Przyciski operatora zostają te same.
- Test: czysty moduł `lib/admin/centrum/timeline.ts` składający wiersze
  funkcji w próby i fazy (wejście = tablica wierszy, wyjście = próby);
  przypadki: jedna próba OK; dwie próby (porażka + sukces); uzgodnienie;
  reset; wiersze bez `send_attempt_id` (dane sprzed A5).

### 6.4 Faza 3 — magazyn błędów i wzorce

- Lista prób nieudanych (`/admin/centrum/bledy`): filtr po kodzie,
  klasie, etapie, oknie; każda pozycja linkuje do karty faktury
  i zdarzenia Sentry. Źródło: `lib/admin/centrum/attempts.ts` (sekcja 5).
- **Odcisk wzorca** (czysty `lib/admin/centrum/fingerprint.ts`):
  `code + stage + ksef_http_status + szablon komunikatu` (komunikat po
  zamianie liczb, UUID-ów, numerów, dat na symbole). Test: dwa komunikaty
  różniące się tylko numerem faktury → ten sam odcisk; różny kod → inny.
- Tabela `ksef_error_patterns` (00140): `fingerprint` (PK), `code`,
  `stage`, `sample_message` (po scrub), `first_seen_at`, `last_seen_at`,
  `count_total`, `count_7d`, `sample_attempt_ids uuid[]` (max 5),
  `status` (`new` / `known` / `fixed`), `note`, `linked_pr` — bez
  `tenant_id` (dane platformy, tylko `service_role`).
- Cron nocny `cron.ksef-error-patterns` (rejestracja w `lib/jobs/handlers/`,
  `CRON_JOBS` rośnie o 1 — **zaktualizować liczbę w AGENTS.md
  „27/27 cronów” i w teście cronów świadomie**): przelicza odciski
  z ostatniej doby, aktualizuje liczniki, nowe odciski → Slack `bugs`
  („nowy wzorzec błędu: KOD/etap, N prób, pierwsza faktura …”).
  Idempotentny: ponowienie od zera daje te same liczniki (UPSERT
  z przeliczeniem, nie inkrement).
- Historia alarmów: tabela `ops_alert_log` (można w 00140): `alert_key`,
  `fired_at`, `channel`, `summary` — zapis w `markAlertDelivered`
  (`critical-alerts-monitor.ts`) to **jedna linia**; uzgodnić ze mną
  w C-22, zrobię ją w sesji A5, żeby Codex nie dotykał monitora.

### 6.5 Faza 4 — „co poszło nie tak” (deterministycznie)

- Czysty moduł `lib/admin/centrum/explain.ts`: wejście = próba (kod,
  klasa, etap, status HTTP, czy automat ponowił, czy jest otwarty wpis
  `sent`, wiek) → wyjście po polsku: **co się stało**, **dlaczego**
  (klasa), **co system zrobił dalej** (ponowienie automatu za X min /
  czeka na klienta / czeka na operatora / wyczerpane), **co ma zrobić
  operator** (odnośnik do sekcji runbooka `docs/runbooks/ksef-error-codes.md#kod`).
- Źródła prawdy, których **nie wolno powielić w nowych tablicach**:
  `ksef_error_codes.client_message`, `lib/ksef/send-error-classes.ts`
  (`sendErrorClassOf`, `isAutoRequeueable`, `isContentRejection`),
  `lib/admin/ksef-operator-policy.ts` (jakie przyciski ma operator),
  `lib/invoices/ksef-send-policy.ts` (jakie ma klient).
- Test: tabela 19 kodów × etapy → każdy przypadek ma niepuste cztery
  pola i odnośnik do runbooka; brak kodu → wyjaśnienie „nieznany kod”
  + prośba o zgłoszenie (fail-closed z wyjściem).
- To jest 90 % wartości „AI, które mówi, co poszło nie tak” — 19 kodów
  to skończony zbiór. Dopiero faza 5 dokłada model.

### 6.6 Faza 5 — Analityk wysyłki (AI)

Uczciwie o „uczeniu się na tysiącach faktur”: w praktyce to trzy rzeczy,
z których tylko jedna wymaga modelu językowego.

- **5a. Wzorce i anomalie (bez modelu):** faza 3 + reguły: skok liczby
  prób z danym odciskiem względem mediany z 7 dni, nowy odcisk, wzrost
  czasu do przyjęcia, spadek SLI poniżej celu. Wynik: pozycja w centrum
  i wpis na Slack `bugs`. To **jest** „uczenie się” w sensie
  operacyjnym i działa od pierwszego dnia ruchu.
- **5b. Wyjaśnienie na żądanie (model):** przycisk „Wyjaśnij” przy
  próbie: wejście = oś czasu próby + wyjaśnienie z fazy 4 + fragment
  runbooka + 3 ostatnie próby z tym samym odciskiem; wyjście = akapit
  po polsku, hipoteza przyczyny, sugerowany krok, pewność; zapis
  w `ksef_attempt_explanations` (`send_attempt_id`, `model`, `prompt_hash`,
  `text`, `created_at`) — żeby dwa kliknięcia nie płaciły dwa razy.
  Klient Anthropic już jest w stacku (`lib/flo/llm.ts`, `lib/support/chat.ts`);
  budżet platformowy (nie per firma) obok `lib/ai/tenant-ai-budget.ts`.
- **5c. Tygodniowy raport „co doprecyzować” (model):** poniedziałek,
  wejście = nowe i rosnące wzorce z tygodnia + metryki; wyjście = lista
  propozycji z kategorii: *nowa kontrola przed wysyłką* (formularz
  przepuszcza coś, co KSeF odrzuca), *nowy kod błędu*, *zmiana klasy*,
  *uzupełnienie runbooka*, *kandydat na test E2E*. Każda propozycja
  cytuje `send_attempt_id` przykładów. Raport trafia do centrum i na
  Slack `metrics`; **każda przyjęta propozycja staje się osobną sesją
  według protokołu napraw** — model nie zmienia kodu ani katalogu.
- **Granice (twarde):** Analityk nie ma dostępu do akcji; prompt nie
  zawiera NIP, nazw, adresów, kwot ani treści faktur (ten sam
  `scrubTelemetry` co Sentry; `tenant_id` zastąpiony pseudonimem);
  wynik jest oznaczony „hipoteza modelu”; brak odpowiedzi modelu nie
  blokuje niczego. Przed włączeniem 5b/5c: Bartosz potwierdza, że
  polityka prywatności obejmuje ten cel (dane operacyjne, bez danych
  osobowych, procesor już wymieniony).
- **Kiedy:** 5a po fazie 3; 5b/5c dopiero, gdy jest prawdziwy ruch
  (alfa), bo model bez danych nie ma na czym pracować, a koszt i ryzyko
  są od razu.

### 6.7 Faza 6 — logi

- Dziś: `docker logs` na `app-1` (nietrwałe, znikają z kontenerem przy
  wdrożeniu), Sentry (wyjątki), `inngest_run_log` (przebiegi jobów).
- Krok 1 (w A5, nie Codex): linia JSON per etap próby + `sentry_event_id`
  w wierszu próby → centrum pokazuje przy próbie: „log: `docker logs
  <worker> | grep <sendAttemptId>`” i link do Sentry. To domyka
  „podpięty pod logi” bez nowej usługi.
- Krok 2 (osobna decyzja Bartosza, infrastruktura): Loki + Grafana na
  `ops-1` **po** jego powiększeniu (plan przeprowadzki §7 odkładał to
  świadomie; GlitchTip tak samo). Agent logów (Alloy/Promtail) na `app-1`
  jest lekki, ale `app-1` buduje obrazy na granicy pamięci (OOM, swap
  8 GB) — nic ciężkiego tam nie stawiamy. Gdy Loki stanie, centrum
  dostaje link „otwórz logi tej próby” z zapytaniem po `sendAttemptId`.
  Do tego czasu **nie** budować własnej tabeli logów w Postgresie.

### 6.8 Faza 7 — widok klienta (po alfie)

Ta sama funkcja osi czasu, zawężona przez RLS do faktur firmy i do
zdarzeń zrozumiałych dla klienta („wysłana do KSeF 10:42, KSeF
niedostępny, ponowimy automatycznie; przyjęta 11:07; UPO pobrane”),
na karcie faktury w `/invoices/[id]`. Nie wcześniej — najpierw operator
ma zobaczyć, czy oś czasu mówi prawdę.

---

## 7. Układ centrum (`/admin/centrum`) — sekcje i źródła

| Sekcja | Co widać | Źródło | Działanie |
|---|---|---|---|
| Nagłówek | wersja webu i workera (SHA), środowisko KSeF, hamulce (`KOR_HOLD`, `ROZ_HOLD`, pauza wysyłki), czy monitor alarmów przebiegł w ostatnich 30 min | `/api/health` (dodać SHA), flagi, `inngest_run_log` | — |
| SLI | metryki z sekcji 8 w oknach 24 h / 7 d / 30 d, kolor wg celu | `ksef_send_metrics` | „pokaż faktury” → `/admin/ksef?code=…` |
| Strażnik | naruszenia per inwariant (I1–I9), ostatnie 24 h alarmów monitora, ostatni raport dzienny | `ksef_lifecycle_violations()`, `ops_alert_log`, agregacja raportu | → `/admin/ksef` |
| W toku | `queued`/`sending` wg wieku (0–5, 5–15, 15–60 min, > 1 h), przejęcia (`ksef_send_owner`) starsze niż 15 min | `invoices` | → karta faktury |
| Błędy | próby nieudane z doby per kod/klasa/etap; wzorce `new` i rosnące; „co poszło nie tak” | fazy 3–4 | → karta faktury, Sentry, runbook |
| Dowody | `accepted` bez UPO (< 24 h / > 24 h), bez `xml_documents`, bez pliku próby | `ksef_lifecycle_violations()` (I3), `upo_receipts` | → `/admin/ksef` |
| KSeF | dostępność z `ksef_health_log` (po B3), czas odpowiedzi, ostatnia awaria MF | `ksef_health_log` | — |
| Skrzynka | opóźnienie odbioru per firma (p95), kursor, ostatni backfill | `ksef_inbox_cursor`, `invoices direction=incoming` | → `/admin` (uzgodnienie S12 po E1) |
| Joby | kolejki pg-boss: oczekujące/aktywne/ponawiane/nieudane per kolejka, crony z czasem ostatniego przebiegu i „spóźniony” | funkcja SQL w stylu `ops.*` (00100) nad `pgboss.*` + `inngest_run_log` | — |
| E2E | ostatni przebieg `ksef-test-e2e.yml` (po H1): data, 12 scenariuszy zielone/czerwone | API GitHuba albo tabela zasilana przez CI (uzgodnić) | → GitHub |
| Odnośniki | Sentry, PostHog, Slack, Uptime Kuma, Coolify (tunel), runbooki, `scripts/ops/kontrola-faktur-ksef.sh` | stałe | — |

Zasady układu: Server Components, dane przez funkcje w `lib/admin/centrum/*`
z `requireAdmin()` **przed** klientem serwisowym (jak `lib/admin/metrics.ts`);
`'use client'` tylko dla filtrów i przycisku „Wyjaśnij”; brak przycisków
zmieniających stan faktur (te są w `/admin/ksef`).

---

## 8. Definicje metryk (propozycja do zatwierdzenia przez Bartosza)

Okna liczone w dniach `Europe/Warsaw`. „Wysyłka” = faktura wychodząca
z co najmniej jednym `invoice.send_enqueued`. Do A5 mianowniki liczymy
z `audit_logs` + `invoices`; po A5 z wierszy prób.

| SLI | Definicja | Cel | Dlaczego taki |
|---|---|---|---|
| S1 Skuteczność ostateczna | odsetek faktur zakolejkowanych po raz pierwszy w oknie [T−48 h, T−24 h], które są `accepted` w ≤ 24 h od pierwszego kolejkowania | ≥ 99,5 % | liczba Bartosza; okno przesunięte o dobę, żeby faktura miała czas na ponowienia automatu (24 h) |
| S2 Odrzucenia treści | liczba faktur `rejected` z kodem klasy terminal **po przejściu walidacji formularza** (KSEF_REJECTED, INVALID_DOCUMENT) | 0 | każda = formularz przepuścił coś, co KSeF odrzuca (cel 4 planu) → wzorzec → sesja naprawy |
| S3 Pierwsza próba | odsetek prób zakończonych `accepted` bez ponowienia | informacyjna (≥ 97 %) | mówi o jakości ścieżki, nie o karach |
| S4 Czas do przyjęcia | p50 / p95 od pierwszego kolejkowania do `ksef_accepted_at`, tylko gdy KSeF był dostępny (po B3) | p95 ≤ 15 min | klient patrzy na ekran |
| S5 Czas do UPO | p95 od `ksef_accepted_at` do `upo_receipts` | p95 ≤ 2 h; 100 % ≤ 24 h | I3 strażnika |
| S6 Niepewne | próby z kodami klasy reconcile (`RESULT_UNCERTAIN`, `KSEF_DUPLICATE_RECONCILE`, `STALE`) na 1000 wysyłek | ≤ 1 ‰ | każda wymaga człowieka |
| S7 Naruszenia strażnika | wiersze `ksef_lifecycle_violations()` | 0 | bramka planu (14 dni) |
| S8 Czas do sygnału | od `attempted_at` porażki do pierwszego alarmu/wpisu widocznego operatorowi | ≤ 15 min | definicja „zgubiona po cichu” z planu |
| S9 Ponowienia automatu | liczba `send_requeued` z `user_id NULL` / dobę i faktur `TRANSIENT_EXHAUSTED` | informacyjna; `TRANSIENT_EXHAUSTED` = 0 bez znanej awarii KSeF | pokazuje, ile pracy robi automat |
| S10 Skrzynka | p95 od `DataPrzeslania` faktury przychodzącej w KSeF do wiersza `received` | ≤ 30 min | odbiór co 15 min |
| S11 Dostępność KSeF | odsetek pingów `ok` z `ksef_health_log` | kontekst, bez celu | tłumaczy S1/S4, nie jest naszym SLO |

Budżet błędów S1: 0,5 % wysyłek w miesiącu; przekroczenie = zatrzymanie
nowych funkcji wysyłki do czasu naprawy (zasada po bramce z planu).

---

## 9. Zasady techniczne (skrót AGENTS.md + plan dla tego toru)

1. Gałąź od `origin/main` per faza, **bez stosów**; kolejna faza po
   scaleniu poprzedniej (albo `gh pr edit N --base main` po scaleniu).
2. `requireAdmin()` zanim powstanie klient serwisowy; klient serwisowy
   tylko w `lib/admin/**` i `app/admin/**`; funkcje SQL `SECURITY DEFINER`
   z `REVOKE ... FROM PUBLIC, anon, authenticated` i `GRANT EXECUTE TO service_role`
   (wzór: 00131).
3. Nowa logika = czysty moduł w `lib/admin/centrum/*` z testem Vitest;
   funkcja SQL = test na bazie w `tests/rls-*.test.ts`.
4. Plik `'use server'` eksportuje wyłącznie funkcje asynchroniczne;
   komunikaty i typy w `lib/**` (`pnpm build` to łapie, `typecheck` nie).
5. Migracje: numery **00138–00140** (rejestr w `CLAUDE-DO-CODEXA.md`),
   nagłówek „przed/PO wdrożeniu”, bez `DROP TABLE/COLUMN`, `TRUNCATE`,
   `DELETE FROM`, `UPDATE` danych; typy `types/database.ts` generowane
   z produkcji po wgraniu (Claude wgrywa po scaleniu, w PR wpis „Do
   wgrania: 00NNN, przed wdrożeniem”).
6. UI: shadcn (`@/components/ui/*`), Tailwind, teksty po polsku, Server
   Components domyślnie; żadnych nowych bibliotek UI.
7. Przed PR: `pnpm run ci && pnpm build`; liczby cronów/jobów w testach
   zmieniane świadomie z komentarzem.
8. Opis PR według `.github/pull_request_template.md`; w „Ponowienie od
   zera” — co się stanie, gdy cron wzorców ruszy drugi raz.
9. Produkcję czytamy tylko `scripts/ops/kontrola-faktur-ksef.sh`
   i procedurami z `AGENTS.md`; brak ręcznych odczytów danych klientów.
10. Żadnych adresów, nazw kontenerów ani sekretów w śledzonych plikach
    (repozytorium jest publiczne).

---

## 10. Pułapki — żeby nie policzyć czegoś dwa razy albo źle

- **Skuteczność z `invoices` zamiast z prób** zawyża wynik: faktura po
  trzech porażkach i sukcesie wygląda jak sukces. S1 liczy się
  z pierwszego kolejkowania; S3 z prób.
- **Mianownik bez okna przesuniętego** każe liczyć faktury, które jeszcze
  mają prawo być w ponowieniach. Stąd [T−48 h, T−24 h].
- **`last_error*` na fakturze to tylko ostatnia porażka** — do A5
  historia porażek sprzed POST nie istnieje w bazie; w UI napisać to
  wprost, nie udawać kompletności.
- **`inngest_run_log` nie ma `invoice_id` celowo** (klucze obce wywracały
  zapis). Łączyć po `run_id` = id joba, nie dopisywać kolumny.
- **Drugi cron liczący naruszenia** albo **druga tabela kodów** = dwa
  źródła prawdy. Czytać `ksef_lifecycle_violations()` i `ksef_error_codes`.
- **Schemat `pgboss` nie jest widoczny przez PostgREST.** Wzorzec:
  funkcja SQL w schemacie `ops`/`public` dla roli serwisowej (00100).
- **Nazwa „Inngest” w `/admin/system`** jest historyczna; przemianować
  w ramach centrum, nie tworzyć obok drugiego panelu jobów.
- **Retencja `audit_logs`** (`cron.cleanup-audit-logs`) może być krótsza
  niż 30 dni — sprawdzić przed oknem 30 d; jeśli tak, S1/S9 w 30 d
  dopiero po A5 (wiersze prób mają retencję faktur).
- **`sendAttemptId` jest UUID** — każdy test z fixture musi go mieć
  poprawny, inaczej ścieżka kończy się `INVALID_EVENT` i udaje inny błąd.
- **Czas w bazie to UTC**, dni raportowe to Warszawa — konwersja po
  stronie SQL (`AT TIME ZONE 'Europe/Warsaw'`), nie w JS.

---

## 11. Decyzje do podjęcia (Masło / Bartosz)

| # | Pytanie | Propozycja Claude |
|---|---|---|
| D1 | Gdzie mieszka centrum: `/admin/centrum` czy strona główna `/admin`? | `/admin/centrum` + kafel na `/admin`; po dwóch tygodniach użycia można zamienić miejscami |
| D2 | Wykresy: shadcn `chart` (recharts) czy SVG bez biblioteki? | shadcn `chart` — to komponent shadcn, więc zgodny z AGENTS.md; Masło decyduje |
| D3 | Cele SLI z sekcji 8 | zatwierdzić albo zmienić liczby **przed** fazą 0 |
| D4 | Analityk AI: model, budżet miesięczny, zapis w polityce prywatności | Haiku 4.5 do wyjaśnień, Sonnet do raportu tygodniowego; budżet 20 zł/mies. na start; polityka: potwierdzić z prawnikiem razem z B1 |
| D5 | Loki/Grafana: kiedy i gdzie | po powiększeniu `ops-1`; do tego czasu krok 1 z fazy 6 |
| D6 | Wynik E2E (H1) w centrum: API GitHuba czy tabela z CI | tabela `ops_e2e_runs` zasilana z workflow — niezależna od limitów API; uzgodnić z H1 |
| D7 | Kto robi `ops_alert_log` w monitorze alarmów | Claude w A5 (jeden plik, jedna linia), Codex czyta |

---

## 12. Kolejność i zależności z planem

```
Faza 0 (definicje) ─► Faza 1 (pulpit SLI) ─► Faza 2 (oś czasu, wersja „do A5”)
                                   │
plan: A2 (intent) ─► A5 (ślad per próba) ─┼─► Faza 3 (błędy, wzorce) ─► Faza 4 (wyjaśnienia) ─► Faza 5a
                                   │                                                   └─► Faza 5b/5c (po alfie)
plan: B3 (health log) ─────────────┴─► panel KSeF
plan: H1 (E2E) ─► panel E2E;  plan: H2 (game day) używa centrum jako kryterium „sygnał ≤ 15 min”
Faza 6 krok 1 w A5; krok 2 po decyzji D5.  Faza 7 po alfie.
```

Fazy 0–2 można zacząć **teraz**, bez czekania na plan. Fazy 3–4
w pełnej wersji po A5 (do tego czasu na dzisiejszych danych, z jednym
plikiem do podmiany). Faza 5a po 3. Fazy 5b/5c i 7 po pierwszym
prawdziwym ruchu.

---

## 13. Jak odpowiedzieć

Codex odpowiada w `CLAUDE-DO-CODEXA.md` pod **C-22** (sekcja „Odpowiedź
Codexa”): które fazy bierze, w jakiej kolejności, jakie decyzje z sekcji
11 potrzebuje od Bartosza i co w tym briefie uważa za błędne — z plikiem
i linią. Zmiany w kontrakcie z sekcji 5 uzgadniamy **przed** A5, bo potem
zmienia się runner.
