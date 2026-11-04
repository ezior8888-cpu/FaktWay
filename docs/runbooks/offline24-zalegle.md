# Offline24 — zaległe wpisy kolejki i faktury `offline_queued`

Jak czytać sekcję **4a** skryptu `./scripts/ops/kontrola-faktur-ksef.sh`
i co robić przy każdym wierszu. Skrypt tylko czyta. **Danych nie zmieniaj
bez zgody Bartosza** — każda zmiana stanu faktury Offline24 to dziś ręczny
SQL, a przed nim trzeba uzgodnić fakturę z KSeF.

## Stan od 02.10.2026

Automatyczny Offline24 jest wyłączony wszędzie, także na KSeF TEST
(decyzja Bartosza, `lib/ksef/offline24-policy.ts`, wdrożone 02–03.10): nowe
wpisy kolejki `ksef_offline_queue` nie powstają, a zdarzenia odtworzenia
z kolejki job wysyłki odrzuca od razu (`submit-invoice.ts`, przed hamulcem).
Zostaje cron `cron.process-offline-queue` (co 5 min, **niezależnie od
wyłącznika wysyłek**), który zamyka stare wpisy `queued` — tylko ze
środowiskiem równym `KSEF_ENV` workera (pierwszy wiersz sekcji 4a)
i z `next_attempt_at` w przeszłości, do 10 na przebieg
(`lib/jobs/runners/process-offline-queue.ts`):

| Wpis `queued` | Co robi cron | Faktura po przebiegu |
|---|---|---|
| faktura innej firmy | wpis → `failed QUEUE_INVOICE_OWNERSHIP_MISMATCH` | bez zmian |
| faktura `accepted` | wpis → `failed` („Accepted invoice requires manual reconciliation”) | bez zmian (przyjęta) |
| faktura w innym stanie niż `offline_queued` | wpis → `failed …STATE_REVIEW…` albo `expired` | bez zmian (ma własne wyjście) |
| po terminie, faktura nieprzejęta | wpis → `expired` | `failed OFFLINE_DEADLINE_EXCEEDED` — ma wyjście |
| po terminie, faktura przejęta (`submitted_to_ksef_at`) | wpis → `expired` | zostaje `offline_queued` — **bez wyjścia** |
| w terminie (kwarantanna) | wpis → `failed <KOD>_REQUIRES_RECONCILIATION` | zostaje `offline_queued`, kod `OFFLINE_*` tylko gdy nieprzejęta — **bez wyjścia** |
| środowisko NULL (sprzed 00117) albo inne niż `KSEF_ENV` | nic, co przebieg | bez zmian |
| `sending` | nic (odtworzenie wyłączone) | bez zmian |

**Dlaczego „bez wyjścia”:** z `offline_queued` nie wyprowadza żadne RPC
(`requeue_ksef_send` i `reset_ksef_send` przyjmują tylko `failed`/`rejected`),
a zamknięty wpis kolejki nie wraca do crona. Strażnik
`ksef_lifecycle_violations` nie ma inwariantu dla samego stanu
`offline_queued`; wyjątek: faktura z otwartym wpisem `sent`/`intent`
w `ksef_submissions` starszym niż 48 h wpada w I5 (w (c) „dowód kontaktu”
= t) — jest wtedy w alarmie i w `/admin/ksef`, ale bez przycisków, a cron
cyklu życia tylko ją liczy (`i5Other`). Klient ma ją w filtrze „W toku”
(`lib/invoices/list-query.ts`), portal księgowej pokazuje ją jako dokument
wystawiony offline (`lib/accountant/load-accountant-portal.ts`), a PDF jest
zablokowany (`lib/pdf/invoice-pdf.ts`).

Kody `OFFLINE_*` nie są w katalogu `ksef_error_codes`: faktura `failed`
z takim kodem to naruszenie I4 strażnika (alarm), ale ma przyciski.

**Skąd się dowiesz poza skryptem:** alarmy `offline_backlog` (≥ 50 otwartych
wpisów) i `offline_environment_blocked` (wpis ze środowiskiem NULL albo
innym), kafelek kolejki na `/admin/system`, liczba `offline_queued`
w dziennym raporcie cyklu życia. Żadne z nich nie liczy faktur po
kwarantannie — to robi tylko sekcja 4a.

## Luka #5 — dwie części

Naprawa blokady to **luka #5** projektu A5 (osobny PR). Werdykt „BEZ
WYJSCIA” w wyniku skryptu wskazuje, której części potrzeba:

- **(i) wyjście dla faktur, które już stoją** w `offline_queued` (wpis
  zamknięty, brak wpisu, `sent`, `sending`, środowisko NULL albo inne):
  ścieżka operatora (RPC, akcja w `/admin` albo skrypt w `scripts/ops/`)
  `offline_queued` → `failed` z kodem z katalogu, po uzgodnieniu z KSeF
  i z zachowaniem dowodu kontaktu. Poprawka crona tych faktur **nie
  uwolni** — cron ich już nie pobiera.
- **(ii) poprawka zapisu crona** przy kwarantannie i wygaśnięciu, żeby nowe
  zamknięcia dawały stan z wyjściem. Ma znaczenie tylko wtedy, gdy są
  wpisy `queued` w środowisku `KSEF_ENV` (b).

## Jak czytać sekcję 4a

Pusta lista pod etykietą znaczy zero wierszy; nieudane zapytanie skrypt
podpisuje „zapytanie nieudane”.

| Zapytanie | Normalnie | Problem | Co zrobić |
|---|---|---|---|
| `KSEF_ENV` workera | `KSEF_ENV=test` (produkcja FaktFlow 05.10) | brak albo inna wartość niż oczekiwana | Porównuj z kolumną środowiska w (a)–(d). **Nie przełączaj `KSEF_ENV`** na środowisko zaległych wpisów bez uzgodnienia — cron wrzuci je w kwarantannę bez wyjścia |
| (a) kolejka wg stanu | pusto albo same `failed`/`expired`/`sent` sprzed wdrożenia wyłączenia | „najnowszy wpis” po 02–03.10.2026 | Coś parkuje mimo wyłączenia — błąd krytyczny. SHA obu kontenerów (sekcja 1). Wpis tworzy aplikacja (audyt z `metadata->>'mode' = 'offline_queued'`) albo worker (audyt `invoice.submit_redirected_offline`); szukaj w `audit_logs` po czasie wpisu. Zgłoś Bartoszowi |
| (b) otwarte wpisy | pusto | `sending`, środowisko NULL, `ponad 15 min do wziecia` | Cron ich nie zamknie (NULL, `sending`, inne środowisko) albo jego przebieg pada — sprawdź (h). Faktury `offline_queued` z takim wpisem są w (d). **Nie ustawiaj `ksef_environment`** — cron wrzuciłby wpis w kwarantannę bez wyjścia |
| | | `cron zamknie, faktura zostanie offline_queued BEZ WYJSCIA` | Przy następnym przebiegu powstanie nowa faktura bez wyjścia — potrzebna część (ii) luki #5. Zgłoś Bartoszowi; wstrzymać cron może tylko `WORKER_DISABLE_SCHEDULES` (wyłącza wszystkie crony) — to jego decyzja |
| | | inne `cron zamknie …` | Faktura dostanie wyjście albo się nie zmieni — nic nie rób |
| (c) faktury `offline_queued` | pusto | `BEZ WYJSCIA: …` | Faktura stoi dziś bez wyjścia — potrzebna część (i) luki #5. Lista (d) do uzgodnienia z KSeF; nic nie zmieniaj |
| | | `BEZ WYJSCIA, jesli srodowisko …` | Środowisko wpisu ≠ `KSEF_ENV` → jak wyżej; równe → zobacz (b), co zrobi cron |
| | | `przejęta` = t albo `dowód kontaktu` = t | Faktura mogła dotrzeć do KSeF — ponowna wysyłka bez uzgodnienia grozi duplikatem |
| | | `QR offline` = t | Faktura mogła trafić do nabywcy jako dokument offline — nie wracać do szkicu bez decyzji prawnej B1 |
| (d) lista do uzgodnienia | pusto | wiersze | Dla każdej: wyszukaj w KSeF (środowisko wpisu albo `KSEF_ENV`) po NIP-ie firmy, numerze i dacie; zapisz „jest z numerem K” albo „nie ma” i flagi z wiersza; przekaż Bartoszowi |
| (e) `failed`/`rejected` z `OFFLINE_*` | pusto | `failed`, zwykła, z danymi | Klient ma „Wyślij ponownie” i może kliknąć w każdej chwili. Przy `przejęta`/`dowód kontaktu`/`QR` = t skontaktuj się z klientem albo zgłoś Bartoszowi od razu |
| | | `failed` dokumentu specjalnego albo bez danych | Klient ma tylko „Wróć do szkicu”, który przy kluczu offline daje zamrożony szkic — postępuj jak w (f) |
| | | `rejected` | Ponowna wysyłka niemożliwa — anomalia (ręczny SQL?), zgłoś Bartoszowi |
| (f) inny ślad | pusto | klucz offline = t | Treść i pozycje zamrożone dla każdej roli; „Wróć do szkicu” klucza nie zdejmuje (zamrożony szkic, bez PDF i usuwania) — zgłoś Bartoszowi zamiast resetować |
| (g) wpisy zamknięte | `expired … failed` (wygaśnięcie z wyjściem) | `…_REQUIRES_RECONCILIATION` albo `expired` przy `offline_queued` | Kwarantanna albo wygaśnięcie bez wyjścia; faktury z takim wpisem jako najnowszym są w (c) i (d). `QUEUE_INVOICE_OWNERSHIP_MISMATCH`: wpis niezgodny z fakturą, przejrzyj ręcznie |
| (h) przebiegi crona (doba) | `succeeded`, co 5 min | `failed` z błędem | Handler rzucił wyjątek; wpis zostaje `queued` i blokuje kolejne przebiegi (zawsze pierwszy). Log workera (sekcja 2 pokaże ERROR co 5 min) — zgłoś Bartoszowi, nic nie kasuj |
| | | brak wierszy | Cron nie startuje: harmonogram w sekcji 7 i log workera „Gotowy: … N/N cronów zaplanowanych” |

## Decyzja

- **(c) i (b) puste** — dziś nie ma ofiar; luka #5 może poczekać (nowe
  wpisy nie powstają).
- **(c) `BEZ WYJSCIA` > 0** — potrzebna część (i) luki #5; do tego czasu
  lista (d) do uzgodnienia z KSeF, zmiana danych tylko za zgodą Bartosza.
- **(b) `cron zamknie, … BEZ WYJSCIA`** — przy najbliższym przebiegu
  przybędzie faktura bez wyjścia: potrzebna też część (ii); zgłoś
  Bartoszowi.
- **Wpisy ze środowiskiem innym niż `KSEF_ENV`** — dziś bez wyjścia jak
  NULL (część (i)); przed przełączeniem `KSEF_ENV` na ich środowisko
  potrzebna część (ii), inaczej cron wrzuci je w kwarantannę.
