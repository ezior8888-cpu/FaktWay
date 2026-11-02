# Plan „zero zgubionych faktur” — ostatnia runda napraw wysyłki KSeF

Stan na 04.10.2026. Właściciel: Bartosz. Wykonawcy: sesje agenta (jedna
sesja = jeden blok albo jedna sesja z tego planu). Obowiązuje
**„Protokół naprawy błędu”** z `AGENTS.md` bez wyjątków: czerwony test
na prawdziwej ścieżce → naprawa → `pnpm run ci && pnpm build` → PR według
szablonu → raport i stop. Ten plan mówi *co* i *w jakiej kolejności*;
protokół mówi *jak*.

> Jak zacząć sesję z tego planu: „Kontynuuj plan zero zgubionych faktur,
> sesja N”. Sesja czyta ten plik, `docs/architecture/cykl-zycia-faktury-ksef.md`
> i raport rewizji `docs/automation/13_REWIZJA_2026-10-03.md` (plik poza
> gitem — jeśli go nie ma, poproś Bartosza), robi TYLKO swoją sesję, na
> końcu dopisuje w sekcji 9 wiersz „zrobione / co zostało” i numer PR.

---

## 1. Cel i definicja sukcesu

**Cel biznesowy:** klient FaktFlow nigdy nie dostaje kary ani odsetek
z powodu tego, co zrobiła (albo czego nie zrobiła) aplikacja.

**Co oznacza „faktura zgubiona po cichu”:** stan faktury w FaktFlow różni
się od stanu prawnego (KSeF, termin wystawienia, treść dokumentu), a przez
15 minut nikt — ani automat, ani klient, ani operator — nie dostał o tym
sygnału **z wyjściem** (co zrobić). Każdy taki przypadek to kandydat na karę:
faktura nie wystawiona w terminie (art. 106na), wystawiona dwa razy
(duplikat w KSeF), wystawiona z błędną treścią (korekta liczona od złego
stanu, zła stawka, zły nabywca), bez dowodu (UPO/XML) albo w złym
środowisku (TEST zamiast PROD).

**Definicja sukcesu (mierzalna, do odhaczenia w sekcji 8):**

1. Każdy stan końcowy faktury wychodzącej ma **wyjście**: automat (cron),
   klient (przycisk z komunikatem, co dalej) albo operator (`/admin/ksef`).
   Żaden kod błędu z katalogu `ksef_error_codes` nie jest ślepą uliczką.
2. Strażnik `ksef_lifecycle_violations()` zwraca **0 wierszy** poza I5D
   (faktury czekające na decyzję klienta, od 00148 — stan, nie naruszenie;
   `I5D-env` = 0) przez 14 kolejnych dni produkcji, a alarm „Strażnik cyklu
   życia” nie odezwał się ani razu bez znanej przyczyny.
3. Każda faktura `accepted` ma w ciągu 24 h numer KSeF, plik XML tej
   próby, wpis `xml_documents` i UPO (I3 = 0).
4. Każdy dokument, który wychodzi do KSeF, przeszedł **ten sam** zestaw
   kontroli treści, co formularz: granice XSD, data wystawienia, stawki,
   nabywca — nie ma pola, które formularz przepuszcza, a KSeF odrzuca.
5. Scenariusze z sekcji 7 (duplikat 440, odrzucenie 450, zabity worker
   w trakcie `sending`, awaria bazy w kolejkowaniu, reset + poprawa + ponowna
   wysyłka, druga korekta) są **zautomatyzowane na prawdziwym KSeF TEST**
   i przechodzą w CI co tydzień.
6. Przełączenie TEST → PROD ma runbook przećwiczony na kopii bazy.

Czego ten plan nie obiecuje: zera błędów w aplikacji. Obiecuje, że błąd
w wysyłce **nie zostaje niewidoczny** i **nie kończy się karą**, bo każda
ścieżka ma kontrolę przed wysyłką, uzgodnienie po wysyłce i alarm w środku.

---

## 2. Zasady tej rundy (uzupełnienie protokołu z AGENTS.md)

Lekcje z 03–04.10.2026, które kosztowały realny czas:

1. **Jeden PR od `origin/main`, bez stosów.** Stos PR na GitHubie nie
   przestawia bazy po scaleniu bazowego; dwa razy treść poszła do gałęzi
   zamiast do `main` (#206, #208). Kolejny PR dopiero po scaleniu
   poprzedniego, albo po `gh pr edit N --base main` zrobionym przez agenta.
2. **Plik `'use server'` eksportuje wyłącznie funkcje asynchroniczne.**
   Komunikaty, typy, czyste funkcje idą do `lib/**`. `pnpm typecheck`
   tego nie łapie, `pnpm build` tak — dlatego build jest obowiązkowy
   przy każdym dotknięciu akcji, nie tylko `app/`.
3. **Fixture zdarzenia = pełny, poprawny payload** (`sendAttemptId` jako
   UUID, faktura z `finalizeInvoice`). Niepoprawny payload w teście kończy
   się `INVALID_EVENT` i udaje inny błąd.
4. **Testy na bazie dla wszystkiego, co ma wyzwalacz, RPC albo RLS**
   (`tests/rls-*.test.ts`, job CI „RLS isolation”). DELETE z roli klienta
   może skończyć się „0 wierszy” przez RLS zanim dojdzie do wyzwalacza —
   asercja sprawdza skutek (wiersz zostaje), nie konkretny kod błędu.
5. **Test niestabilny pod pełnym biegiem to defekt testu** (S22 z
   `vi.resetModules`). Naprawia się go osobnym, małym PR od razu.
6. **Czyste moduły dla decyzji współdzielonych** (`lib/invoices/ksef-send-policy.ts`,
   `lib/admin/ksef-operator-policy.ts`, `lib/ksef/send-error-classes.ts`):
   przycisk i akcja podejmują tę samą decyzję z tej samej tabeli.
7. **Bez `vi.resetModules`/`vi.doMock` w locie** — stan testu steruje się
   hoisted wartością w jednej atrapie.
8. **Migracje:** numer z rejestru, nagłówek „przed/PO wdrożeniu”, zero
   `DROP TABLE/COLUMN`, `UPDATE` na danych tylko za zgodą; typy bazy po
   wgraniu generowane z produkcji (odstępstwo tylko jawne, z domknięciem
   w następnym PR — jak #215 → #217).
9. **Operator ma wyjście dla każdego kodu klasy reconcile.** Zanim
   dodasz nowy kod albo blokadę, dopisz go do tabeli w `/admin/ksef`
   (`lib/admin/ksef-operator-policy.ts`) i do `docs/runbooks/ksef-error-codes.md`.
10. **Produkcja czytana tylko skryptem** `scripts/ops/kontrola-faktur-ksef.sh`
    i procedurami z `AGENTS.md`; żadnych ręcznych odczytów danych klientów
    poza nimi.

---

## 3. Stan wyjścia (co już jest)

Zrobione i wdrożone 03–04.10.2026 (migracje 00131–00134 na db-1):

| Obszar | Co | PR |
|---|---|---|
| Katalog kodów i RPC przejść | `ksef_error_codes`, `enqueue/requeue/reset/release_ksef_send`, `ksef_has_contact_evidence`, strażnik I1–I5, I9 | #202 |
| Worker | klasyfikacja błędów jednym katalogiem; `rejected` tylko dla błędu treści; kody i zwolnienie przejęcia przy każdej porażce; zamykanie historii po 450/440; oczekiwanie bez zużycia próby | #204 |
| Kolejkowanie | `draft → queued` w jednej transakcji z zleceniem pg-boss; klient nie pisze `ksef_status` | #205 |
| Klient | „Wyślij ponownie” / „Wróć do szkicu” wg klasy kodu i roli; etykiety stanu | #206/#207 |
| Operator | `/admin/ksef`: naruszenia, `failed` per kod, karta faktury, „Wyślij ponownie / Tylko uzgodnij / Wróć do szkicu” | #208/#209 |
| Wyzwalacze | 00132: klient nigdy nie zmienia stanu; diagnostyka nie zamraża treści | #210 |
| Automat | cron co 15 min: I1, ponowienia klasy transient przez 24 h, wznowienie po hamulcu; raport dzienny; alarm strażnika; martwe kolejki usunięte | #211 |
| Korekty | 00133 + 00135: jedna korekta w toku; łańcuch korekt — „stan przed” po ostatniej przyjętej KOR (prawdziwe K4) | #212, #217 |
| Magazyn XML | klucz per próba (D5), wpis `sent` zna swój plik, retencja prób | #215 |
| Uzgodnienie | tryb „tylko uzgodnij” w runnerze; okno 48 h dla zalegających wpisów `sent` (STALE) | #216 |
| Wcześniej | K1 (faktura za abonament), K2 (skrzynka: kategoryzacja i XML), W1, W2, W3, W16, S1, S14, S22 | #199–#201, #213, #214 |

#216 i #217 scalone 04.10.2026; 00135 wgrana na db-1 04.10 (strażnik 0),
worker i aplikacja wdrożone na `2dbf13a` (razem z A1, #219). Hamulce nadal włączone na PROD: `KOR_HOLD` (korekty),
`ROZ_HOLD` (faktury rozliczające), Offline24 wyłączony (AUD-14).

Nienaprawione z rewizji (tematy tego planu): W4–W15, S2–S13, S15–S21, S23,
NISKIE.

---

## 4. Mapa źródeł kar — skąd realnie bierze się kara

| # | Mechanizm kary | Dziś chroni | Luka | Sesja |
|---|---|---|---|---|
| M1 | Faktura nie trafiła do KSeF w dniu wystawienia (art. 106na: datą wystawienia jest data przesłania; faktura „z wczoraj” wysłana dziś to dokument offline wymagający trybu i oznaczeń) | kontrola „dziś” w zwykłej fakturze i szkicu; automat ponawia przez 24 h | ZAL/KOR/ROZ bez kontroli „dziś” (W5); faktura `failed` przez noc wychodzi nazajutrz **z wczorajszą datą** bez trybu offline; brak decyzji, co robić po północy | A1, B1, B2 |
| M2 | Duplikat w KSeF (ta sama faktura dwa razy) | uzgodnienie po referencji przed POST, 440 → własny duplikat, `singletonKey`, przejęcie 00124 | okno POST → zapis referencji (awaria między) → 440 bez sesji w historii → `failed KSEF_DUPLICATE_RECONCILE` (wyjście operatora, nie automatu) | A2, H1 |
| M3 | Błędna treść dokumentu przyjęta przez KSeF (stawka, nabywca, kwoty korekty) | XSD lokalnie; AUD-03/21 sumy różnicy; łańcuch korekt (#217) | W4 (granice XSD w ZAL/KOR), W6 (`unit` > 20), W7 (`zw` w KOR), W8 (prefiks PL dla UE/np II), S6 (sprzedawca z przeglądarki w KOR), S7 (paszport = PL), S8 (VAT-UE) | C1–C4 |
| M4 | Faktura w złym środowisku (TEST na PROD lub odwrotnie) | `ksef_environment` na wierszu, ENV_MISMATCH, 00117 | go-live: przełączenie `KSEF_ENV` bez runbooku (W15, S13) | F1 |
| M5 | Brak dowodu (UPO/XML) przy kontroli | `xml_documents`, UPO job, I3 | W12 (UPO wiecznie ponawiane bez limitu / nigdy), D5 wdrożone ale bez kontroli skrótu w PDF dla starych plików | D1 |
| M6 | Awaria KSeF dłuższa niż doba | ponowienia 24 h → `TRANSIENT_EXHAUSTED` | brak trybu offline na PROD (AUD-14) = po dobie klient musi wiedzieć, że musi działać ręcznie; brak komunikatu w aplikacji o awarii | B2, B3 |
| M7 | Faktury przychodzące nie odebrane (VAT naliczony, terminy) | skrzynka co 15 min, backfill, alarm > 6 h | W10 (`isTruncated` na ostatniej stronie), S12 (legacy bez środowiska zatrzymuje skrzynkę) | E1 |
| M8 | JPK/KPiR z błędnych danych | sumy różnicy w KOR; XSD JPK | W9 (`P_12` surowe z importu wywala JPK), S18/S19 (eksport/pulpit padają na jednym dokumencie) | C5, F2 |
| M9 | Zabity worker / restart w trakcie wysyłki | heartbeat pg-boss, przejęcie 15 min, uzgodnienie po referencji | S4 (graceful 30 s vs SIGKILL 10 s → podwójne wykonanie jobów bez idempotencji poza wysyłką) | G1 |
| M10 | Operator nie wie, że coś stoi | alarmy krytyczne, raport dzienny | S2 (sonda zdrowia KSeF martwa bez Redisa), brak runbooku per kod | G2, I2 |

---

## 5. Sesje

Każda sesja: **1 PR** (wyjątkowo 2, gdy migracja musi iść osobno),
czerwony test najpierw, DoD z tabeli. „Dni” to orientacyjny czas sesji
agenta z weryfikacją Bartosza, nie obietnica.

### Blok A — domknięcie cyklu życia (wysyłka nie ginie)

**A1. Data wystawienia a dzień wysyłki — jedna reguła dla wszystkich dokumentów (M1, W5)**
- Problem: zwykła faktura i szkic wymagają `issueDate == dziś (Europe/Warsaw)`;
  ZAL, KOR, ROZ nie (`advance-actions.ts`, `correction-actions.ts`,
  `final-actions.ts`), a formularz zaliczki liczy datę w UTC.
- Czerwony test: `saveAndSendAdvanceAction` z `issueDate` wczorajszą
  przechodzi dziś → ma odmówić z tym samym komunikatem co `draft-actions.ts:77`.
  Test formularza (`tests/unit/daty-formularzy-warszawa.test.ts:59-63`
  utrwala błędne zachowanie — poprawić, nie dopisać).
- Zakres: wspólna funkcja `assertIssueDateIsToday(invoice)` w
  `lib/invoices/issue-date.ts`, użyta w 5 akcjach; formularze ZAL/KOR/ROZ
  z `todayInWarsaw`.
- DoD: wszystkie akcje tworzące i szkic odmawiają innej daty; raport
  w PR z listą miejsc.

**A2. Okno POST → zapis referencji (M2)**
- Problem: `recordKsefSubmissionSent` idzie po odpowiedzi na POST; awaria
  między POST a INSERT = wysłana faktura bez wpisu `sent` → kolejna próba
  wysyła drugi raz → 440 bez sesji w historii → `failed` dla operatora.
- Czerwony test: `submitInvoiceFullFlow` z `recordKsefSubmissionSent`
  rzucającym po udanym POST, potem druga próba → oczekiwane: druga próba
  **nie** robi POST, tylko uzgadnia (po zapisie „zamiaru” przed POST).
- Rozwiązanie: wpis `ksef_submissions` ze statusem `intent` (nowy, 00136)
  PRZED POST, z `sendAttemptId` i kluczem XML; po odpowiedzi `sent`
  z referencjami; runner traktuje `intent` starszy niż 15 min bez referencji
  jak „nie wiadomo, co KSeF dostał” → uzgodnienie po **numerze faktury
  sprzedawcy i NIP** (zapytanie o faktury sesji/listę) zanim wyśle.
  Jeśli API KSeF 2.0 nie daje wyszukania po numerze — zostaje 440 jako
  siatka, ale wpis `intent` zapewnia, że sesja z 440 jest „własna”.
- DoD: scenariusz „awaria po POST” kończy się `accepted` z numerem KSeF
  bez drugiego POST; test na KSeF TEST w H1.

**A3. Tryb „tylko uzgodnij” i STALE — domknięcie po #216**
- Po scaleniu #216: cron I5 (zalegające `sent`) może zlecać uzgodnienie
  automatycznie (`requeue_ksef_send(reconcile_only)`), bo runner nie wyśle
  od nowa; dopisać do `ksef-lifecycle-reconcile.ts` z limitem 1 próba /
  dobę / faktura i alarm po trzeciej.
- Czerwony test: runner cyklu życia z wierszem `failed RESULT_UNCERTAIN`
  + `sent` sprzed 3 dni → jedno zlecenie `reconcileOnly`.
- DoD: I5 znika z listy „tylko alarm”; `/admin/ksef` pokazuje wpisy STALE.

**A4. Kody bez wyjścia — przegląd katalogu**
- Dla każdego z 19 kodów: tabela (kod → kto ma wyjście → gdzie przycisk →
  test) w `docs/runbooks/ksef-error-codes.md`. Dziś bez pełnego wyjścia:
  `ENQUEUE_LOST`, `ENV_MISMATCH`, `INVALID_EVENT` (operator ma tylko
  „Tylko uzgodnij” / szkic); `KOR_HOLD`, `ROZ_HOLD_RECONCILE` (hamulce do
  C4).
- Zakres: dane zdarzenia wysyłki na wierszu faktury (00137) zapisywane przy
  tworzeniu dokumentu specjalnego → zdarzenie wysyłki da się odtworzyć →
  „Wyślij ponownie” i cron dla KOR/ZAL z kopii w dniu wystawienia (decyzja b);
  ROZ i KOR na PROD czekają na C4. Po projekcie A4b
  (05.10.2026): jedna kolumna `special_data` zamiast trzech — KOR
  `{correctionData}`, ROZ `{finalData, finalAdvanceSettlementRows}`; ZAL nie
  dostaje kopii, bo jej koperta jest już w `fa3_data.advanceEnvelope` (od
  02.10) i granica wysyłki ją porównuje. Zapis jednorazowy wyzwalaczem
  zamiast dopisania kolumn do list ROW z 00132. PR1: kolumna, zapis, porównanie
  na granicy wysyłki; PR2: ponowienie z kopii (bez migracji).
- Czerwony test: ZAL / TEST KOR z kopią w dniu wystawienia → `decideResend`
  dozwolone; KOR_HOLD/ROZ_HOLD — bez przycisków klienta (decyzja a), operator;
  runner odtwarza XML identyczny (skrót) z pierwszej próby.
- DoD: `operatorInvoiceButtons` i `failedInvoiceButtons` nie mają gałęzi
  „dokument specjalny: tylko szkic” — spełnione: operator w A4b PR2a (#243),
  klient w A4b PR2b.
- Podział (04.10.2026): **A4a** — katalog wyjść (tabela w runbooku,
  macierz `tests/unit/ksef-wyjscia-kodow.test.ts`, „Wyślij ponownie”
  operatora dla ENQUEUE_LOST / INVALID_EVENT / RESULT_UNCERTAIN, akcja
  = przycisk); **A4b** — dane specjalne na wierszu (00137) i ponowienie
  KOR/ZAL/ROZ; decyzje D-A4-1 (cudzy 440) i D-A4-2 (ENV_MISMATCH) w runbooku
  `ksef-error-codes.md`.
- **D-A4-1b-3 — decyzja klienta przy nierozstrzygniętym 440** (stan
  25.10.2026; część PR B opisana wg stanu 07.10.2026): A0 (#229) i A — dane oryginału na wpisie (#230, 00144) —
  scalone; wierny import C5a–C5c (#231, #239, #241) scalony. **PR B** —
  decyzja klienta „ta sama sprzedaż” / „inna sprzedaż” (00148, przed
  wdrożeniem; numer PR w dzienniku, sekcja 9): powody `no-own-file`
  i `known-number` (runner pobiera oryginał także przy znanym numerze),
  tylko zwykła faktura; nic nie importujemy, wpłaty blokują decyzję
  (07.10 (A)); szkic wycofany przy każdym wpisie `number_taken` — bez
  wysyłki, bez e-maila do nabywcy, bez zmiany numeru przez klienta, zwykła
  i ZAL bez usunięcia, KOR i ROZ usuwalne (07.10 (2), (3), (9)–(11)); I5D
  „czeka na klienta” osobno od I5 — bez automatu i bez alarmu, poza
  `I5D-env` (07.10 (4)); e-mail raz na fakturę i numer KSeF oryginału
  oraz „Przypomnij klientowi” raz na 24 h (07.10 (5), (12)); teksty klienta
  i komunikaty P0001 — przegląd prawnika przed KSeF PROD (punkt bramki,
  sekcja 8). **PR C0** (#246) i **C0b** (#247) to warunki PR C (mapowanie
  wiersza importu do czystego modułu, odczyt plików z generatora bez strat).
  **PR C, zapis oryginału z oznaczeniem FaktWay** (`faktflow-original`,
  00156 przed wdrożeniem; numer PR w dzienniku, sekcja 9; migracja 00156
  zamiast rezerwacji 00149, bo 00151 i 00155 przepisały te same funkcje):
  runner ocenia pobrany plik bramą pochodzenia (16 jawnych reguł, wynik
  w `original_check.importGate`); przy ocenie `importable` klient (albo
  operator na jego prośbę) zapisuje decyzję, a `decide_ksef_duplicate_original`
  w jednej transakcji wycofuje dokument X bez numeru i zapisuje oryginał K
  jako przyjętą fakturę sprzedaży z numerem X (pozycje, `xml_documents`,
  sesja i `upo_receipts`; data nadania z KSeF albo NULL z alarmem, nigdy
  `now()`). Dwa przyciski „ta sama” / „inna” zapisują K (C1, C2); przy
  własnej historii pliku albo tej samej treści jeden przycisk (C3, C5).
  Plik z oceną `review` idzie do przeglądu operatora (I5R, alarm krytyczny
  po 72 h od `checkedAt`): zapis K albo oddanie decyzji klientowi (bez
  zapisu K, jak w PR B). Znacznik bez oceny pliku albo po odmowie przy zapisie
  to `recheck-needed` (I5, cron robi nowy werdykt); `cross-tenant` kończy
  się runbookiem i decyzją Bartosza, `known-now` powtórzeniem werdyktu.
  Szkic wycofany po zapisie K jest bez numeru, PDF i e-mail odmawiają
  (C8), K ma kartę z notatką o pochodzeniu; I3K (brak sesji UPO albo daty)
  to trwały sygnał, a datę uzupełnia `scripts/ops/oryginal-ksef-data-nadania.sh`.
  Teksty klienta PR C i komunikaty P0001 z 00156: przegląd prawnika przed
  KSeF PROD (punkt bramki, sekcja 8). Runbook: `ksef-error-codes.md`, sekcja
  „D-A4-1b-3 PR C”; kontrola: `kontrola-faktur-ksef.sh`, sekcja 10 (h) do (p).
  Dalej: **PR D** („Sprawdź ponownie” dla powodów bez danych oryginału)
  i **PR E** (K na wierszu X przy tej samej treści, C5). Bez decyzji
  w panelu zostają: KOR/ZAL/ROZ (D-A4-1b-3-S), `same-content-other-program`
  (D-A4-1b-2), `archive-conflict` (runbook).
  Zapisane osobno przy PR C (nie naprawiane w nim; szczegóły w runbooku):
  **D-A4-1b-3-MI** (szkic wycofany Z numerem blokuje Magiczny import oryginału),
  **-UPO** (brak skryptu ręcznego UPO, `upo-retry-stale` bez limitu prób),
  **-SYS** (`SystemInfo` jest jedyną podstawą powodu; zmiana przed KSeF PROD),
  **-DATE** (werdykt bez daty nie alarmuje w runnerze), **-PDF** (PDF zwykłego
  szkicu bez oznaczenia), **-PAY** (brak blokady wpłaty na szkic wycofany),
  **-CAT** (komunikat katalogu „damy znać” przy `pair`), **-LIST** (lista
  pokazuje X jako „(bez numeru)”), **-EVID** (decyzje PR B tylko w `audit_logs`),
  **-XEDIT** (treść szkicu wycofanego zmienialna surowym PATCH), **-KORB2C**
  (brak korekty dla nabywcy bez NIP i VAT-UE), **-KORZW** (brak korekty K
  z pozycją `zw`, stawką FA(3) spoza FaktWay albo bez ceny netto), **-FLO-NUM** (audyt numeracji FLO
  liczy tylko `origin = 'app'`), **-TESTENV** (wspólny KSeF TEST), a także
  GEN-PESEL-KRAJ, C5b-d+, IDX-ENV. Reguła `totals` bramy jest ścisła co do
  grosza (pierwotna specyfikacja dopuszczała 0,01 zł): plik „importable”,
  którego nie da się zapisać, krążyłby w ponownym sprawdzaniu bez wyjścia.

**A5. Ślad per próba — kontrakt danych dla centrum dowodzenia (M10)**
- Problem: porażka przed POST (poświadczenia, XML, upload, przejęcie) nie
  zostawia wiersza w `ksef_submissions`; na fakturze zostaje tylko ostatnia
  (`last_error*`), więc historia prób nie istnieje w bazie, a operator
  i centrum dowodzenia (osobny tor Masła/Codexa,
  `CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md`) nie widzą, ile razy i na czym
  faktura padła.
- Czerwony test: runner z `KsefCredentialsError` → oczekiwany wiersz
  `ksef_submissions` ze `status = failed`, `stage = credentials`,
  `send_attempt_id` zdarzenia; druga próba tej samej faktury nie traktuje
  go jako otwartej wysyłki.
- Zakres (po A2, bo A2 wprowadza wiersz `intent`): kolumny
  `send_attempt_id` (UNIQUE), `stage`, `error_class`, `job_id`,
  `worker_sha`, `sentry_event_id`, `ksef_http_status` (numer z rejestru,
  przed wdrożeniem); wiersz tworzony na początku próby i uzupełniany;
  `findOpenKsefSubmission` filtruje `status IN ('sent','intent')`; jedna
  linia JSON per etap w logu workera; `ops_alert_log` zapisywany
  w `markAlertDelivered` monitora alarmów (decyzja D7 briefu).
- DoD: każda próba (udana i nie) ma dokładnie jeden wiersz; test na bazie
  dla UNIQUE i filtra otwartej wysyłki; `/admin/ksef/[id]` pokazuje próby
  sprzed POST. Kontrakt kolumn uzgodniony w `CLAUDE-DO-CODEXA.md` (C-22)
  PRZED tą sesją.

### Blok B — awaria KSeF i tryb offline (M1, M6) — najgroźniejsze prawnie

**B1. Decyzja prawna i produktowa (Bartosz + prawnik, bez kodu)**
- Pytania do rozstrzygnięcia i zapisania w `docs/architecture/cykl-zycia-faktury-ksef.md`
  sekcja 9: (a) co robimy z fakturą, która nie wyszła w dniu wystawienia —
  tryb offline24 z kodem QR II i certyfikatem offline, czy nowy dokument
  z nową datą (klient decyduje?); (b) czy w ogóle oferujemy Offline24 na
  PROD; (c) jak komunikujemy klientowi awarię KSeF (baner, mail).
- Bez tej decyzji sesje B2–B3 nie startują.

**B2. Północ: co z fakturami `queued`/`failed`, które nie wyszły tego dnia**
- Dziś: automat ponawia do 24 h; faktura z datą wczorajszą wychodzi nazajutrz
  jako zwykła (KSeF przyjmie, ale prawnie to dokument offline bez oznaczeń).
- Zakres (wg B1): cron o 23:45 Europe/Warsaw oznacza niewysłane faktury
  z dzisiejszą datą: albo wstrzymuje je (`failed ISSUE_DATE_PASSED`, nowy
  kod klasy terminal — klient wraca do szkicu i wystawia z nową datą), albo
  przełącza w tryb offline (jeśli B1 = tak). Komunikat w aplikacji i mail.
- Czerwony test: faktura `failed INFRA` z `issue_date = wczoraj` nie jest
  ponawiana przez automat; klient widzi dlaczego i co zrobić.
- Częściowo zrobione przed B2 (decyzja Bartosza 06.10.2026, A4b): kod
  `ISSUE_DATE_PASSED` (00147) i bezpiecznik w workerze (przed wysyłką i w haku
  sesji tuż przed plikiem) — tylko
  dla dokumentów specjalnych (KOR, ZAL, ROZ). B2 rozszerza go na zwykłe faktury
  (po decyzji B1) i dokłada cron 23:45 oraz maila.
- Bezpiecznik daty jest w czterech miejscach: runner (`submit-invoice.ts`,
  przed wysyłką), hak otwarcia sesji (`submit-invoice-full.ts`, tuż przed
  plikiem), builder ponowień (`ksefResendFacts` w
  `lib/invoices/ksef-requeue-event.ts` — cron I6/I7, operator i od A4b PR2b
  klient) oraz filtr kandydatów crona (`ksef-lifecycle-reconcile.ts`,
  `candidates`: `.eq('issue_date', todayInWarsaw())`). Granicę dnia mają też
  teksty: `ksef-send-policy.ts` (`sendToday`, `transient`, `paused`,
  `resend*Message`), `submission-holds.ts` (`KSEF_PAUSED_SPECIAL_JOB_MESSAGE`)
  i lustra w `tests/unit/ksef-wyjscia-kodow.test.ts`. Zmiana albo zdjęcie
  (np. tryb offline po B1) — wszędzie razem; inaczej klient i operator
  dostaną przycisk, którego worker odmówi, odmowę, której worker już nie ma,
  albo tekst o północy, który przestał być prawdą.

**B3. Sonda zdrowia KSeF bez Redisa (S2) i baner awarii**
- Problem: `ksef-health-check` nic nie zapisuje bez Redisa; `isKsefHealthy`
  zawsze `true`; alarm „KSeF niedostępny” martwy.
- Zakres: zapis do `ksef_health_log` (tabela istnieje) przy każdym pingu;
  `isKsefHealthy` z bazy; baner na pulpicie „KSeF niedostępny od HH:MM —
  wysyłki ponawiamy automatycznie” z `lib/ksef/health-status.ts`.
- Czerwony test: `tests/unit/*health*` z atrapą bez Redisa → log w bazie,
  `isKsefHealthy === false` po 3 porażkach.

### Blok C — treść dokumentu (M3, M8)

**C1. Granice XSD w formularzach ZAL/KOR/ROZ (W4, W6)**
- `lib/validators/invoice-validators.ts` vs `lib/schemas/invoice-form.ts`:
  P_7/P_7Z 512, `PrzyczynaKorekty` 256, adres 512, znaki sterujące, `unit`
  ≤ 50 (baza VARCHAR(50)); dziś faktura pada w jobie jako `failed` z technicznym
  komunikatem.
- Czerwony test: generator FA(3) + XSD dla każdej granicy (golden files
  w `tests/xml/`); formularz odmawia tych samych wartości.
- DoD: jeden moduł granic (`lib/xml/fa3-limits.ts`) importowany przez
  schematy formularzy, walidatory i generatory.

**C2. Nabywca i sprzedawca — prawda w dokumencie (W8, S6, S7, S8)**
- W8: `Podmiot1/PrefiksPodatnika = PL` dla UE / np II w XML, JPK_FA `P_4A`, PDF.
- S6: sprzedawca w KOR z `requireTenantSeller` (jak ZAL/ROZ), nie z przeglądarki.
- S7: paszport nabywcy → `KodKraju` z formularza, nie `PL` na sztywno.
- S8: VAT-UE per kraj (`lib/invoices/vat-ue.ts`): wzorce krajowe, AT z „U”,
  bez spacji/prefiksu podwójnego.
- Czerwony test: po jednym na pozycję (XSD + golden); DoD: PDF, XML, JPK
  pokazują to samo.

**C3. `zw` w korektach i firmy zwolnione z VAT (W7)**
- Problem: firma z art. 113 nie wystawi żadnej korekty (`zw` w wierszach =
  „wymagane ręczne uzgodnienie”).
- Zakres: KOR ze stawką `zw` i podstawą zwolnienia (P_19/P_19A) w generatorze
  korekt; walidator dopuszcza `zw` z podstawą; komunikat fail-closed mówi
  o `zw`, dopóki generator nie przejdzie XSD.
- Czerwony test: korekta „przed/po” z `zw` → XML przechodzi XSD i ma P_19A.
- DoD (D-A4-1b-3-KORZW): korekta z `zw` działa także dla faktury K zapisanej
  przez PR C (`origin = 'ksef_import'`, pozycje `zw` z pliku z KSeF): test na
  K z `fa3_data.import`, nie tylko na fakturze wystawionej w FaktWay. Po C3
  `ORIGINAL_CORRECTABLE_VAT_RATES` (`lib/ksef/duplicate-check.ts`) dostaje `zw`,
  a zdanie `CORRECTION_RATE` i `reviewRecordHint` przestają o niej mówić.
  Zostaje otwarte po C3: K zapisana z przeglądu operatora (`review-record`)
  ze stawką FA(3) spoza FaktWay (0 WDT, 0 EX, 22, 7, 4, 3) albo z NULL ceny
  netto (ceny brutto, brak P_9A): korekta dalej odmówi, klient dostaje
  `CORRECTION_RATE`, sprawa do Bartosza.

**C4. Zdjęcie `KOR_HOLD` i `ROZ_HOLD` (po C1–C3 i #217)**
- Checklista przed zdjęciem: łańcuch korekt (#217) wdrożony; C1–C3 scalone;
  H1 przeszedł scenariusze korekt na KSeF TEST (pierwsza, druga, 440, 450);
  ROZ: 00125 (jedna ROZ na zaliczkę) + `assertSubmitReferences` + test TEST.
- Zdjęcie = jeden PR zmieniający razem `lib/ksef/kind-holds.ts`
  (`isCorrectionHeldForEnv`, `isKindHeldForEnv` — cron, panel operatora,
  przyciski klienta), `lib/ksef/roz-submission-hold.ts`, kolejkowanie
  (`lib/invoices/ksef-submit-enqueue.ts`, odmowy ROZ i KOR na PROD)
  i `lib/ksef/submit-invoice-full.ts` + wpis w `docs/runbooks/hamulce-ksef.md`.
- Cron I7 wznawia **tylko** `KSEF_PAUSED` (`ksef-lifecycle-reconcile.ts`,
  krok `find-paused`) — wiersze `failed KOR_HOLD` / `ROZ_HOLD_RECONCILE`
  po zdjęciu hamulca same nie wyjdą. Do wyboru: I7 (albo osobne zapytanie B)
  także dla `KOR_HOLD`/`ROZ_HOLD_RECONCILE`, z tymi samymi faktami kopii
  (dane, rodzaj, dzień wystawienia), albo procedura operatora w runbooku.
- Wiersze `KOR_HOLD`/`ROZ_HOLD_RECONCILE` z wcześniejszych dni: decyzja —
  `ISSUE_DATE_PASSED` (szkic, usuń, wystaw od nowa) czy inna ścieżka; builder
  ponowień odmawia wysyłki po dacie wystawienia (decyzja b).
- ROZ: przed wysyłką z kopii przeliczyć wiersze rozliczenia zaliczek (00125,
  jedna ROZ na zaliczkę) — `finalAdvanceSettlementRows` w `special_data`
  zapisano przy wystawieniu ROZ.
- Teksty razem ze zdjęciem: klient (`korHold`, `rozHold`, `kindHeld`
  w `lib/invoices/ksef-send-policy.ts` — dziś „sami nie wyślemy, napisz do
  pomocy FaktFlow”), worker (`KOR_HOLD_JOB_MESSAGE` w `submission-holds.ts`,
  `ROZ_RECONCILIATION_MESSAGE` w `submit-invoice.ts`) i `client_message`
  w katalogu 00131 (`KSEF_PAUSED`, `KOR_HOLD`, `ROZ_HOLD_RECONCILE` — wciąż
  „wyjdzie automatycznie”; aplikacja go nie czyta, ale nowa migracja ma go
  poprawić).
- Odmowa INSERT `special_data` z sesji klienta (`authenticated`): 00137
  pilnuje kształtu (CHECK) i zapisu jednorazowego tylko przy UPDATE, a od
  A4b PR2b ponowienie wysyła treść z kopii — przed zdjęciem hamulca kopię ma
  zapisywać wyłącznie serwer.
- DoD: pierwsza korekta klienta na PROD przyjęta z UPO; strażnik 0.

**C5. Import historii i JPK (W9, S18, S19)**
- W9: normalizacja `P_12` w `lib/import/fa3-parser.ts` (np II, np I, 0 KR,
  0 WDT) + ewentualny `UPDATE` istniejących wierszy **za zgodą** (migracja
  z licznikiem `SELECT count(*)` w nagłówku).
- S18/S19: eksport i pulpit nie padają na jednym dokumencie — błąd per
  dokument z nazwą, reszta liczy się dalej.
- Czerwony test: JPK_V7M dla miesiąca z jedną zaimportowaną fakturą „np II”.
- Podział (05.10.2026): **C5a** — W9 (stawki P_12, `lib/xml/fa3-p12.ts`,
  runbook `import-stawki-vat.md`); **C5b** — data sprzedaży (P_6) i adnotacje
  (P_16, P_18A, P_19A/B/C) z pliku do `sale_date` / `fa3_data.annotations` —
  **warunek** D-A4-1b-3 PR C (zapis oryginału z KSeF po decyzji klienta);
  S18/S19 osobno. Na produkcji 05.10: 0 faktur z importu — bez `UPDATE`.
  Decyzje Bartosza 06.10.2026: **C5c** — ceny brutto (`P_9B`, `P_11A`,
  `P_11Vat`, VAT rozłożony do `P_14_x`) osobnym PR po C5b, też warunek PR C;
  JPK_FA wpisuje `P_17`, jawne `P_18` i `P_19B`/`P_19C` z pliku; FP, TP,
  podmiot upoważniony, GTU i Procedura — wykrywane i zatrzymywane w JPK;
  faktury z importu sprzed C5b uzupełnia ponowny import.
  C5c (decyzje 06.10): VAT nagłówka dzielony na pozycje także dla faktur
  netto; `P_11Vat` częściowy albo niezgodny z nagłówkiem — zatrzymać.

### Blok D — dowody (M5)

**D1. UPO dla każdej przyjętej faktury (W12, I3)**
- Problem: `upo-retry-stale` bez limitu prób, trwale nieudane wypychają nowe.
- Zakres: `download_attempts` z limitem i wykluczeniem kodów nieretryowalnych;
  po limicie `failed` UPO z kodem i wyjście operatora w `/admin/ksef` (karta
  faktury: „Pobierz UPO ponownie”); I3 w strażniku rozdzielone na „bez UPO
  < 24 h” (ostrzeżenie) i „> 24 h” (naruszenie).
- Czerwony test: 60 wpisów UPO: 50 trwale 4xx, 10 świeżych — świeże
  pobrane w jednym przebiegu.

**D2. Dowód treści: skrót XML w każdym PDF i w portalu**
- PDF z KOD I liczy skrót z pliku próby (D5); dla faktur sprzed D5 — z pliku
  historycznego; brak pliku = PDF bez kodu z wyraźnym komunikatem (B14 jest),
  plus alarm I3.
- Czerwony test: `generateInvoicePdf` dla faktury z `xml_storage_path` próby.

### Blok E — faktury przychodzące (M7)

**E1. Skrzynka bez luk (W10, S12, S9)**
- W10: `isTruncated` honorowany niezależnie od `hasMore` (`lib/ksef/inbox.ts:105-115`).
- S12: legacy wiersz bez `ksef_environment` w oknie kursora — uzgodnienie
  per firma w `/admin` zamiast zatrzymania skrzynki (fail-closed z wyjściem).
- S9: PDF faktury ze skrzynki nie rzuca 500 — podgląd z `fa3_data` albo
  komunikat „oryginał XML w KSeF”.
- Czerwony test: skrzynka z 10 001 faktur w oknie (atrapa) → 10 001 wierszy,
  HWM nie przeskakuje.

**E2. Magiczny import odporny na jedną złą fakturę (S11)**
- Jedna faktura w EUR / nakładka ze skrzynką nie wywala paczki; błąd per
  dokument w raporcie importu.

### Blok F — go-live (M4, M8)

**F1. Runbook przełączenia TEST → PROD (W15, S13)**
- Dziś przełączenie `KSEF_ENV` wyłączy KPiR, eksporty i stronę zaległości
  u firm z fakturami przyjętymi na TEST; zmiana `ksef_environment` tylko
  rolą `postgres`.
- Zakres: `docs/runbooks/go-live-ksef-prod.md` (kolejność: hamulce, flagi,
  env obu aplikacji, weryfikacja), oznaczenie faktur TEST per firma
  (kolumna/filtr), komunikaty zamiast wyjątków na pulpicie; przećwiczone
  na kopii bazy (I3).
- DoD: próbne przełączenie na kopii bez „Coś poszło nie tak”.
- Z D-A4-2 (04.10.2026): przed zmianą `KSEF_ENV` hamulec i pusta kolejka,
  a faktury `failed` z kodami przejściowymi i `KSEF_PAUSED` rozstrzygnięte
  (szkic albo wysyłka na TEST) — cron I6/I7 wznawia je nowym zdarzeniem
  z bieżącym środowiskiem, więc po przełączeniu wyszłyby same na PROD.
  To samo „Wyślij ponownie” klienta i operatora (od A4b PR2b klient także
  dla KOR/ZAL z kopii): zdarzenie dostaje BIEŻĄCE środowisko aplikacji.
  Aplikacja bez poprawnego `KSEF_ENV` pokazuje klientowi „Nie możemy teraz
  potwierdzić środowiska KSeF…”, bez przycisków.
  Worker i aplikacja przełączane razem (zdarzenie z drugiego środowiska =
  `ENV_MISMATCH`, wyjście: szkic i decyzja klienta).

**F2. Firma z fakturami TEST po go-live**
- Widok „dokumenty testowe” oddzielony od księgowych; portal księgowej
  bez faktur TEST (S10); eksporty tylko PROD.

### Blok G — joby i odporność (M9, M10)

**G1. Zabity worker (S4)**
- `stopBoss({ timeout })` dopasowane do czasu łaski kontenera (Coolify
  10 s) + idempotencja jobów, które dziś dublują: sekwencja maili próbnych
  (W14, klucz `seq/<userId>/<stage>`), przypomnienia, eksporty.
- Czerwony test (chaos, H2): SIGKILL w trakcie `submit-invoice` po POST →
  po restarcie uzgodnienie, nie drugi POST.

**G2. Równoległość i kolejność (S3, S16)**
- `localConcurrency` zamiast `batchSize` tam, gdzie Inngest miało `concurrency.limit`;
  bramka `/wdroz` wdraża worker PRZED webem (jak AGENTS.md).

**G3. Retencja bez półśrodków (W13)**
- Referencje (FK) sprawdzane przed kasowaniem plików; DELETE per faktura;
  pliki prób (D5) w jednym przebiegu z wierszem.

### Blok H — prawdziwy KSeF TEST w CI (klucz całego planu)

Dotąd wszystko było dowodzone na atrapach. Bez tego bloku każda kolejna
rewizja znajdzie „~45 defektów przy zielonych testach”.

**H1. E2E na KSeF TEST (cotygodniowo, konto testowe FaktFlow)**
- Workflow `ksef-test-e2e.yml` (ręczny + harmonogram): środowisko TEST,
  firma testowa z certyfikatem/tokenem w sekretach GitHub, baza lokalna
  (jak „RLS isolation”) + worker w procesie.
- Scenariusze (każdy = test z asercjami na bazie i w KSeF): wysyłka VAT
  → `accepted` + UPO; duplikat 440 (ta sama faktura dwa razy) → własny
  duplikat; odrzucenie 450 (błąd semantyczny) → `rejected` + wpis zamknięty;
  reset → poprawa → ponowna wysyłka (nowy klucz XML); korekta „przed/po”
  → druga korekta (łańcuch) → sumy; uzgodnienie po referencji (POST bez
  odczytu statusu); „tylko uzgodnij”; nieznana sesja → **tu ustalamy
  prawdziwy kod odpowiedzi** i wpisujemy do `KSEF_SUBMISSION_STALE_*`.
- DoD: raport w CI z kodami odpowiedzi KSeF; każdy scenariusz zielony
  3 tygodnie z rzędu przed wydaniem.

**H2. Chaos na kopii bazy (game day)**
- Skrypt `scripts/ops/game-day.sh` (na kopii, nigdy na produkcji): zabij
  worker w `sending`; odetnij R2 w uploadzie; odetnij bazę w `enqueue`;
  wyłącz PostgREST na 2 min; zmień klucz szyfrowania bez `_PREVIOUS`.
  Po każdym: strażnik, `/admin/ksef`, alarmy — wszystko ma wskazać fakturę
  i wyjście.
- DoD: tabela „awaria → sygnał w ≤ 15 min → wyjście” bez pustych pól.

### Blok I — operacje

**I1. Rotacja kluczy (dług z Vercela)**
- `KSEF_CREDENTIALS_ENCRYPTION_KEY` z `_PREVIOUS` i skryptem reencrypt
  (AUD-52 ✅) — wykonać rotację naprawdę; `CREDENTIALS_UNAVAILABLE` ma test
  na prawdziwej rotacji (H2). Pozostałe klucze wg `docs/runbooks/key-rotation.md`.

**I2. Runbook operatora per kod + ćwiczenie**
- `docs/runbooks/ksef-error-codes.md`: dla każdego kodu — co widzi klient,
  co robi automat, co klika operator, kiedy dzwonić do klienta. Jedno
  ćwiczenie Bartosza na kopii bazy z fakturami w każdym stanie.

**I3. Backup i odtworzenie z weryfikacją faktur**
- `docs/runbooks/backup-restore.md` wykonany na kopii: po odtworzeniu
  `ksef_lifecycle_violations()` bez I5D = 0, liczby faktur per stan zgodne,
  pliki XML prób dostępne.

### Blok J — pozostałe ustalenia rewizji (po A–I)

S5 (cron ponagleń proponuje ROZ/KOR z błędną kwotą), S15 (usunięcie
użytkownika omija RODO), S17 (AUD-58: MFA w `getOcrJobStatusAction`,
`upo-actions`, support chat), S20/S21 (env `RESEND_FROM_EMAIL`,
`STRIPE_PRICE_ANNUAL`), S23 (eksport RODO), NISKIE z raportu. Każde osobnym
PR według protokołu; nie dotyczą kar, więc po bramce z sekcji 8.

---

## 6. Kolejność i zależności

```
A1 ──┐
A2 ──┼──► H1 (E2E na KSeF TEST) ──► C4 (zdjęcie hamulców) ──► bramka (sekcja 8)
A3 ──┤        ▲
A4 ──┘        │
B1 (decyzja) ─► B2 ─► B3 ───────────┤
C1 ─► C2 ─► C3 ─────────────────────┘
D1, D2, E1, E2, F1, F2, G1–G3 — równolegle, każda osobno; I1–I3 w dowolnym momencie.
H2 (game day) po G1 i A2. Blok J po bramce.
```

A5 (ślad per próba) po A2, przed H2 — dostarcza dane centrum dowodzenia
(osobny tor Masła/Codexa, `CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md`);
centrum nie jest sesją tego planu.

Można prowadzić dwie sesje naraz tylko wtedy, gdy nie dotykają tych samych
plików: np. C1 (walidatory) i E1 (skrzynka), D1 (UPO) i G3 (retencja).
Bloki A i H prowadzi jedna linia sesji, bo zmieniają runner.

Orientacyjnie: 21 sesji roboczych (A: 5, B: 3, C: 5, D: 2, E: 2, F: 2, G: 3,
H: 2, I: 3 — część krótkich), plus decyzje Bartosza w B1 i C4.

---

## 7. Scenariusze, które muszą przechodzić na prawdziwym KSeF TEST

| # | Scenariusz | Oczekiwany stan końcowy | Dowód |
|---|---|---|---|
| 1 | Zwykła faktura VAT | `accepted`, numer KSeF, XML próby, `xml_documents`, UPO ≤ 24 h | `/admin/ksef` karta; strażnik 0 |
| 2 | Ta sama faktura wysłana dwa razy (dwa zdarzenia) | jedna wysyłka; druga → `singletonKey` albo 440 → własny duplikat | `ksef_submissions`: 1 wpis `accepted` |
| 3 | Odrzucenie semantyczne (450) | `rejected KSEF_REJECTED`, wpis `rejected`, przycisk „Wróć do szkicu” | brak wpisu `sent` |
| 4 | Reset → poprawa → ponowna wysyłka | `accepted`, nowy klucz XML, stary plik nietknięty | dwa pliki w folderze faktury |
| 5 | POST wysłany, worker zabity przed statusem | po restarcie uzgodnienie, `accepted`, **bez** drugiego POST | 1 wpis `sent → accepted` |
| 6 | KSeF niedostępny 2 h | `failed KSEF_UNAVAILABLE` → automat ponawia → `accepted` | audyt `send_requeued` z `user_id NULL` |
| 7 | KSeF niedostępny > 24 h | `TRANSIENT_EXHAUSTED` + alarm + decyzja z B1/B2 | raport dzienny |
| 8 | Korekta „przed/po”, potem druga | P_15 drugiej = różnica od stanu po pierwszej | XML golden |
| 9 | Nieznana / stara sesja przy uzgadnianiu | kod odpowiedzi KSeF zapisany; STALE tylko gdy uzasadnione | log CI |
| 10 | Brak certyfikatu / NIP niezweryfikowany | `failed NO_CERTIFICATE / NOT_VERIFIED`, link do ustawień | przycisk |
| 11 | Zdarzenie z innego środowiska | `failed ENV_MISMATCH`, alarm, operator | Sentry |
| 12 | Faktura przychodząca w KSeF TEST | wiersz `received`, koszt, XML, KOD I w PDF | skrzynka |

---

## 8. Bramka wydania „zero zgubionych faktur”

Wydanie na PROD dla klientów płacących dopiero, gdy **wszystkie** punkty
są odhaczone (z datą i numerem PR/raportu):

- [ ] Sesje A1–A4, B1–B3, C1–C4, D1, E1, F1, G1, H1, H2 scalone i wdrożone.
- [ ] 12 scenariuszy z sekcji 7 zielone na KSeF TEST w 3 kolejnych
      tygodniowych przebiegach.
- [ ] `ksef_lifecycle_violations()` bez I5D = 0 przez 14 dni (I5D — faktury
      czekające na decyzję klienta — w raporcie osobno; I5D-env = 0); raport
      dzienny bez `exhausted` i `i1Lost` niewyjaśnionych.
- [ ] Każdy kod z `ksef_error_codes` ma wiersz w runbooku z wyjściem
      i testem (A4, I2).
- [ ] Game day (H2): każda z 5 awarii → sygnał ≤ 15 min → wyjście.
- [ ] Rotacja kluczy wykonana (I1); odtworzenie z kopii wykonane (I3).
- [ ] Runbook go-live przećwiczony na kopii (F1).
- [ ] Hamulce: `KOR_HOLD`, `ROZ_HOLD` zdjęte świadomie (C4) **albo** decyzja,
      że korekty/ROZ nie są w pierwszym wydaniu — zapisana i widoczna
      w produkcie (komunikat, nie `failed`).
- [ ] Decyzja B1 zapisana w projekcie cyklu życia; Offline24 albo działa,
      albo jest jawnie poza produktem.
- [ ] Teksty decyzji D-A4-1b-3 PR B (dialogi, odmowy w panelu, komunikaty
      P0001 z RPC i wyzwalaczy 00148, baner wycofanego dokumentu każdego
      rodzaju, odmowa e-maila, e-mail i przypomnienie, teksty
      KSEF_NUMBER_TAKEN, w tym KOR/ZAL/ROZ) przejrzane przez prawnika —
      decyzje Bartosza 07.10.2026 (A) i (8); TEST bez blokady. Lista:
      DUPLICATE_DECISION_TEXTS + DUPLICATE_DECISION_SQL_TEXTS (snapshot
      tests/unit/ksef-duplikat-decyzja-teksty.test.ts).
- [ ] Teksty decyzji D-A4-1b-3 PR C (zapis oryginału z oznaczeniem FaktWay)
      przejrzane przez prawnika (rozszerzenie punktu wyżej); TEST bez
      blokady. Ta sama migawka
      (`tests/unit/__snapshots__/ksef-duplikat-decyzja-teksty.txt`): 69 tekstów
      klienta `DUPLICATE_DECISION_TEXTS.FAKTFLOW` i 12 nowych szablonów
      `DUPLICATE_DECISION_SQL_TEXTS` z 00156. Klient: wstęp panelu (para,
      własna historia, ta sama treść), „Zapisz fakturę z KSeF w FaktWay”,
      dialogi „ta sama” / „inna” / „zapisz” z „Rozumiem skutki”, zdania o JPK
      i KPiR (`LEDGER`, `PAST_PERIOD`, `NOT_RECORDED`), o korekcie dla nabywcy
      bez NIP i VAT-UE (`CORRECTION_PERSON`), o pozycji `zw`, stawce spoza
      FaktWay i braku ceny netto (`CORRECTION_RATE`) i o wstrzymanych korektach na
      produkcji (`HELD_CORRECTIONS`), tosty, banery wycofanego dokumentu,
      karta faktury z KSeF (`IMPORTED_CARD*`), odmowa PDF i e-maila
      (`RETIRED_DOCUMENT_REFUSAL`, `RETIRED_PDF_LINK`), teksty o ponownym
      sprawdzeniu i o błędzie odczytu (`RECHECK`, `READ_FAILED`), e-mail i push (`NOTICE_*`: zapis, oddanie,
      „sprawdzamy fakturę”), `LAST_ERROR`, `LAST_ERROR_REVIEW`,
      `RELEASED_NOTE`, `PROGRAM_RELEASED`. Komunikaty P0001 z 00156:
      `known-now`, `cross-tenant`, `recheck-needed`, `provenance-review`,
      `CHOICE`, `IMPORT_MISMATCH`, `ALREADY_IMPORTED` i pięć odmów wyzwalacza
      `TRIGGER_*_IMPORTED`. Teksty operatora (`OPERATOR_DUPLICATE_MESSAGES`)
      prawnika nie dotyczą. Zmiana tekstu P0001 po przeglądzie wymaga nowej
      migracji i tej samej zmiany w lustrze TS (strażnik
      `tests/unit/zapis-oryginalu-migracja.test.ts`).
- [ ] `scripts/ops/kontrola-faktur-ksef.sh` uruchamiany codziennie przez
      14 dni bez „nieznanych” stanów.

Po bramce: tygodniowy przegląd (raport dzienny + strażnik + Sentry) przez
pierwszy kwartał; każdy nowy kod błędu lub blokada wchodzi tylko z wyjściem.

---

## 9. Dziennik sesji

| Data | Sesja | PR | Zrobione | Co zostało |
|---|---|---|---|---|
| 03–04.10.2026 | (runda cyklu życia, przed tym planem) | #199–#217 | sekcja 3 | — (wszystko scalone, 00131–00135 na db-1, wdrożone 04.10) |
| 04.10.2026 | A1 | #219 | `lib/invoices/issue-date.ts`: jedna reguła „data wystawienia = dziś w Polsce” w 5 akcjach wysyłki (FA, szkic, ZAL, KOR, ROZ — w ROZ przed hamulcem); formularz ZAL bez UTC; 11 przypadków czerwonych przed naprawą. Scalone i wdrożone 04.10 (worker, potem web; `2dbf13a`) | faktura, która nie wyszła przed północą (ponowienie, cron, `/admin/ksef`), to B1/B2 |
| 04.10.2026 | A2 | #221 | wpis `intent` z numerem sesji przed POST pliku (bez zapisu — bez wysyłki); ponowienie zamyka sesję zamiaru i pyta KSeF o jej faktury (`GET /sessions/{ref}/invoices`): plik → `sent` + uzgodnienie, pusto → `abandoned` + wysyłka od nowa; 00136: `intent` = dowód kontaktu, I5 widzi stary zamiar; „Tylko uzgodnij” działa przy zamiarze | scalone, 00136 wgrana na db-1 i wdrożone 04.10 (worker, potem web; `dcf48ba`; strażnik 0); test na KSeF TEST (H1, scenariusz 5); osobne ustalenie: status 440 przy uzgadnianiu po referencji (`reconcile-previous-submission`) kończy się ponowieniami zamiast ścieżką „własny duplikat”; dla A5/C-22: A2 dodało status `abandoned`, a otwarte zamiary rozstrzyga osobny krok (`findOpenKsefSubmissionIntents`) — `findOpenKsefSubmission` zostaje przy `sent`; punkt 3 kontraktu w sekcji 5 briefu do uzgodnienia przed A5 |
| 04.10.2026 | A2b | #222 | ustalenie z A2: „tylko uzgodnij”, które stwierdza brak faktury w KSeF (zamiar porzucony, wpis STALE) i brak dowodu kontaktu, kończy `failed NOT_IN_KSEF` (00141, transient, bez automatu) z „Wyślij ponownie” / „Wróć do szkicu” zamiast ślepej uliczki RESULT_UNCERTAIN; poprawione błędne zdanie runbooka A2 | scalone, 00141 wgrana na db-1 i wdrożone 04.10 (`ae87bdd`); osobne ustalenie: komunikat klienta dla klasy transient obiecuje „ponowimy automatycznie” także przy `TRANSIENT_EXHAUSTED` i `CREDENTIALS_UNAVAILABLE` (bez automatu); A3 po #222 |
| 04.10.2026 | A3 | #223 | cron cyklu życia: I5 (zalegający `sent` / zamiar `intent` > 48 h) przy fakturze `failed`/`rejected` → „tylko uzgodnij” z aktorem NULL; najwyżej raz na dobę (audyt `reconcile_only = true`), po 3 próbach w tygodniu `i5NeedsOperator` + Sentry; inne stany `i5Other` (tylko alarm); dokumenty specjalne pominięte (A4) | scalone i wdrożone 04.10 (`1f95c97`); I5 przy `accepted` z niezamkniętym wpisem — automat go nie zamyka (do rozważenia: zamknięcie wpisu, gdy numer KSeF się zgadza) |
| 04.10.2026 | A4a | #224 | macierz wyjść dla 20 kodów × rodzaj × dowód × otwarty wpis (test-strażnik z jawną listą ślepych uliczek); „Wyślij ponownie” operatora dla ENQUEUE_LOST, INVALID_EVENT, RESULT_UNCERTAIN; akcja operatora decyduje jak przycisk (zasada 6); tabela kod → wyjście w runbooku | scalone i wdrożone 04.10 (`4aa27ce`); A4b (00137, dokumenty specjalne); decyzje D-A4-1 (cudzy 440: porównanie treści z KSeF) i D-A4-2 (ENV_MISMATCH, z F1) |
| 04.10.2026 | D-A4-1a | #226 | cudzy 440 (decyzja D-A4-1): weryfikacja treści oryginału z KSeF w obu ścieżkach (wysyłka i uzgadnianie po referencji — wcześniej 440 przy uzgadnianiu krążył w ponowieniach); własny duplikat tylko przy tym samym skrócie pliku; `KSEF_NUMBER_TAKEN` (00142) dla oryginału z innego programu, wpisy → `number_taken`; ponowienie samej weryfikacji bez drugiej wysyłki; klasa `KsefSendVerdictError` przed klasami KSeF w klasyfikatorze; sesja oryginału z numerem KSeF w historii (UPO); kody z `problem+json`. Projekt sprawdzony adwersaryjnie (3 recenzentów) przed kodem, gotowy diff — drugi raz (4 soczewki + weryfikacja): znacznik 440 na otwartym wpisie (00142: `original_ksef_number`), żeby po 48 h nie powstało fałszywe NOT_IN_KSEF; alarmy operatora; błąd magazynu = ponowienie; akceptacja zamyka wpis po zapisie faktury; ta sama treść z innego programu = operator | scalone, 00142 wgrana na db-1 i wdrożone 04.10 (`e09d408`); D-A4-1b: ręczny werdykt operatora — **czeka na decyzje** (recenzja projektu: „numer zajęty” dla oryginału z FaktFlow o innej treści jest prawnie błędny — to wcześniejsza wersja tej faktury; przyjęcie „tej samej treści z innego programu” wymaga znacznika i ostrzeżenia w JPK; „inna sprzedaż czy ta sama” wie klient, nie operator); potwierdzić na KSeF TEST (H1), że skrót pobranego oryginału = `invoiceHash` wysyłki i że UPO z sesji spoza FaktFlow się pobiera; osobne ustalenia: `NOT_IN_KSEF` (transient) parkowany w Offline24 na TEST; limiter `invoiceDownload` (16/min) wspólny ze skrzynką |
| 04.10.2026 | D-A4-1a-data | #227 | ustalenie z recenzji D-A4-1b: numer przyjęty z duplikatu (własnego i zweryfikowanego) nie miał `ksef_accepted_at` — teraz data nadania numeru oryginałowi (status po referencji własnej sesji albo `POST /invoices/query/metadata` po numerze KSeF; brak → alarm); typy bazy z produkcji po 00142 | bez migracji; scalone 04.10 (`38c8512`), wdrożenie czeka na polecenie |
| 04.10.2026 | D-A4-2 | #228 | `ENV_MISMATCH` (decyzja D-A4-2): klasa reconcile → **terminal** (00143) — bez dowodu kontaktu faktura wraca do szkicu (klient sam albo operator), klient decyduje, czy wysłać ją w obecnym środowisku; `requeue_ksef_send` odmawia ponowienia (wcześniej przepuszczał — chronił tylko przycisk), „tylko uzgodnij” przy otwartym wpisie zostaje; komunikat z obu środowiskami w `last_error`, osobny przy workerze bez `KSEF_ENV`; przy dowodzie kontaktu „nie wystawiaj ponownie” zamiast „wróć do szkicu” (recenzja: wcześniejsza próba mogła dotrzeć do KSeF); etykieta „Inne środowisko KSeF” zamiast „Do uzgodnienia”; ślepa uliczka wykreślona z macierzy wyjść (także dla korekt bez dowodu) | 00143 przed wdrożeniem (0 faktur z kodem na produkcji 04.10); ustalenia dla F1/F2: cron I6/I7 wznawia `failed` nowym zdarzeniem z BIEŻĄCYM środowiskiem — po przełączeniu TEST → PROD faktury przejściowe i wstrzymane z czasu TEST wyszłyby same na PROD; `ksef_submissions` bez kolumny środowiska — próba z TEST to po przełączeniu „dowód kontaktu”; gałąź `ENV_MISMATCH` w `onExhausted` nie wysyła zdarzenia `invoice/submit.failed` (brak maila do klienta — dziś tylko interfejs i alarm operatora); z recenzji: `ENV_MISMATCH` z otwartym wpisem sprzed przełączenia środowiska — „tylko uzgodnij” (operator i cron I5, który nie patrzy na kod) uzgadnia w bieżącym środowisku, `requeue` czyści kod, a wynik (`NOT_IN_KSEF`/`NOT_VERIFIED`/`RESULT_UNCERTAIN`) zaprasza do wysyłki dokumentu z TEST na PROD — do F2 (środowisko na wpisie albo filtr I5), do tego czasu ostrzeżenie w runbooku i komunikacie operatora |
| 04.10.2026 | D-A4-1b-3 (A0) | #229 | decyzje D-A4-1b w runbooku; kolejność zmieniona (Bartosz): D-A4-1b-1 (automat przyjęcia treści) odłożony do B2 — projekt pokazał, że treść jednego wiersza nie zmienia się między próbami, a szkic z nieaktualną datą jest usuwany razem z historią prób; budujemy D-A4-1b-3 (przycisk klienta, ok. 7 PR). A0: „znany numer KSeF” liczy tylko faktury sprzedaży — zakupowa z tym numerem zatrzymywała porównanie treści (operator zamiast werdyktu) | bez migracji; ustalenie „`NOT_IN_KSEF` parkowane w Offline24 na TEST” nieaktualne — Offline24 wyłączony wszędzie od 02.10 (`offline24-policy.ts`), warunek do sesji, która go włączy (#122); osobne ustalenia z projektu D-A4-1b-3: podpowiedź numeru oddaje numer zajęty w KSeF po usunięciu szkicu (pętla 440 w wyjściu `KSEF_NUMBER_TAKEN`), szkic po „numer zajęty” da się wysłać ponownie (powtórne 440) |
| 04.10.2026 | D-A4-1b-3 (A) | #230 | dane oryginału przy nierozstrzygniętym 440 zapisane na otwartym wpisie próby (`original_check`, 00144) w każdej gałęzi bez werdyktu: powód (8 wartości), dane z faktury (numer, data, nabywca, kwota, program), data nadania numeru, skrót, „w historii tej faktury”, „treść jak nasza”; bajty oryginału w archiwum importu (`<firma>/ksef-import/<numer>.xml`), konflikt archiwum = werdykt dla operatora (nie pętla ponowień); klient widzi panel „W KSeF jest już faktura o tym numerze” (bez przycisku — ten w B), operator — sekcję na karcie `/admin/ksef`. Recenzja diffu (3 soczewki + sceptycy): nieudane ponowne sprawdzenie (I5 po 48 h, 403 po zmianie tokenu) zerowało zapisane dane — teraz `recheck` obok danych z udanego; „odśwież za kilka minut” nieprawdziwe (panel widać po wyczerpaniu ponowień) — „sprawdzimy ponownie automatycznie”; osobny powód `archive-pending`; panel nie wraca ze starymi danymi po zmianie stanu (realtime); data nadania w strefie Europe/Warsaw | 00144 przed wdrożeniem; #229 (A0) scalone 04.10, wdrożenie razem z tym PR |
| 05.10.2026 | C5a (W9) | #231 | import historii KSeF: P_12 → stawka FaktFlow jednym odwzorowaniem (`lib/xml/fa3-p12.ts`, spięte testem z mapami 3 generatorów): `0 KR`→`0`, `np I`→`np`, `np II`→`np_ii`; kody bez odpowiednika (`0 WDT`, `0 EX`, `22`, `7`, `4`, `3`) dosłownie, bez P_12 — z nagłówka tylko jednoznacznie (23/22 i 8/7 z proporcji, `zw` przy P_19), inaczej `nieznana` (nigdy domyślne 23%); JPK_FA i JPK_V7M odmawiają takich dokumentów oraz zaimportowanych KOR/ZAL/ROZ z numerem faktury (`JpkDocumentNotSupportedError`, bez ponowień, 422 w portalu, CSV w paczce Co-Pilot), ostrzeżenie na początku raportu importu, opis stawki na karcie faktury, sekcja 8 w `kontrola-faktur-ksef.sh`. Projekt sprawdzony adwersaryjnie (2 recenzentów): regresja dla faktur uproszczonych bez P_12 i FA(2), korekty z importu dotąd chronione przypadkiem. Recenzja diffu (3 soczewki + sceptycy): pozycja zwolniona bez P_12 obok sumy 23% (P_19 = 1) szła jako 23% — teraz `nieznana`; ceny brutto (P_11A bez P_11) dawały netto 0, a po normalizacji `0 KR`/`np` sprzedaż cicho wypadała z JPK — teraz odmowa z numerem (netto pozycji ≠ netto nagłówka) i ostrzeżenie; fałszywe ostrzeżenie przy ponownym imporcie własnej korekty / zaliczki z FaktFlow; ostrzeżenie ginęło przy nieudanym zapisie XML; Centrum eksportu nie pokazywało powodu odmowy (`error_message`); tekst odmowy w portalu kazał księgowej „przygotować JPK z księgową” | bez migracji (0 faktur z importu na produkcji); C5b (P_6, adnotacje) przed D-A4-1b-3 PR C; osobne ustalenia: W9-b `jpk-fa-parser` (import pliku JPK) domyślne 23% i stratne `0`/`np`, W9-c parsery CSV z własnym słownikiem stawek (szkice), W9-e Comarch Optima (wstrzymany) zamienia nieznane stawki na 23%, W9-g JPK_FA(4) wyraża `22`/`7`/`4`/`3` i całe 0% (P_13_6) — można zawęzić odmowę do JPK_V7M, P_12Z (`ZamowienieWiersz` zaliczek) pomijane przez parser, korekta zaimportowanej faktury 0% teraz możliwa (KOR_HOLD obowiązuje); z recenzji: paczka Co-Pilot wyrzuca powód odmowy JPK_FA (księgowa dostaje CSV bez wyjaśnienia — dotyczy też korekt i GUS), CSV/KPiR opisuje zaimportowane KOR/ZAL/ROZ jak zwykłe faktury, import ze stanem `failed` ukrywa ostrzeżenia w widoku postępu, odczyt cen brutto (P_9B/P_11A) — C5b |
| 05.10.2026 | A4b PR1 | #235 | dane zdarzenia wysyłki dokumentu specjalnego na wierszu faktury: jedna kolumna `special_data` (00137) — KOR `{correctionData}`, ROZ `{finalData, finalAdvanceSettlementRows}`, ZAL w `fa3_data.advanceEnvelope` (odejścia od tekstu A4 potwierdzone przez Bartosza 05.10); zapis w tym samym INSERT (`insertCorrection`, `insertFinalDraft`), CHECK kształtu dwuwartościowy (brak klucza = odmowa), wyzwalacz zapisu jednorazowego (NULL → wartość tylko serwer — wyjście operatora); worker porównuje zapisaną kopię ze zdarzeniem (NULL = sprzed 00137); sekcja 9 `kontrola-faktur-ksef.sh` z sondą PostgREST zapisem (SELECT nie wykrywa nieprzeładowanego cache). Projekt sprawdzony adwersaryjnie (3 krytyki: CHECK z NULL przepuszczał niepełne kształty, zapis jednorazowy bez wyjścia operatora, sonda SELECT-em). Recenzja diffu (3 soczewki + sceptycy): test granicy nie wykrywał usunięcia kolumny z SELECT, test akcji porównywał obiekt sam ze sobą — poprawione (projekcja w atrapie, kopia w chwili zapisu, granica na prawdziwym wierszu w teście bazy) | 00137 przed wdrożeniem (produkcja 05.10: 0 KOR/ZAL/ROZ, KSEF_ENV=test); scalenie wstrzymane awarią GitHub Actions 05.10; A4b PR2 — ponowienie z kopii (bez migracji), przed nim decyzja: KOR_HOLD klienta zostaje w klasie hold; zapisane dla C4/B2: wiersze zaliczek ROZ odtworzyć z przyjętych zaliczek przed zdjęciem hamulca, odmówić klientowi INSERT z `special_data` zanim szkice specjalne staną się wysyłalne, zmiana zapisanej kopii (B2, C4) wymaga migracji zastępującej wyzwalacz; `xml_generated_at` zapisywalne przez klienta (osobne ustalenie) |
| 06.10.2026 | A4b (bezpiecznik daty) | #242 | decyzja Bartosza 06.10 (krytyka projektu A4b PR2): dokument specjalny (KOR, ZAL, ROZ) nie wychodzi do KSeF z datą wystawienia inną niż dziś (Europe/Warsaw) — worker odmawia przed wysyłką (runner, po granicy dokumentu) i drugi raz w haku otwarcia sesji tuż przed plikiem i zamiarem (`lib/ksef/special-issue-date.ts`); kod `ISSUE_DATE_PASSED` (00147, terminal, bez automatu): klient wraca do szkicu, usuwa go i wystawia od nowa z dzisiejszą datą; `requeue_ksef_send` odmawia, operator bez „Wyślij ponownie”; zwykła faktura bez zmian (B1/B2). Recenzja diffu (soczewki + sceptycy): sprawdzenie przed uwierzytelnieniem zostawiało okno kilkudziesięciu sekund (zaliczka z 23:59:50 szła po północy) — drugie sprawdzenie w haku sesji; podpowiedź operatora i runbook wskazywały wyłączone „Tylko uzgodnij”; brak wiersza w cyklu życia §6 — poprawione, testy czerwone przed poprawką; odrzucone: ogólny mail „odrzucona” (B2) | 00147 przed wdrożeniem (worker bez wiersza zgłosiłby I4); zostaje okno samego żądania z plikiem (< 1 s); dokument specjalny z dowodem kontaktu bez wyjścia w panelu — jak przy innych kodach, A4b PR2a/B2; następnie A4b PR2a (ponowienie dokumentów specjalnych z kopii, cron, operator) i PR2b (klient) |
| 06.10.2026 | C5b | #239 | import historii KSeF zapisuje datę sprzedaży (`P_6`, `OkresFa` → `P_6_Do`, wspólne `P_6A`; ZAL/KOR — NULL) i Adnotacje (`P_16`, `P_17`, `P_18`, `P_18A`, `P_19` + `P_19A/B/C`, `P_22`, `P_23`, `PMarzy`) w kluczach FaktFlow (liczby 1\|2, nieczytelne w `annotationProblems` — nigdy domyślne „nie”) oraz oznaczenia FP / TP / podmiot upoważniony / GTU / Procedura (`ksefMarkers`); JPK_FA wpisuje `P_17`, jawne `P_18`, `P_19B`/`P_19C` z pliku; JPK_FA i JPK_V7M (także paczka Co-Pilot) odmawiają z numerem: P_23, P_22, marża, oznaczenia, adnotacje nieczytelne, P_19 niezgodne ze stawkami, różne daty sprzedaży pozycji, import sprzed C5b (podpowiedź „ponów import” — ponowny import uzupełnia warunkowym UPDATE); generator FA(3) pisze `P_19B/C`, odmawia P_22 i marży. Decyzje Bartosza 06.10 (4). Projekt sprawdzony adwersaryjnie (2 krytyki: FP/TP/GTU cicho błędne w V7M, `P_6` sprzeczne z `P_6A`, testy generatora poza vitest, stare importy bez wyjścia). Recenzja diffu (3 soczewki + sceptycy): tylko luki w testach (warunki uzupełnienia — sprawdzone mutacją, daty niejasne, paczka) i P_19 w sekcji 8 skryptu — poprawione | bez migracji (produkcja 06.10: 0 faktur z importu); **C5c** — ceny brutto (`P_9B`, `P_11A`, `P_11Vat`, VAT do `P_14_x`) przed D-A4-1b-3 PR C; osobne ustalenia: C5b-b (nabywca `NrID`, JST/GV z pliku), C5b-c (`ksef_accepted_at` z chwili importu, `notes` „[import]” na PDF, Stopka), C5b-d (PDF bez P_17/P_18/P_23/marży/`OkresFa`, karta bez adnotacji), C5b-e (KOR faktury z importu z procedurami wpisuje 2/N — przed C4), C5b-f (V7M okres po dacie wystawienia, nie po obowiązku podatkowym; też faktury FaktFlow); panel 440 przed decyzją klienta pokazuje datę sprzedaży i adnotacje oryginału — warunek PR C |
| 06.10.2026 | C5c | #241 | import historii KSeF: kwoty pozycji zgodne z sumami stawek co do grosza (`lib/import/fa3-line-amounts.ts`, grosze całkowite): ceny brutto (`P_9B`, `P_11A`) — VAT od sumy brutto stawki (ust. 7), netto = brutto − VAT (podział FaktFlow), cena netto pusta; VAT pozycji z pliku (`P_11Vat` przy każdej, `P_11A − P_11`), inaczej VAT nagłówka `P_14_x` dzielony największą resztą (porównanie na krzyż 23/22) — także przy cenach netto (decyzja Bartosza 06.10); faktura bez sum stawek: VAT od sumy każdej stawki, całość = `P_15`, netto i VAT faktury z pozycji; JPK_FA `FakturaWiersz` przepisuje pola z pliku (`ksefLineFields`), suma kontrolna z `P_11`, kontrola VAT pozycji = VAT faktury; zatrzymania z numerem (netto i brutto w jednej stawce, `P_11Vat` częściowe albo ≠ nagłówek — decyzja: zatrzymać, VAT poza podziałem, brutto ≠ netto + VAT, netto ≠ nagłówek, suma bez pozycji, kwota nieczytelna, pozycja bez wartości, duble `NrWierszaFa`, brutto przy taksówkach) i „kwoty faktury nieznane” (KPiR i CSV też nie pokażą). Recenzja diffu (soczewki + sceptycy): faktura uproszczona w cenach brutto przy zw zapisywała netto 0 z „KPiR i CSV działają”, brak sumy stawki sumującej się do 0 zatrzymywał, `P_11A − P_11` ignorowane bez sum, paczka bez odmowy „pozycja bez pól”, testy nierozróżniające (na krzyż, T2, produkt, suma kontrolna) — poprawione, 18 testów czerwonych na kodzie sprzed poprawki | bez migracji (produkcja 06.10: 0 faktur z importu); D-A4-1b-3 PR C może ruszyć (przed nim decyzja: oryginał w cenach brutto — generatory FaktFlow piszą tylko netto); osobne ustalenia: C5c-b (import pliku JPK_FA czyta tylko netto), C5c-c (własne faktury liczą `P_14_x` sumą VAT pozycji — ust. 10 vs ust. 1 pkt 14, pytanie do doradcy), C5c-e (brak `P_8B` → ilość 0), C5b-d rozszerzone (cena brutto na PDF i karcie), import sprzed C5c: duplikat nie przepisuje pozycji (decyzja, gdy pojawią się stare importy) |
| 07.10.2026 | A4b PR2a | #243 | ponowienie KOR/ZAL/ROZ z kopii na wierszu (ZAL `fa3_data.advanceEnvelope`, KOR/ROZ `special_data` 00137) dla crona i operatora: `lib/ksef/kind-holds.ts` (KOR na PROD, ROZ wszędzie, nieznane środowisko — wstrzymane), builder `ksef-requeue-event.ts` z kontraktem kolumn `KSEF_RESEND_SOURCE_COLUMNS` (kolumna niepobrana = wyjątek) i faktami (dane → rodzaj → data; decyzja Bartosza 06.10 b: pełna wysyłka tylko w dniu wystawienia, uzgodnienie bez daty); cron I6/I7 osobne zapytania dla zwykłych i specjalnych (specjalne tylko dziś), audyt paczkami, pola `skippedNoData`/`skippedHeld`/`skippedIssueDate`/`skippedConflict`, konflikt 00135 rozpoznany wąsko; I5 uzgadnia KOR/ZAL bez względu na datę; operator: fakty i `environmentKnown`, osobny `operatorReconcileButton` (akcja = przycisk), karta pokazuje fakty i `KSEF_ENV`; granica: żywy profil firmy pomijany tylko przed uzgodnieniem; runbook (kolumny automat/operator, „Stary dokument specjalny” + `scripts/ops/dopisz-dane-specjalne.sh`), sekcja 9 kontroli (3 zapytania, ostatni przebieg crona). Projekt sprawdzony ponownie na main 5546781 (3 weryfikatory + synteza); 73 testy czerwone przed naprawą. Recenzja diffu (4 soczewki + sceptycy): 5 drobnych ustaleń (dopisanie special_data bez wiązania joba z fakturą → skrypt, etykieta I5, trzy luki testów pominięcia profilu) — poprawione, sprawdzone mutacją | bez migracji (00137 06.10, 00147 07.10 na db-1); **PR2b** (klient: przycisk, `decideResend`, teksty KSEF_PAUSED / transient / ISSUE_DATE_PASSED dla dokumentów specjalnych) zaraz po tym — do tego czasu klient widzi przy failed ZAL/KOR na TEST tylko „Wróć do szkicu”; zapisane: I5 ponawia konflikt 23505 co 15 min bez limitu, KOR/ZAL z błędem po ok. 23:00 bez automatu (D1), stara ZAL po przejęciu — decyzja Bartosza, dokument po dacie klasy reconcile bez dowodu i wpisu — B2, „dziś” w trzech miejscach — ujednolicić w B2 |
| 07.10.2026 | A4b PR2b | #244 | strona klienta ponowienia z kopii: „Wyślij ponownie” dla KOR/ZAL z zapisaną kopią, rodzajem niewstrzymanym i dzisiejszą datą wystawienia (decyzja b); `resendInvoiceAction` z `KSEF_RESEND_SOURCE_COLUMNS`, faktami i builderem z #243, `validateInvoice` tylko dla zwykłej, Sentry w catch; kolejność klienta rodzaj → dane → data; strona liczy fakty dla każdego stanu bez wysyłania treści do klienta; decyzje Bartosza 07.10 (8–11): prawdziwe teksty KOR_HOLD/ROZ (sami nie wyślemy, pomoc@faktflow.pl), „uzgodni operator” → pomoc FaktFlow (także worker ENV_MISMATCH), `automaticResendExpected` dla tekstu i znaczka „Błąd — ponawiamy” (wszystkie rodzaje — zamyka A2b), `environmentKnown` u klienta; kolejkowanie w trybie ponowienia nie mówi „zapisana jako szkic”; teksty workera KOR_HOLD / KSEF_PAUSED dokumentu specjalnego / ROZ. Projekt sprawdzony ponownie na gałęzi #243 (3 weryfikatory + synteza); 125 testów czerwonych przed naprawą. Recenzja diffu (4 soczewki + sceptycy): 4 ustalenia (ważne: przy KOR na PROD i ROZ teksty odrzucenia, błędu treści, ENV_MISMATCH i ISSUE_DATE_PASSED kazały wystawić od nowa dziś — teraz „po zdjęciu blokady”, macierz pilnuje) — poprawione | bez migracji; po wdrożeniu blok A4 zamknięty po stronie wyjść (DoD: brak gałęzi „dokument specjalny: tylko szkic”); zapisane: katalog 00131 `client_message` hamulców (C4), `resetDone` zwykłej po dacie (B1/B2), surowy P0001 w wyścigu z I6, teksty bez instrukcji („Brak NIP firmy.”), ISSUE_DATE_PASSED workera przy dowodzie (B2); dalej w bloku A: D-A4-1b-3 PR B, C, D i A5 |
| 08.10.2026 | D-A4-1b-3 PR B | #245 | decyzja klienta przy nierozstrzygniętym 440 (powody `no-own-file` i `known-number`, zwykła faktura): panel z tabelą porównania i dwoma dialogami „To ta sama sprzedaż” / „Inna sprzedaż → nowy numer” z „Rozumiem skutki” (sprawdzane też na serwerze; etykieta wg `markedDifference`); 00148: RPC `decide_ksef_duplicate` (jedna transakcja: wpisy → `number_taken` z decyzją na znaczniku, powrót do szkicu z numerem, audyt), `ksef_duplicate_check_allows`, `ksef_duplicate_decision_blocker` (m.in. wpłaty blokują), wyzwalacze szkicu wycofanego (bez wyjścia z `draft` dla każdej roli — wyścig EvalPlanQual; sesja klienta nie usuwa zwykłej/ZAL niezależnie od kierunku, nie zmienia numeru ani kierunku), I5 bez czekających + I5D, katalog `KSEF_NUMBER_TAKEN` bez „usuń go”; `known-number` pobiera i streszcza oryginał; automatyczny „numer zajęty” poprawiony tak samo (zasada 3); szkic wycofany bez wysyłki, maila PDF i usunięcia (KOR/ROZ usuwalne), baner z „Wystaw nową fakturę”; mail i push „czeka na Twoją decyzję” raz na (fakturę, K) ze śladem po dostarczeniu, ścisły odczyt właściciela z ponowieniem co 5 min, operator: „Zapisz decyzję klienta” (z notatką), „Przypomnij klientowi” (24 h), sekcja I5D z kolumną „Powiadomienie klienta”, monitor I5D-env; recenzja przed PR: 10 drobnych poprawionych (m.in. obejście usunięcia przez zmianę kierunku); 177 czerwonych testów jednostkowych na `main` przed naprawą, testy bazy w CI; migracja 00148 **przed** wdrożeniem | po scaleniu: 00148 na db-1, wdrożenie worker → web, `kontrola-faktur-ksef.sh`; typy `types/database.ts` z produkcji w następnym PR; przed KSeF PROD przegląd tekstów przez prawnika (lista w runbooku + migawka, dwa teksty dopisane po recenzji); zapisane: niedostarczone pierwsze powiadomienie bez automatycznego ponowienia (decyzje 4 i 5), „bez powiadomienia: n” w raporcie dziennym, odwrotna zmiana kierunku z tym samym tekstem, zamrożenie treści szkicu wycofanego (§7.15); dalej w bloku A: D-A4-1b-3 PR C (faktflow-original), PR D („Sprawdź ponownie”), A5 (czeka na zatwierdzenie kontraktu kolumn w briefie §5) |
| 10.10.2026 | D-A4-1b-3 PR C0 | #246 | refaktor przed PR C (`faktflow-original`): mapowanie wiersza importu z `insertInvoices` do czystego `lib/import/imported-invoice-row.ts` (nagłówek, pozycje bez `invoice_id`, `fa3_data` z wstrzykniętym `provenance`, ostrzeżenie JPK, rodzaj, nabywca, sprzedawca, płatność); silnik zostawia zapis do bazy, kolejność i znaczniki czasu; inwarianty C0-1…C0-5 spisane przed zmianą; strażnik `import-wiersze-tozsamosc` (36 testów, migawka nagrana na silniku z `main`: generator FaktFlow, ceny brutto, KOR, ZAL, ROZ, nabywca UE, OkresFa, FP/GTU, same P_15, niezgodne sumy, 4 źródła, ponowienie, awarie zapisu, kolejność kluczy) — mutacje 118/143 zabitych (reszta równoważna, nieosiągalna z FA(3) albo identyczna ze starym kodem), porównanie stary/nowy na 5810 przypadkach: 0 różnic; test czystości (zegar, wstrzyknięte znaczniki, dokładne klucze, zamrożone argumenty) | bez migracji; dalej C0b (GEN-RUNDA: parser czyta pliki z generatora FaktFlow bez strat — `NrID`, VAT 0 przy stawkach bez VAT, `Stopka`, JST/GV), potem PR C (00149); decyzje Bartosza dla PR C 08–10.10 (C1–C8, N1–N6) w specyfikacji; zapisane, nie naprawiane: **IMP-ACC** `ksef_accepted_at` importu historii = chwila importu, nie data nadania numeru (`history-fetcher` ją ma); **IMP-PROD** ponowny import / ponowienie zadania zwiększa `products.use_count` i nadpisuje dane kontrahenta, także gdy zapis faktury się nie uda; **IMP-KOR** zaimportowana KOR z FaktFlow zapisuje wiersze `StanPrzed` jak zwykłe pozycje (JPK ją zatrzymuje); **IMP-STAWKA** przy stawce spoza FA(3) VAT pozycji = 0 i kontrola zgodności z nagłówkiem pominięta; **CQ-IDENT** `tests/unit/decyzja-duplikatu-operator-ekran.test.tsx:150` (PR B) `.replace(/ /g, ' ')` zamienia spację na spację (CodeQL `js/identity-replacement`, nie blokuje bramki; zamiar: twarda spacja `\u00a0`) |
| 10.10.2026 | C0b (GEN-RUNDA) | #247 | import historii KSeF czyta pliki z generatora FaktFlow bez strat i bez fałszywych ostrzeżeń (warunek PR C: brama „plik FaktFlow” i zapisany oryginał K): `Podmiot2/NrID` (+ `KodKraju`: PL albo brak, 11 cyfr, suma PESEL → `pesel`, inaczej `nrInny`, napis), `JST`/`GV`, `footerNote` (pierwsza niepusta `StopkaFaktury`), surowe `RodzajFaktury` (`invoiceTypeCode`); `pickTotals` — bez `P_14_x`, każda pozycja bez VAT i |P_15 − Σ P_13_x| ≤ 1 grosz → VAT 0 bez ostrzeżenia; wiersz importu: `buyer_id_number` = NrInny, `buyer_data.jst/gv` z pliku, `noIdMarker` tylko przy BrakID albo bez identyfikatora; czerwony test rundy (42 pliki z generatora × GR-1..GR-5 + 18 plików obcych programów) — 150 czerwonych na `main`; strażniki GR-4 po mutacjach (every/some, tolerancja w obie strony, brutto, P_14 obok zw); migawka strażnika C0 zmieniona świadomie (nowe pola `parsed` w każdej fiksturze + PESEL, NrInny, zw, Stopka) | bez migracji; dalej PR C (00149); zapisane: **GEN-PESEL-KRAJ** generator pisze przy PESEL `KodKraju` z adresu nabywcy (PESEL z adresem zagranicznym wraca jako NrInny); **IMP-B2C-NRINNY** nabywca z NrInny po imporcie `is_b2c` false / `buyer_id_type` `nip`, a formularz zapisuje go jako `is_b2c` true z `id_card`/`passport` (kolumn nikt nie czyta — ujednolicić przed użyciem); **IMP-STOPKA-WIELE** z kilku `Informacje` innych programów tylko pierwsza niepusta; **IMP-ID-XSD** plik łamiący XSD (NIP i NrID naraz) daje dwa identyfikatory; uwaga RODO: PESEL nabywcy z importu zapisywany w `buyer_pesel`, `buyer_data`, `fa3_data.parsed` |
| 13.10.2026 | A5 | #249 (widok: #250) | dziennik prób wysyłki `ksef_send_attempts` (00150): wiersz na każde wykonanie joba wysyłki (`withSendAttemptLedger` w `package-d.ts`, runner nietknięty) — etap z nazw kroków runnera (`submit-to-ksef` doprecyzowany: `xml` / `ksef`), kod i klasa z `classifySendError` w chwili zdarzenia, HTTP i kod KSeF, job pg-boss (`JobContext.jobId`), numer wykonania, SHA workera (`SOURCE_COMMIT`); oczekiwanie (`RetryAfterError` bez zużycia próby) = `waiting` tylko w budżecie odczekań (po `MAX_WAIT_RETRIES` błąd z kodem); każdy zapis fail-open z limitem 3 s (Sentry raz na wykonanie). Odmowy przed kolejką (`ksef-submit-enqueue.ts`: hamulce, wyłącznik, MFA, certyfikat, KSeF niedostępny, błąd kolejkowania) → `refused` / `enqueue` z `user_id`, odpowiedź dla klienta bez zmian (decyzja 13.10.2026). Kontrakt §5 briefu zatwierdzony z poprawką po A2: **osobna tabela zamiast kolumn `ksef_submissions` z UNIQUE `send_attempt_id`** — po A2 jedna próba ma kilka sesji i wykonań, a statusy `ksef_submissions` są dowodem kontaktu; `findOpenKsefSubmission` bez zmian (`sent`), zamiary w `findOpenKsefSubmissionIntents`. Czerwone przed naprawą: dziennik 4/5 (plus 2 po recenzji: oczekiwanie po limicie, zawieszony zapis), odmowy 3/5; test bazy `tests/rls-dziennik-prob-wysylki.test.ts` (tylko serwis, bez DELETE także dla `service_role`, CHECK, dowód kontaktu = false, CASCADE); migracje przeszły na Postgresie 16 z domyślnymi uprawnieniami jak Supabase (cały łańcuch). Widok: osobny PR (`/admin/centrum/bledy`, karta `/admin/ksef/[id]` z próbami — DoD A5) | migracja **00150 przed wdrożeniem** (00149 zajęte przez szkic #248); `SOURCE_COMMIT` w środowisku workera (inaczej `worker_sha` puste); **nie zrobione z zakresu A5**: `ops_alert_log` w `markAlertDelivered` (D7), `sentry_event_id` (Sentry pomija `NonRetriableError`, id zdarzenia nie da się pewnie przypisać do joba); błędy poza jobem wysyłki (cron cyklu życia: ENQUEUE_LOST / TRANSIENT_EXHAUSTED, Offline24, UPO) nadal tylko w `invoices` / `upo_receipts`; odmowy operatora w `/admin/ksef` (`app/admin/ksef/actions.ts`) bez wiersza `refused`; `scripts/ops/kontrola-faktur-ksef.sh` bez sekcji dziennika; `ksef_code` pusty dla odpowiedzi `problem+json` do scalenia #189 (F-093). Zrobione w tym PR także: ślad nieudanego zlecenia faktury VAT za abonament (`self-invoice-payment.ts`, `ENQUEUE_ERROR`) |
| 13.10.2026 | A5 — luka „skrypt kontroli” | #251 | `scripts/ops/kontrola-faktur-ksef.sh`, sekcja 12: dziennik prób (00150) zamiast surowego SQL — sonda tabeli (bez 00150 jeden komunikat „BRAK TABELI”, nieudana sonda = „nie wiadomo”, nigdy „pusty”), zakres dziennika, wykonania joba z `inngest_run_log` bez wiersza w dzienniku (czy dziennik pisze — worker bez A5 dawał pusty dziennik jak „brak błędów”), wykonania z 24 h wg stanu (przerwane = `started` bez wyniku po 20 min), błędy, odmowy i przerwane wg kodu ze stanem faktur teraz (progi i kubełki jak `/admin/centrum/bledy`, „utknęła” = I2), 20 ostatnich z zamaskowaną treścią, logi od startu kontenera (`ksef.send.attempt`, nieudane zapisy dziennika; worker i aplikacja). Testy na prawdziwym skrypcie z atrapą ssh (`bash -c`, jak sshd): jednostkowy (5/6 czerwonych na `main`; każde zapytanie skryptu dociera do psql bez zmian po dwóch powłokach) i na bazie w jobie RLS (`tests/rls-kontrola-dziennik-prob.test.ts`, wyrocznia `effectiveStatus`/`recoveryState` dashboardu; czerwony na `main`, mutanty progów i bez `refused` czerwone); recenzja w 4 perspektywach z weryfikatorami: 4 potwierdzone, naprawione | bez migracji i bez wdrożenia (skrypt z repo); runner CI potrzebuje `psql` w `PATH`; otwarte luki A5 bez zmian: odmowy operatora w `/admin/ksef` bez wiersza `refused`, historia błędów spoza joba wysyłki (cykl życia, Offline24, UPO, powiadomienia), I1 na dashboardzie, `ops_alert_log` (rezerwacja Codexa), retencja `ksef_send_attempts` (decyzja) |
| 13.10.2026 | A5 — odmowy operatora | #252 | „Wyślij ponownie” i „Tylko uzgodnij” w `/admin/ksef` zapisują każdą odmowę jako `refused` / `enqueue` z `user_id` operatora (`recordSendRefusal`, fail-open); polityka `operatorRequeueRefusal`/`operatorReconcileRefusal` zwraca kod i powód, przyciski są jej pochodną; kody z katalogu, gdy znaczą to samo (`KSEF_PAUSED`, `KOR_HOLD`, `ROZ_HOLD_RECONCILE`, `ISSUE_DATE_PASSED`), klasa błędu faktury → jej kod, nowe poza katalogiem (`STATUS_NOT_ALLOWED`, `NO_OPEN_SUBMISSION`, `ENV_UNKNOWN`, `SEND_DATA_MISSING`, `NO_NIP`); typ `SendRefusalCode` w czystym `send-error-classes.ts` (strażnik W1). 18 przypadków czerwonych przed naprawą | scalone w wydaniu A5 (PR „Scalenie #251, #252, #253, #255, #256”); bez migracji; wdrożenie: aplikacja; reset, decyzja duplikatu i przypomnienie poza zakresem (to nie wysyłki) |
| 13.10.2026 | A5 — I1 na dashboardzie | #253 | `/admin/centrum/bledy`: sekcja „Utknięte w wysyłce teraz” z I1 i I2 z istniejącego RPC `ksef_lifecycle_violations()` (bez migracji); „od” wg zegara strażnika (I1 = `updated_at`), I1 > 45 min = „Automat nie zadziałał”; nieudany odczyt → „nie wiadomo” + problem. 5 przypadków czerwonych | scalone w wydaniu A5; wdrożenie: aplikacja; otwarte: procedura operatora dla I2 i przeterminowanego I1 (karta bez akcji, runbook bez opisu) |
| 14.10.2026 | A5 — luka #2 identyfikatory | #255 | cron cyklu życia nazywa fakturę przy decyzjach bez śladu w bazie: ostrzeżenie z `invoiceId` dla I5 po limicie (`lastAttemptAt`) i I5 poza `failed`/`rejected`, `invariant` w logu odmowy budowy zlecenia, licznik `skippedNoNip`, zbiorczy Sentry z `<licznik>Ids` (do 20 na rodzaj, płasko); wyzwalacz Sentry bez zmian (stany trwałe bez deduplikacji zjadałyby kwotę); skrypt kontroli §9: lista faktur bez akcji automatu z logu (z rozróżnieniem wyłącznika i braku przebiegu). 14 czerwonych przed naprawą, 25 mutantów | scalone w wydaniu A5; wdrożenie: worker; zapisane: zagłodzenie paczki 100 (I5 `slice` i odmówione wiersze I6/I7), zbiorczy Sentry bez deduplikacji (od A3), sekcja 2 skryptu łapie każdą linię crona |
| 14.10.2026 | A5 — luka #4 Offline24 | #256 | skrypt kontroli, sekcja 4a: `KSEF_ENV` workera, kolejka `ksef_offline_queue`, otwarte wpisy i co zrobi z nimi cron, faktury `offline_queued` wg werdyktu (BEZ WYJŚCIA), lista do uzgodnienia z KSeF (NIP firmy, flagi), `failed`/`rejected` z `OFFLINE_*`, zamrożone szkice, wpisy zamknięte, przebiegi crona z `inngest_run_log`; runbook `offline24-zalegle.md`; potwierdzone: kwarantanna zostawia fakturę w `offline_queued` bez wyjścia. Test na bazie (job RLS) z wyrocznią z reguł crona, 29 mutantów SQL | scalone w wydaniu A5; bez wdrożenia (skrypt z repo); decyzja o luce #5 po pierwszym przebiegu sekcji 4a na produkcji — (i) wyjście dla istniejących faktur, (ii) poprawka zapisu crona; zapisane: kody `OFFLINE_*` poza katalogiem (I4), nieaktualne `cykl-zycia-faktury-ksef.md:42,:69`, reset nie czyści `offline_idempotency_key` |
| 14.10.2026 | A5 — zagłodzenie paczki | #258 | cron cyklu życia: paczka 100 liczy faktury, przy których automat działa, nie odczytane wiersze — odmówione (brak pozycji, NIP-u, danych, rodzaj wstrzymany; I5 poza `failed`/`rejected`, po limicie, odroczone) już nie zajmują paczki na zawsze; I6/I7 kursorem po (`updated_at`, `id`) (`applyCursorFilter` — pierwszy wołający), I5 stronami po 100 identyfikatorów, bezpiecznik `LIFECYCLE_SCAN_MAX_PAGES` = 10 z licznikiem `scanCapped` i ostrzeżeniem „bezpiecznik odczytu”; w wydaniu połączone z #255 (inwariant i identyfikatory przy odmowach z `collect()` i wstępnej odmowie I5 — mutanty 4/4) | w wydaniu #257–#263; wdrożenie: worker; po wdrożeniu `scanCapped: 0`, `errors: 0` w „przebieg zakończony”; skrypt kontroli §9 bez `scanCapped` (osobny PR) |
| 14.10.2026 | A5 — luka #3 powiadomienia | #259 | powiadomienie o wyniku wysyłki nie ginie po cichu: karta FLO izolowana (`floCard`), ścisły `readTenantOwnerContact` (błąd bazy/GoTrue = ponowienie), push mimo błędu Resend, ponowienia po 5 i 30 min (`notifyRetryDelayMs`), `onNotifyExhausted` (Sentry z `invoiceId`); runbook `joby-pg-boss.md` | w wydaniu #257–#263; wdrożenie: worker; push przy ponowieniu po błędzie Resend dzwoni drugi raz (osobna kolejka push — decyzja) |
| 14.10.2026 | A5 — procedura I2/I1 | #260 | `scripts/ops/zwolnij-utknieta-wysylke.sh` + `.sql`: podgląd, zapis z `--wykonaj` w jednej transakcji z blokadą wiersza; I2 → `failed RESULT_UNCERTAIN` + audyt `invoice.send_lease_released`, I1 jak cron (`release_ksef_enqueue` albo `ENQUEUE_LOST` + audyt `invoice.enqueue_lost`); tylko bez żywego zlecenia w pg-boss; runbook `hamulce-ksef.md`; test na bazie 17/17; w wydaniu podpowiedzi I1/I2 na `/admin/centrum/bledy` wskazują procedurę (test-strażnik) | w wydaniu #257–#263; bez wdrożenia (skrypt z repo); uruchamia Bartosz |
| 14.10.2026 | A5 — push przy błędzie odczytu | #261 | `PushReadError` zamiast cichego `{ sent: 0 }` przy błędzie odczytu subskrypcji/członków; `sendPushToTenant` czyta subskrypcje firmy jednym zapytaniem przed wysyłką; certyfikat i OCR „nie rozpoznano” łapią błąd pusha (OCR: z przeglądu — ponowienie płaciło drugi raz za odczyt i gubiło kartę FLO) | w wydaniu #257–#263; wdrożenie: worker |
| 14.10.2026 | A5 — dokument cyklu życia | #262 | `cykl-zycia-faktury-ksef.md`: `offline_queued` bez wyjścia do `sending` od 02.10, jedyne wyjście `failed OFFLINE_DEADLINE_EXCEEDED` z crona kolejki (kod spoza katalogu — I4) | w wydaniu #257–#263; luka #5 (wyjście dla stojących faktur) po sekcji 4a z produkcji |
| 14.10.2026 | A5 — certyfikat | #263 | `cert-expiry-alert`: ścisły odczyt adresu — błąd bazy/GoTrue nie jest „brakiem adresu” (dawniej push zamykał próg, a mail nie wychodził nigdy); firma z błędem odłożona i na liście operatora, pozostałe dalej, zadanie rzuca na końcu (ponowienie); mail z kluczem idempotencji (próg + liczba dni); mutanty 12/12 | w wydaniu #257–#263; wdrożenie: worker; błąd Resend dalej zatrzymuje kolejne firmy w pętli (osobne ustalenie); `getTenantAdminEmail`/`getTenantOwnerUserId` bez wołających |
| 26.10.2026 | D-A4-1b-3 PR C | #248 | zapis oryginału z oznaczeniem FaktWay/FaktFlow (`faktflow-original`) przy nierozstrzygniętym 440: klient decyduje na karcie („ta sama” / „inna sprzedaż”, a przy wcześniejszej wersji tego dokumentu albo tej samej treści jeden przycisk „Zapisz fakturę z KSeF”), a jedna transakcja zapisuje K jako przyjętą fakturę sprzedaży (`origin='ksef_import'`, numer FV/N) i zdejmuje numer z wycofanego X (decyzje Bartosza 08.10 C1–C8, 09–10.10 N1–N6); brama pochodzenia (16 jawnych reguł) liczona przez runner i zapisana na znaczniku; plik nie z generatora → przegląd operatora (I5R, alarm po 72 h) z zapisem albo oddaniem decyzji klientowi; ponowne sprawdzenie (`recheck-needed`) przy archiwum/rozjeździe; inna firma z tym samym NIP i numer znany po werdykcie → blokady; PDF szkicu bez numeru odmawiany z odnośnikiem do K; I3K (brak sesji albo daty) + skrypt `oryginal-ksef-data-nadania.sh`; migracja **00156** (dawniej 00149 — przeniesiona, bo 00151 i 00155 nadpisały po niej funkcje PR C; ciała z 00151/00155 + zmiany PR C, ścieżka PR B bez zmian); czerwone przed naprawą: 1487 jednostkowych (commit 2), 69/70 testów bazy (commit 4, PGRST202); scalenie main (330 commitów, marka FaktWay); testy bazy uruchamiane lokalnie na izolowanym Supabase (kopia joba „RLS isolation”) | **00156 przed wdrożeniem**; typy 00156 w kolejnym PR; przed KSeF PROD przegląd tekstów przez prawnika (82 nowe, lista w sekcji 8); zapisane: D-A4-1b-3-MI, -UPO, -SYS, -DATE, -PDF, -PAY, -CAT, -LIST, -EVID, -XEDIT, -KORB2C, -KORZW, -FLO-NUM, GEN-PESEL-KRAJ, C5b-d+, IDX-ENV, -TESTENV (opis w runbooku i opisie PR); dalej w bloku A: PR D („Sprawdź ponownie” dla powodów bez danych oryginału) |

---

## 10. Czego nie robić w tej rundzie

- Nie dodawać funkcji (nowe moduły FLO, eksporty, integracje) — każda
  sesja z tego planu zamyka ryzyko kary albo buduje dowód, nic więcej.
- Nie zdejmować hamulców „na próbę”.
- Nie naprawiać dwóch rzeczy w jednym PR, nawet gdy są obok siebie.
- Nie uznawać za naprawione niczego, czego nie widział test na prawdziwej
  ścieżce (baza z wyzwalaczami albo KSeF TEST).
- Nie pisać `ksef_status` nigdzie poza RPC z 00131 i workerem.
- Nie budować w sesjach planu statystyk, pulpitów ani osi czasu faktury —
  to centrum dowodzenia (tor Masła/Codexa, `CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md`);
  plan dostarcza dane (A5), nie widoki.
