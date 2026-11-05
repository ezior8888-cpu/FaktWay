# Test obciążenia odpytywania Skrzynki KSeF

Odpowiada na jedno pytanie: ile firm z KSeF wytrzyma worker pg-boss przy danej
liczbie slotów, zanim firmy zaczną czekać dłużej, niż mówi harmonogram. Wyniki
i wzór pojemności: [`docs/runbooks/skrzynka-ksef-pojemnosc.md`](../../docs/runbooks/skrzynka-ksef-pojemnosc.md).

## Jedna komenda

```bash
pnpm db:local env                         # .env.local na lokalną bazę
pnpm load:inbox --firms=3000 --minutes=18
```

Wynik na końcu i w `load-tests/ksef-inbox/wyniki/<id>-wynik.json` (katalog poza
gitem, jest tam też log workera i próbki pamięci). Firmy i schemat kolejki znikają
same, także po Ctrl+C. Po przerwanym procesie: `pnpm load:inbox --sprzataj`.

| Argument | Domyślnie | Co robi |
|---|---|---|
| `--firms` | 1000 | ile firm zasiać |
| `--minutes` | 18 | jak długo mierzyć (poniżej 16 min nie widać drugiego cyklu firm gorących) |
| `--slots` | 16 | `KSEF_INBOX_POLL_SLOTS` workera |
| `--mix` | `60,25,10,5` | udział poziomów: gorąca, ciepła, zimna, uśpiona |
| `--faktur` | 60 | faktur na firmę miesięcznie w atrapie |
| `--blad-429`, `--blad-5xx` | 0,005 | szansa losowego błędu na żądanie |
| `--wszystkie-naraz` | nie | wszystkie firmy należne od razu (po awarii) zamiast równo w cyklu |
| `--etykieta` | | nazwa przebiegu w wyniku |

## Co jest prawdziwe, a co nie

Prawdziwe: `lib/jobs/worker.ts`, cron rozsyłki, runner, klient HTTP KSeF, logowanie
XAdES z podpisem RSA, szyfrowanie certyfikatów, lokalny Postgres i PostgREST.

Atrapa tylko po drugiej stronie HTTP (`atrapa-ksef.mjs`), przez `KSEF_TEST_URL`.
Klient KSeF przyjmuje inny adres wyłącznie na pętli zwrotnej i poza produkcją
(`getKsefBaseUrl`). Opóźnienia: logowanie 2-4 s, zapytanie o metadane 300-800 ms,
odświeżenie 150-400 ms, losowe 429 i 503. Limit z dokumentacji MF (16/min, 20/h na
NIP) atrapa egzekwuje osobno od losowych błędów i liczy w `limit429`.

Worker dostaje własny schemat pg-boss (`JOBS_PGBOSS_SCHEMA`) i tylko cron rozsyłki
(`WORKER_ONLY_CRONS`), bo lokalna baza bywa wspólna, a pozostałe crony (retencja,
maile, kopie) pracowałyby na cudzych danych. Obie zmienne działają tylko poza
produkcją (`lib/jobs/config.ts`).

## Co mierzy

| Pole wyniku | Skąd | Co znaczy |
|---|---|---|
| `lag_s` | `started_on − dueAt` z `job` | opóźnienie względem harmonogramu; `afterWarmup` bez pierwszych 15 min, gdy wszystkie firmy logują się od zera |
| `jobs.perMinuteAvg`, `perMinuteMax` | `completed_on` z `job` | przepustowość |
| `tick` | linia `ksef.inbox.dispatch`, czas zadania crona | czas taktu i zaległość |
| `ksef.logins`, `refreshes`, `queries` | liczniki atrapy | ile pełnych logowań XAdES, ile odświeżeń, ile zapytań |
| `ksef.gapsByTier` | atrapa, po NIP | realny odstęp między zapytaniami firmy, na poziom |
| `worker.rss*`, `cpuPercent` | `licznik-procesu.mjs` | pamięć i procesor procesu (100 = jeden rdzeń) |
| `worker.dbQueriesPerMinute` | jw. | żądania PostgREST i zapytania połączenia pg-boss |
| `notKeepingUp` | `ksef_inbox_schedule` na końcu | firmy spóźnione ponad 5 min i ponad próg alarmu |

## Czego ten test nie oddaje

- **Limitów po adresie IP na prawdziwym KSeF.** Dokumentacja podaje limity na parę
  (NIP, IP) i mówi o możliwej blokadzie zakresu adresów przy skrajnym ruchu, bez
  liczby. Jedno IP z tysięcy firm trzeba sprawdzić na DEMO albo PROD przy małym ruchu.
- **Prawdziwych opóźnień MF.** W godzinach szczytu i w dni terminów mogą być inne.
- **Sprzętu `app-1`.** Mac ma więcej rdzeni i pamięci niż 2 vCPU i 4 GB. Liczy się przyrost
  pamięci na firmę, bo stan wyjściowy jest inny (produkcja: ok. 190 MB przy 4 firmach).
- **Sieci do bazy.** Postgres i PostgREST są na tej samej maszynie, bez `db-1`.
- **Wysyłki, UPO i historii KSeF.** Ten worker robi tylko skrzynkę; na produkcji dzieli
  z nimi proces, a z historią też limit metadanych na firmę.
