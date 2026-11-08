# Plan agenta Claude — szukanie i naprawa błędów przed launchem

> **Polecenie „kontynuuj plan z agentem”** (albo podobne) znaczy:
> 1. przeczytaj ten plik do końca,
> 2. zrób checklistę z sekcji 1,
> 3. pracuj od sekcji **„5. Następny krok”**,
> 4. po każdym zakończonym etapie zaktualizuj sekcję 4 (stan) i sekcję 5 (następny krok)
>    w tym pliku — w tym samym PR co poprawka albo w osobnym, małym PR.
>
> Plik prowadzi Claude na zlecenie Igora. Codex ma swój kanał:
> [`CLAUDE-DO-CODEXA.md`](CLAUDE-DO-CODEXA.md) (sprawy C-01…C-16).

---

## 0. Po co ten plan

FaktFlow trzyma prawdziwe faktury VAT, więc błąd w kwocie, eksporcie albo
wysyłce do KSeF to realna szkoda dla klienta (podatek, kara, zła KPiR).
Agent przechodzi po ścieżkach krytycznych, znajduje błędy, naprawia je
w kodzie z testami i zgłasza to, czego sam zrobić nie może (migracje,
wdrożenia, decyzje księgowe).

## 1. Start każdej sesji — checklista

| # | Co | Jak |
|---|---|---|
| 1 | Świeży stan repo | `git fetch origin`; nowa gałąź `git checkout -b claude/<temat> origin/main`. **Nigdy `git checkout main`** (lokalny main bywa nieaktualny). |
| 2 | Otwarte PR-y | `gh pr list --state open` — porównaj z tabelą w sekcji 4. Scalony/zamknięty PR → popraw tabelę. |
| 3 | Kanał z Codexem i audyt | [`CLAUDE-DO-CODEXA.md`](CLAUDE-DO-CODEXA.md) (od 02.10 szkice Codexa przejmuje sesja Claude Bartosza — C-20) oraz [`docs/audyt/`](../audyt/) — audyt logiki domenowej prowadzony przez sesje Bartosza (raport, plan, numery AUD-xx). Zanim weźmiesz sprawę, sprawdź, czy nie ma jej tam z właścicielem. |
| 4 | Cudze pliki | Zanim ruszysz plik: `git diff --name-only origin/main...origin/<gałąź>` dla KAŻDEGO otwartego PR (nie tylko `codex/*`). Plik w cudzym PR → nie zmieniaj, zgłoś. |
| 5 | Środowisko | `pnpm install` w worktree (bez `node_modules` testy nie ruszą); testy XSD potrzebują systemowego `xmllint`. |

## 2. Zasady — twarde

1. **Bez wdrożeń.** Żadnego deployu, restartu, zmian zmiennych w Coolify,
   `docker …`. Wdrożenie aplikacji (id=1) i workera (id=2) robi Bartosz.
2. **Bez migracji.** Nie tworzymy plików w `supabase/migrations/`. Potrzebna
   zmiana schematu → prośba do Bartosza w opisie PR (gotowy SQL + co
   sprawdzić przed) i wpis w sekcji 4.3.
3. **Scalanie: tylko na wyraźne polecenie Bartosza** — zasada zespołu
   z `AGENTS.md` („Scalanie PR”, 02.10.2026), która zastępuje zgodę z 01.10
   na samodzielne scalanie. Sesja Igora kończy na zielonym PR i zgłasza go
   do scalenia. Merge commit, nigdy `--admin`. Scalenie to nie wdrożenie —
   zasada 1 obowiązuje dalej.
4. **PR od `origin/main`, bez stosów.** Kilka gotowych PR-ów naraz → gałąź
   „wydanie” łącząca je, jedno CI, jedno scalenie.
5. **Każda poprawka:** test, który bez poprawki pada; testy mutacyjne
   (celowe psucie kodu — każda mutacja ma zostać złapana); `pnpm run ci`
   lokalnie przed pushem. Uwaga na CRLF w plikach przy skryptach mutacji.
6. **Rozmowa z Igorem po polsku.** Bez materiałów do nauki w repo.
7. Repo jest **publiczne** — żadnych adresów serwerów, kluczy ani danych klientów
   w tym pliku i w PR-ach.

## 3. Etapy

Status: ✅ zrobione · 🔄 w toku · ⏳ czeka na kogoś · ⬜ do zrobienia

| Etap | Zakres | Status | Gdzie |
|---|---|---|---|
| E1 | Eksporty: KPiR (koszty z wydatków, strony, odliczenie VAT), JPK_FA(4) wg XSD, JPK_V7M(3), CSV, eksporty programowe | ✅ / ⏳ | #58–#61, #91, #93, #97, #98, #99; wstrzymania #66, #93 |
| E2 | Faktury: adnotacje FA(3) (MPP, metoda kasowa, „odwrotne obciążenie”), ROZ po zaliczkach, PDF korekty, kod QR, mail z kwotą do zapłaty | ✅ / ⏳ C-05 | #75, #76, #79, #84, #95, #102, #103 |
| E3 | OCR i waluty: koszt w walucie obcej po kursie NBP | ✅ | #94 |
| E4 | Joby pg-boss: ponowienie wykonuje CAŁY job od nowa (brak pamięci kroków) — każdy zapis musi być odporny na powtórkę | ✅ | #109 (OCR), #112/#116 (Co-Pilot), #114 (Sentry w workerze), #118 (maile triala), #119 (zapis przebiegów); lista w 3.1 |
| E5 | RODO / konto: usunięcie konta a subskrypcja i klucze obce | ✅ | #108 + migracja 00113 |
| E6 | Konfiguracja produkcji bez cichych zastępstw (GUS sandbox, brak kluczy) | ✅ / ⏳ B2 | #107 |
| E7 | Retencja 10 lat: joby `retention-delete`, `archive-old-invoices` — czy nic nie kasuje faktur przed terminem | ✅ sprawdzone 01.10 | uwagi w 3.2 |
| E8 | Pozostałe obszary: import (Magiczny Import), portal księgowej, walidatory formularzy, powiadomienia | ✅ przegląd 01.10 | portal: token jako hash, wygaśnięcie, odwołanie, firma i ścieżka XML sprawdzane; push tylko do aktywnych członków; walidator ZAL bez „zw” = C-15; import: silnik w stosie Codexa, parsery FA(3)/JPK_FA ignorowały walutę — #130. Uwaga dla Codexa: Magiczny Import łapie błąd parsera tylko w logu (`magic-import-ksef.ts`), użytkownik nie widzi powodu pominięcia |
| E9 | Flo — funkcje zapisujące dane (`payment.confirm`, `expense.review`, `expense.rule`, `payment.chase`) | ✅ przegląd 01.10 | `expense.*` bez skutków wstecz; `payment.confirm` — uwaga o dacie wpłaty w 4.4; `payment.chase` = ponaglenia (stos Codexa) |
| E10 | Formularze faktur VAT/KOR/ZAL/ROZ — przypadki brzegowe dat i kwot (art. 106i, 106e) | ✅ przegląd 01.10 + poprawka | KOREKTA przeglądu: reguły sprawdzane tylko przy wysyłce (`validateInvoice` w jobie) — rachunek przy przelewie, format IBAN wymagający „PL” (zwykłe 26 cyfr odrzucane), zakres daty wystawienia — przepuszczały fakturę przez zapis, a wysyłka padała bez możliwości poprawki; #134. Ograniczenia produktowe w 4.4. Formularz i akcje VAT/KOR/ZAL/ROZ w stosie Codexa |
| E11 | Ustawienia firmy i KSeF — zmiana NIP, danych sprzedawcy, certyfikatu; co dzieje się z wystawionymi fakturami | ✅ przegląd 01.10 | PDF bierze sprzedawcę z migawki faktury (`seller_data`); NIP firmy ustawia się tylko w szkicu; ponowna wysyłka wstrzymana do ręcznego uzgodnienia |
| E12 | Koszty samochodu osobowego (50% VAT, 75% PIT) — aplikacja odlicza 100% VAT i nie stosuje limitu | ⏳ decyzja | 4.4 |
| E15 | Job OCR po B4: ponowienie bez płatnego OCR, karta i powiadomienie z zapisanego wydatku, `onProcessOcrExhausted` bez „nieudane” w ciemno | ✅ 03.10 | #192 (razem z B4) |
| E16 | Resztki OCR i karty wydatku: karta przy braku kursu (`deductible: 1` → „stale”, kwota w walucie jako „zł”, `unknown_seller` nieosiągalne); status odczytu OCR (błąd bazy = „Job nie istnieje”); baner „odczytany” nad kartą porażki; zawieszone „przetwarzanie” (decyzja); dubel przy ponownym wgraniu zdjęcia (decyzja) | ✅ 03.10 kod / ⏳ decyzje | #198; decyzje Bartosza w 5 |
| E17 | Podpięcie E16 w `process-ocr` (po scaleniu #192 i #198): waluta kwot i `is_deductible` do karty (świeża ścieżka i `reviewSourceFromSaved`), `ocrJobId` w karcie sukcesu (baner bez wniosku z czasu), karta porażki w `onProcessOcrExhausted` | ✅ 05.11 kod / ⏳ scalenie | #416 (osobne ustalenia w opisie PR) |

### 3.1. Audyt jobów pod ponowienia (E4)

Pytanie dla każdego joba: *co się stanie, gdy job padnie PO zapisie i wykona
się od nowa?*

| Job | Wynik |
|---|---|
| `process-ocr` | ❌→✅ dubel wydatku w KPiR — #109 |
| `co-pilot-monthly` (cron) | ❌→✅ rezerwacja okresu przed wysłaniem zdarzenia; ponowienie pomijało firmy → paczka za miesiąc nie wychodziła — #112 |
| `co-pilot-monthly` (paczka) | ❌→✅ ponowienie po wysłanym mailu tworzyło nowe eksporty i wysyłało mail drugi raz; `emailed_at` nikt nie zapisywał — #116; nieudana paczka → Sentry od #114 |
| `auto-categorize-inbox` | ✅ sprawdza istniejący wydatek po `ksef_invoice_id` |
| `download-upo` | ✅ odczyt/aktualizacja istniejącego rekordu |
| `dunning-payment-failed`, `trial-countdown-emails` | ✅ claim w `billing_notifications` |
| `retention-delete`, `archive-old-invoices` | ✅ ponowienie bezpieczne (aktualizacje idempotentne) — reszta w 3.2 |
| `exports-generate` | ✅ nazwa pliku deterministyczna, HEAD przed wgraniem do R2, upsert `export_files`. Drobiazg: JPK ma znacznik czasu, więc po ponowieniu `file_hash`/`size_bytes` mogą nie pasować do pliku w R2 — nikt ich nie weryfikuje |
| `email-sequence` | ❌→✅ TREŚĆ: maile dnia 12 i 14 („2 dni do końca trialu”, „trial zakończony, read-only, dane usuwane po 30 dniach”) przeczyły regulaminowi (trial 30 dni), retencji i aplikacji; dzień 14 szedł do płacących — wstrzymane (#118). Ponowienia: powitalny mail może pójść drugi raz, gdy padnie planowanie dnia 1 — drobne |
| `daily-summary-email` | ✅ raport dla operatora, bez skutku dla klientów. ALE: wskaźnik „błędy jobów” czytał `inngest_run_log`, do której NIKT nie pisał (także panel `/admin/system`) — zawsze 0; naprawione w #119 (worker zapisuje każdy przebieg) |
| `magic-import-ksef` | stos Codexa (#63–#86) — tylko czytać |
| `reminder-scheduler` | ✅ propozycje deduplikowane po `topic_key` (wyścig: 23505) |
| `send-reminder` | ✅ mail z `idempotencyKey: 'reminder/' + approvalId` |
| `bulk-import` | ✅ deduplikacja po numerze i numerze KSeF + UNIQUE `(tenant_id, internal_number)`; kolizje numerów faktur odebranych to C-08 (#117) |
| `nightly-validation-recheck`, `bulk-validate-contractors` | ❌→✅ awaria API Białej Listy/VIES (timeout, limit zapytań) zapisywała kontrahentowi „nieznany” i pustą listę rachunków na 7 dni i truła cache na 24 h — #123 |
| `cert-expiry-alert` | ✅ data wygaśnięcia zapisywana przy wgraniu certyfikatu; progi 30/14/7 w oknach jednodniowych |
| `cleanup-old-backups` | ❌→✅ retencja samą datą kasowała ostatnie DOBRE kopie, gdy nowe od miesiąca się nie udawały — zostaje zawsze 7 najnowszych udanych (#124) |
| `submit-invoice`, `inbox-polling`, `self-invoice-payment`, `process-offline-queue` | Codex (stos #62–#86) — tylko czytać, uwagi przez C-xx |

### 3.2. Retencja (E7) — wynik przeglądu 01.10.2026

Nic nie kasuje faktur przed terminem: archiwum (Glacier) bierze faktury
starsze niż 2 lata od daty wystawienia i planuje usunięcie za 8 lat, czyli
najwcześniej 10 lat od wystawienia (ustawowo wystarczy 5 lat od końca roku
terminu płatności podatku). Bez konfiguracji AWS archiwum rzuca błąd, nic
nie oznacza. Uwagi, bez pilności:

| Uwaga | Kiedy zaboli |
|---|---|
| `retention-delete` kasuje paczką 100 faktur; korekta (`parent_invoice_id … ON DELETE RESTRICT`) albo wydatek (`expenses.ksef_invoice_id`) blokuje całą paczkę i job staje codziennie na tych samych wierszach | ~2034 |
| `archive-old-invoices`: jedna faktura z brakującym XML w R2 zatrzymuje archiwizację wszystkich (te same 500 kandydatów co dzień) | gdy pierwszy XML zginie |
| Faktury bez XML (import CSV) nigdy nie dostają terminu usunięcia | RODO, po 10 latach |

## 4. Stan — aktualizuj po każdym etapie

**Ostatnia aktualizacja:** 03.10.2026 wieczór (20:45) — Claude (sesja z Igorem).
`main` poszedł do `d1aae4c` (#199–#201 Bartosza, w tym protokół naprawy).
Moje PR-y są BEHIND, bez konfliktów; aktualizuje je Bartosz przy scalaniu
(`gh pr update-branch`). Wcześniej: punkt 00
sprawdzony (main dalej czerwony, wiadomość dla Bartosza), F-093 zrobione w #189,
B4 i E15 w #192 (kod + prośba o migrację w opisie). Po południu Bartosz scalił
B8 (`553d69e`, `shadcn` w devDependencies) i #186 — audyt w CI zielony; moje
PR-y #187–#189 i #192 zaktualizowane merge'em z `main`. Wieczorem E16 w #198
(karta wydatku, status OCR, baner zdjęcia — po przeglądzie w trzech
soczewkach i poprawkach).

**Co się zmieniło 02.10 (ważne dla każdej nowej sesji):** sesje Claude
Bartosza zrobiły audyt logiki domenowej (`docs/audyt/blok-1/`, PR #166),
przeniosły cały stos Codexa na `main` (#170–#180, C-20) i dodały zasady
scalania i migracji w `AGENTS.md` (#168). Main poszedł od #134 do #185.
Wiele spraw z tego planu zamknęły tamte PR-y — tabela 4.4 jest po
sprawdzeniu na kodzie 03.10. Stan wdrożenia i wgranych migracji prowadzi
Bartosz (rejestr migracji w `CLAUDE-DO-CODEXA.md`, migracje do 00200) —
nie zakładaj, że coś jest albo nie jest na produkcji.

### 4.1. Moje PR-y — wszystkie scalone

Do `main` weszły: #91–#97, #100, #101, #105 (= #98, #99, #102, #103),
wydanie #111 (`7a9f49a`) z #106–#110, #134 (przez #167 Bartosza) oraz:

| PR | Co |
|---|---|
| #106 | Koordynacja: C-05 (aktualizacja), C-11…C-16 |
| #107 | JPK_FA: bez `GUS_API_KEY` w produkcji odmowa zamiast adresu z testowej bazy GUS |
| #108 | RODO: usunięcie konta nie zostawia płatnej subskrypcji bez opiekuna |
| #109 | OCR: ponowienie joba nie dubluje wydatku w KPiR |
| #110 | Ten plan + wskaźnik w `AGENTS.md` |
| #112 | Co-Pilot (cron): ponowienie nie gubi miesięcznej paczki dla księgowej |
| #114 | Worker pg-boss inicjalizuje Sentry — alerty z jobów wcześniej nie wychodziły wcale |
| #116 | Co-Pilot (paczka): ponowienie nie wysyła księgowej drugiego maila; zapis `emailed_at` |
| #118 | Wstrzymane maile triala z dnia 12 i 14 (sprzeczne z regulaminem i retencją) |
| #119 | Worker zapisuje przebiegi jobów do `inngest_run_log` — panel i raport „błędy jobów” przestają pokazywać zawsze 0 |
| #121 | C-17 w kanale z Codexem (tylko dokumentacja) |
| #123 | Awaria API Białej Listy/VIES nie kasuje statusu VAT i rachunków kontrahenta ani nie truje cache |
| #124 | Retencja kopii bazy zostawia zawsze 7 najnowszych udanych |
| #127 | Plan: E10/E11 przejrzane, E12 samochód do decyzji (scalony razem z #129) |
| #129 | Kafelek „Szac. podatek” na przepływach liczy od 1 stycznia (był: ostatnie 6 miesięcy, także z zeszłego roku) + C-21 (zgłoszone jako „C-18”, numer zajęty — zob. 4.4) |
| #130 | Import FA(3)/JPK_FA odmawia faktury w walucie obcej (kwoty szły jak złote do KPiR) |

### 4.2. Otwarte PR-y Claude

#187 (ten plan), #188 (C-21, gałąź `claude/przeplywy-od-stycznia`), #189
(F-093, gałąź `claude/jolly-tesla-jg9c9z`), #192 (B4 + E15, gałąź
`claude/ocr-unikalnosc-b4`), #198 (E16, gałąź `claude/karta-wydatku-e16`) i #191 (atrapa GUS w teście hasha eksportu —
z zadania zgłoszonego 03.10, gałąź `claude/test-hash-gus-atrapa`) — czekają
na scalenie przez Bartosza.
Audyt zależności naprawiony w `main` (B8) — CI liczy się od nowa po
aktualizacji z `main` (03.10 po południu: #187–#189 i #192 zaktualizowane).
#186 Bartosza (korekta dla firmy z UE, np. II) scalony 03.10.

### 4.3. Prośby do Bartosza (migracje, produkcja) — stan 03.10

| # | Prośba | Stan |
|---|---|---|
| B1 | Wdrożyć `main` (aplikacja + worker) | u Bartosza — rejestr migracji / wdrożeń w `CLAUDE-DO-CODEXA.md` |
| B2 | Sprawdzić/ustawić `GUS_API_KEY` na produkcji | nieznany |
| B3 | Klucze obce blokujące usunięcie konta (RODO) | ✅ migracja `00113_user_deletion_foreign_keys` |
| B4 | Odczyt dubli wydatków z OCR, potem `UNIQUE (tenant_id, ocr_job_id)` | 03.10: kod (obsługa 23505, „nie rozpoznano” po zapisie) w #192; w opisie #192 gotowy SQL sprawdzony na PG16 z kompletem migracji: liczenie dubli, odczyt dla księgowej, migracja `00NNN_expense_ocr_job_identity` (numer nadaje Bartosz — **00129 rezerwuje szkic Codexa #190**), wiersz do rejestru. Czeka na Bartosza |
| B5 | C-16: płatności/ponaglenia ROZ | ✅ częściowo #178 (ponaglenia i zaległości tylko dla faktur ścigalnych, 00126) |
| B6 | `SENTRY_DSN` w zmiennych workera (log startu „Sentry: alerty z jobów włączone”) | nieznany; od #120 alerty idą też na Telegram |
| B7 | Mail o końcu trialu dla kont bez karty | decyzja — cennik i trial ujednolicone w #136 (`lib/billing/pricing.ts`) |
| B8 | CI: `shadcn` → `devDependencies` (punkt 00 w sekcji 5) | ✅ Bartosz 03.10, `553d69e` w `main` — `pnpm audit --prod` czysty |

### 4.4. Czeka na decyzję / kogoś innego — sprawdzone na kodzie 03.10

| Sprawa | Stan / kto |
|---|---|
| C-05: adnotacje P_16/P_18A dla ZAL i ROZ | ✅ #176, #177 (z zamrożonej koperty) |
| C-17 = audyt F-020: faktura zaliczkowa bez P_6 (data otrzymania zaliczki) i z przyszłym terminem zamiast „zapłacono” | otwarte; `Zamowienie` zrobione (AUD-71, #177). Generator ZAL zmieniany 02.10 przez sesje Bartosza (AUD-70) — **zanim weźmiesz: ustal z Bartoszem**, czy ktoś to robi |
| C-15 = AUD-04: korekty i zaliczki przy stawce „zw” rzucają wyjątek; korekty na produkcji wstrzymane (`lib/ksef/submission-holds.ts`, AUD-03/04) | otwarte; #186 scalony 03.10 — zostaje uzgodnienie z Bartoszem (pliki korekt zmieniały jego sesje) |
| F-093: `KsefApiError.ksefCode` zawsze `null` + odpowiedź `application/problem+json` nieparsowana (kody z tego kształtu, także 21184 z F-050, nieczytelne w prawdziwym `ksefFetch`) | zrobione 03.10 w #189 — czeka na scalenie przez Bartosza |
| F-093-KOPIA: `historyKsefErrorCodes` w `lib/ksef/history-sync/errors.ts` to ręczna kopia `ksefErrorCodes`. Powód kopii (zakaz importu `lib/ksef/submit.ts`) znika po #189, bo parser jest wtedy w `client.ts`, który ten plik już importuje | otwarte, po scaleniu #189: usunąć kopię i importować parser z `client.ts`; do tego czasu `tests/unit/ksef-kod-bledu.test.ts` sprawdza obie na tych samych danych |
| C-21 (dawniej mylnie „C-18” — ten numer ma sprawa „Niepewny wynik wysyłki KSeF i UPO”): strona przepływów ładuje dane od 1 stycznia i przekazuje `dataFrom` | zrobione 03.10 w #188 — czeka na scalenie przez Bartosza |
| Szacunek podatku zakłada 19% liniowy dla każdego (podpisane na kafelku); skala i ryczałt dałyby inne kwoty; Flo ma profil podatkowy (`taxGateOpen`) | decyzja produktowa (Bartosz) |
| JPK_V7M: pole dla „oo” i okres według daty sprzedaży | księgowa |
| C-01: konwencja kwot korekty | ✅ rozstrzygnięte 02.10 (I1: różnica, #146); JPK_FA z korektą — audyt F-060 |
| Ochrona przed brakiem `KSEF_ENV` (`claim-environment`) | ✅ `lib/ksef/claim-environment.ts` na `main` (#172) |
| Autouzupełnianie kontrahentów z testowej bazy GUS bez klucza | zgłoszone, decyzja produktowa |
| Pulpit `monthly-figures` i FLO sumują `gross_total` ROZ | ✅ pulpit odejmuje zaliczki (#151) |
| Flo `payment.confirm` zapisuje `payment_date` = dzień KLIKNIĘCIA, nie wpływu pieniędzy (karta pyta dobę po terminie, zbiorczo). Dziś czytają to tylko zabezpieczenia ponagleń — ale zanim VAT metodą kasową (#76) zacznie liczyć okres z wpłat, karta musi pytać o datę wpływu | przyszłość, decyzja przy JPK_V7M dla metody kasowej |
| **E12 — samochód osobowy.** Paliwo i inne wydatki na auto idą z odliczeniem 100% VAT (OCR, skrzynka KSeF), a użytkownik nie ma jak ustawić 50%. W typowej mikrofirmie (użytek mieszany): VAT tylko 50% (art. 86a ust. 1), nieodliczona połowa do kosztu, koszt PIT max 75% (art. 23 ust. 1 pkt 46a); leasing ma osobne limity (pkt 47a). Dziś KPiR zaniża koszt o połowę VAT i nie stosuje limitu 75% (JPK_V7M zawyżyłby odliczenie, ale jest wstrzymany). Propozycja: ustawienie firmy „samochód: brak / mieszany / 100% firmowy (VAT-26)”, rozpoznanie wydatków samochodowych (paliwo, serwis, ubezpieczenie) i proporcja odliczenia przy zapisie wydatku | Igor + księgowa (decyzja, co liczyć), potem Claude |
| Import: Magiczny Import z KSeF zapisuje faktury jako `accepted` (wchodzą do KPiR i eksportów), a import pliku JPK_FA/CSV jako `draft` (nie wchodzą). Spójne z celem „historia z innego programu, który już zaksięgował”? Szkiców z importu nie da się wysłać do KSeF (wysyłka tylko z formularza „zapisz i wyślij”). Wszystkie importy zapisują `invoice_kind = regular` z kwotami z pliku (ROZ = reszta po zaliczkach, KOR = różnica) — w KPiR bez dubli | decyzja produktowa (Igor/Bartosz) |
| Data sprzedaży po dacie wystawienia (art. 106i ust. 7) | ✅ audyt P-22 (`isSaleDateWithinLimit` w `schemas/invoice-form.ts`) |

## 5. Następny krok

00. ✅ **CI czerwone przez audyt `braces` (03.10)** — rozwiązane przez
    Bartosza (B8, `553d69e`: `shadcn` w devDependencies). Po aktualizacji
    z `main` PR-y przechodzą audyt; lokalnie `pnpm audit --prod` czysty.
0a. **Od 03.10 wieczór obowiązuje „Protokół naprawy błędu” (`AGENTS.md`,
   #201):
   - jedna naprawa = jedna gałąź `claude/<kod>-<temat>` = jeden PR;
   - najpierw czerwony test na prawdziwej ścieżce (wyzwalacze, RPC i statusy
     na bazie, `tests/rls-*`);
   - opis PR według `.github/pull_request_template.md`;
   - komendy dla Bartosza jako skrypty w `scripts/ops/`, nie bloki
     „`source` + komenda”;
   - po etapie raport i stop do „idź dalej”.
   Moje PR-y #187–#198 powstały przed protokołem. Opis #198 przepisany na
   szablon (na `main` czerwonych 70 ze 160 testów E16). #192 ma dla
   Bartosza bloki z `source .agents/infra.env` — skrypt w `scripts/ops/`
   tylko po decyzji Igora.
0. **Najpierw podział pracy z sesjami Bartosza.** Logikę domenową prowadzi
   teraz audyt (`docs/audyt/`). Zanim weźmiesz sprawę z listy niżej, ustal
   z Igorem (a on z Bartoszem), czy jest twoja — inaczej dwie sesje zrobią
   to samo w tych samych plikach.
1. **Następny krok: zapytać Igora** o C-17 / C-15 (pkt 2 — mogą je robić
   sesje Bartosza). **E17** (podpięcie E16 w `process-ocr`) czeka na
   scalenie #192 i #198 — bez tego konflikt w `process-ocr.ts`. Do E17:
   w świeżej ścieżce `amountCurrency: cost.kind === 'missing_rate' ?
   currency : 'PLN'` i `deductible: cost.kind !== 'missing_rate'`;
   w `reviewSourceFromSaved` waluta ze śladu i `expense.is_deductible`
   (`SAVED_EXPENSE_COLUMNS` + `is_deductible`); `ocrJobId` w ładunku karty
   sukcesu i dokładne dopasowanie w banerze (`photoBannerResult`); karta
   porażki (best effort) w `onProcessOcrExhausted`. Do tego czasu karta
   z #198 działa jak na `main` (PLN, `deductible: 1`) — (a) i (b) widać
   dopiero po E17; (c)–(e) działają od razu.
   **Decyzje Bartosza (E16, dalej otwarte):** zawieszone „przetwarzanie” —
   po wyczerpaniu ponowień samego pg-boss `onExhausted` się nie wywołuje,
   a `findStuckOcrJobs` nie jest podpięty, choć `share-target/route.ts`
   i baner obiecują kartę „po 3 min” (technicznie: krok w `jobs-watchdog`,
   bez nowego crona, rozstrzygany stanem pg-boss, nie czasem); ponowne
   wgranie tego samego zdjęcia (także po 60 s limitu w przycisku) daje
   drugi wydatek.
   **Drobne z przeglądu E16 (poza zakresem #198, do wzięcia osobno):**
   tekst `expense.review:ask` („…zanim to zaksięguję”) przy koszcie już
   zapisanym; komunikat po 60 s w przycisku bez zdania, że zdjęcie jest
   bezpieczne (ryzyko drugiego wgrania); „Nigdy więcej takich” na karcie
   porażki wycisza cały `expense.review`; brak banera w pustym wątku
   (`FloWelcome`); `categorizeExpense` dostaje kwoty w walucie; karta
   skrzynki KSeF (W-02) sumuje kwoty w walucie jako „zł”.
   Zrobione 03.10: F-093 w #189 (getter `ksefCode` przez `ksefErrorCodes`;
   `ksefFetch` parsuje też `application/problem+json` — inaczej 21184 z
   F-050 w tym kształcie nie byłby rozpoznany), B4 + E15 w #192, C-21 w #188,
   E16 w #198.
   **Weryfikacja na prawdziwej bazie:** w kontenerze w chmurze jest
   PostgreSQL 16 (`/usr/lib/postgresql/16/bin`); komplet migracji repo
   wchodzi na czystą bazę z atrapami Supabase (role, `auth.*`,
   `supabase_migrations`, `pgboss.job`) — tak sprawdzono SQL dla B4.
   **Numery migracji:** rejestr na `main` nie wystarcza — sprawdź też
   gałęzie zdalne (`git ls-tree -r --name-only <gałąź> supabase/migrations`;
   03.10 szkic #190 zajął 00129).
   **Numery spraw `C-xx`:** przed nadaniem sprawdź `grep "^### C-"
   docs/koordynacja/CLAUDE-DO-CODEXA.md` — sesje Bartosza też je nadają
   (03.10 kolizja „C-18”).
   **Vitest na Windows:** 6 testów pada lokalnie niezależnie od zmian
   (CRLF w plikach SQL, `\` w ścieżkach: `cennik-jedna-cena`, `ci-rls`,
   `jeden-adres-kontaktowy`, `rodo-usuniecie-konta-klucze`). Na GitHub CI
   (Linux) przechodzą — sprawdź tylko, że na liście nie ma nic więcej.
   Po dużym `git pull` typecheck krzyczy o `app/api/inngest` → usuń
   `.next` i `tsconfig.tsbuildinfo`.
   **Sesja w chmurze (kontener Claude Code):** `pnpm install` + `pnpm run ci`
   działają; pada tylko `tests/unit/export-file-hash-integrity.test.ts`
   (2 testy, także na czystym `main`) — test woła PRAWDZIWĄ testową bazę GUS
   (`lookupCompanyByNip` z `@/lib/gus/client` bez atrapy), a proxy kontenera
   daje 403. Na GitHub CI przechodzi, dopóki sandbox GUS odpowiada — ukryta
   zależność testu od sieci, kandydat na małą poprawkę (atrapa w teście).
2. Po uzgodnieniu: C-17 / F-020 (P_6 i „zapłacono” w ZAL); C-15 / AUD-04
   (korekty „zw”) — #186 już scalony, zostaje tylko uzgodnienie.
3. E14 zamknięty 03.10: generatory KOR/ZAL nie wołają `validateInvoice`;
   formularze wymuszają 26 cyfr rachunku i identyfikator B2C; jedyna blokująca
   reguła to „zw” (C-15). ROZ wstrzymana.
4. E13: funkcje podatkowe Flo (grupa T) WYŁĄCZONE bramką
   (`lib/flo/tax-params.ts`: `PARAMS_VERIFIED = false`) — przegląd przed
   włączeniem, razem z weryfikacją parametrów przez księgową.
5. Po decyzji Igora/księgowej: E12 (samochód 50%/75%).

Sprawdzone 01.10 bez zmian: `daily-db-snapshot`, `verify-backup` (suma
kontrolna, rozpakowanie, liczby wierszy), `cleanup-audit-logs` (logi > 12 mies.,
`inngest_run_log` > 3 mies.), `refresh-materialized-views`,
`weekly-business-review`, `daily-analytics-digest`. Analityka PostHog:
lista dozwolonych zdarzeń i właściwości, identyfikatory tylko UUID, host UE,
zgoda — bez uwag.
