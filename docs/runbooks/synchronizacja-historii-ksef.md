# Synchronizacja historii KSeF — runbook operatora

Decyzja Bartosza 22.10.2026: „Magiczny import” znika. FaktWay sam pobiera
z KSeF **całą historię** sprzedaży i zakupów firmy (od 2022-01-01 albo od
daty rozpoczęcia działalności), a potem **na bieżąco** faktury sprzedaży
wystawione poza FaktWay. Bieżące zakupy dalej przychodzą przez Skrzynkę KSeF
(firma gorąca co 15 minut, harmonogram: `skrzynka-ksef-pojemnosc.md`; koszty i KPiR bez zmian).

| Element | Gdzie |
|---|---|
| Migracja | `supabase/migrations/00155_ksef_history_sync.sql` (przed wdrożeniem) |
| Cron | `cron.ksef-history-sync` (`11,26,41,56 * * * *`) — wybór firm i fan-out |
| Przebieg firmy | kolejka `ksef.history-sync.tenant` (`groupId` = NIP, bez ponowień pg-boss) |
| Kod | `lib/jobs/runners/ksef-history-sync.ts`, `lib/ksef/history-sync/*` |
| Ekran klienta | Import danych → „Historia z KSeF” (`lib/ksef/history-sync/status.ts`) |
| Skrypt operatora | `./scripts/ops/ksef-historia.sh` (stan, pozycje, odblokuj, wznow, wstrzymaj-wszystko) |
| Alarmy | `stale_ksef_history_sync`, `ksef_history_blocked`, `ksef_history_rate_limited` |

## 1. Jak to działa

**Strumień** = (firma, środowisko KSeF, kierunek) w `ksef_history_sync`.

- **Sprzedaż** (`subject1`): zaległość wstecz od S = (chwila założenia − 1 h,
  pełna minuta) do `history_floor`, oknami ≤ 90 dni, stronami po 250; plus
  kursor bieżący `live_hwm` od S do przodu — co 29 min w dzień, co 14 min
  w nocy. Granica S dzieli oba kursory bez dziury.
- **Zakupy** (`subject2`): tylko zaległość, do U = HWM Skrzynki KSeF
  w chwili założenia strumienia. Strumień powstaje dopiero, gdy skrzynka ma
  HWM. Zakupy z historii to **archiwum**: wiersz `invoices`
  (`origin = ksef_import`) z XML, bez `expenses`, bez KPiR, bez katalogów.

**Dziennik** `ksef_history_items`: każda faktura z KSeF jest albo fakturą
FaktWay / ze Skrzynki (bez wiersza), albo wierszem z `status` i `reason_code`
(pary pilnuje CHECK). Wiersz `imported` z `invoice_id` NULL = faktura usunięta
retencją — nie pobieramy jej drugi raz.

**Kolejność w przebiegu firmy:** dzierżawa (10 min, jeden warunkowy UPDATE:
wolna i bez pauz — niezależny zapis wiersza, np. znacznik kolejki crona, jej
nie odbiera) → niższy początek historii, jeśli właściciel poprawił datę
rozpoczęcia działalności na wcześniejszą (zakończona zaległość otwiera się
od starego początku w dół; przycięte okno w toku szukane szerzej od nowa) →
ponowne sprawdzenie odłożonych i zablokowanych (tylko baza) → sygnały
ustępowania → zapytania
o metadane (najpierw bieżąca sprzedaż, potem zaległość round-robin po
najdawniejszym postępie) → pobrania XML → stan firmy. Kursor rusza się
dopiero PO zapisie strony w dzienniku, CAS-em.

**Zapis faktury** wyłącznie silnikiem importu (`source: ksef_history`):
sprzedaż z katalogami `insert-only` (bez nadpisywania kontrahentów i bez
`use_count`), zakupy i naprawy `skip`. `ksef_accepted_at` = chwila nadania
numeru w KSeF (`acquisitionDate`, zapasowo `permanentStorageDate`).

**Pełny zapis.** Faktura zapisana przez ten strumień (pochodzenie
`fa3_data.import.importJobId` = id strumienia) liczy się jako `imported`
dopiero, gdy ma pozycje, ścieżkę XML, wiersz `xml_documents` (KOD I na
fakturze i w PDF) i adnotacje. Silnik zapisuje je osobno: nieudany zapis
oryginału albo przerwany zapis (sam nagłówek) zostawia fakturę do
uzupełnienia — pozycja wraca do kolejki i silnik w trybie uzupełnienia (bez
katalogów) dopisuje brakujące. Nagłówek bez pozycji nie przejdzie jego
sprawdzenia liczby pozycji i po 3 próbach trafia do operatora (`save_failed`).

## 2. Budżet i ustępowanie

KSeF pozwala na (NIP, IP): 20 zapytań o metadane/h i 64 pobrania/h (16/min).
Historia bierze najwyżej:

| Pora (Europe/Warsaw) | Na przebieg (co 15 min) | Na godzinę |
|---|---|---|
| Dzień 06:00–20:00 | 1 zapytanie, 5 pobrań | 4 i 20 |
| Noc 20:00–06:00 | 2 zapytania, 10 pobrań | 8 i 40 |

Pobrania co ≥ 6 s, po 90 s od startu przebiegu — żadnego nowego wywołania.

**Ustępowanie** (tylko stan lokalny; wspólnego wiadra żetonów celowo nie ma —
zmieniałoby wysyłkę i skrzynkę chronione planem „zero zgubionych faktur”):

- bez żadnego wywołania KSeF, gdy firma ma fakturę `queued`/`sending`, świeże
  (15 min) sprawdzenie duplikatu 440 albo HWM skrzynki starszy, niż pozwala poziom
  firmy (gorąca 60 min, rzadziej odpytywane odpowiednio dłużej, `inboxLagYieldThresholdMs`);
- bez pobrań, gdy faktura ze skrzynki z ostatnich 2 h czeka na archiwum XML.

**Pojemność:** fan-out cyklu mieści się w 3 slotach × 13 min (szacunek
15 s + 5 s/zapytanie + 7 s/pobranie, ≤ 100 s), pomniejszonych o zlecenia
poprzednich cykli, które jeszcze czekają w kolejce (przekroczenie szacunku
nie narasta). Pobrania idą PO odkrywaniu w tym samym przebiegu, więc firma
z otwartą zaległością jest liczona z pełnym budżetem pobrań, nawet przy
pustej kolejce: w dzień 55 s (42 firmy na cykl), w nocy 95 s (24 firmy).
Ok. 23 firmy przy 100 s. 117 na cykl dotyczy tylko firm z zakończoną
zaległością, samą bieżącą sprzedażą i pustą kolejką (20 s) — przy interwale
29 min ~230 firm. Reszta czeka na kolejny cykl, najdawniej obsłużone
pierwsze. Tempo na ekranie jest **mierzone** (ostatnie 6 h),
termin końca tylko po przeszukaniu całej historii.

**429:** pauza firmy na pełny `Retry-After` (60 s – 24 h, domyślnie 15 min),
bez zużywania prób. ≥ 3 firmy z 429 w godzinie = globalny bezpiecznik
(cron nie robi fan-outu) + alarm.

## 3. Problemy kursorów i błędy firmy

| Pole | Wartość | Co znaczy | Wyjście |
|---|---|---|---|
| `backfill_issue` | `waiting_for_ksef` | KSeF nie potwierdził kompletu okna (HWM < koniec okna) | samo; okno bez HWM starsze niż doba = komplet |
| `backfill_issue` | `internal` | `isTruncated` bez postępu — okna nie da się zawęzić | ponowienie co godzinę; po dobie alarm „stoi”; Sentry; `wznow` |
| `backfill_issue` | `capacity` | strumień ma 25 000 pozycji | klient: „napisz na pomoc@”; operator: decyzja o podniesieniu limitu |
| `live_issue` | `waiting_for_ksef` / `internal` | jak wyżej dla bieżącej sprzedaży | jak wyżej |
| `last_error_code` | `credentials` | KSeF nie przyjął certyfikatu / brak certyfikatu | klient wgrywa certyfikat (link na ekranie); wgranie czyści błąd od razu (`clearKsefHistoryCertificateErrors`), najbliższy przebieg sprawdza sesję |
| | `certificate_expired` | certyfikat wygasł (`tenants.ksef_certificate_expiry`) | klient wgrywa nowy; ekran pokazuje błąd tylko, dopóki certyfikat jest wygasły; cron czyści kod, gdy data ważności jest w przyszłości |
| | `permission` | 403 — brak uprawnienia do przeglądania faktur | klient nadaje uprawnienie w Aplikacji Podatnika |
| | `ksef_unavailable` | dwa błędy przejściowe (5xx/408/sieć) w przebiegu | samo; po 6 h bez sukcesu alarm |
| | `internal` | nasz błąd (odszyfrowanie, NIP w szyfrogramie, odczyt bazy, 400 na metadanych, wyjątek) | alarm „stoi”, Sentry, `pozycje <firma>` (`last_error_detail`), po naprawie `wznow` |

Szczegół dla operatora (`last_error_detail`, `detail`) = `HTTP {status}
{ścieżka} kody:{…}` albo nazwa wyjątku — nigdy treść odpowiedzi KSeF.
Klient tych kolumn nie czyta (GRANT kolumnowy).

## 4. Powody pozycji — tekst klienta i działanie operatora

| Status / powód | Klient widzi | Operator |
|---|---|---|
| `pending` / — | „pobieramy jeszcze N faktur” | — |
| `pending` / `repair_content` | (liczy się do „pobieramy”) | naprawa XML/adnotacji dawnego importu; po 3 próbach `repair_failed` |
| `pending` / `ksef_not_ready` | — | KSeF 21165, ponowienie za 15 min bez liczenia próby |
| `imported` / — , `jpk_note` | pobrana (notatka JPK w szczegółach) | — |
| `imported` / `repaired` | nie liczy się do pobranych | — |
| `skipped` / `own_invoice` | — | faktura wysłana z FaktWay |
| `skipped` / `already_present` | — | jest już w FaktWay (plik, OCR, dawny import) — wiersza nie ruszamy |
| `skipped` / `retired_draft` | „N faktur ma numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy ich” | numer przenosi wyłącznie PR C (00149); sprawdzane raz na dobę; `odblokuj … retired_draft --tak` tylko po decyzji Bartosza |
| `deferred` / `duplicate_decision` | „czeka na Twoją decyzję przy duplikacie” + link do dokumentu | ścieżka klienta 440 (e-mail, I5D); bez limitu czasu |
| `deferred` / `own_send_pending` | „prawdopodobnie faktura wysłana właśnie z FaktWay — sprawdzimy za godzinę” | po 48 h → `own_send_unresolved` |
| `blocked` / `currency_not_supported` | „faktura w walucie … — oryginał zostaje w KSeF” | brak obsługi walut; `odblokuj … --wymus` dopiero po jej dodaniu |
| `blocked` / `number_conflict` | „W FaktWay jest szkic o numerze … — zmień numer albo usuń szkic” + link | samo po zmianie szkicu (sprawdzane co godzinę) |
| `blocked` / `file_import_mismatch` | „faktura przeniesiona z pliku, ale z innymi danymi — nie zmieniaj jej” | porównać z oryginałem w KSeF; decyzja Bartosza (§15 pkt 2) |
| `blocked` / `number_taken_local` | „dokument o tym numerze z innym numerem KSeF — nie zmieniaj go” | wyjaśnić, który dokument jest prawdziwy |
| `blocked` / `local_conflict` | „nie udało się jej zapisać — sprawdzamy” | dwa wiersze albo inne środowisko przy tym numerze KSeF |
| `blocked` / `own_send_unresolved` | „wynik wysyłki jeszcze uzgadniamy — nie wystawiaj ponownie” | jak I5: uzgodnić wysyłkę w `/admin/ksef` |
| `blocked` / `parse_failed`, `metadata_mismatch`, `archive_conflict` | „nie udało się jej zapisać — napisz na pomoc@ jeśli pilne” | `pozycje <firma> blocked <powód>` (detail), naprawa, `odblokuj` |
| `blocked` / `save_failed`, `repair_failed`, `download_failed` | jak wyżej | 3 nieudane próby; szczegół = pierwsze ostrzeżenie silnika / HTTP. `save_failed` z `invoice_id` ≠ NULL = niepełny zapis tego strumienia (np. nagłówek bez pozycji) — sprawdzić fakturę w `/admin`, naprawić, `odblokuj` |

Powody zależne od stanu lokalnego (`number_conflict`, `number_taken_local`,
`file_import_mismatch`, `local_conflict`, `own_send_unresolved`) są
sprawdzane ponownie co godzinę (najstarsze pierwsze, `updated_at` podbijany).

## 5. Alarmy

1. **`stale_ksef_history_sync`** — „Synchronizacja historii KSeF stoi”
   (dedup 30 min). Klasy: brak strumienia sprzedaży > 1 h od weryfikacji;
   brak strumienia zakupów > 2 h (zwykle przyczynę pokazuje
   `stale_inbox_sync`); bez sukcesu > 6 h z błędem po naszej stronie (także
   długa pauza 429: ≥ 4 trafienia albo > 6 h); zaległość bez postępu > 24 h;
   podejrzane poświadczenia (≥ 3 firmy i ≥ 20% strumieni z `credentials`
   albo skrzynka pobiera po błędzie historii). Firmy wstrzymane przez
   klienta — pomijane.
   → `ksef-historia.sh stan`, kolejka `ksef.history-sync.tenant`, cron,
   Sentry. Po naprawie `wznow <firma> --tak` — pobieranie wraca od
   zapisanego miejsca.
2. **`ksef_history_blocked`** — pozycje z powodem operatorskim i strumienie
   przy limicie (raz na dobę). → `pozycje <firma> blocked`, potem `odblokuj`.
3. **`ksef_history_rate_limited`** — ≥ 3 firmy z 429 w godzinie (ten sam
   warunek co bezpiecznik). Wysyłka i skrzynka działają. → `stan`;
   w razie potrzeby `wstrzymaj-wszystko <h> --tak`.

## 6. Wyłącznik klienta

Właściciel firmy (z potwierdzonym 2FA, jak przy certyfikacie) może na
ekranie Import danych wstrzymać i wznowić pobieranie historii
(`client_paused_at`, audyt `ksef.history.paused` / `ksef.history.resumed`).
Pauza zatrzymuje tylko wywołania KSeF historii tej firmy — wysyłka i skrzynka
działają. Przebieg w toku kończy się sam (≤ 90 s).

## 6a. Okresy zmienione po eksporcie

Widok `ksef_history_export_changes` (00155, `security_invoker`) liczy
w bazie miesiące wyeksportowanych okresów (eksporty z ostatnich 24 mies.),
do których po eksporcie doszły faktury z historii — w zakresie eksportu
(wystawione / otrzymane), bez napraw treści. Ekran pokazuje 12 najnowszych
z dokładną liczbą (bez próbki pozycji — przy dużej historii żaden okres nie
ginie): „Po Twoim eksporcie doszły faktury z KSeF za okresy …”.

## 7. Rozmiar

Na fakturę ≈ XML 4–12 KB (MinIO na ops-1) + `fa3_data` 3–6 KB + pozycje
~1,2 KB + dziennik ~0,5 KB ≈ 15–20 KB. 100 firm × 2 000 faktur × 2 kierunki
≈ 8 GB w najgorszym razie. Twardy limit 25 000 pozycji na strumień
(≈ 0,5 GB). Przed wdrożeniem i co tydzień: `ksef-historia.sh stan` (sekcja
7: `df -h` na db-1 i rozmiar tabel). Faktury z historii nie idą do Glacier
(`archive-old-invoices` je pomija) do potwierdzenia konfiguracji AWS.

## 8. Wdrożenie (tylko na polecenie Bartosza)

**Bramka:** Bartosz potwierdza z prawnikiem, że regulamin i umowa
powierzenia obejmują automatyczne pobieranie pełnej historii KSeF, także
danych kontrahentów.

1. Scalenie PR.
2. 00155 na db-1 z `main` (AGENTS.md → „Wgrywanie migracji”), potem
   `schema_migrations` + `NOTIFY pgrst`. Sprawdzić PostgREST: obie tabele,
   oba widoki (`ksef_history_item_counts`, `ksef_history_export_changes`)
   i pole wyliczane `ksef_upo_expected` (42501, nie PGRST205/PGRST204).
3. `./scripts/ops/ksef-historia.sh stare-importy` — oba liczniki 0; inaczej
   poczekać.
4. Worker (id=2), potem aplikacja (id=1). Między nimi stary przycisk
   „Magiczny import” przez kilka minut nie wyśle zlecenia — akceptowane.
   Worker przy starcie usuwa kolejkę `import.ksef-history.requested`.
5. Weryfikacja: log workera „54 kolejek, 29/29 cronów”; w 15 min `stan`
   pokazuje strumienie sprzedaży, w 30 min — zakupów; brak nowych I3 i
   alarmów `ksef_history_*`; `/import-danych` pokazuje kartę.
6. Następny PR: typy z produkcji (`types/database.ts`), wiersz rejestru
   „wgrana na db-1 DD.MM”.

## 9. Ponowienia — co się dzieje przy powtórce każdego kroku

| Krok | Powtórka |
|---|---|
| Zakładanie strumieni | `ON CONFLICT DO NOTHING` |
| Fan-out | podwójne zlecenie trafia w dzierżawę albo regułę „należy się” |
| Odkrywanie | dziennik `ignoreDuplicates` po kluczu tożsamości; kursor i strona CAS; awaria przed ruchem kursora = to samo zapytanie |
| Archiwum XML | klucz deterministyczny + zapis tylko gdy brak; inny skrót = `archive_conflict` |
| Silnik | awaria po PEŁNYM zapisie → ponowna klasyfikacja daje `imported` (pochodzenie `importJobId` = id strumienia + pozycje, `xml_documents`, adnotacje); niepełny zapis → uzupełnienie silnikiem (gałąź duplikatu); katalogi `insert-only`/`skip`; indeksy 00120 |
| Zmiana pozycji | CAS na `status`/`attempts`/`updated_at` |
| Niższy początek historii | pod dzierżawą, CAS na kursorze; ponowienie nic nie zmienia (początek już niższy) |
| Dzierżawa | jeden warunkowy UPDATE (wolna, bez pauz); wygasa po 10 min |
| Czyszczenie błędu certyfikatu | warunkowy UPDATE (tylko błędy z listy) — idempotentny |
| pg-boss | `maxRetries 0` — ponowieniem jest następny cron |
| Pauza klienta | idempotentne ustawienie/zdjęcie, audyt |
