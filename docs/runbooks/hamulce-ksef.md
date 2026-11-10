# Hamulce wysyłki do KSeF

Krok 5 planu automatyzacji (1 października 2026). Trzy blokady, które
zatrzymują wysyłkę, zanim faktura dotrze do KSeF, oraz jedna reguła
konfiguracji, która nie pozwala jobom zniknąć po cichu.

| Hamulec | Kiedy działa | Co widzi użytkownik |
|---|---|---|
| Wyłącznik `killAllKsefSubmissions` | operator włącza go SQL-em | „Wysyłka faktur do KSeF jest chwilowo wstrzymana…”: pierwsza wysyłka — faktura zostaje szkicem; „Wyślij ponownie” — „tej wysyłki nie wykonaliśmy”, faktura zostaje z błędem wysyłki; w jobie (`KSEF_PAUSED`) — zwykła wyjdzie automatycznie po zdjęciu, KOR/ZAL tylko w dniu wystawienia |
| Blokada korekt (`KOR_HOLD`) | zawsze przy `KSEF_ENV=production` | „Wysyłka faktur korygujących… wstrzymana do czasu poprawki ich kwot”: przy wysyłce korekta zostaje szkicem; w jobie — „po zdjęciu blokady tej korekty sami nie wyślemy”, bez przycisków, napisz do pomocy FaktFlow (pomoc@faktflow.pl) |
| Blokada ROZ (`ROZ_HOLD_RECONCILE`) | zawsze (wcześniejsza zmiana) | „Wysyłka faktur rozliczeniowych… wstrzymana”: przy wysyłce dokument zostaje szkicem; w jobie — „po zdjęciu blokady tej faktury sami nie wyślemy”, bez przycisków, napisz do pomocy FaktFlow |
| `JOBS_BACKEND` jawny | poza lokalnym środowiskiem | brak zmiennej = zlecenie odrzucone, worker nie startuje |

Każdy hamulec sprawdzany jest w trzech miejscach: przy kolejkowaniu
(`lib/invoices/ksef-submit-enqueue.ts`), na starcie joba przed sondą zdrowia
i Offline24 oraz tuż przed wysyłką (`lib/jobs/runners/submit-invoice.ts`).
Zatrzymana faktura dostaje status `failed` z kodem w `last_error_code`
— to stan „do uzgodnienia”, nie „odrzucona przez KSeF”. Mail o odrzuceniu
nie wychodzi.

Automatyczna pauza firmy po 429 z KSeF to nie hamulec operatora: nie ma
flagi, nie zapisuje kodu w fakturze i zdejmuje się sama — sekcja
[„Pauza firmy po 429 (L1a)”](#pauza-firmy-po-429-l1a).

## Wyłącznik wszystkich wysyłek

Kiedy: KSeF przyjmuje faktury z błędem po naszej stronie, podejrzenie
podwójnych wysyłek, incydent bezpieczeństwa z certyfikatami, prośba MF.

Globalne flagi nie mają przełącznika w `/admin/flags` (tam są tylko flagi
per organizacja), więc włączasz je w bazie:

```bash
source .agents/infra.env
ssh -i $K root@$DB "docker exec $PGC psql -U postgres -d postgres -c \
  \"UPDATE public.global_feature_flags
      SET enabled = true, updated_at = now(), updated_by = 'operator',
          note = 'powód i godzina'
    WHERE flag = 'killAllKsefSubmissions'
    RETURNING flag, enabled, updated_at;\""
```

Działa natychmiast: kolejkowanie i job czytają flagę wprost z bazy, z pominięciem
60-sekundowego cache. Jeśli `RETURNING` nie zwróci wiersza, flagi brakuje
w tabeli — dopisz ją `INSERT … ON CONFLICT (flag) DO UPDATE`.

Wyłączenie: to samo z `enabled = false`.

**Co dzieje się z fakturami w trakcie:**

- Nowe kliknięcia „Wyślij” zwracają komunikat i zostawiają szkic.
- „Wyślij ponownie” przy fakturze z błędem: komunikat, faktura zostaje
  z błędem wysyłki (nie szkic).
- Joby już w kolejce kończą się stanem `failed` / `KSEF_PAUSED`.
- Kolejki Offline24 wyłącznik nie dotyczy. Automatyczny Offline24 jest
  wyłączony od 02.10.2026: zdarzenia z kolejki job odrzuca przed hamulcem,
  a cron `cron.process-offline-queue` zamyka stare wpisy niezależnie od
  wyłącznika. Faktura może przy tym zostać w `offline_queued` bez wyjścia —
  sprawdź sekcję 4a `kontrola-faktur-ksef.sh` i postępuj według
  [offline24-zalegle.md](./offline24-zalegle.md).
- Wysyłka, która przed włączeniem doszła do KSeF, ma numery w
  `ksef_submissions`. Ponowne wysłanie po zdjęciu wyłącznika najpierw zapyta
  KSeF o jej status, więc nie powstanie duplikat.

Po zdjęciu wyłącznika cron cyklu życia (I7, co 15 min) sam wznawia faktury
`KSEF_PAUSED` z danymi do ponowienia: zwykłe każdego dnia, KOR/ZAL z kopią
tylko w dniu wystawienia (KOR na PROD i ROZ nigdy — C4). Faktury, które
zostają (brak danych, dokument specjalny po dacie wystawienia, wstrzymany
rodzaj), klient widzi z powodem i przyciskiem „Wróć do szkicu”. Lista
faktur, które nadal czekają:

```sql
SELECT id, tenant_id, internal_number, invoice_kind, issue_date, updated_at
  FROM public.invoices
 WHERE ksef_status = 'failed' AND last_error_code = 'KSEF_PAUSED'
 ORDER BY updated_at;
```

Błąd odczytu flagi (baza niedostępna) też blokuje wysyłkę: kolejkowanie
zwraca komunikat „spróbuj ponownie”, a job ponawia próbę. Awaria bazy nie
może po cichu zdjąć wyłącznika.

## Rejestracja i przerwa techniczna

Dwie pozostałe flagi globalne, włączane tym samym `UPDATE` co wyżej
(`flag = 'disableSignups'` albo `'maintenanceMode'`). Rejestrację wyłącza też
bramka: `/wylacz rejestracja`.

| Flaga | Co blokuje | Błąd odczytu flagi |
|---|---|---|
| `disableSignups` | zakładanie nowych kont: formularz `/register` (bez przycisku Google) i hook GoTrue z 00102 (e-mail, pierwsze logowanie Google, API; działa przy `GOTRUE_HOOK_BEFORE_USER_CREATED_*` na `db-1`), oraz **pierwszej** firmy w aplikacji (`app/actions/organizations.ts`); działają logowanie, kolejne firmy klientów i przyjęcie zaproszenia przez osobę z kontem, a osoba bez konta dostanie mail, ale przyjmie zaproszenie dopiero po zdjęciu flagi (link ważny 7 dni) | rejestracja zamknięta |
| `maintenanceMode` | panel zalogowanego i onboarding → `/przerwa-techniczna`, prywatne API → 503 `maintenance`; działają strony publiczne, logowanie, `/admin`, `/api/health`, webhooki, joby | ostatnia znana wartość, a bez niej panel działa |

`disableSignups` działa od razu (odczyt wprost z bazy). `maintenanceMode`
proxy pamięta do 30 s w każdym procesie web — tyle trwa włączenie i zdjęcie.

## Blokada korekt na produkcji

Generator korekt wysyła wartości „po” zamiast różnicy i zamienia `zw` na 23%
(AUD-03, AUD-04). Dopóki to nie jest naprawione, korekta przy
`KSEF_ENV=production` zostaje szkicem. Na KSeF TEST wysyłka działa, żeby
dało się sprawdzić poprawkę.

Zdjęcie blokady to zmiana w kodzie (C4 planu), razem z poprawką generatora
i testami kwot: `lib/ksef/kind-holds.ts` (`isCorrectionHeldForEnv`,
`isKindHeldForEnv` — z nich korzystają cron, panel operatora i przyciski
klienta), `lib/ksef/roz-submission-hold.ts` (ROZ), kolejkowanie
`lib/invoices/ksef-submit-enqueue.ts` i `lib/ksef/submit-invoice-full.ts` —
wszystkie razem. Nie przełączaj jej flagą. Faktury `failed KOR_HOLD`
i `ROZ_HOLD_RECONCILE` po zdjęciu nie wyjdą same (I7 wznawia tylko
`KSEF_PAUSED`) — C4 rozstrzyga je osobno; do tego czasu klient pisze do
pomocy FaktFlow (procedura w `ksef-error-codes.md`).

## `JOBS_BACKEND`

Jedyny backend to pg-boss — Inngest odpięty 02.10.2026 (etap 10), **bez
ścieżki powrotu**. Produkcja ma `JOBS_BACKEND=pgboss` w obu aplikacjach
Coolify (id=1 i id=2, `is_preview = false`); brak zmiennej też oznacza
pg-boss. Nieobsługiwana wartość (literówka, dawne `inngest`):

- kolejkowanie rzuca błąd — zlecenie nie wychodzi,
- `/api/health` zwraca 503 (`checks.env = fail`; wymaga też `DATABASE_URL`),
- worker nie startuje.

Lokalnie: `DATABASE_URL` do bazy z kolejką i `pnpm worker:dev`.

## Pauza firmy po 429 (L1a)

**Co to.** MF liczy limity API na parę (NIP, adres IP), a cała platforma
wysyła z jednego adresu (`app-1`). Po 429 MF blokuje kolejne żądania na czas
z `Retry-After`; powtórki wydłużają blokadę, a przy powtarzających się
naruszeniach MF może zablokować podmiot albo zakres adresów IP, czyli
wszystkie firmy naraz (`ksef-docs/limity/limity-api.md`). Dlatego po każdej
odpowiedzi 429 czeka cała firma (środowisko + NIP): wysyłka, uzgodnienie,
UPO, skrzynka i historia. Bramka w `ksefFetch` (`lib/ksef/client.ts`) nie
wysyła wtedy żadnego żądania tej firmy i od razu zwraca lokalny 429
(`KsefRateLimitPausedError`). Kod: `lib/ksef/rate-limit-pause.ts`. W logach
kod `KSEF_RATE_LIMIT_PAUSE`; `KSEF_PAUSED` to wyłącznik operatora z sekcji
wyżej, nie ta pauza.

**Pomiar na KSeF TEST (10.11.2026, scenariusz 17, przebieg 98822DEB).** Po
429 na otwarciu sesji (`onlineSession`, `Retry-After` 58 s) MF blokował tylko
tę grupę: `GET /rate-limits` (`other`) i status faktury (`invoiceStatus`)
odpowiadały 200, a inna firma wysłała bez czekania. Pauza całej firmy jest
więc ostrożniejsza niż MF; zostaje świadomie (eskalacja blokady do podmiotu
albo zakresu IP). Zawężenie pauzy do grupy to osobna decyzja.

**Gdzie jest stan.** Redis na `app-1` (bez migracji, stan ulotny):

| Klucz | Co trzyma | Wygasa |
|---|---|---|
| `ff:ksef:pause:<środowisko>:<nip>` | koniec pauzy w ms od 1970 | z końcem pauzy (`px` = długość pauzy) |
| `ff:ksef:rl429:<środowisko>` | zbiór NIP-ów z czasem ostatniego prawdziwego 429 (okno hamulca) | 10 min po ostatnim wpisie |

Proces, który dostał 429 (zwykle worker), trzyma kopię pauzy w pamięci.
Awaria albo brak Redisa nie zatrzymuje wysyłki: odczyt ma limit 1 s, potem
liczy się sama pamięć procesu (fail-open). Inny proces (worker po restarcie)
widzi pauzę z Redisa z opóźnieniem do 5 s.

**Czego pauza NIE obejmuje (stan 10.11.2026).**

- Logowania w kreatorze połączenia KSeF w aplikacji web
  (`components/settings/actions.ts`): idzie bez kontekstu NIP, więc nie czeka
  na pauzę, a jego 429 jej nie zapisuje. Ruch mały (ręczne logowanie, limit
  prób), do dopięcia osobno.
- Sondy zdrowia KSeF i Latarni (bez uwierzytelnienia, bez NIP-u).
- Wyniku prawdziwego 429 na samym żądaniu UPO: pauza firmy jest zapisana,
  ale ten jeden wpis UPO dalej kończy się jak dotąd (`HTTP_429`, `failed`,
  powrót przez `upo-retry-stale` po 24 h). Zmianę klasyfikacji robi sesja D1
  planu „zero zgubionych faktur”. Pozostałe żądania UPO tej firmy czekają na
  pauzę.
- Skrzynki i historii jako harmonogramu: mają własne terminy (`next_poll_at`,
  `paused_until`) liczone z pozostałego czasu pauzy, więc nigdy nie ruszą
  przed jej końcem. Przy 429 bez `Retry-After` skrzynka i historia czekają
  po swojemu 15 min, a wspólna pauza firmy tylko 60 s.

**Ile trwa.**

- Pełny `Retry-After` z odpowiedzi, bez dawnego obcięcia do godziny; bez
  nagłówka 60 s; najwyżej doba (bezpiecznik na absurdalny nagłówek). Kolejny
  429 tylko wydłuża pauzę, nigdy jej nie skraca.
- Job wysyłki w pauzie czeka do jej końca z rozrzutem w górę (20%, od 5 s do
  5 min), żeby faktury, które padły razem, nie wróciły w tej samej sekundzie.
  Nie zużywa ani próby, ani odczekań (`MAX_WAIT_RETRIES`).
- Budżet łańcucha pauz jednej wysyłki: doba od pierwszej pauzy
  (`MAX_PAUSE_CHAIN_MS`, `lib/jobs/retry.ts`). Potem każda pauza liczy się
  jak zwykła próba, a po wyczerpaniu prób faktura dostaje `failed
  KSEF_RATE_LIMIT` (TRANSIENT): cron I6 ponawia ją co 60 min przez 24 h,
  potem `TRANSIENT_EXHAUSTED` i alarm (`cykl-zycia-faktury-ksef.md`, I6).
- Dokument specjalny (KOR, ZAL, ROZ), który przez pauzę dojdzie do wysyłki po
  północy, kończy się `ISSUE_DATE_PASSED` (00147), jak każde ponowienie po
  dacie wystawienia.

**Co widzi klient.** Faktura „W kolejce” (`queued`) do końca pauzy, bez
osobnego komunikatu o limicie. Pauza zastana przed przejęciem wysyłki czeka
w `queued`. 429 w trakcie wysyłki zwalnia przejęcie (`sending` → `queued`,
`cykl-zycia-faktury-ksef.md`, sekcja 4), więc pauza nie trzyma faktury
w `sending` i nie włącza alarmu I2. Po pauzie job najpierw uzgadnia
poprzednią próbę (zamiar albo wpis `sent`), więc nie wyśle faktury drugi
raz. UPO w pauzie czeka na ponowienie zamiast kończyć się błędem (poza
prawdziwym 429 na samym żądaniu UPO, sekcja wyżej). Skrzynka
przesuwa przebieg firmy na koniec pauzy (`skrzynka-ksef-pojemnosc.md`).

**Skąd widać pauzę.**

- log workera: `code: KSEF_RATE_LIMIT_PAUSE` z `remainingMs`;
- `ksef_send_attempts`: wiersz `waiting` z etapem `pause` (pauza przed
  przejęciem) albo `ksef_http_status = 429` (prawdziwa odpowiedź MF; lokalna
  pauza nie ma statusu HTTP, bo żądanie nie wyszło);
- stan klucza: skrypt niżej.

**Co robi operator.** Jedna linia, skrypt sam ładuje `.agents/infra.env`:

```bash
./scripts/ops/ksef-pauza.sh stan <środowisko> <nip>
./scripts/ops/ksef-pauza.sh zdejmij <środowisko> <nip> --tak
```

1. Zwykle nic: pauza kończy się sama, a faktury wychodzą po niej bez
   udziału klienta.
2. `stan` pokazuje koniec pauzy, ile zostało (`PTTL`) i ile firm ma 429
   w ostatnich 10 minutach. Tylko odczyt.
3. `zdejmij` usuwa klucz pauzy (`DEL`); bez `--tak` tylko pokazuje stan.
   Zdejmuj **tylko**, gdy masz pewność, że blokada MF już minęła (błędny
   nagłówek, potwierdzenie MF). Pierwsze żądanie przed końcem blokady dostaje
   znów 429, a powtórki wydłużają blokadę, przy kolejnych naruszeniach także
   dla zakresu IP, czyli wszystkich firm.
   `DEL` działa w każdym procesie najpóźniej po 5 s (odświeżenie odczytu
   z Redisa), także w workerze, który pauzę zapisał. Wyjątek: pauza zapisana
   w chwili awarii Redisa żyje tylko w pamięci procesu i kończy się sama
   (najwyżej po dobie); restart workera to wdrożenie, czyli zgoda Bartosza
   (AGENTS.md), a nie sposób na pauzę.
   `DEL` NIE przyspiesza zadań, które już czekają: każde ma w pg-boss termin
   startu (`start_after`) z chwili zapisu pauzy i ruszy dopiero wtedy. Od razu
   ruszają nowe zlecenia i żądania (np. „Wyślij ponownie”, nowa faktura).
   Skrzynka i historia trzymają też własny termin (`next_poll_at`,
   `paused_until` w bazie, `ksef-historia.sh wznow`).
4. Skrypt nie był jeszcze uruchomiony na serwerze (stan 09.11.2026). Pierwsze
   użycie zacznij od `stan`. Założenia w nagłówku skryptu: kontener z obrazem
   `redis:7…` na `app-1` (nie nakładka SRH; przy kilku pasujących podaj
   `REDISC=<nazwa>`), hasło w zmiennej `REDIS_PASSWORD` kontenera.

**Hamulec 429 (wiele firm naraz).** Co najmniej 5 różnych firm z prawdziwym
429 (z dowolnego żądania firmy: wysyłka, UPO, skrzynka, historia)
w ostatnich 10 minutach to już nie limit jednej firmy, tylko sygnał, że MF
ogranicza nasz adres. Wtedy każde zadanie wysyłki przechodzi z szansą ok. 1/4
na minutę (wybór z id faktury i minuty, co minutę od nowa), a reszta czeka
minutę z rozrzutem, bez zużycia próby. Hamulec gaśnie sam po 10 minutach bez nowego 429. Alarm Sentry
`ksef-rate-limit-brake` (ostrzeżenie, najwyżej raz na 10 minut). Gdy trwa:
sprawdź, czy to nie nasz rytm (wdrożenie, fala ponowień po awarii KSeF) i czy
MF nie obniżył limitów. Skrzynka ma własny hamulec, który liczy też firmy we
wspólnej pauzie (`skrzynka-ksef-pojemnosc.md`).
W odróżnieniu od hamulca skrzynki ten nie ma warunku udziału (20% aktywnych
firm), bo proces nie liczy firm, które w oknie wysyłały: przy dużym ruchu
5 firm z 429 też go włącza. Świadomie ostrożnie: hamulec tylko spowalnia
(1/4 zadań na minutę), niczego nie zatrzymuje na stałe. Licznik na żądanie
i na adres IP to karta L1b.

## Faktura utknęła w wysyłce (I1/I2)

Objaw: faktura od dawna „Wysyłanie” (`sending`) albo „W kolejce” (`queued`);
alarm strażnika I2 (`stale_ksef_sending_invoices`) albo I1; w `/admin/ksef`
przyciski wyłączone („tylko failed”).

| Inwariant | Stan | Kiedy | Kto sprząta |
|---|---|---|---|
| I2 | `sending` | przejęta ponad 30 min temu (dzierżawa 15 min + 15 min) albo bez znacznika przejęcia | **nikt automatycznie** — strażnik tylko alarmuje; RPC operatora przyjmują wyłącznie `failed`/`rejected` |
| I1 | `queued` | ponad 15 min bez zlecenia w pg-boss | cron cyklu życia co 15 min (szkic albo `ENQUEUE_LOST`); skrypt — gdy cron nie działa |

Przyczyny I2: worker przerwany w trakcie wysyłki (wdrożenie, OOM), a zlecenie
w pg-boss nie wróciło; nieudany zapis wyniku. Dopóki w pg-boss żyje zlecenie
tej faktury (`created`, `retry`, `active`), **nic nie rób** — po wygaśnięciu
dzierżawy worker sam ją przejmie (00124) i najpierw uzgodni poprzednią próbę.

**Procedura** — jedna linia, sama ładuje `.agents/infra.env`:

```bash
./scripts/ops/zwolnij-utknieta-wysylke.sh <id-faktury>
```

Bez opcji tylko sprawdza i pisze werdykt: stan, właściciel i czas przejęcia,
żywe zlecenia w pg-boss, dowód kontaktu z KSeF, otwarty wpis wysyłki. Zapis
dopiero z `--wykonaj` (jedna transakcja, wiersz faktury zablokowany na czas
decyzji; gdy zapis nie trafi dokładnie w jeden wiersz — wycofanie):

- **I2** → `failed RESULT_UNCERTAIN` („Czekamy na potwierdzenie z KSeF. Nie
  wystawiaj tej faktury ponownie.”), przejęcie zdjęte, `submitted_to_ksef_at`
  zostaje jako ślad, audyt `invoice.send_lease_released` (poprzedni właściciel,
  dowód kontaktu). Dalej `/admin/ksef/<id>`: przy otwartym wpisie **„Tylko
  uzgodnij”** (po 48 h cron I5 zrobi to sam), bez niego **„Wyślij ponownie”**
  — runner zaczyna od uzgodnienia, więc nie powstanie duplikat; klient może też
  wrócić do szkicu, jeśli faktura nie ma dowodu kontaktu z KSeF.
- **I1** → to samo co cron: szkic przez `release_ksef_enqueue` (bez dowodu
  kontaktu), inaczej `failed ENQUEUE_LOST` z audytem `invoice.enqueue_lost`.

Skrypt odmawia (i nic nie zmienia), gdy faktura nie jest w I1/I2 albo w pg-boss
żyje jej zlecenie. Warunki i zapis: `scripts/ops/zwolnij-utknieta-wysylke.sql`
(test na bazie: `tests/rls-zwolnij-utknieta-wysylke.test.ts`).
