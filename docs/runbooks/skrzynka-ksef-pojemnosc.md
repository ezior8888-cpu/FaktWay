# Skrzynka KSeF: harmonogram i pojemność odpytywania

Dla operatora: jak działa odpytywanie, skąd widać, że nie nadąża, i co wtedy zrobić.
Kod: `lib/ksef/inbox-schedule.ts` (wszystkie liczby), `lib/jobs/runners/inbox-polling.ts`,
migracja `00160`. Test obciążenia: `load-tests/ksef-inbox/`.

## Jak to działa

Cron `cron.inbox-polling` co minutę bierze firmy, których termin (`next_poll_at`) minął,
do limitu slotów, i zapisuje im zlecenia w jednej transakcji z dzierżawą. Reszta należnych
czeka na następny takt, od najdawniej należnych. Worker odpytuje KSeF od HWM, więc przerwa
dowolnej długości nie gubi faktur: dłuższa niż 90 dni idzie kolejnymi oknami co 5 minut.

| Poziom | Warunek (liczony po każdym przebiegu) | Odstęp w dzień | W nocy (22-6) |
|---|---|---|---|
| gorąca | ktoś z firmy aktywny w 24 h, albo subskrypcja i nowa faktura w 7 dni | 15 min | 15 min |
| ciepła | subskrypcja i cokolwiek w 30 dni | 60 min | 2 h |
| zimna | subskrypcja, nic od 30 dni | 6 h | 12 h |
| uśpiona | bez subskrypcji i próby, nikt nie pracuje w aplikacji | 24 h | 24 h, nigdy rzadziej |

Termin to stałe miejsce firmy w cyklu, wyliczone z jej id. Po awarii, gdy wszystko jest
należne naraz, następny cykl jest znów równomierny, a firmy nie ruszają w tej samej minucie.

Przyspieszają termin: wejście do Skrzynki i „Sprawdź teraz” (najwyżej raz na 5 minut na
firmę), aktywność w panelu (termin najpóźniej za 15 minut), nowy certyfikat (termin „teraz”,
błędy na zero).

Po błędzie:

| Błąd | Następna próba |
|---|---|
| zły certyfikat, brak uprawnienia | 1 h, 2 h, 4 h … do 24 h; naprawia klient, nowy certyfikat zeruje licznik |
| KSeF 5xx, timeout, sieć, nasz błąd | 5, 10, 20 … min, gorąca najdalej 15 min, reszta najdalej godzina |
| KSeF 429 | tyle, ile każe `Retry-After`; bez nagłówka 15 min |

Hamulec: co najmniej 5 firm z 429 w 10 minut i co najmniej 20% odpytanych zmniejsza pojemność
rozsyłki czterokrotnie. Dokumentacja MF: powtarzane przekroczenia wydłużają blokadę, także dla
zakresu adresów.

## Limity KSeF, które przyjęto

Źródło: `CIRFMF/ksef-docs`, `limity/limity-api.md`, `open-api.json`, stan z 02.11.2026.

| Co | Limit | Skutek w kodzie |
|---|---|---|
| `POST /invoices/query/metadata` | 8/s, 16/min, 20/h na parę (NIP, adres IP) | gorąca 4/h, „Sprawdź teraz” najwyżej 12/h, razem 16/h; ten sam limit zużywa historia KSeF (1-2 zapytania na 15 min) i ona ustępuje skrzynce |
| interwał cykliczny | nie krócej niż 15 min na podmiot | poziom gorący; termin firmy spóźnionej wypada najbliżej po 7,5 min |
| `/auth/*`, także `/auth/token/refresh` | 60/s (OpenAPI, `x-rate-limits`), `/auth/challenge` na adres IP | odświeżenie nie jest wąskim gardłem |
| noc 20-6 na PROD | wyższe limity pobierania, liczb brak | nie przyjęto nic |

Dokumentacja nie podaje limitu na sam adres IP poza `/auth/challenge`. Mówi tylko, że przy
skrajnym ruchu MF może zablokować zakres adresów.

## Sesja KSeF

Token dostępu żyje kilkanaście minut, refresh token do 7 dni. Przebieg odświeża token
(`POST /auth/token/refresh`), a pełne logowanie XAdES idzie dopiero po odrzuceniu refresh
tokenu, po jego wygaśnięciu albo przy nowym certyfikacie. Tokeny są tylko w pamięci procesu:
restart workera to jedno logowanie na firmę, kiedy przyjdzie jej termin.

## Skąd widać, że nie nadąża

Jedna linia na takt w logu workera:

```json
{"msg":"ksef.inbox.dispatch","due":12,"sent":12,"inFlight":3,"limit":477,"slots":16,"oldestLagSeconds":41,"rateLimitedRecent":0,"braking":false,"durationMs":23}
```

| Pole | Znaczenie | Niepokojące |
|---|---|---|
| `oldestLagSeconds` | opóźnienie najstarszej należnej firmy | rośnie z taktu na takt, ponad 300 s poza godziną po wdrożeniu |
| `due` vs `sent` | należne vs wysłane w tym takcie | `due` stale wyższe od `sent` |
| `inFlight` | zlecenia czekające i trwające | równe `limit + inFlight` przez wiele taktów: sloty nie przerabiają |
| `braking` | hamulec 429 | `true` dłużej niż kilka minut |

Opóźnienie po fakcie, z kolejki (przez `scripts/ops/kontrola-faktur-ksef.sh` albo psql na `db-1`):

```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) AS p50_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY lag) AS p95_s,
       max(lag) AS max_s, count(*) AS przebiegi
  FROM (SELECT extract(epoch FROM started_on - (data->>'dueAt')::timestamptz) AS lag
          FROM pgboss.job
         WHERE name = 'inbox.poll.tenant'
           AND data ? 'dueAt'
           AND started_on > now() - interval '1 hour') x;
```

Alarm `stale_inbox_sync` (`critical-alerts-monitor`, co 5 minut) patrzy na harmonogram, a nie
na stałą liczbę godzin. Firma zimna po 5 h jest w normie, firma gorąca po 2 h nie.

| Klasa w alarmie | Warunek | Co to znaczy |
|---|---|---|
| Termin minął | `next_poll_at` starszy niż 60 min | rozsyłka albo worker stoi, albo sloty nie nadążają |
| Błędy KSeF albo nasze | błędy i bez sukcesu dłużej niż normalny odstęp poziomu + 90 min | przebiegi padają: Sentry, `ksef_down` |
| HWM stoi | HWM starszy niż normalny odstęp poziomu + 6 h | przebiegi przechodzą, a KSeF nie daje kompletu |
| Bez harmonogramu | żywa firma bez wiersza | wyzwalacz z 00160 nie zadziałał |
| Podejrzane błędy certyfikatu | co najmniej 3 firmy i 20% żywych | nasz klucz albo rotacja, nie klienci |

Firmy usunięte, nieaktywne i z wygasłym certyfikatem nie są odpytywane i nie budzą.

## Co zmierzono (02.11.2026)

`pnpm load:inbox` na Macu z M4 i lokalną bazą, prawdziwy worker i cron, atrapa KSeF po HTTP
(logowanie 2-4 s, zapytanie 300-800 ms, losowe 429 i 503), rozkład poziomów 60/25/10/5.
Opóźnienie to czas od terminu firmy do startu zadania, po pierwszych 15 minutach.

| Przebieg | Firmy | Sloty | Opóźnienie p50 / p95 / maks. (s) | Zadań na minutę | Logowania XAdES / odświeżenia | Pamięć maks. (MB) | Spóźnione ponad 5 min | Czekające na koniec |
|---|---|---|---|---|---|---|---|---|
| stary kod (rozsyłka co 15 min) | 1000 | 8 | 426 / 887 / 941 | 43 | 1422 / 0 | 362 | 746 | 582 |
| nowy kod, mało slotów | 5000 | 8 | 492 / 545 / 573 | 122 | 2411 / 22 | 382 | 1065 | 105 |
| nowy kod | 1000 | 16 | 32 / 69 / 93 | 42 | 695 / 229 | 420 | 0 | 0 |
| nowy kod | 3000 | 16 | 40 / 81 / 108 | 129 | 2110 / 750 | 342 | 0 | 0 |
| nowy kod | 5000 | 16 | 57 / 103 / 127 | 207 | 3516 / 1137 | 419 | 0 | 0 |
| wszystkie należne naraz (po awarii) | 5000 | 16 | p95 712, całego okresu | 240 | 2899 / 0 | 439 | 2125 | 348 |

Wzór pojemności: jeden slot obsługuje ok. 15 zadań na minutę (16 slotów dało 240 przy
zadaniu trwającym ok. 3,8 s). Potrzebne sloty ≈ zadania na minutę z harmonogramu / 15.
Przy rozkładzie z testu 5000 firm to ok. 207 zadań na minutę, czyli zapas ok. 15%.
Po awarii 5000 firm nadrabia się w ok. 20 minut.

## Co zrobić, gdy przestaje nadążać

Po kolei, od najtańszego:

1. **Sprawdź, czy to nie chwila po wdrożeniu.** Restart workera to logowanie każdej firmy przy
   jej pierwszym terminie. W tabeli wyżej widać, ile to trwa.
2. **Więcej slotów.** `KSEF_INBOX_POLL_SLOTS` na workerze (Coolify) i restart, bez wdrażania kodu.
   Limit rozsyłki liczy się ze slotów sam. Patrz na CPU i pamięć `app-1`: dzieli je z aplikacją web.
3. **Mniej odpytywania.** Odstępy poziomów w `lib/ksef/inbox-schedule.ts`. Faktury nie giną, bo
   okno idzie od HWM, klient czeka tylko dłużej na powiadomienie.
4. **Worker na osobnej maszynie** (`PLAN-SKALOWANIE-3000.md`, etap 3), kiedy procesor `app-1`
   jest zajęty przez slot i aplikację web. Limit KSeF jest na parę (NIP, IP), więc drugi adres
   nie zwiększa limitu firmy, a MF monitoruje używanie wielu adresów w jednym kontekście.
5. **Wniosek do MF o wyższy limit** (dokumentacja zapowiada formularz), jeśli 429 biorą się
   z samego limitu, a nie z naszego rytmu.

## Czego pomiar nie oddaje

- **Limitów po adresie IP na prawdziwym KSeF.** Atrapa egzekwuje tylko limit na firmę. Jedno IP
  z tysięcy firm trzeba sprawdzić na DEMO albo na PROD przy małym ruchu.
- **Prawdziwych opóźnień MF**, zwłaszcza w dni terminów.
- **`app-1`: 2 vCPU i 4 GB.** Pomiar szedł na Macu współdzielonym z innymi procesami. Procesor
  przeliczaj z zapasem; pamięć licz z przyrostu na firmę.
- **Sieci do `db-1` i jej obciążenia.** Baza była na tej samej maszynie.
- **Wysyłki, UPO, historii KSeF i kategoryzacji z AI.** Worker w teście ma tylko cron skrzynki.
  Na produkcji proces i pętlę zdarzeń dzieli z nimi wszystkimi.
- **Odświeżania na prawdziwym KSeF.** Kontrakt jest z OpenAPI, sprawdzony tylko na atrapie.
