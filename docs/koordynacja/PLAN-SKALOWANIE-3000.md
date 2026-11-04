# Plan skalowania: 3000 aktywnych userów

> **Jak zacząć sesję:** napisz „Kontynuuj plan skalowania 3000, sesja N”.
> Agent czyta ten plik, robi checklistę z sekcji 0 i TYLKO wskazaną sesję
> według „Protokołu naprawy błędu” z `AGENTS.md`. Na końcu dopisuje wiersz
> w dzienniku (sekcja 6) z numerem PR.

## Po co ten plan

Zlecenie Bartosza (23.10.2026): przygotować aplikację na 3000 aktywnych
userów **bez zakupu droższych serwerów** (serwery podnosimy razem
z przybytkiem userów, kod ma być gotowy), umożliwić skalowanie **bez
zmieniania całej struktury**, sprawdzić kod pod kątem jakości i szybkości,
zbadać wąskie gardła.

Analiza (24.10.2026, stan `main` 6005c15f) przeszła przez 10 obszarów, a każdy
obszar sprawdził osobny weryfikator. Wyszło 185 ustaleń: 8 KRYT, 51 WYS,
85 ŚRED, 41 NISK, wiele z nich to te same sprawy widziane z różnych stron.
**Pełny raport z dowodami (plik:linia) i rachunkami jest prywatny**
(artefakt „Pojemność FaktWay”, link u Igora i Bartosza). Repo jest publiczne,
a raport opisuje też słabe punkty konfiguracji. Ten plik mówi tylko, co
naprawiamy i w jakiej kolejności.

## Wynik w skrócie

- **Dziś obecny sprzęt i kod nie uciągną 3000 aktywnych userów.** Odczyt
  Bartosza z 25.10 (sekcja 5): db-1 ma 2 vCPU, 4 GB i dysk 40 GB (jak CX23
  z „wariantu budżetowego”, `docs/migration/PRZEPROWADZKA-HETZNER.md`
  §1.7), app-1 i ops-1 też po 2 vCPU i 4 GB. Rachunek procesora db-1
  (szacunek z odczytów, nie test obciążeniowy): dziś ok. 1000 aktywnych
  w zwykły dzień, ale nie w dzień terminu; po sesjach 8, 9 i 19 ok. 1000
  także w szczycie (db-1 ok. 60%); 1500–2000 dopiero na db-1 z 4 vCPU
  (etap 1a). **Wcześniej niż procesor skończą się dysk i pamięć db-1:**
  przy 4 kontach dysk jest zajęty w 79%, a w swapie leży 1,1 GB. Na 3000
  trzeba db-1 z 8 vCPU / 16 GB i dysku poza 40 GB, a do tego etapów
  z sekcji 4 (build w CI, repliki aplikacji z jednego obrazu, worker na
  osobnej maszynie). Żaden z nich nie wymaga przebudowy architektury.
- **Największa dźwignia to sprawdzanie sesji.** Produkcja podpisuje sesje
  kluczem HS256 (publiczny JWKS jest pusty), więc `getClaims()` woła GoTrue
  przez sieć. Proxy robi to 3 razy na każde chronione żądanie, a widok
  panelu łącznie ok. 6 razy.
- **Ruch w tle jest tak duży jak ruch z kliknięć:** baner KSeF co 30 s
  z każdej karty przez pełną bramkę logowania, prefetch 13 tras po każdym
  wejściu, `router.refresh()` co 4 s przy eksportach, telemetria przez proxy.
- **Joby nie są gotowe na tysiące firm:** skrzynka KSeF przestaje nadążać od
  ok. 1000 firm z KSeF (4 sloty, pełne logowanie w każdym przebiegu, rozsyłka
  bez deduplikacji). Kolejki z `batchSize` działają po jednym zadaniu.
  `singletonKey` na polityce `standard` niczego nie deduplikuje.
- **Produkcja ucina każdą odpowiedź bazy do 1000 wierszy** (`PGRST_DB_MAX_ROWS`,
  odczyt 25.10), po cichu i bez błędu, a `.limit(5000)` niczego nie
  zmienia. Przeszukanie kodu z 25.10 nie znalazło tego błędu w eksportach
  księgowych ani na Pulpicie (stronicują przez `readCompletePages`). Crony
  czytają jednak pełne listy firm: od ok. 500 firm z KSeF historia KSeF,
  a od ok. 1000 skrzynka, miesięczna paczka dla księgowej i ostrzeżenia
  o wygasającym certyfikacie zaczną po cichu pomijać część firm. Alarmy,
  które miałyby to wykryć, liczą na tych samych obciętych listach
  (sesje 27–29).
- **Czas jest groźniejszy niż userzy:** nocna kopia JSON trzyma całą bazę
  w pamięci workera, sprzątanie dzienników nie mieści się w limicie 8 s,
  dysk db-1 (40 GB, już 79%: obrazy Dockera, dziennik systemowy, dane
  bazy) zapełnią dzienniki i lokalne zrzuty, a dysk ops-1, gdzie stoi
  MinIO z plikami (wolne ok. 28 GB), pełnowymiarowe zdjęcia paragonów.
- **Już dziś nie działa:** upload zdjęcia paragonu powyżej 1 MB (domyślny
  limit Server Actions).

## 0. Checklista startowa (każda sesja)

1. `git fetch origin` i nowa gałąź od `origin/main`:
   `git switch -c claude/skal-<N>-<temat> origin/main`. Nigdy od lokalnego `main`.
2. Przeczytaj w `AGENTS.md` „Protokół naprawy błędu” i „Co NIE robić”.
3. Przeczytaj swoją sesję w sekcji 3 i ustalenia, które wskazuje. Jeśli
   masz dostęp do prywatnego raportu, przeczytaj tam pełne wpisy.
4. Sprawdź, czy otwarty PR nie rusza tych samych plików:
   `gh pr list --state open --json number,title,headRefName`.
5. Worktree bez `node_modules`: `pnpm install --frozen-lockfile`.
6. Sprawdź, czy kod nadal wygląda tak, jak opisuje sesja. `main` idzie do
   przodu, więc ustalenie mogło się zmienić albo zniknąć.

## 1. Zasady tego planu

- **Jedna sesja = jedna gałąź = jeden PR.** Najpierw czerwony test, potem
  naprawa (protokół z `AGENTS.md`).
- **Pomiar przed i po w opisie PR.** Przy wydajności czerwony test to
  zwykle licznik: wywołań GoTrue na żądanie, zapytań na render, zadań
  w kolejce, rozmiaru pamięci. Liczba przed i po naprawie trafia do opisu.
- **Migracje (sesje 20–21):** sesja przygotowuje plik z numerem z rejestru
  w `CLAUDE-DO-CODEXA.md` i opisuje, czy wgrać go przed, czy po wdrożeniu.
  Wgrywa Bartosz.
- **Wdrożenie, zmienne środowiskowe, konfiguracja serwerów:** tylko
  Bartosz. Sesja 25 to jego lista decyzji.
- **Szczegóły słabych punktów** (limity, konfiguracja logowania) opisuj
  w PR ogólnikowo. Pełne wpisy są w prywatnym raporcie.
- **Twierdzenia o stanie produkcji** z repo (komentarze, dokumenty) to
  hipoteza. Rozstrzyga odczyt (sekcja 5).
- **Odczyt, który może zwrócić ponad 1000 wierszy**, idzie stronami po
  kluczu (`order('id')` + `gt('id', ostatni)`, strona ≤ 500) albo przez
  `readCompletePages`, a liczby liczy baza (`count` z `head: true`, RPC
  z GROUP BY). Produkcja ucina każdą odpowiedź do 1000 wierszy bez błędu.
- **Wdrożenia poza godzinami pracy**, dopóki obraz buduje się na app-1:
  każdy build zabiera app-1 cały procesor i ok. 4,5 GB swapu na
  12–18 minut. Zasada znika z buildem w CI (etap 1a).

## 2. Model obciążenia (założenia)

| Co | Założenie |
|---|---|
| Userzy i firmy | 3000 aktywnych (logują się co tydzień), ok. 2500 firm, ok. 2000 z KSeF |
| Szczyt | 9–11 w dni robocze: 400–600 sesji naraz; dni terminów (20., 25., koniec i początek miesiąca) ×3 |
| Ruch | 20–40 żądań/s z kliknięć zwykle, 100–150 w dni terminów, plus ruch w tle |
| Dokumenty | 40 wystawionych + 60 odebranych faktur na firmę miesięcznie; szczyt wysyłek 1–2 tys./h; 15 paragonów OCR na firmę |
| Serwery (odczyt 25.10) | app-1 CX23 (2 vCPU, 4 GB, swap 8 GB): aplikacja, worker, Redis, buildy. db-1 2 vCPU, 4 GB, dysk 40 GB: cały Supabase (analiza 24.10 liczyła CPX32: 4 vCPU, 8 GB, 160 GB, stąd korekta). ops-1 2 vCPU, 4 GB, dysk 40 GB: Coolify i MinIO z plikami aplikacji |
| Stan wyjściowy (4 konta, 25.10) | db-1: ok. 17% CPU przez cały dzień (sam stos Supabase i crony), ok. 28 transakcji/s, 1,1 GB w swapie, dysk 79%; baza 198 MB, trafność cache 99,97%. app-1: web ok. 270 MB, worker ok. 190 MB |

Po pierwszych tygodniach z prawdziwym ruchem podmień założenia na liczby
z produkcji (sekcja 5).

## 3. Sesje

Numer sesji to identyfikator, nie kolejność. Rozmiar: S = do kilku godzin,
M = dzień. Identyfikatory ustaleń odsyłają do prywatnego raportu (numeracja
inna niż w „Rejestrze braków” z 17.10).

**Kolejność wykonania (25.10, dla db-1 = CX23: mały dysk i RAM idą
pierwsze):** 23 → 22 → 20 → 26 → 27 → 4 → 1 → 2 → 8 → 9 → 19 → 21 → 13 →
28 → 14 → 17 → 5 → 6 → 7 → 3 → 12 → 18 → 10 → 11 → 24 → 29 → 30, a na końcu 15
i 16.
Sesja 27 idzie wcześnie, bo to błąd poprawności, nie wydajności: od ok.
500 firm z KSeF crony po cichu pomijają część firm.
Sesje 15 i 16 dokładają obciążenie bazy, więc na CX23 robi się je po
pomiarze i z niższymi wartościami: wysyłka 6–8 slotów, OCR
i kategoryzacja 2–3.

| # | Sesja | Typ | Kto | Rozmiar | Ustalenia | Gotowe, gdy |
|---|---|---|---|---|---|---|
| 1 | Baner KSeF: odpytywanie tylko widocznej karty co 120 s, `/api/ksef/health` bez weryfikacji sesji w proxy, wynik w pamięci 15 s | kod | sesja | S | REQ-03, CAC-01, HOR-07, CPU-02 | Odpytanie z ciasteczkiem sesji nie woła GoTrue; ukryta karta nie odpytuje |
| 2 | Ścieżki techniczne (`/ingest`, `/monitoring`, `sw.js`, manifest, robots, sitemap) omijają tworzenie klienta Supabase w proxy | kod | sesja | S | REQ-05, CAC-04, CPU-08 | Test: te ścieżki nie tworzą klienta; trasy o podobnym prefiksie dalej chronione |
| 3 | Flo: `expireStale` i `releaseStuck` jednym UPDATE z warunkiem w zapytaniu zamiast listy id w adresie (dziś lista wygasłych kart jest do tego ucinana do 1000 na przebieg); izolacja błędów prologu pulsu | kod | sesja | S | FLO-01 | Test z 500 wygasłymi kartami: jedno żądanie o stałej długości, idempotentne |
| 4 | Zdjęcia paragonów zmniejszane w przeglądarce (≤ 2000 px, JPEG ok. 0,8) + czytelny komunikat przy zbyt dużym pliku; PDF bez zmian | kod | razem | S | EXT-09, HOR-V1, LIM-08, CPU-06, DBC-02, BCK-09 | Plik 4 MB wychodzi jako < 1 MB; Bartosz decyduje o oryginale |
| 5 | Limity czasu `fetch` w klientach Supabase (proxy krótko, RSC i akcje ok. 10 s, admin w workerze dłużej); przekroczenie = 503, nie wylogowanie | kod | sesja | S | REQ-V01, QRY-V1, LIM-05 | Test z atrapą, która nie odpowiada: 503 po limicie |
| 6 | Klient Redisa: 1 ponowienie, limit czasu ok. 500 ms, krótki obwód „Redis niedostępny”, ping w healthchecku z osobnym limitem | kod | sesja | S | HOR-05, LIM-04 | Niedostępny Redis daje błąd po ≤ 500 ms |
| 7 | Błąd infrastruktury ≠ brak dostępu: 5xx/429/timeout GoTrue i błąd zapytania o członkostwo → „spróbuj ponownie”, osobny komunikat i log dla 429 | kod | sesja | S | REQ-V02, GTR-03, QAL-06 | 429/503 nie zwraca `unauthenticated` ani przekierowania na `/onboarding`; fail-closed zostaje |
| 8 | Proxy: 1 wywołanie GoTrue zamiast 3 (claims z tokenu po udanym `getUser(token)`, `getClaims()` tylko tam, gdzie decyduje o trasie publicznej) | kod | razem | M | REQ-01, QRY-01, QAL-02, DBC-06 | Licznik wywołań `/auth/v1/user` na żądanie chronione: 3 → 1; testy MFA (AUD-58) zielone; przegląd Bartosza |
| 9 | Deduplikacja sesji w RSC: layout przez `getDashboardSessionUser`, `getPageContext` w `cache()`, tytuły pomocy liczone raz | kod | sesja | S | REQ-04, CAC-09, CPU-14 | 1 `getUser` i 1 zapytanie o członkostwo na render |
| 10 | Prefetch: bez `prefetch={true}` w dolnym pasku, krótsza lista `PrefetchDashboardRoutes`, reszta przy najechaniu | kod | sesja | S | REQ-02, QRY-V2, CAC-03, CPU-09 | Pomiar liczby żądań po wejściu na panel przed i po |
| 11 | Odpytywanie eksportów, importów i OCR lekką akcją statusu; `router.refresh()` raz po zmianie statusu; rosnący odstęp | kod | sesja | S | REQ-08, CAC-V01, CAC-10 | Takt odpytywania nie woła `router.refresh()`, dopóki status się nie zmieni |
| 12 | Kopia JSON: bezpiecznik rozmiaru (alarm „kopia niepełna” zamiast awarii workera), stronicowanie po kluczu (dziś OFFSET bez ORDER BY, więc między stronami kopia może gubić i dublować wiersze); weryfikacja bez parsowania całego pliku | kod | sesja | S | JOB-02, QAL-01, CPU-03, CPU-V2 | Atrapa ponad progiem: jeden alarm, worker żyje |
| 13 | Rozsyłka skrzynki: tylko żywe firmy (nieusunięte, aktywne, z ważnym certyfikatem), pominięcie firm z czekającym zadaniem, wstawianie paczkami, `localConcurrency` z env; listę firm czyta helperem z sesji 27 | kod | sesja | M | JOB-01, EXT-01, HOR-03, LIM-01, JOB-V1, LIM-V-02, JOB-V3 | Druga rozsyłka przy czekającym zadaniu nic nie dodaje |
| 14 | Sesja KSeF: odświeżanie przez refresh token zamiast pełnego logowania XAdES; pełne logowanie dopiero po odrzuceniu (KSEF-08 z rejestru 17.10) | kod | razem | M | EXT-01, HOR-04, JOB-01 | Testy cache sesji + próba na KSeF TEST |
| 15 | Wysyłka do KSeF: 2–3 sloty na firmę, 10 (potem do 15) slotów razem, z pomiarem pamięci | kod | sesja | S | JOB-03, EXT-02, LIM-02 | Konfiguracja kolejki w teście; p95 czasu przed i po w opisie PR |
| 16 | Kolejki „równoległe”: `batchSize: 1` + `localConcurrency` (OCR, kategoryzacja, import, eksporty, paczki księgowego) + `groupId` = firma | kod | sesja | S | JOB-04, EXT-05, LIM-03, QAL-V01 | `tests/unit/joby-rownoleglosc.test.ts` rozszerzony; wszyscy nadawcy ustawiają grupę |
| 17 | Duble w skrzynce: wczesne wyjście w kategoryzacji, backfill pomija faktury z czekającym zadaniem; poprawione komentarze o `singletonKey` | kod | sesja | S | JOB-06, EXT-V1, LIM-06, QAL-V02, CPU-V1 | Drugie zadanie dla tej samej faktury kończy się jednym odczytem, bez pobrania XML i bez AI |
| 18 | Ponaglenia: najpierw firmy z włączonymi ponagleniami, kandydaci paczkami, przetwarzanie strona po stronie | kod | sesja | S | DB-03, JOB-08 | Firma z wyłączonymi ponagleniami nie jest czytana; pamięć niezależna od liczby stron |
| 19 | Pulpit: wspólny loader sprzedaży w `cache()` na żądanie, paczki pozycji równolegle, `count` tylko na pierwszej stronie. Od #328 Pulpit czeka na wszystkie karty naraz, więc najwolniejsza karta wyznacza czas wejścia | kod | sesja | M | QRY-02, QAL-05, QRY-05, QRY-07, CPU-13 | Licznik zapytań na render: ok. 35 → ok. 10; wyniki kart identyczne |
| 20 | Migracja: sprzątanie `audit_logs` i `inngest_run_log` paczkami, codziennie; retencja `ksef_health_log` | migracja | razem | S | DB-01, JOB-05, DBC-07, DB-09 | Test na bazie: paczka mieści się w limicie, blokada append-only działa; wgrane przez Bartosza |
| 21 | Migracja: indeksy częściowe pod crony KSeF (`CONCURRENTLY`), lżejsza funkcja przebiegu uzgadniania | migracja | razem | S | DB-02, DB-V02, DB-08 | EXPLAIN na kopii: index scan; wyniki identyczne przed i po |
| 22 | Skrypt kopii `db-backup.sh`: sprzątanie `.partial`, kontrola wolnego miejsca przed zrzutem, bez drugiej kopii w `.outbox`, retencja przed wysyłką | infra | razem | S | BCK-01, DBC-01, BCK-04, BCK-05 | Test skryptu na katalogu tymczasowym; wdrożenie na db-1 przez Bartosza |
| 23 | Pomiar: opóźnienie i wykorzystanie pętli zdarzeń, pamięć i czas żądań w logu web i workera co 60 s, osobno czas renderu Pulpitu (p50/p95; web to jeden proces Node, czyli jeden rdzeń, więc w dzień terminu może być drugim sufitem obok db-1); `scripts/ops/pojemnosc-db.sh` (tylko odczyt, obejmuje też niezrobione odczyty z sekcji 5); próbkowanie Sentry bez health i telemetrii | operacje | sesja | S | CPU-12, DBC-10, EXT-15 | Linia JSON z metrykami w logach obu procesów, w tym czas renderu Pulpitu; skrypt uruchamiany jedną linią |
| 24 | Przygotowanie replik: lekki `/api/live` do HEALTHCHECK, `deploymentId` i ID z SHA, stały klucz Server Actions, `stop-timeout` | infra | razem | M | HOR-01, REQ-09, CPU-05, HOR-11, DBC-05 | Healthcheck nie dotyka bazy ani Redisa; dwa buildy tego samego commita mają te same ID akcji |
| 25 | Decyzje i konfiguracja Bartosza: limity GoTrue i przekazywanie IP klienta, klucze JWT asymetryczne, pula PostgREST (na 2 vCPU 8–10) i strojenie Postgresa pod rozmiar serwera (dziś ustawienia domyślne), limit dziennika systemowego i sprzątanie nieużywanych obrazów Dockera na db-1, build obrazu w CI, Storage Box + kopia MinIO + WAL, wyłączenie Logflare i Vector (na 4 GB od razu), Realtime czy endpoint statusu, model klasyfikatora | decyzja | Bartosz | M | GTR-*, DBC-04, DBC-08, BCK-02, BCK-03, DB-05, EXT-16 | Każda decyzja zapisana z datą; zmiany w oknie serwisowym za zgodą |
| 26 | Audyt odpytywania KSeF: wiersz w `audit_logs` tylko przy zmianie albo błędzie, nie przy każdym żądaniu HTTP (ok. 70% wierszy audytu) | kod | sesja | S | EXT-03 | Test: zwykłe odpytanie bez zmian nie zapisuje audytu; błąd i zmiana stanu zapisują |
| 27 | Pełne listy w cronach i skryptach czytane stronami po kluczu (`order('id')` + `gt('id', …)`, strona ≤ 500, koniec na pustej stronie), jeden wspólny helper: lista firm skrzynki i historii KSeF, strumienie i liczniki historii tylko dla bieżącej strony firm, firmy do miesięcznej paczki dla księgowej, firmy z wygasającym certyfikatem, `scripts/reencrypt-ksef-credentials.ts` (dziś przeszyfruje tylko 1000 firm i zgłosi sukces, a potem stary klucz można usunąć), katalog produktów w imporcie. `PGRST_DB_MAX_ROWS` zostaje 1000 jako bezpiecznik | kod | sesja | M | JOB-11 + przeszukanie 25.10: `inbox-polling.ts:144`, `ksef-history-sync.ts:232`, `history-sync/db.ts:276, :547`, `co-pilot-monthly.ts:153`, `cert-expiry-alert.ts:79`, `reencrypt-ksef-credentials.ts:30`, `import-engine.ts:334` | Test z atrapą PostgREST, która ucina każdą odpowiedź do 1000 wierszy: 2500 firm daje 2500 zadań skrzynki, komplet strumieni historii i 2500 paczek; przeszyfrowanie obejmuje wszystkie firmy |
| 28 | Alarmy, raporty i panel admina liczą w bazie, nie na obciętej liście: klasy w monitorze skrzynki i historii KSeF, naruszenia cyklu życia KSeF (RPC z GROUP BY do alarmu i raportu, osobny odczyt I5 z limitem dla crona uzgadniania), akcje w raporcie dziennym, wpisy `ksef_health_log` w raporcie tygodniowym (dziś ok. 2000 wpisów, więc już obcięty), `/admin/system`, `/admin/ksef`, lista kont w `/admin/users`, panel Flo | kod + migracja | razem | M | QAL-09 + przeszukanie 25.10: `critical-alerts-monitor.ts:885, :1036, :1085`, `ksef-lifecycle-reconcile.ts:288`, `admin/ksef-lifecycle.ts:166, :229`, `ksef-lifecycle-report.ts:147`, `business-metrics.ts:100`, `admin/system.ts:45, :85`, `admin/users.ts:70, :248`, `flo/metrics.ts` | Test z atrapą ucinającą do 1000: alarmy i raporty podają te same liczby co zapytanie liczące; migracja wgrana przez Bartosza |
| 29 | Odczyty jednej firmy, które przekroczą 1000 wierszy dopiero po latach: decyzje i wyciszenia Flo (wyciszony rodzaj karty może wrócić), cień Flo, historia sprzedawcy w przeglądzie kosztu, reguły nazw w kategoryzacji, walidacja kontrahentów, eksport danych RODO (jawnie ucięty do 1000 wpisów audytu), lista korekt (własny limit 500 bez ORDER BY), znani sprzedawcy w karcie Flo „podsumowanie skrzynki” (`.limit(1000)`, więc część znanych wygląda na nowych) | kod | sesja | S | przeszukanie 25.10: `flo/decisions.ts:327`, `flo/shadow.ts:157`, `expense-review.ts:519`, `name-rule.ts:28`, `actions/validation.ts:120`, `gdpr/data-collector.ts:174`, `invoices/new/correction/page.tsx:33`; weryfikacja 29.10: `inbox-polling.ts:418` | Test z atrapą ucinającą do 1000: wyciszony rodzaj zostaje wyciszony przy 1500 wierszach decyzji; eksport RODO kompletny |
| 30 | Archiwizacja starych faktur: `mark-archived` i `schedule-deletion` wysyłają do 500 id jednym `.in('id', …)` w adresie (ok. 19,5 KB, ponad typowy limit wiersza żądania bramki). Krok pada po wgraniu plików, ponowienie wgrywa je od nowa, a archiwum stoi. Paczki po ≤ 100 id. Dziś kandydatek nie ma (faktury starsze niż 2 lata), więc pilne dopiero przy ok. 200 naraz | kod | sesja | S | weryfikacja 29.10: `archive-old-invoices.ts:95, :108` | Test: 500 kandydatek daje zapytania z ≤ 100 id; wynik oznaczenia identyczny |

## 4. Etapy skalowania (sprzęt)

| Etap | Kiedy (metryka) | Co | Kod potrzebny wcześniej |
|---|---|---|---|
| 0 | teraz, przed launchem | sesje kodu na obecnym sprzęcie + Storage Box (lokalnie 2–3 kopie), wyłączenie Logflare i Vector, Studio na żądanie, strojenie bazy pod rozmiar serwera; na db-1 limit dziennika systemowego (dziś 3,8 GB) i sprzątanie nieużywanych obrazów Dockera; wdrożenia poza godzinami pracy | — |
| 1a | przed pierwszym płacącym klientem (twarda zasada z `PRZEPROWADZKA-HETZNER.md` §1.7), najpóźniej przed ok. 1000 aktywnych, a nie dopiero po alarmie z procesora. Wcześniej, jeśli po etapie 0 zostaje którykolwiek sygnał: na db-1 wolne < 200 MB RAM, swap > 0,5 GB, CPU > 70% w godz. 9–11, dysk > 70%, trafność cache < 99%. 25.10, przy 4 kontach, dysk (79%) już przekracza próg, a w swapie leży 1,1 GB (do sprawdzenia, ile z tego to Postgres) | db-1 CX23 → CX33 (4 vCPU, 8 GB), najtańszy krok w planie; opcja „tylko CPU i RAM” da się cofnąć, ale zostawia dysk 40 GB, więc dane i kopie na Volume albo Storage Box. Do tego obraz budowany w CI (koniec buildów na app-1): przy ok. 1000 userach build zabiera app-1 cały procesor i ok. 4,5 GB swapu na 12–18 minut | 22, 23 |
| 1b | przed ok. 2000 aktywnych (po sesjach 8, 9, 19 db-1 z 4 vCPU mieści 1500–2000) albo te same sygnały na CX33 | db-1 → 8 vCPU / 16 GB (CX43 albo CPX42), potem pula PostgREST i strojenie Postgresa pod nowy rozmiar | 8, 9, 19, 21 |
| 2 | wykorzystanie pętli zdarzeń web > 0,6 w szczycie przez 3 dni, p99 opóźnienia pętli > 100 ms albo czas renderu Pulpitu w dzień terminu rośnie mimo zapasu na db-1 | app-1 4 vCPU, 2–3 kontenery web z jednego obrazu (z CI, etap 1a), limity pamięci kontenerów | 23, 24 |
| 3 | cykl skrzynki > 10 min po sesji 14, p95 oczekiwania wysyłki > 30 s, dysk db-1 albo ops-1 > 70% | worker na osobnej maszynie w sieci prywatnej, Redis na adresie prywatnym, MinIO (dziś na ops-1) na Volume albo Object Storage, archiwizacja WAL (dziś wyłączona) | 13, 14 + stan KSeF z pamięci procesu do Redisa/bazy |
| 4 | CPX42 > 70% CPU w zwykłe dni | Postgres na osobnym serwerze, usługi Supabase na drugim, osobny PostgREST dla workera, replika do odczytu dla raportów | 25 |

## 5. Odczyty z produkcji (tylko odczyt, robi Bartosz)

Rozstrzygają ustalenia „do sprawdzenia” i kalibrują progi. Sesja 23
zamienia je w jeden skrypt.

**Zrobione 25.10.2026** (komentarz Bartosza w #329):

| Co | Wynik |
|---|---|
| Serwery | db-1 i ops-1: 2 vCPU, 4 GB, dysk 40 GB; app-1: CX23 (2 vCPU, 4 GB), swap 8 GB |
| db-1 przy 4 kontach | ok. 17% CPU przez cały dzień, ok. 28 transakcji/s, 1,1 GB w swapie, dysk 79% (z tego ok. 3,8 GB to dziennik systemowy, do odzyskania) |
| Postgres | ustawienia domyślne (`shared_buffers` 128 MB, `max_connections` 100, w użyciu 54); baza 198 MB; trafność cache 99,97%; `archive_mode` wyłączony |
| PostgREST | pula 11 połączeń; `PGRST_DB_MAX_ROWS` = 1000, czyli dłuższe wyniki są po cichu ucinane (sesje 27–29) |
| app-1 | web ok. 270 MB, worker ok. 190 MB |
| MinIO aplikacji | na ops-1, nie na db-1; wolne ok. 28 GB |
| Twierdzenia o kodzie | pusty publiczny JWKS, 3 sprawdzenia sesji w proxy na chronione żądanie, baner KSeF co 30 s, brak `bodySizeLimit`: potwierdzone na `main` 25035bf9 |

**Etap 0 na db-1, zrobiony 26.10.2026** (Bartosz):

| Co | Wynik |
|---|---|
| Dysk | 79% → 69% samo (slot replikacji Logflare `cainophile_*` ruszył: 0,5 GB WAL zamiast 4 GB) → 57% po sprzątaniu, 16 GB wolne |
| Dziennik systemowy | 3,7 GB → 288 MB, stały limit 300 MB (`/etc/systemd/journald.conf.d/limit.conf`) |
| Obrazy Dockera | usunięty 1 nieużywany (722 MB); pozostałe 16 w użyciu |
| Co zostaje na dysku | baza `_supabase` 1,1 GB (logi Logflare, bez retencji), dane aplikacji 199 MB, `btmp` ok. 290 MB |
| Logflare i Vector | działają; NIE wyłączone, bo w compose Supabase inne usługi czekają na zdrowy `analytics` i samo zatrzymanie wywróci stos przy restarcie. Wyłączenie (albo retencja logów `_supabase`) to osobna zmiana w compose (sesja 25) |

Uwaga: slot replikacji Logflare potrafi trzymać kilka GB WAL, gdy przestaje
nadążać; to argument za `max_slot_wal_keep_size` 2–4 GB (sesja 25).

**Jeszcze do zrobienia:**

- `docker stats --no-stream` na app-1 i db-1 rano 9–11 i o 02:00; ile z 1,1 GB swapu na db-1 to Postgres; `vmstat` (kradzież CPU na linii CX).
- Które jeszcze kontenery stosu Supabase działają na db-1 (Studio, Storage, imgproxy, Supavisor). Logflare i Vector: działają (26.10).
- `KEEP` i `RCLONE_REMOTE` w `/etc/faktflow-backup.env`, liczba i rozmiar zrzutów w katalogu kopii.
- Limity czasu ról (`statement_timeout`) i `work_mem`.
- 25 najdroższych zapytań z `pg_stat_statements`.
- Rozmiary 25 największych tabel i dzienny przyrost `audit_logs` oraz `inngest_run_log`.
- Konfiguracja limitów GoTrue (nazwy zmiennych `GOTRUE_RATE_LIMIT_*`, bez wartości sekretów).
- Liczby: aktywne firmy, firmy z KSeF, faktury na firmę miesięcznie.
- Kolejki pg-boss: zaległości wg kolejki i czasy przebiegów z `inngest_run_log`.

## 6. Dziennik sesji

| Data | Sesja | PR | Stan |
|---|---|---|---|
| 24.10.2026 | Analiza i plan | #329 | plan gotowy, czeka na akceptację Bartosza |
| 25.10.2026 | Korekta: db-1 nie ma 4 vCPU / 8 GB (najpewniej CX23) | #329 | przeliczone progi, nowa kolejność, sesja 26, etap 1 podzielony na 1a/1b |
| 25.10.2026 | Odczyty Bartosza z produkcji (komentarz w #329) | #329 | sprzęt potwierdzony, MinIO na ops-1 (poprawione też w `AGENTS.md`), build w CI w etapie 1a, sesja 23 mierzy render Pulpitu; `PGRST_DB_MAX_ROWS` = 1000 → przeszukanie kodu (8 agentów, każde trafienie sprawdzone przez osobnego weryfikatora), nowe sesje 27–29 |

| 26.10.2026 | Etap 0 na db-1 (Bartosz) | — | dysk 57% (16 GB wolne), limit dziennika 300 MB; Logflare i Vector zostają do zmiany w compose |
| 27.10.2026 | Akceptacja planu (Bartosz) | #329 | „Zaczynaj od sesji 23, potem 22, 20, 26, 27 i 4, każda jako osobny PR” |
| 27.10.2026 | Sesja 23: pomiar procesu (web, worker, Pulpit), próbkowanie Sentry, `scripts/ops/pojemnosc-db.sh` | #338 | PR otwarty, czeka na CI i Bartosza; każda kolejna sesja w osobnym czacie, po kolei |
| 28.10.2026 | Sesja 22: `db-backup.sh` nie zapełnia dysku Postgresa (sprzątanie przy błędzie, kontrola miejsca, bez `.outbox`, retencja przed wysyłką, retencja zdalna 60 dni) | #342 | PR otwarty, czeka na CI i Bartosza; skrypt na db-1 podmienia Bartosz |
| 28.10.2026 | Sesja 20: sprzątanie `audit_logs`, `inngest_run_log` i `ksef_health_log` paczkami, codziennie (migracja 00157, btree po `created_at` zamiast samego BRIN) | #343 | PR otwarty, CI 11/11 zielone, czeka na Bartosza; 00157 wgrywa Bartosz przed wdrożeniem; zmiana crona na dzienny = do tygodnia możliwy fałszywy alarm „cron stoi” |
| 28.10.2026 | Sesja 26: audyt odpytywania KSeF tylko przy błędzie albo zmianie (`audit.when` w `ksefFetch`, 1 wiersz podsumowania na przebieg skrzynki z nowymi fakturami i na odpytaną fakturę) | #344 | PR otwarty, CI 11/11 zielone; zawęża regułę Fazy 23 — decyzja Bartosza; szacunek ok. 6,5 mln → 0,5–0,7 mln wierszy/mies. przy 2000 firm; możliwy konflikt z #189 w `submit.ts` |
| 29.10.2026 | Weryfikacja miejsc sesji 27 na `main` 7a4f90ba (16 agentów, nowe trafienia sprawdzone przez sceptyka) | #329 | 8 miejsc z planu dalej ucina do 1000; nowe: `archive-old-invoices.ts:95, :108` → sesja 30, `inbox-polling.ts:418` → sesja 29; `flo/proposals.ts:248` to sesja 3; obok skryptu przeszyfrowania błąd pomijania „już v2” przy rotacji klucza (zgłoszony sesji 27) |
| 29.10.2026 | Sesja 27: pełne listy w cronach i skryptach stronami po kluczu (`lib/pagination/keyset.ts`; skrzynka, historia KSeF, Co-Pilot, certyfikat, przeszyfrowanie, katalog produktów) | #345 | PR otwarty, CI 11/11 zielone; przy okazji naprawione wprost: przeszyfrowanie pomijało v2 na starym kluczu i nadpisywało certyfikat wgrany w trakcie; osobne ustalenia w PR: `.in()` z list CSV w imporcie (F-089), `products` bez UNIQUE (migracja), OFFSET ze stroną 1000 we Flo i `jpk-fa-readiness`; po wdrożeniu skrzynka ok. 2000 zadań co 15 min przy przepustowości ok. 1000 → zaległość do sesji 13 |
| 29.10.2026 | Sesja 4: zdjęcia paragonów zmniejszane w przeglądarce (4,10 MB → 393 KB, 2000×1500), plik ponad 1 MB z polskim komunikatem przed wysłaniem, odrzucona akcja w toaście zamiast granicy błędu; import CSV z tym samym limitem i tekstem „max 1 MB” | #346 | PR otwarty, CI w toku; do decyzji Bartosza: czy kopia 2000 px wystarcza jako dowód, PDF i importy ponad 1 MB (route handler, podpisany PUT albo globalny `bodySizeLimit`); `/share-target` dalej w pełnej rozdzielczości; MinIO ok. 11–22 GB/mies. przy 3000 userów zamiast 55–110. Koniec kolejki zaakceptowanej 27.10 |
| 29.10.2026 | Sesja 1: baner KSeF tylko z widocznej karty (co 120–150 s, po powrocie raz od razu), `/api/ksef/health` przed klientem Supabase w proxy (lista `NO_SESSION_PATHS`, którą rozszerzy sesja 2), wynik w pamięci 15 s, bez pola `error` | #347 | PR otwarty, CI w toku; GoTrue na takt 3 → 0, szczyt 40–60 → 0 wywołań GoTrue/s; pierwsza sesja spoza kolejki z 27.10 (dalej według kolejności planu) |
| 30.10.2026 | Z recenzji sesji 1: proxy dokłada nagłówki zakazujące cache'owania do każdej odpowiedzi z odświeżonym ciasteczkiem sesji, także do przekierowań | #348 | PR otwarty, CI w toku; razem z #347 zmienia `lib/supabase/middleware.ts`, więc drugi scalany może wymagać rozwiązania konfliktu |
| 30.10.2026 | Z recenzji #348: tunele PostHog (`/ingest`) i Sentry (`/monitoring`) obsłużone w `proxy.ts` przed `updateSession`, bez klienta Supabase i bez nagłówka `cookie` do celu (część sesji 2: REQ-05, CAC-04, CPU-08) | #349 | PR otwarty, CI w toku; bez konfliktu z #347 i #348 (`git merge-tree`). Dla sesji 2 zostają `sw.js`, manifest, robots, sitemap (do `NO_SESSION_PATHS` z #347) i połączenie obu mechanizmów, więc sesja 2 dopiero po scaleniu #347 |
| 30.10.2026 | Sesja 9: jedno sprawdzenie sesji i jedno zapytanie o członkostwo na render RSC (layout bez drugiego `getUser`, `getPageContext` w `cache()` na wierszach z cache, ustawienia i szczegół faktury przez `getDashboardSessionUser`, tytuły pomocy raz na proces) | #350 | PR otwarty, CI w toku. Poprawka do planu: Next 16 skleja identyczne GET w renderze RSC, więc powtórzone `getUser` szło dotąd do sieci raz; realny zysk dziś to członkostwo (2 → 1). Sesja 9 musi wejść **przed sesją 5** (limity czasu z `AbortSignal` wyłączą sklejanie). Błąd odczytu członkostw w `getPageContext` daje teraz stronę błędu zamiast `/onboarding` (jak layout; decyzja Bartosza) |
| 30.10.2026 | Z sesji 9: „Spróbuj ponownie” na stronie błędu panelu pobiera stronę od nowa (`router.refresh()` + `reset()` w przejściu; samo `reset` w Next 16.4 nie pobierało RSC) | #351 | PR otwarty, CI 11/11 zielone; do decyzji Bartosza: `app/error.tsx` dla segmentu głównego (dziś przy trwałej awarii layoutu kończy się `global-error.tsx`) |
| 30.10.2026 | Sesja 19: Pulpit czyta sprzedaż raz na wejście (`lib/dashboard/sales-history.ts` w `cache()`, strażniki liczone na oknie każdej karty, przy błędzie wspólnego odczytu karty czytają osobno jak dawniej), paczki pozycji do 4 naraz, nowy `readCompletePagesByKey` (`readCompletePages` bez zmian) | #352 | PR otwarty, CI w toku; złoty wzorzec 32/32 identyczny z `main`. Zapytania na wejście: dane przykładowe 26 → 14, mikrofirma 35 → 22, duża firma 62 → 40. Cel „ok. 10” osiągnięty tylko dla sprzedaży bez pozycji (19 → 6); zostają pozycje rankingu (paczki po 100, krok 2 = RPC, migracja), koszty i należności (osobne ustalenia w PR) |

**Następny krok:** sesja 23 (pomiar i skrypt pozostałych odczytów), potem
22, 20, 26, 27, 4 — każda osobny PR. Dopóki #329 nie jest scalony, sesje
czytają ten plik z gałęzi `origin/claude/plan-skalowania-3000`.
