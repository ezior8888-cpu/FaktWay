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
| `disableSignups` | formularz `/register` (bez przycisku Google) i zakładanie **pierwszej** firmy — konto z Google albo prosto z GoTrue bez firmy nic nie może; zaproszenia i kolejne firmy istniejących klientów działają | rejestracja zamknięta |
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
