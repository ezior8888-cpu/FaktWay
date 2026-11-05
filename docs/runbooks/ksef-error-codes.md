# KSeF API Error Codes (Faza 35)

Lookup dla błędów zwracanych przez API KSeF 2.0. Pełne, aktualne tłumaczenia
trzymamy w bazie (`error_translations` table) i przekładamy w UI.

> ⚠️ **Źródło prawdy:** tabela `error_translations` w DB + dokumentacja MF
> (https://ksef.mf.gov.pl). Lista niżej jest **przewodnikiem operacyjnym**
> (najczęściej widywane kody + co z nimi zrobić), nie kompletnym katalogiem.
> MF aktualizuje kody; po większych release'ach KSeF warto zsynchronizować
> `error_translations`.

## Klasyfikacja (jak ich używamy)

Każdy kod KSeF mapujemy na jedną z 4 kategorii w `lib/ksef/error-classifier.ts`:

| Klasa | Co znaczy | Reakcja Inngest |
|---|---|---|
| **CLIENT_INPUT** | Błąd po stronie user-a (zły NIP, duplikat, walidacja) | `NonRetriableError` — nie retry'ujemy |
| **AUTH** | Token wygasł, bad credentials | Refresh tokenu + 1 retry |
| **KSEF_DOWN** | KSeF zwrócił 5xx / timeout | Pełen retry schedule (30s → 1h) |
| **MAINTENANCE** | Zapowiedziana przerwa | Offline24 od razu |

## Katalog kodów wysyłki FaktFlow — kto ma wyjście (A4)

Kody `invoices.last_error_code` z katalogu `ksef_error_codes` (00131, 00141).
Zasada: każdy stan ma **wyjście** — automat (cron `ksef-lifecycle-reconcile`),
klient (przycisk na fakturze) albo operator (`/admin/ksef/<id>`). Strażnikiem
tej tabeli jest test `tests/unit/ksef-wyjscia-kodow.test.ts` (macierz kod ×
rodzaj dokumentu (FA/KOR/ZAL/ROZ) × dane do ponowienia × środowisko × data
wystawienia (dziś/wcześniej) × dowód kontaktu × otwarty wpis); ślepe uliczki
z kolumny „Luka” są w nim wypisane jawnie.

| Kod | Klasa | Skąd | Klient | Automat | Operator | Luka |
|---|---|---|---|---|---|---|
| `XSD_INVALID` | terminal | XML niezgodny z XSD | Wróć do szkicu | — | Wróć do szkicu | przy dowodzie kontaktu bez otwartego wpisu (po cudzym 440) → D-A4-1 |
| `KSEF_REJECTED` | terminal | KSeF odrzucił treść (status ≥ 400, HTTP 4xx) | Wróć do szkicu | — | Wróć do szkicu; „Tylko uzgodnij” przy otwartym wpisie | jak wyżej |
| `INVALID_DOCUMENT` | terminal | walidacja dokumentu, odwołania (`assertSubmitReferences`) | Wróć do szkicu | — | Wróć do szkicu | jak wyżej |
| `KSEF_NUMBER_TAKEN` | terminal | cudzy 440, oryginał z innego programu (treść sprawdzona, D-A4-1a) | Wróć do szkicu → szkic wycofany: nie wyślesz go ani nie wyślesz e-mailem; zwykłej faktury i zaliczki nie usuniesz ani nie zmienisz jej numeru (00148) → „Wystaw nową fakturę” z nowym numerem; korektę i fakturę rozliczeniową usuń („Usuń szkic”) i wystaw od nowa z nowym numerem; ta sama sprzedaż — nic | — | Wróć do szkicu | — (wpisy `number_taken` nie są dowodem kontaktu); szkic wycofany trzyma numer (00148; KOR/ROZ usuwalne — decyzja 07.10 (9)) |
| `ENV_MISMATCH` | terminal (D-A4-2, 00143) | zdarzenie z innego środowiska KSeF niż skonfigurowane w workerze (zlecone na TEST, worker na PROD; albo worker bez poprawnego `KSEF_ENV`) — runner nie dotknął KSeF | Wróć do szkicu → zdecyduj, czy wysłać w obecnym środowisku (dokument specjalny: usuń szkic i wystaw od nowa z dzisiejszą datą); szkic zablokowany → pomoc FaktFlow (sprawdzamy w KSeF) | — | Wróć do szkicu (bez dowodu); „Tylko uzgodnij” tylko dla otwartego wpisu z OBECNEGO środowiska; **nigdy** „Wyślij ponownie” (baza odmawia) | przy dowodzie kontaktu bez otwartego wpisu — jak wyżej; otwarty wpis sprzed przełączenia środowiska — bez bezpiecznego wyjścia do F2 (niżej) |
| `ISSUE_DATE_PASSED` | terminal (decyzja 06.10.2026, 00147) | dokument specjalny (KOR, ZAL, ROZ) z datą wystawienia sprzed dzisiaj — worker odmówił przed wysyłką (runner) albo tuż przed plikiem (hak otwarcia sesji, po uwierzytelnieniu); ponowienie, oczekiwanie albo samo uwierzytelnienie przeniosło wysyłkę za północ, a w KSeF dokument wystawia się w dniu wysyłki. Zostaje okno samego żądania z plikiem (poniżej sekundy) | Wróć do szkicu → usuń szkic i wystaw dokument od nowa z dzisiejszą datą (szkicu dokumentu specjalnego się nie wysyła); szkic zablokowany → pomoc FaktFlow (sprawdzamy w KSeF) | — | Wróć do szkicu (bez dowodu); **nigdy** „Wyślij ponownie” (baza odmawia); kod powstaje bez otwartego wpisu (worker odmawia po uzgodnieniu, przed plikiem i zamiarem), więc nie ma czego uzgadniać | z dowodem kontaktu — brak wyjścia w panelu do B2: sprawdź dokument w KSeF i zgłoś Bartoszowi |
| `KSEF_UNAVAILABLE` | transient | 5xx, timeout | Wyślij ponownie / Wróć do szkicu (KOR/ZAL¹ tylko w dniu wystawienia; po dacie, bez danych albo przy wstrzymanym rodzaju — tylko Wróć do szkicu z powodem) | I6: co godzinę przez 24 h; KOR/ZAL¹ tylko w dniu wystawienia | Wyślij ponownie / szkic (KOR/ZAL¹ w dniu wystawienia) | — |
| `KSEF_RATE_LIMIT` | transient | 429 | jak wyżej | I6 (KOR/ZAL¹ jak wyżej) | jak wyżej | — |
| `KSEF_SESSION` | transient | 401/403, 21184 | jak wyżej | I6 (KOR/ZAL¹ jak wyżej) | jak wyżej | — |
| `INFRA` | transient | baza / PostgREST / R2 przed POST | jak wyżej | I6 (KOR/ZAL¹ jak wyżej) | jak wyżej | — |
| `CREDENTIALS_UNAVAILABLE` | transient | klucz po rotacji, deszyfrowanie | Wyślij ponownie / szkic (KOR/ZAL¹ tylko w dniu wystawienia; po dacie, bez danych albo przy wstrzymanym rodzaju — tylko Wróć do szkicu z powodem); komunikat: bez automatu | — (alarm) | napraw klucz → Wyślij ponownie (KOR/ZAL¹ w dniu wystawienia) | — |
| `TRANSIENT_EXHAUSTED` | transient | 24 h ponowień bez skutku | jak wyżej | — | Wyślij ponownie / szkic (KOR/ZAL¹ w dniu wystawienia) | — |
| `NOT_IN_KSEF` | transient | „tylko uzgodnij”: KSeF nie ma faktury (A2b) | Wyślij ponownie / Wróć do szkicu (KOR/ZAL¹ tylko w dniu wystawienia; po dacie, bez danych albo przy wstrzymanym rodzaju — tylko Wróć do szkicu z powodem) | — (decyzja o dacie: B1/B2) | Wyślij ponownie / szkic (KOR/ZAL¹ w dniu wystawienia) | — |
| `KSEF_PAUSED` | hold | wyłącznik operatora | czeka, bez przycisków (zwykła — automat po zdjęciu; KOR/ZAL¹ tylko dziś); bez danych (także zwykła), dokument specjalny po dacie albo wstrzymany rodzaj — Wróć do szkicu z powodem | I7: po zdjęciu hamulca (KOR/ZAL¹ tylko w dniu wystawienia) | Wyślij ponownie / szkic | — |
| `KOR_HOLD` | hold | hamulec korekt | brak przycisków (decyzja a); komunikat: sami nie wyślemy, napisz do pomocy FaktFlow | — (I7 wznawia tylko `KSEF_PAUSED`) | TEST: „Wyślij ponownie”¹; PROD: Wróć do szkicu (bez dowodu) | PROD z dowodem kontaktu — C4 |
| `ROZ_HOLD_RECONCILE` | hold | hamulec ROZ | brak przycisków (decyzja a); komunikat: sami nie wyślemy, napisz do pomocy FaktFlow | — (jak wyżej) | Wróć do szkicu (bez dowodu) | z dowodem kontaktu — C4 |
| `KSEF_DUPLICATE_RECONCILE` | reconcile | 440, którego automat nie rozstrzygnął: oryginał z innego programu bez naszego pliku do porównania (`no-own-file`), oryginał z oznaczeniem naszego programu o innym pliku (`faktflow-original`; od 00156 z oceną pliku), numer KSeF w innej fakturze firmy (`known-number`), oryginału nie da się pobrać (403 — token bez `InvoiceRead`; po ponowieniach 5xx/429/21164/21165) | Decyzja klienta (no-own-file, known-number, `faktflow-original` z oceną „importable”; zwykła faktura): przycisk na karcie faktury — „To ta sama sprzedaż” / „To inna sprzedaż” (właściciel albo administrator; 00148 i 00156, D-A4-1b-3 PR B i PR C; e-mail „czeka na Twoją decyzję” raz). Przy `faktflow-original` oba przyciski zapisują fakturę z KSeF w FaktWay (numer przechodzi na nią), a dla pliku z historii tego dokumentu albo o tej samej treści jest jeden przycisk „Zapisz fakturę z KSeF w FaktWay”. Plik do przeglądu operatora (I5R): tekst `provenance-review` (sprawdzamy, nie wystawiaj ponownie, damy znać), bez przycisku. Bez danych oryginału (pobranie 403/5xx, magazyn, archiwum, brak zapisu sprawdzenia `no-check`, dane z innego środowiska KSeF): przycisk „Sprawdź ponownie” (właściciel albo administrator, PR D; `requeue_ksef_send(p_reconcile_only)`, nigdy nie wysyła; cooldown 10 minut; przy 403 wskazówka o uprawnieniu `InvoiceRead`). Pozostałe powody i rodzaje: dane oryginału z KSeF na karcie faktury (00144), „nie wystawiaj ponownie”, pytania do pomocy FaktFlow | I5D: bez automatu i bez alarmu (`I5D-env`: alarm); I5R (przegląd pliku): bez automatu, alarm krytyczny `I5R-72h` po 72 h od ostatniego sprawdzenia pliku; I5 dla pozostałych powodów: przy otwartym wpisie > 48 h weryfikacja od nowa, także dla `faktflow-original` bez oceny pliku albo z `recheckNeeded` (`recheck-needed`) i dla `known-now` (cron sam robi nowy werdykt) | „Zapisz decyzję klienta” (tylko decyzja przekazana przez klienta, notatka: kanał, data, osoba) i „Przypomnij klientowi” (raz na 24 h, decyzja 07.10 (12); nie przy `provenance-review` ani `recheck-needed`); w przeglądzie (I5R) „Zapisz fakturę z KSeF w FaktWay” (po rozmowie z klientem, tylko gdy plik da się zapisać) albo „Oddaj decyzję klientowi (plik nie z FaktWay)”; „Tylko uzgodnij” przy otwartym wpisie (powtarza weryfikację); karta `/admin/ksef/[id]`: `original_check` (powód, dane, skrót, archiwum, decyzja, powiadomienie) | bez otwartego wpisu: **ślepa uliczka** → ręczny werdykt D-A4-1b; `cross-tenant` (K albo numer dokumentu ma faktura innej firmy z tym NIP): martwy koniec → „Oryginał w innej firmie” (D-A4-1b-3 PR C), decyzja Bartosza; bez decyzji w panelu: `same-content-other-program` → D-A4-1b-2, KOR/ZAL/ROZ → D-A4-1b-3-S; `download-*`/`storage-pending`/`archive-pending`/`no-check`/inne środowisko mają przycisk klienta „Sprawdź ponownie” (PR D), a I5 i „Tylko uzgodnij” są drugim wyjściem |
| `RESULT_UNCERTAIN` | reconcile | niepewny wynik, KSeF nie odpowiada | „nie wystawiaj ponownie” | I5 (A3): „tylko uzgodnij” raz na dobę, także KOR/ZAL¹ bez względu na datę | „Tylko uzgodnij” (KOR/ZAL¹ każdego dnia) / **Wyślij ponownie** (A4; KOR/ZAL¹ tylko w dniu wystawienia) | dokument specjalny po dacie wystawienia bez otwartego wpisu — do B2 |
| `INVALID_EVENT` | reconcile | zły payload zdarzenia | „zajmujemy się” | — | **Wyślij ponownie** (A4) — zdarzenie odtworzone z wiersza (KOR/ZAL¹ tylko w dniu wystawienia) | dokument specjalny po dacie wystawienia bez otwartego wpisu — do B2 |
| `ENQUEUE_LOST` | reconcile | `queued` bez zlecenia, z dowodem kontaktu (I1) | „zajmujemy się” | I5 przy otwartym wpisie > 48 h (także KOR/ZAL¹ bez względu na datę) | **Wyślij ponownie** (A4; KOR/ZAL¹ tylko w dniu wystawienia) / „Tylko uzgodnij” | dokument specjalny po dacie wystawienia bez otwartego wpisu — do B2 |
| `NO_CERTIFICATE` | setup | brak certyfikatu | Ustawienia → Wyślij ponownie (KOR/ZAL¹ tylko w dniu wystawienia; po dacie, bez danych albo przy wstrzymanym rodzaju — tylko Wróć do szkicu z powodem) | — | Wyślij ponownie | — |
| `NOT_VERIFIED` | setup | NIP niezweryfikowany | jak wyżej | — | Wyślij ponownie | — |

¹ Dokument specjalny z zapisanymi danymi, rodzaj niewstrzymany w tym
środowisku (KOR nie na PROD, ROZ nigdy — C4). I6 czeka godzinę po każdym
błędzie, więc błąd KOR/ZAL po ok. 23:00 nie zostanie ponowiony automatycznie;
ponowienie, które dojdzie do KSeF po północy, kończy się `ISSUE_DATE_PASSED`.
To samo w kolumnie „Klient” (A4b PR2b): „Wyślij ponownie” z kopii tylko
w dniu wystawienia; inaczej tylko „Wróć do szkicu” z powodem, a szkic
dokumentu specjalnego klient usuwa i wystawia dokument od nowa z dzisiejszą
datą (szkicu specjalnego się nie wysyła).

Pola raportu crona (log workera „Cykl życia: przebieg zakończony”):
`skippedNoData` — brak danych do ponowienia (zwykła bez pozycji albo stary
dokument specjalny); `skippedHeld` — rodzaj wstrzymany (w praktyce I5: KOR na
PROD, ROZ); `skippedIssueDate` — północ między odczytem a zleceniem;
`skippedNoNip` — brak NIP-u sprzedawcy (ani w firmie, ani w `fa3_data`):
błąd danych, automat próbuje co przebieg bez skutku — po uzupełnieniu NIP-u
firmy następny przebieg sam ponowi fakturę (I6/I7) albo ją uzgodni (I5);
inaczej „Wróć do szkicu”;
`skippedConflict` — odrzucona korekta czeka na inną korektę tej samej faktury
pierwotnej (00135); utrzymujące się > 0 = sprawdź tamtą korektę. Które to
faktury: sekcja 9 `kontrola-faktur-ksef.sh` (niżej, „Która faktura”).

`scanCapped` (A5) — w tylu zapytaniach crona bezpiecznik odczytu przerwał
szukanie: 10 stron po 100 faktur, których automat nie ruszy (odmówione,
I5 poza `failed`/`rejected`, po limicie albo odroczone). Takie faktury nie
zajmują paczki 100, ale za ponad tysiącem z nich poprawne nie są ponawiane.
W logu workera obok jest ostrzeżenie „bezpiecznik odczytu” z inwariantem
i rodzajem (`regular`/`special`). Wyjście: naprawić albo cofnąć do szkicu
odmówione (sekcja 9 `kontrola-faktur-ksef.sh` pokazuje, które to grupy).

**Dlaczego „Wyślij ponownie” operatora przy klasie reconcile jest bezpieczne**
(ENQUEUE_LOST, INVALID_EVENT, RESULT_UNCERTAIN): runner najpierw rozstrzyga
zamiar i uzgadnia otwarty wpis (A2), treść faktury z dowodem kontaktu jest
zamrożona (00132), a KSeF nie przyjmie drugiej faktury o tym samym numerze
(440 — sesja z naszej historii oznacza własny duplikat i `accepted`).
Duplikat mógłby powstać tylko po zmianie numeru, czyli po powrocie do szkicu.

**Dokumenty specjalne (KOR, ZAL, ROZ) — cron i operator od A4b PR2a, klient
od PR2b:** zdarzenie odtwarzamy z kopii na wierszu — ZAL
z `fa3_data.advanceEnvelope`, KOR/ROZ ze `special_data` (00137); te same fakty
i ten sam builder (`lib/invoices/ksef-requeue-event.ts`). Warunki (cron, panel
operatora, klient): dane zapisane; rodzaj niewstrzymany (KOR na PROD —
KOR_HOLD, ROZ wszędzie — C4); pełna wysyłka tylko w dniu wystawienia
(decyzja b, 06.10.2026); uzgodnienie (I5, „Tylko uzgodnij”) bez względu na
datę, bo nie wysyła. Ponowienie, które dojdzie do KSeF po północy, worker
zamienia w `ISSUE_DATE_PASSED` (00147). Brak danych → „Stary dokument
specjalny” niżej. Bez wyjścia do B2: dokument po dacie wystawienia bez
otwartego wpisu, z dowodem kontaktu albo kodem reconcile — sprawdź w KSeF
i zgłoś Bartoszowi.

**Klient (A4b PR2b, `lib/invoices/ksef-send-policy.ts`):**
- KOR/ZAL z kopią, rodzaj niewstrzymany, dziś data wystawienia → „Wyślij
  ponownie” jak przy zwykłej fakturze (komunikat: tylko do północy).
  Inaczej tylko „Wróć do szkicu” z powodem. Kolejność powodów: rodzaj
  wstrzymany → brak kopii → data (inna niż u operatora celowo: stary ROZ
  albo KOR na PROD nie dostaje „wystaw od nowa”, bo kolejkowanie odmówiłoby
  też nowemu dokumentowi). Szkicu dokumentu specjalnego się nie wysyła —
  klient usuwa szkic i wystawia dokument od nowa (przy wstrzymanym rodzaju
  po zdjęciu blokady). To samo przy odrzuceniu, błędzie treści, ENV_MISMATCH
  i ISSUE_DATE_PASSED: przy KOR na PROD i ROZ tekst mówi „możesz wrócić do
  szkicu — nowy dokument dopiero po zdjęciu blokady”, nigdy „wystaw od nowa
  z dzisiejszą datą”.
- `KOR_HOLD`, `ROZ_HOLD_RECONCILE`: bez przycisków (decyzja a); klient
  i `last_error` workera mówią „sami jej nie wyślemy, napisz do pomocy
  FaktFlow (pomoc@faktflow.pl)” — procedura niżej.
- „Ponowimy automatycznie” w tekście nad przyciskami i znaczek „Błąd —
  ponawiamy” tylko wtedy, gdy cron naprawdę ponowi
  (`automaticResendExpected`): kod `KSEF_UNAVAILABLE`, `KSEF_RATE_LIMIT`,
  `KSEF_SESSION`, `INFRA` albo `KSEF_PAUSED`, dane zapisane, rodzaj
  niewstrzymany, KOR/ZAL tylko w dniu wystawienia. Inaczej tekst bez
  automatu, a przy kodach transient znaczek „Błąd wysyłki” (np.
  `CREDENTIALS_UNAVAILABLE`, `TRANSIENT_EXHAUSTED`, `NOT_IN_KSEF`).
- Aplikacja (id=1) bez poprawnego `KSEF_ENV`: przy kodach transient, hold
  i setup jeden komunikat „Nie możemy teraz potwierdzić środowiska KSeF…”,
  bez przycisków — napraw zmienną w Coolify.
- Odmowa „Wyślij ponownie” przy kolejkowaniu (wyłącznik, brak certyfikatu)
  zostawia fakturę z błędem wysyłki, nie szkic; strona odświeża się po
  odmowie (strona otwarta przez północ traci przycisk).
- Gdzie panel nie ma wyjścia (szkic zablokowany przy `ISSUE_DATE_PASSED`,
  `ENV_MISMATCH` albo braku kopii), klient dostaje „nie wystawiaj ponownie
  i napisz do pomocy FaktFlow — sprawdzimy w KSeF”.

### Klient pisze do pomocy FaktFlow (pomoc@faktflow.pl)

- **`KOR_HOLD` / `ROZ_HOLD_RECONCILE`:** bez dowodu kontaktu — „Wróć do
  szkicu” w `/admin/ksef/<id>` (klient usuwa szkic i po zdjęciu blokady
  wystawia dokument od nowa); z dowodem — dokument czeka na C4, odpisz
  klientowi, że nie wystawia go ponownie.
- **Szkic dokumentu specjalnego zablokowany** (`ISSUE_DATE_PASSED`, brak kopii,
  wstrzymany rodzaj z dowodem kontaktu): sprawdź dokument w KSeF i zgłoś
  Bartoszowi (B2 / C4 / D-A4-1b).
- **`ENV_MISMATCH` z zablokowanym szkicem:** sprawdź fakturę w KSeF tamtego
  środowiska i zgłoś Bartoszowi (F2, D-A4-2 niżej).

**`KSEF_DUPLICATE_RECONCILE` — decyzja klienta (D-A4-1b-3 PR B, 00148;
zasady w „Decyzje do podjęcia” niżej):**
- **Zapis decyzji przekazanej przez klienta:** `/admin/ksef/<id>` →
  „Zapisz decyzję klienta”. Operator nie decyduje sam (04.10.2026) —
  zapisuje tylko to, co klient powiedział albo napisał. Notatka (co
  najmniej 10 znaków): **kanał, data, osoba**, np. „e-mail od właściciela
  05.10, Jan Kowalski”. Odpowiedź klienta zachowaj w skrzynce pomocy.
  Gdy dialog wymaga potwierdzenia „Rozumiem skutki” (inny albo nieznany NIP
  nabywcy, inna albo nieznana kwota brutto lub waluta), zaznacz je tylko
  wtedy, gdy klient potwierdził je wprost. Przycisk wyłączony = powód obok
  (np. wpłaty, środowisko, `known-stale`) — kroki niżej.
- **„Przypomnij klientowi”:** pierwszy e-mail „Faktura {nr} czeka na
  Twoją decyzję” (i push) automat próbuje wysłać raz na fakturę i numer
  KSeF oryginału; ślad zapisuje tylko po dostarczeniu. Niedostarczonego
  (adres właściciela na liście odbić, firma bez właściciela albo adresu,
  push bez subskrypcji) nic automatycznie nie ponawia: faktura w I5D nie
  dostaje kolejnego zdarzenia. Błąd odczytu właściciela albo adresu (baza,
  GoTrue) ponawia samo zadanie co 5 min (pg-boss, 2 ponowienia); po ich
  wyczerpaniu — tak samo bez śladu. Sprawdź kolumnę „Powiadomienie klienta” w tabeli
  „Czekają na decyzję klienta (I5D)” w `/admin/ksef` (w karcie faktury:
  „Powiadomienie klienta: N ×”): **„nie” → operator: „Przypomnij
  klientowi”**. Przycisk wysyła przypomnienie na adres właściciela firmy,
  najwyżej raz na 24 h (decyzja 07.10 (12)). „Firma nie ma adresu e-mail
  właściciela” → skontaktuj się innym kanałem. „Nie udało się odczytać
  adresu e-mail właściciela” → chwilowy błąd bazy albo GoTrue: spróbuj
  ponownie za chwilę, nie szukaj innego kanału. „Nie wysłano przypomnienia
  (hard_bounce)” albo „(complaint)” → adres właściciela jest na liście odbić,
  przypomnienie tam nie dojdzie: skontaktuj się z klientem innym kanałem
  (telefon albo inny adres z danych firmy) i zapisz kontakt w skrzynce
  pomocy. „Przypomnienie wysłane, ale nie zapisaliśmy śladu w audit_logs”
  → nie wysyłaj ponownie przez 24 h.
  Faktura, która czekała przed wdrożeniem PR B, dostaje pierwszy e-mail
  dopiero z tego przycisku.
- **`known-number` po decyzji klienta:** sprawdź dokument Y (ten, który
  w FaktFlow ma numer KSeF oryginału) w KSeF i w FaktFlow — lista decyzji
  z 30 dni: sekcja 10 (f) `scripts/ops/kontrola-faktur-ksef.sh`; sygnał
  także z alarmu Sentry `ksef-duplicate-known-number`. Jeśli Y ma ten
  numer KSeF przez pomyłkę albo jego dane nie zgadzają się z fakturą
  w KSeF: naprawa Y rolą serwisową **tylko za zgodą Bartosza**, dla tej
  jednej faktury (D-A4-1b-3-KN-Y — narzędzia nie ma).
- **Wpłaty na dokumencie (decyzja 07.10 (6)):** decyzja jest zablokowana,
  dopóki przy dokumencie są wpłaty (`paid_amount` albo wiersze
  `payments`). Ustal z klientem, przy której fakturze wpłata ma być.
  `UPDATE payments.invoice_id` (przeniesienie) albo usunięcie wiersza
  wpłaty — **tylko za zgodą Bartosza, osobno dla każdego przypadku**;
  potem „Zapisz decyzję klienta”. Panel klienta widzi tylko `paid_amount`
  (rola `authenticated` nie czyta `payments`): wiersz, którego `paid_amount`
  nie liczy (np. niepotwierdzone dopasowanie automatyczne), kończy się
  odmową RPC z numerem dokumentu i ostrzeżeniem Sentry
  `ksef.duplicate-decision` („RPC odmówiło mimo zgody polityki”).
- **Blokady bez decyzji w panelu** — `billing` (faktura abonamentu),
  `offline`, `conflicting-originals`, `own-history` (oryginał może być
  wcześniejszą wysyłką z FaktFlow), `kind` (KOR/ZAL/ROZ, D-A4-1b-3-S),
  `no-marker`, `known-stale`: sprawdź fakturę w KSeF i zgłoś Bartoszowi.
  `known-stale` (Y nie ma już numeru KSeF oryginału albo nie jest
  przyjęty): „Tylko uzgodnij” odświeża werdykt; Y w stanie `failed`
  z numerem KSeF to I9 — najpierw I9. `no-check` (wpis sprzed 00144): I5
  zapisze dane przy ponownym sprawdzeniu.
- **Błędna decyzja:** wycofany dokument zostaje niewysyłalny (RPC odmawia
  drugiej, innej decyzji). Przy „ta sama sprzedaż”, która okazała się inną
  sprzedażą, klient wystawia nową fakturę z nowym numerem. Zmiana
  `original_check.decision` — tylko za zgodą Bartosza.
- **Usunięcie albo zmiana numeru wycofanego szkicu zwykłej faktury lub
  zaliczki na prośbę klienta:** tylko za zgodą Bartosza, rolą serwisową
  (wyzwalacze `c_guard_ksef_retired_draft_delete`
  i `c_guard_ksef_retired_draft_number` przepuszczają serwis). Usunięcie
  kasuje ślad decyzji (`ksef_submissions` usuwa się kaskadą) i oddaje numer
  do podpowiedzi następnego numeru. Szkic wycofany KOR i ROZ klient usuwa
  sam („Usuń szkic”, decyzja 07.10 (9)).
- **Przełączenie TEST → PROD (lista kontrolna):** przed zmianą `KSEF_ENV`
  policz faktury I5D z `detail.env = 'test'` (sekcja 10 (c)
  `kontrola-faktur-ksef.sh`). Po przełączeniu każda z nich to `I5D-env`
  (alarm krytyczny): klient nie zapisze decyzji (RPC `ENV`), a ponowne
  sprawdzenie pytałoby PROD o numer z TEST. Niech klienci zdecydują przed
  przełączeniem; reszta — zgłoś Bartoszowi (F2). To samo dotyczy
  `faktflow-original` z `env = test` w I5R i w I5 (`recheck-needed`): po
  przełączeniu dane oryginału są z innego środowiska, więc ani klient, ani
  operator nie zapisze decyzji (`kontrola-faktur-ksef.sh`, sekcja 10 (a): powód
  `faktflow-original` × środowisko).

### Stary dokument specjalny (bez danych do ponowienia)

KOR/ROZ sprzed 00137 (bez `special_data`) albo ZAL sprzed 02.10.2026 (bez
`fa3_data.advanceEnvelope`). Na produkcji 05.10.2026: 0 takich dokumentów
(sekcja 9 `kontrola-faktur-ksef.sh`).

1. Tylko przy dowodzie kontaktu albo kodzie klasy reconcile; w pozostałych
   przypadkach operator klika „Wróć do szkicu”.
2. KOR/ROZ: uruchom skrypt — najpierw bez opcji (tylko sprawdza i pokazuje
   faktura + PIERWSZE zlecenie wysyłki tej faktury z pg-boss, które trzyma joby
   7 dni):
   ```bash
   ./scripts/ops/dopisz-dane-specjalne.sh <id-faktury>
   ```
   Wszystkie kolumny warunków muszą być `t`: faktura KOR/ROZ bez
   `special_data`; job tej faktury (`invoiceId`) i tej samej firmy
   (`tenantId`); środowisko joba = `KSEF_ENV` workera; treść joba = `fa3_data`;
   job niesie dane tego rodzaju. Inaczej STOP (inne środowisko — F2;
   po 7 dniach źródła nie ma — ślepa uliczka, decyzja Bartosza).
3. Zapis (NIEODWRACALNY — 00137 zapisuje `special_data` raz):
   ```bash
   ./scripts/ops/dopisz-dane-specjalne.sh <id-faktury> --wykonaj
   ```
   Jedna transakcja: te same warunki w jednym zapytaniu, zapis tylko przy
   DOKŁADNIE jednym trafionym wierszu (inaczej ROLLBACK) i wpis `audit_logs`
   `invoice.special_data_backfilled` z id joba. Wyzwalacz 00137 dopuszcza
   NULL → wartość tylko serwerowi; kształt pilnuje CHECK.
4. ZAL: tylko gdy `submitted_to_ksef_at IS NULL` i za zgodą Bartosza dla tej
   faktury (dopisanie `fa3_data.advanceEnvelope` z `data->'advanceData'`). Po
   przejęciu wysyłki (00124) `fa3_data` jest zamrożone dla każdej roli (00132)
   — 42501 = STOP, zgłoś Bartoszowi.
5. Po zapisie wiersz ma dane: I5 i „Tylko uzgodnij” przy otwartym wpisie
   sent/intent każdego dnia, I6/I7 i „Wyślij ponownie” tylko w dniu
   wystawienia; poza tym brak wyjścia do B2 (zgłoś Bartoszowi). ROZ i KOR na
   PROD czekają na C4.
6. Sekcję 9 `kontrola-faktur-ksef.sh` uruchom ponownie po wdrożeniu PR2a.

**Decyzje do podjęcia (Bartosz):**
- **D-A4-1 — cudzy 440 — PRZYJĘTA (Bartosz, 04.10.2026).** Automat (D-A4-1a)
  przy każdym 440 — w nowej wysyłce i przy uzgadnianiu po referencji:
  1. sesja oryginału w historii tej faktury **i ten sam skrót pliku** →
     nasza faktura, `accepted` z numerem oryginału (bez skrótu albo z innym
     skrótem → dalej, bo po powrocie do szkicu treść mogła się zmienić);
  2. numer KSeF oryginału ma inna faktura firmy w FaktFlow (Y) → bez
     przyjęcia treści; od D-A4-1b-3 PR B oryginał i tak pobieramy (krok 3)
     i zapisujemy jego dane, a werdykt po udanym pobraniu to `known-number`
     — decyzja klienta (niżej; nieudane pobranie jak w kroku 4), alarm
     operatora `ksef-duplicate-known-number` zostaje;
  3. pobranie oryginału (`GET /invoices/ksef/{ksefNumber}`, `InvoiceRead`):
     bieżący plik bajt w bajt (albo wcześniejsza próba o tej samej treści)
     → `accepted`; oryginał z FaktFlow (`SystemInfo = KSeF SaaS v1.0`) o innym
     pliku → operator; oryginał z innego programu → `KSEF_NUMBER_TAKEN`
     (wszystkie wpisy duplikatu → `number_taken`, klient może wrócić do szkicu
     (szkic wycofany, 00148));
  4. pobranie się nie udało: chwilowo (5xx, 429, 401, 21164, 21165, błąd
     odczytu naszego pliku z magazynu) — ponowienie samej weryfikacji, bez
     drugiej wysyłki; trwale (403, inne 4xx) — operator.
  Wpis próby dostaje **znacznik 440** (`original_ksef_number`,
  `original_session_reference_number`, 00142) i zostaje **otwarty** (`sent`,
  dowód kontaktu) przy każdym werdykcie „do operatora” — każde kolejne
  uzgodnienie (cron I5, „Tylko uzgodnij”) weryfikuje treść od nowa i nigdy nie
  kończy się STALE / NOT_IN_KSEF. Zamyka go tylko werdykt: `number_taken` albo
  zapis akceptacji. Przy przyjęciu numeru z duplikatu `ksef_accepted_at` =
  data nadania numeru **oryginałowi** (art. 106na — wystawienie i otrzymanie):
  własna sesja — status po referencji, inaczej metadane po numerze KSeF;
  brak daty → numer przyjęty, alarm `ksef-duplicate-no-date` (operator
  uzupełnia datę z KSeF). Kierunek bezpieczny: „numer zajęty” nigdy dla oryginału
  z FaktFlow, przy tej samej treści z innego programu (ta sama sprzedaż) ani
  bez naszego pliku do porównania.
  Każdy nierozstrzygnięty werdykt zapisuje **dane oryginału** na otwartym
  wpisie próby (`ksef_submissions.original_check`, 00144): powód
  (`known-number`, `download-refused`, `download-pending`, `storage-pending`,
  `archive-pending`, `faktflow-original`, `same-content-other-program`,
  `no-own-file`, `archive-conflict`), numer, datę, nabywcę, kwotę, program, datę nadania
  numeru, skrót i — gdy oryginał pobrano, a werdykt nie zapadł — bajty
  oryginału w archiwum `<firma>/ksef-import/<numer KSeF>.xml` (ten sam klucz
  co Magiczny import). Klient widzi je na karcie faktury, operator na karcie
  w `/admin/ksef`. Ponowne sprawdzenie (cron I5, „Tylko uzgodnij”), które
  nie pobrało oryginału (503, 403), nie kasuje danych z udanego — wynik
  próby trafia do `recheck`. `archive-conflict` = w archiwum jest inny plik
  pod tym numerem KSeF: operator porównuje oba pliki, zanim cokolwiek
  zdecyduje.
  „Znany numer” (numer KSeF oryginału ma już inna faktura firmy) liczy
  tylko faktury sprzedaży — zakupowa z tym numerem nie zatrzymuje
  porównania treści (D-A4-1b-3, A0); od PR B pobieramy oryginał także przy
  znanym numerze (dane, skrót, archiwum i `knownInvoice` na wpisie), ale
  w tej gałęzi nie przyjmujemy jego treści — Y ma już ten numer KSeF.
  Wyjątek: krok 1 (własna sesja z tym samym skrótem) idzie przed
  sprawdzeniem znanego numeru — osobne ustalenie D-A4-1b-3-OWN-KN.
- **D-A4-1b — przypadki nierozstrzygnięte przez automat** (decyzje Bartosza
  04.10.2026):
  1. wcześniejsza wersja tej faktury w KSeF → przyjąć oryginał (numer
     i treść), zmiany korektą — **odłożone** do B2 (data poprawiana w tym
     samym szkicu): dziś szkic z nieaktualną datą jest usuwany i wystawiany
     od nowa, a usunięcie kasuje historię prób, więc automat nie ma dowodu.
     **Zmiana C3 (decyzja Bartosza 08.10.2026, PR C):** przyjęcie oryginału na
     tym samym dokumencie (D-A4-1b-1) zostaje odłożone, ale gdy plik jest
     wcześniejszą wersją tego dokumentu (`ownHistory`), klient zapisuje
     oryginał jako OSOBNĄ fakturę z KSeF: numer FV/N przechodzi na nią,
     dokument wycofany zostaje bez numeru, a zmiany wchodzą tylko korektą
     (sekcja „D-A4-1b-3 PR C” niżej);
  2. ta sama treść z innego programu → numer + trwały znacznik, baner, mail,
     ostrzeżenie w JPK (D-A4-1b-2);
  3. pozostałe → decyduje **klient** przyciskiem z danymi oryginału („ta
     sama sprzedaż” / „inna sprzedaż → nowy numer”), operator tylko zapisuje
     decyzję klienta (D-A4-1b-3: A0 i A dane oryginału na wpisie — zrobione;
     wierny import C5a–C5c — zrobiony; **B decyzja — zrobiona dla
     `no-own-file` i `known-number`, tylko zwykła faktura** (00148, punkt
     niżej); **C zapis oryginału z oznaczeniem FaktWay (`faktflow-original`):
     zrobiony** (00156, sekcja „D-A4-1b-3 PR C” niżej); D
     „Sprawdź ponownie” (powody bez danych oryginału)). KOR, ZAL i ROZ
     z nierozstrzygniętym 440 nie mają decyzji w panelu — osobne ustalenie
     D-A4-1b-3-S. Dla powodów i rodzajów bez decyzji w panelu operator
     sprawdza fakturę w KSeF i zgłasza ją Bartoszowi.
- **D-A4-1b-3 PR B — decyzja klienta przy nierozstrzygniętym 440** (00148,
  decyzje Bartosza 04.10 i 07.10.2026):
  1. **Kto i kiedy.** Właściciel albo administrator firmy, przyciskiem na
     karcie faktury `failed KSEF_DUPLICATE_RECONCILE`, gdy
     `ksef_duplicate_decision_blocker` = NULL: powód `no-own-file` albo
     `known-number` z danymi oryginału (skrót, podsumowanie,
     `ownHistory = false`), zwykła faktura bez numeru KSeF, nie abonament,
     nie offline,
     jeden oryginał w historii, brak własnej historii tego pliku, brak wpłat,
     dane oryginału sprawdzone w środowisku = `KSEF_ENV`. Operator zapisuje
     decyzję wyłącznie na prośbę klienta („Zapisz decyzję klienta”,
     notatka: kanał, data, osoba) — sam nie decyduje (04.10.2026).
     „Rozumiem skutki” jest wymagane, sprawdzane też na serwerze (07.10 (7),
     (12)): „inna sprzedaż” przy tym samym albo nieznanym NIP nabywcy;
     „ta sama sprzedaż” przy innym albo nieznanym NIP albo innej, nieznanej
     lub w innej walucie kwocie brutto.
  2. **Skutek** (RPC `decide_ksef_duplicate`, jedna transakcja): wpisy
     `intent`/`sent`/`duplicate` → `number_taken` z kluczem `decision` na
     znaczniku, dokument wraca do szkicu jako **wycofany** (numer zostaje
     przy nim), audyt `invoice.ksef_duplicate_decided` (aktor, notatka,
     dane oryginału, prawdziwy poprzedni stan) i `invoice.send_reset`.
     Nic nie importujemy (07.10 (A)): „ta sama sprzedaż” — fakturą tej
     sprzedaży jest ta w KSeF (FaktFlow nie ujmuje jej w JPK ani w KPiR);
     „inna sprzedaż” — klient wystawia nową fakturę z nowym numerem
     i dzisiejszą datą. Ta sama decyzja drugi raz = `already_decided`, bez
     zapisu; inna — odmowa („Decyzja … jest już zapisana”).
  3. **`known-number`** (07.10 (1)): runner pobiera, archiwizuje
     i streszcza oryginał K; klient widzi dane K i odnośnik „Zobacz
     dokument {Y}” do faktury, która w FaktFlow ma numer K. Decyzja dotyczy
     tylko naszego dokumentu — Y zostaje bez zmian (nie może być wiernym
     zapisem K: indeks unikalny numeru, 00120). Y bez numeru K albo
     nieprzyjęty → `known-stale` (zostaje I5, ponowne sprawdzenie). Naprawa
     Y — procedura „Klient pisze do pomocy”, za zgodą Bartosza
     (D-A4-1b-3-KN-Y).
  4. **Szkic wycofany** — każdy szkic z wpisem `number_taken`, z decyzji
     albo z automatu `KSEF_NUMBER_TAKEN` (07.10 (2), (3), (9)–(11)): nie
     wyślesz go do KSeF (wyzwalacz `c_guard_ksef_retired_draft`, każda
     rola), nie wyślesz go e-mailem do nabywcy (odmowa w
     `emailInvoiceAction`), klient nie zmieni jego numeru
     (`c_guard_ksef_retired_draft_number`); zwykłej faktury i zaliczki
     klient nie usunie (`c_guard_ksef_retired_draft_delete` — numer nie
     wraca do podpowiedzi), korektę i fakturę rozliczeniową usunie (szkic
     KOR blokowałby kolejną korektę, 00133/00135; szkic ROZ trzyma swoje
     zaliczki, 00125). Baner „Dokument wycofany — numer … jest zajęty
     w KSeF” przy każdym rodzaju; pobranie PDF zostaje (kopia klienta).
     Rola serwisowa przechodzi przez wyzwalacze usunięcia i numeru (zgoda
     Bartosza, procedura niżej).
  5. **I5D — czeka na klienta** (07.10 (4)): osobny wiersz
     `ksef_lifecycle_violations()` dla faktury, którą klient może
     rozstrzygnąć (blokada = NULL), od pierwszej minuty, bez progu wieku.
     Cron go nie uzgadnia, alarm krytyczny go nie liczy, raport dzienny
     („Czekają na decyzję klienta (I5D)”) i `/admin/ksef` pokazują go
     osobno. Wyjątek **`I5D-env`** — dane oryginału z innego środowiska
     KSeF niż `KSEF_ENV`: alarm krytyczny, bo klient nie zapisze decyzji
     (RPC `ENV`). Faktura, której klient nie rozstrzygnie (wpłaty, rodzaj,
     abonament, offline, `no-check`, inne powody, `known-stale`, własna
     historia), zostaje w I5 z alarmem i ponownym sprawdzeniem po 48 h.
  6. **Powiadomienie** (07.10 (5), (12)): e-mail „Faktura {nr} czeka na
     Twoją decyzję” i push do właściciela — raz na fakturę i numer KSeF
     oryginału (trwały ślad `invoice.ksef_duplicate_decision_notified`
     w `audit_logs`, zapis tylko po dostarczeniu). Bez automatycznego
     przypomnienia i bez automatycznego ponowienia niedostarczonego
     pierwszego powiadomienia; „Przypomnij klientowi” w `/admin/ksef/<id>`
     wysyła e-mail (także pierwszy, gdy automat go nie dostarczył), najwyżej
     raz na 24 h. Tabela I5D w `/admin/ksef` pokazuje w kolumnie
     „Powiadomienie klienta”, czy klient dostał powiadomienie o tym numerze
     KSeF oryginału.
  7. **Wpłaty** (07.10 (A), (6)): wpłaty zapisane na dokumencie blokują
     decyzję; klient dostaje komunikat z numerem dokumentu i adresem
     pomoc@faktflow.pl. Wiersze `payments` zmieniamy tylko za zgodą
     Bartosza, osobno dla każdego przypadku (procedura „Klient pisze do
     pomocy”). Narzędzia operatora do wpłat nie ma.
  8. **Przegląd prawnika przed KSeF PROD** (07.10 (A), (8); TEST bez
     blokady): dialogi i panel decyzji, odmowy w panelu, komunikaty P0001
     z RPC i wyzwalaczy 00148 (`DUPLICATE_DECISION_SQL_TEXTS`), baner
     wycofanego dokumentu każdego rodzaju, odmowa e-maila, e-mail,
     przypomnienie i push, teksty `KSEF_NUMBER_TAKEN` (także KOR/ZAL/ROZ
     i katalog `ksef_error_codes`). Lista do przekazania prawnikowi to jeden
     plik: `tests/unit/__snapshots__/ksef-duplikat-decyzja-teksty.txt`
     (migawka `DUPLICATE_DECISION_TEXTS` + `DUPLICATE_DECISION_SQL_TEXTS`
     z `lib/ksef/duplicate-decision.ts`, test
     `tests/unit/ksef-duplikat-decyzja-teksty.test.ts`). Po przeglądzie
     PR B doszły dwa teksty — wskaż je prawnikowi osobno:
     `TRIGGER_DIRECTION` (odmowa wyzwalacza: „Wycofanego dokumentu % nie
     zmienisz na fakturę zakupową: zajmuje numer, który w KSeF ma już %,
     i zostaje w FaktFlow jako faktura sprzedaży, żeby tego numeru nie
     dostała inna faktura sprzedaży.”) i `DIALOG_SAME.CHECKBOX_UNCOMPARABLE`
     (potwierdzenie w dialogu „ta sama sprzedaż”: „Rozumiem skutki: faktura
     {K} w KSeF dokumentuje tę samą sprzedaż co dokument {nr}, choć części
     danych w tabeli nie da się porównać.”). Zmiana tekstu
     P0001 po przeglądzie wymaga nowej migracji (`CREATE OR REPLACE`) i tej
     samej zmiany w lustrze TypeScript; dziś zgodność lustra z 00148
     pilnuje `tests/unit/ksef-decyzja-duplikatu-migracja.test.ts` (U16e) —
     nowa migracja musi dostać takie samo sprawdzenie. Punkt bramki: plan
     „zero zgubionych faktur”, sekcja 8.
  9. **Zapisane osobno** (dziennik planu, sekcja 9): D-A4-1b-3-S
     (KOR/ZAL/ROZ z nierozstrzygniętym 440), D-A4-1b-3-KN-Y (zapis Y po
     decyzji `known-number`), D-A4-1b-3-OWN-KN (akceptacja własnej sesji
     przed sprawdzeniem znanego numeru), treść szkicu wycofanego poza
     numerem (niezamrożona na poziomie bazy), e-mail dokumentu bez numeru
     KSeF poza szkicem wycofanym, brak znaczka „Czeka na decyzję” na
     liście faktur.
- **D-A4-2 — `ENV_MISMATCH`** (decyzja Bartosza 04.10.2026, przyjęta
  w 00143). Ponowienie tworzy nowe zdarzenie z BIEŻĄCYM środowiskiem, więc
  wysłałoby fakturę zleconą na TEST jako prawdziwą fakturę na PROD. Dlatego
  kod jest klasy **terminal**: faktura bez dowodu kontaktu wraca do szkicu
  (klient sam albo operator), a klient decyduje — wysyła ją w obecnym
  środowisku albo jej nie wystawia (usuwa szkic). `requeue_ksef_send` odmawia
  ponowienia (przepuszcza tylko „tylko uzgodnij”), więc ochrona nie zależy
  od przycisku. Z otwartym wpisem z wcześniejszej próby faktura mogła
  dotrzeć do KSeF: klient dostaje „nie wystawiaj ponownie”, szkic jest
  zablokowany. **Uwaga:** „Tylko uzgodnij” (i cron I5 po 48 h) uzgadnia
  w BIEŻĄCYM środowisku, a wpis `ksef_submissions` nie zna swojego (F2).
  Wpis sprzed przełączenia środowiska nic tam nie znajdzie, a `requeue`
  czyści kod — wynik (`NOT_IN_KSEF`, `NOT_VERIFIED`, `RESULT_UNCERTAIN`)
  zaprasza do ponownej wysyłki, czyli wysłania dokumentu z TEST na PROD.
  Operator nie uzgadnia tak wpisu z drugiego środowiska: sprawdza fakturę
  w KSeF tamtego środowiska i zgłasza ją Bartoszowi (wyjście — F2). Gdy worker nie ma poprawnego `KSEF_ENV`, każda wysyłka kończy
  się `ENV_MISMATCH` z komunikatem „zajmujemy się tym”: najpierw napraw
  zmienną w Coolify (worker `id=2`), potem klienci wracają do szkicu
  i wysyłają ponownie. Operator: lista w `/admin/ksef` po kodzie, alarm
  Sentry „KSeF submit event environment mismatch”.
  Przełączenie TEST → PROD (F1) musi to uwzględnić: przed zmianą `KSEF_ENV`
  hamulec i pusta kolejka, bo cron (I6, I7) wznawia `failed` z kodami
  przejściowymi i `KSEF_PAUSED` nowym zdarzeniem z bieżącym środowiskiem —
  faktury z czasu TEST wyszłyby same na PROD; wpisy `ksef_submissions` nie
  mają kolumny środowiska, więc próba z TEST wygląda po przełączeniu jak
  dowód kontaktu (F2). Od 00148 także faktury czekające na decyzję klienta
  (I5D) z danymi oryginału z TEST — po przełączeniu `I5D-env`, alarm
  krytyczny (lista kontrolna w „Klient pisze do pomocy FaktFlow”).

### D-A4-1b-3 PR C — oryginał z oznaczeniem FaktWay/FaktFlow (00156)

Decyzje Bartosza z 04.10, 07.10 i 08.10.2026 (C1 do C8). Dotyczy powodu
`faktflow-original`: KSeF ma już fakturę Twojej firmy o tym numerze, a jej plik
ma `SystemInfo` naszego generatora (`KSeF SaaS v1.0`), ale treść jest inna niż
w naszym pliku. Migracja `00156_ksef_duplicate_original.sql` idzie przed
wdrożeniem kodu. Numer 00149, zarezerwowany dla PR C, nie został użyty: 00151
(zmiana marki) i 00155 (historia KSeF) przepisały te same funkcje, a pod 00149
świeża baza wgrałaby PR C przed nimi i one by go cofnęły. Marka w tekstach dla
klienta to FaktWay, adres pomocy pomoc@faktway.pl. Identyfikator powodu zostaje
`faktflow-original`.

**Skąd wiadomo, że plik jest nasz (brama pochodzenia).** Runner przy werdykcie
ocenia pobrany plik oryginału szesnastoma jawnymi regułami (tabela niżej) i
zapisuje wynik na znaczniku jako `original_check.importGate`
(`{v, rules, kind, problems, preview, release?}`). `kind = importable` znaczy:
plik wygląda na plik z generatora FaktWay zwykłej faktury, a jego zapis przejdzie
kontrolę bazy. `kind = review` znaczy: jest co najmniej jeden problem i plik ogląda
operator. Znacznik bez poprawnej bramy (sprzed 00156, stary runner w oknie
wdrożenia, zły kształt) nie jest przeglądem. To `recheck-needed`: faktura idzie
do I5 i cron sam robi nową ocenę.

**Skutek zapisu oryginału (C1).** Jedna transakcja
(`decide_ksef_duplicate_original`), albo wszystko, albo nic:

1. wpisy `intent`, `sent`, `duplicate` dokumentu X przechodzą w `number_taken`
   z kluczem `decision` na znaczniku (kto, kiedy, co wybrał, jaki plik, jaka
   oferta, kopia treści X); X wraca do `draft`;
2. numer dokumentu X przechodzi na oryginał: X zostaje szkicem bez numeru;
   klient nie wyśle go, nie usunie i nie nada mu numeru;
3. oryginał K zapisuje się jako przyjęta faktura sprzedaży
   (`origin = 'ksef_import'`, `accepted`, numer = P_2 z pliku = dawny numer X,
   pozycje, `xml_documents` z plikiem z archiwum, `ksef_accepted_at` z daty
   nadania numeru), z sesją oryginału na K i wierszem `upo_receipts`;
4. audyt `invoice.ksef_duplicate_decided`, `invoice.ksef_original_imported`
   (na K) i `invoice.send_reset`.

Numer nie wraca do podpowiedzi: trzyma go K. Dowód decyzji leży na wierszach
z retencją faktur (`X.marker.original_check.decision` i
`K.fa3_data.import.decision`), nie tylko w `audit_logs` (usuwane po 12 miesiącach).

**Oferty: co widzi klient, co operator, co się dzieje.** Ofertę liczy jedna
funkcja bazy (`ksef_duplicate_original_offer`) i jej lustro w TS; panel, e-mail,
push i karta operatora biorą z niej ten sam wariant.

| Oferta | Kiedy | Klient | Operator | Skutek |
|---|---|---|---|---|
| `pair` | brama `importable`; plik nie jest wcześniejszą wersją tego dokumentu; treść różni się nie tylko nagłówkiem | dwa przyciski „To ta sama sprzedaż” / „To inna sprzedaż” z „Rozumiem skutki”; oba zapisują K (C2) | „Zapisz decyzję klienta” (oba wybory) | K zapisany, X wycofany bez numeru |
| `record` | brama `importable`; plik jest w historii tego dokumentu (sesja albo skrót pliku w próbach X, albo `ownHistory`) albo ma tę samą treść poza nagłówkiem | jeden przycisk „Zapisz fakturę z KSeF w FaktWay” (C3, C5), tylko „ta sama sprzedaż” | to samo | jak wyżej |
| `review-pair`, `review-record` | brama `review`, blokada `provenance-review` (I5R) | tekst `provenance-review` (sprawdzamy, nie wystawiaj ponownie, damy znać), bez przycisku; jeden e-mail „sprawdzamy fakturę z KSeF” na fakturę i numer KSeF | procedura „Przegląd pliku (I5R)” niżej | zapis K albo oddanie decyzji |
| `released` | operator oddał decyzję po przeglądzie (`importGate.release`) | dwa przyciski jak w PR B, w polu programu tekst `PROGRAM_RELEASED`, zdanie, że plik sprawdziliśmy; e-mail `NOTICE_BODY_RELEASED` (sprawdziliśmy, zdecyduj) | „Zapisz decyzję klienta” | semantyka PR B: X wycofany Z numerem, bez K |
| bez oferty, `recheck-needed` | znacznik bez poprawnej bramy albo z `recheckNeeded` | tekst `recheck-needed` (sprawdzamy jeszcze raz, zwykle w ciągu 2 dni), bez przycisku | nic nie musi: I5, cron „Tylko uzgodnij” po 48 h od próby; może od razu „Tylko uzgodnij” | nowa ocena pliku na znaczniku |
| bez oferty, `cross-tenant` | K ma faktura sprzedaży innej firmy albo numer X ma wysłana kiedyś faktura innej firmy z tym samym NIP | tekst odmowy, bez przycisku | procedura „Oryginał w innej firmie” niżej | brak, faktura w I5 |
| bez oferty, `known-now` | K ma już inna faktura sprzedaży tej firmy (pojawiła się po werdykcie) | tekst odmowy | nic nie musi: I5, cron powtórzy werdykt i da `known-number` (PR B) | brak, faktura w I5 |

Odmowy przy samym zapisie przez klienta (brama `importable`): brak pliku w
archiwum albo inny SHA-256 lub rozmiar, bieżąca ocena z innym `kind` lub
`problems` niż zapisana, projekcja nie przechodzi lustra kontroli zapisu,
baza odmawia (`IMPORT_MISMATCH` albo 22023). Klient dostaje tekst „musimy
sprawdzić jeszcze raz”, a akcja sama zapisuje `recheckNeeded` i wysyła alarm
Sentry. To już jest `recheck-needed`.

**Reguły bramy (`ORIGINAL_GATE_RULES = 1`).** Kolejność kodów w
`importGate.problems` jest stała, bez powtórzeń. Reguły `currency` i `parse`
kończą ocenę, pozostałe zbierają się naraz. Brama nie czyta ostrzeżeń parsera.

| Kod | Problem, gdy | Zapis przez operatora w przeglądzie |
|---|---|---|
| `currency` | waluta pliku niepusta i inna niż PLN | nigdy |
| `parse` | plik nie daje się odczytać jako FA(3) | nigdy |
| `form` | formularz inny niż FA (3) | tak, gdy projekcja przechodzi kontrolę zapisu |
| `kind` | `RodzajFaktury` inny niż VAT | nigdy |
| `number` | P_2 różni się od numeru dokumentu albo któraś strona jest pusta | nigdy |
| `seller` | NIP sprzedawcy różni się od NIP firmy albo któraś strona jest pusta | nigdy |
| `buyer-id` | nabywca bez identyfikatora albo NIP nabywcy bez 10 cyfr | tak, jw. |
| `no-lines` | brak pozycji | nigdy |
| `gross-prices` | ceny brutto (P_9B, P_11A) | tak, jw. |
| `line-fields` | pozycja bez P_9A, P_11 lub P_12, z P_10 lub P_11Vat, nazwa poza 1 do 512 znaków albo jednostka poza 1 do 50 | tak, jw. |
| `rates` | stawka P_12 spoza tych, które pisze generator | tak, jw. |
| `amounts` | kwoty pozycji niezgodne z sumami stawek | tak, jw. |
| `totals` | brak P_15 albo P_15 różni się od sum P_13 i P_14 choćby o 1 grosz | tak, jw. |
| `annotations` | adnotacje, których FaktWay nie wystawia, albo nieczytelne | tak, jw. |
| `markers` | FP, TP, podmiot upoważniony, GTU albo procedura | tak, jw. |
| `sale-date` | `OkresFa`, P_6A albo nieczytelna data sprzedaży | tak, jw. |

Dla kodów oznaczonych „nigdy” projekcji zapisu nie da się zbudować, więc przycisk
zapisu jest wyłączony z powodem `notBuildable`. Dla pozostałych strona operatora
robi suchy przebieg (odczyt archiwum, bez zapisów i alarmów) i mówi
przed kliknięciem, czy projekcja przejdzie kontrolę bazy.

#### Przegląd pliku (I5R)

Plik ma oznaczenie FaktWay, ale nie wygląda na plik z generatora. Klient usłyszał
„damy znać” i nie ma przycisku. Zegar to 72 godziny od ostatniego udanego
sprawdzenia pliku (`checkedAt`); potem monitor wysyła alarm krytyczny `I5R-72h`.

1. **Sygnał.** Alarm Sentry „KSeF: plik z oznaczeniem FaktWay do przeglądu
   operatora” (`ksef-duplicate-provenance-review`, jeden na fakturę), wiersz I5R
   w `/admin/ksef` albo sekcja 10 (j) `kontrola-faktur-ksef.sh`.
2. **Karta `/admin/ksef/<id>`, sekcja „Zapis oryginału z oznaczeniem FaktWay”.** Rodzaj bramy,
   problemy z opisami, wersja reguł, podgląd (do 20 pozycji), oferta (`review-pair`
   albo `review-record`), blokada `provenance-review` i wynik suchego przebiegu:
   „da się zapisać” albo powód.
3. **Plik.** Archiwum `<firma>/ksef-import/<numer KSeF>.xml` albo ta sama
   faktura w Aplikacji Podatnika KSeF. Sprawdź problemy z tabeli reguł na
   prawdziwym pliku. Ustal z klientem, skąd jest ta faktura: ręczne wystawienie
   w Aplikacji Podatnika, inny program, stara wersja FaktWay, integracja.
4. **Czy plik da się zapisać.** Kody `currency`, `parse`, `kind`, `number`,
   `seller` i `no-lines` (w tabeli „nigdy”) wykluczają zapis na zawsze.
   Pozostałe wstrzymują zapis tylko wtedy, gdy projekcja nie przechodzi kontroli bazy
   (suma pozycji różna od nagłówka, stawka spoza czternastu kodów importu,
   kształt, nabywca B2C). Stawka FA(3) spoza FaktWay (`0 WDT`, `0 EX`, `22`, `7`,
   `4`, `3`) albo oznaczenia FP, TP, GTU, procedury nie blokują zapisu: K trafia
   do FaktWay jak z Magicznego importu, ale JPK za ten miesiąc zostaje
   wstrzymany z komunikatem nazywającym fakturę. Powiedz to klientowi, zanim
   zapiszesz (tekst `reviewRecordHint` jest na karcie). To samo dotyczy korekt:
   FaktWay nie wystawi korekty faktury z pozycją `zw` (do czasu C3), ze stawką
   spoza FaktWay ani bez ceny netto pozycji (ceny brutto, brak P_9A). Powiedz
   klientowi, że korektę uzgadnia przez pomoc FaktWay (D-A4-1b-3-KORZW).
5. **Rozmowa z klientem, potem jedno z dwóch:**
   - **„Zapisz fakturę z KSeF w FaktWay”.** Notatka co najmniej 10 znaków: kanał,
     data, osoba. Notatka trafia do zapisu decyzji przy fakturze (10 lat, firma
     ma do niego dostęp), więc bez uwag wewnętrznych. Wybory jak oferta:
     `review-pair` dwa (ta sama sprzedaż, inna sprzedaż), `review-record` tylko
     „ta sama sprzedaż”. Potwierdzenie „Rozumiem skutki” zaznacz tylko wtedy,
     gdy klient potwierdził je wprost. Skutek: jak w „Skutek zapisu oryginału”.
     Po zapisie poinformuj klienta sam (kanałem z notatki); zapis operatora nie
     wysyła e-maila.
   - **„Oddaj decyzję klientowi (plik nie z FaktWay)”**, tylko przy
     `review-pair`. Notatka: co sprawdziłeś w pliku i dlaczego to nie plik z
     FaktWay. Skutek: oferta `released`, blokada znika (I5D), klient dostaje e-mail
     `NOTICE_BODY_RELEASED` (sprawdziliśmy, zdecyduj) sam, a decyzja idzie jak w PR B (bez zapisu K).
     Przy `review-record` oddanie jest niedostępne: plik jest w historii tego
     dokumentu albo ma tę samą treść, czyli to dowód, że jest nasz. Wyjście: zapis
     albo Bartosz. Jeśli e-mail nie wyszedł (`releaseSentNoEmail`), użyj
     „Przypomnij klientowi”. Komunikat „nie zapisaliśmy śladu w audit_logs” znaczy,
     że e-mail wyszedł: „Przypomnij klientowi” użyj dopiero, gdy klient potwierdzi,
     że go nie dostał (przypomnienie ma inny klucz i wyśle drugi).
6. **Powtórzenie i wyścigi.** Oba przyciski są idempotentne. Drugie oddanie to
   `already_released` z tym samym `release_at`; ponowienie e-maila po zgubionej
   odpowiedzi idzie z tym samym kluczem. Zapis po cudzym zapisie to
   `already_decided`, inna decyzja daje „jest już zapisana”.
7. **Zegar 72 h.** „Tylko uzgodnij”, które pobierze plik, zapisuje nowe `checkedAt`
   i zaczyna 72 godziny od nowa. To świadome: nowa ocena pliku to nowy przegląd.
   Nie używaj go do wyciszenia alarmu. Oddanie przeżywa ponowne sprawdzenie
   tylko wtedy, gdy plik jest ten sam (ten sam SHA-256 i środowisko), a nowa
   ocena nadal jest `review` z tymi samymi problemami; inaczej oddanie przepada, a
   nowa ocena decyduje: przegląd (I5R) albo przyciski klienta.
8. „Przypomnij klientowi” przy `provenance-review` i `recheck-needed` odmawia
   (nic by nie dało).

#### Oryginał w innej firmie (`cross-tenant`)

Blokada ma dwa źródła: numer KSeF oryginału ma faktura sprzedaży innej firmy
albo numer dokumentu X ma wysłana kiedyś faktura sprzedaży innej firmy z tym
samym NIP. Typowo to dwa konta tego samego przedsiębiorcy (NIP nie jest już
unikalny w `tenants`). Rzadziej: dwie firmy z jednym NIP na TEST i PROD z tą
samą numeracją (IDX-ENV), czyli fałszywy alarm.

1. Nie zapisuj decyzji i nie próbuj obejść blokady. Klient dostał tekst
   „wyjaśniamy to i damy znać”, a faktura jest w I5 (nie w I5D).
2. Ustal, która firma jest zapisem K: kto wysłał fakturę do KSeF i czyj token
   ją przyjął. Zapytanie pomocnicze, tylko odczyt, dla sesji lokalnej z
   `.agents/infra.env` (to nie jest komenda dla Bartosza: ile faktur ma blokadę
   `cross-tenant`, pokazuje sekcja 10 (b) `kontrola-faktur-ksef.sh`):
   ```sql
   SELECT tenant_id, id, internal_number, ksef_status, origin
     FROM invoices WHERE ksef_number = '<numer KSeF oryginału>';
   ```
   Dla drugiej gałęzi (numer X) szukaj faktur sprzedaży o tym `internal_number` u
   firm z tym samym NIP, które mają wpis w `ksef_submissions`.
3. **Decyduje Bartosz.** Naprawa jest ręczna, rolą serwisową, osobno dla każdego
   przypadku i tylko za jego zgodą. Przycisku w panelu nie ma.
4. Po rozstrzygnięciu „Tylko uzgodnij”: werdykt liczy blokadę od nowa i faktura
   wraca do `known-number`, `pair`, `record` albo zostaje zablokowana.
5. Napisz do klienta. Tekst obiecał „damy znać”, więc cisza jest błędem.

#### Zapis oryginału odmówiony

Kilka różnych sytuacji, każda ma jednego właściciela.

- **`notBuildable` w przeglądzie** („Nie da się zapisać tej faktury w FaktWay z
  pliku z KSeF (…)”). Dotyczy ofert `review-*`. Przy `review-pair`: oddaj decyzję
  klientowi. Przy `review-record`: zgłoś Bartoszowi (oddanie jest zablokowane,
  bo plik jest nasz, a zapis niemożliwy); Bartosz decyduje, czy poprawia
  program, czy zapisuje fakturę ręcznie.
- **`notBuildableProgram`** (oferta `pair` albo `record`, czyli brama mówiła
  „importable”, a przebieg próbny nie zbudował projekcji). To błąd programu.
  Faktura jest już oznaczona do ponownego sprawdzenia, alarm Sentry
  `ksef-duplicate-recheck` z tagiem `detail = not-buildable:<kod>`. Zgłoś
  Bartoszowi z numerem faktury i kodem z tagu `detail`.
- **`import-mismatch` (P0001) albo 22023 `import-projection` z bazy** (teksty
  `importMismatch` i `importProgram`). Baza odrzuciła projekcję, którą przepuściło
  lustro w TS: rozjazd lustra kontroli zapisu albo zmiana danych firmy między
  odczytem a zapisem. Nie zapisuj decyzji. Alarm Sentry
  `ksef-duplicate-import-refused` z tagiem `detail`. **Bartosz.**
- **Ustalenie z recenzji (finding 9).** Odmowa bazy przy zapisie w ofercie
  przeglądu (`review-pair`, `review-record`) też oznacza fakturę do ponownego
  sprawdzenia (`recheckNeeded`). Skutek: faktura przechodzi z I5R do I5 (alarmuje
  jak każde I5, `I5R-72h` jej już nie liczy), a zegar 72 h I5R startuje od nowa
  dopiero po nowym werdykcie crona. Wyjście istnieje (cron, „Tylko uzgodnij”).
  Odmowa bazy to jednak rozjazd lustra, więc zgłoś ją Bartoszowi od razu, nie
  czekaj na cron.
- **Archiwum** (`archive-missing`, `archive-mismatch`). Brak pliku pod kluczem
  `<firma>/ksef-import/<numer KSeF>.xml` albo inny SHA-256 lub rozmiar niż w
  `original_check`. Faktura jest oznaczona do ponownego sprawdzenia; runner
  zapisze plik, gdy go brak. W przeglądzie (`review-*`) to też zdejmuje fakturę z
  I5R do I5, a zegar 72 h liczy się od nowego werdyktu. Inny plik pod tym
  kluczem to `archive-conflict`: porównaj oba pliki, zanim cokolwiek
  zdecydujesz, i zgłoś Bartoszowi. Błąd
  odczytu magazynu (`read-failed`) to stan chwilowy: nic nie jest oznaczone,
  spróbuj za chwilę, a jeśli wraca, zgłoś.
- **`gate-drift`.** Bieżący kod ocenia plik inaczej niż zapisana ocena. Nic do
  zrobienia: nowy werdykt zapisze nową ocenę.
- **Wynik `stale` albo `not-pending` z `flag_ksef_original_recheck`.** Stan zmienił
  się od otwarcia karty, nic nie zostało oznaczone, klient i operator dostają tekst
  „odśwież”. Odśwież kartę.
- **`releaseFailed`** (XX000 po oddaniu, alarm `ksef-duplicate-release-failed`).
  Oddanie wycofało się w całości. Nic nie zapisano. **Bartosz** (błąd programu).

#### Do ponownego sprawdzenia (`recheck-needed`)

Znacznik ma blokadę `recheck-needed`, faktura jest w I5. Klient widzi tekst
`recheck-needed` (sprawdzamy jeszcze raz).
`original_check.recheckNeeded.kind` mówi, dlaczego:

| `kind` | Znaczenie |
|---|---|
| `archive-missing` | w archiwum nie ma pliku oryginału |
| `archive-mismatch` | w archiwum jest plik o innym SHA-256 lub rozmiarze |
| `gate-drift` | bieżący kod ocenia plik inaczej niż zapisana ocena |
| `import-mismatch` | numer dokumentu albo NIP sprzedawcy nie zgadza się z plikiem: wykryło to lustro w TS przy zapisie albo baza (P0001); nowy werdykt oceni je od nowa (reguły `number` i `seller`) |
| `not-buildable` | przebieg próbny nie zbudował projekcji mimo oceny „importable” |
| `import-projection` | baza odrzuciła projekcję (22023) |

Brak klucza `recheckNeeded` przy blokadzie `recheck-needed` znaczy: znacznik nie
ma poprawnej bramy (sprzed 00156 albo zły kształt).

- Cron `ksef-lifecycle-reconcile` robi „Tylko uzgodnij” po 48 godzinach od próby
  (najwyżej raz na dobę, trzy razy w tygodniu). Runner zapisuje znacznik od nowa
  (bez `recheckNeeded`), a faktura wraca do `pair`, `record` albo przeglądu (I5R).
- Operator może od razu: `/admin/ksef/<id>` → „Tylko uzgodnij”.
- Nieudane pobranie przy ponownym sprawdzeniu (`recheck`) zostawia klucz
  `recheckNeeded`: cron spróbuje następnego dnia.
- Po trzech próbach w tygodniu cron przestaje (`i5NeedsOperator`, zbiorczy alarm
  Sentry „faktury czekają na operatora”). Wtedy: sprawdź archiwum pliku
  (czy jest pod kluczem z tabeli wyżej), alarm Sentry `ksef-duplicate-recheck`
  (rodzaj znacznika jest w tagu `detail`) oraz historię wysyłek na karcie. `not-buildable` przy
  ocenie „importable” to błąd programu: Bartosz.
- Jeśli zapis `recheckNeeded` nie wyszedł (błąd bazy), alarm
  `ksef-duplicate-recheck-flag` jest jedynym śladem. Zrób „Tylko uzgodnij”
  ręcznie.

#### Podbicie wersji reguł bramy

`ORIGINAL_GATE_RULES` (`lib/ksef/duplicate-check.ts`, dziś 1) jest informacyjne.
Zmiana wersji sama nic nie blokuje: liczy się inny `kind` lub inne `problems`.

1. Po podbiciu sprawdź sekcję 10 (i) `kontrola-faktur-ksef.sh` (wersja × rodzaj).
2. `review` z niższą wersją przejrzyj: „Tylko uzgodnij” pobierze plik i oceni go
   nowymi regułami, więc może zmienić go w `importable` (klient dostanie wtedy
   przyciski). Oddanie zostaje tylko wtedy, gdy ocena `review` ma te same
   problemy (inaczej oddanie przepada, a nowa ocena decyduje: przegląd (I5R) albo
   przyciski klienta).
3. `importable` z niższą wersją niczego nie wymaga. Jeśli nowe reguły oceniłyby go
   inaczej, klient przy zapisie dostanie tekst „sprawdzimy jeszcze raz”
   (`gate-drift`), a faktura zostanie oznaczona do ponownego sprawdzenia.

#### Brak daty nadania (I3K `no_date`)

Data nadania numeru KSeF to `ksef_accepted_at` na K. Zapis oryginału bierze ją z
`original_check.acquiredAt` i nigdy nie wstawia `now()`. Gdy runner jej nie zdobył,
K ma `ksef_accepted_at IS NULL`, strażnik pokazuje I3K (`no_date`: true), a Sentry
dostaje `ksef-duplicate-import-no-date` (z `importedInvoiceId`).

1. Weź datę i godzinę nadania numeru ze szczegółów faktury w Aplikacji Podatnika
   KSeF. Podaj ją jako pełny czas ISO 8601 ze strefą, np. `2026-10-08T12:34:56Z`
   albo `2026-10-08T14:34:56+02:00`.
2. Podgląd (niczego nie zmienia):
   `./scripts/ops/oryginal-ksef-data-nadania.sh <id faktury K> <czas z KSeF>`.
   `id faktury K` to faktura zapisana z KSeF (nie wycofany dokument): w alarmie
   `importedInvoiceId`, w sekcji 10 (l) pierwsza kolumna. Wypisze werdykt `TAK`
   albo `NIE` z powodem. Ostrzeżenie `UWAGA`, gdy data w numerze KSeF różni się od
   podanej o więcej niż dobę: sprawdź datę jeszcze raz.
3. Zapis: ta sama komenda z `--wykonaj`. Jedna transakcja: `UPDATE invoices SET
   ksef_accepted_at` na dokładnie jednym wierszu (K `accepted`, z
   `fa3_data.import.source = 'ksef_duplicate_decision'`, `origin = 'ksef_import'`,
   sprzedaż, na którą wskazuje `decision.importedInvoiceId`, czyli ta K, którą
   pokazuje I3K; bez daty) i wpis `audit_logs`
   `invoice.ksef_accepted_at_backfilled`; inaczej ROLLBACK. Zły zapis czasu (np.
   brak strefy) skrypt odrzuca od razu; 30 lutego, czas z przyszłości i faktura z
   datą kończą się werdyktem `NIE`. Raz zapisanej daty tym skryptem się nie
   zmienia (zmiana tylko rolą serwisową, za zgodą Bartosza).
4. Po zapisie I3K `no_date` znika od razu: strażnik liczy na bieżąco
   (`/admin/ksef`, sekcja 10 (l) `kontrola-faktur-ksef.sh`). Jeśli I3K zostaje, to
   brak sesji UPO (następny punkt).

#### UPO faktury zapisanej z KSeF

W tej samej transakcji K dostaje wiersz `upo_receipts`. Przy znanej sesji
oryginału jest `pending`, a `upo-retry-stale` po 24 godzinach pobierze UPO.
Bez sesji jest `failed` z tekstem zaczynającym się od „Brak numeru sesji KSeF dla
tej faktury” i alarm Sentry `ksef-duplicate-import-no-session`; I3K (`no_session`) zostaje.

1. UPO pobierz ręcznie z Aplikacji Podatnika KSeF i przekaż klientowi kanałem z
   notatki. Zapisz w skrzynce pomocy, że klient je ma.
2. Skryptu, który wgrywa takie UPO do magazynu i do `upo_receipts`, jeszcze nie ma
   (D-A4-1b-3-UPO). Do tego czasu I3K `no_session` zostaje w raporcie i nie alarmuje
   (monitor jej nie liczy), a K nie trafia do I3.
3. Uwaga operacyjna: `upo-retry-stale` ponawia co godzinę każdy wiersz `failed`
   bez sesji i nie ma limitu prób, a bierze najwyżej 50 najstarszych na przebieg.
   Przy 50 i więcej takich wierszach nowsze `pending` czekają w nieskończoność.
   Policz je w sekcji 5 `kontrola-faktur-ksef.sh` (wiersz „Brak numeru sesji KSeF
   dla tej faktury…”, kod `NO_SESSION_REFERENCE`).

#### Wpłata na dokumencie przy 440

Wpłata (`paid_amount` różne od 0 albo wiersz `payments`) blokuje każdą decyzję,
także zapis operatora w przeglądzie (blokada `payments` stoi przed
`provenance-review`). To wyjście z blokady (reguła 4 protokołu napraw w
`AGENTS.md`) jest ręczne. Usunięcie wiersza `payments` to `DELETE FROM`, więc
wymaga zgody Bartosza, osobno dla każdego przypadku:

1. Ustal z klientem, przy której fakturze wpłata ma być. Po zapisie K właściwa
   jest faktura K z KSeF (karta K mówi, że wpłaty zapisuje się przy niej).
2. Zapisz w skrzynce pomocy dane wpłaty (kwota, data, metoda).
3. Rolą serwisową usuń wpłatę z dokumentu X (wiersz `payments` i `paid_amount`
   na zero).
4. Decyzja (klient albo operator na prośbę klienta).
5. Klient zapisuje wpłatę przy fakturze K.

Przy `faktflow-original` panel klienta czyta blokadę z bazy, więc wiersz
`payments` daje od razu odmowę `payments` (z numerem dokumentu), przed wywołaniem
RPC. Faktura z wpłatą jest w I5 (nie w I5R ani I5D). Przy powodach PR B panel
widzi tylko `paid_amount`: wiersz `payments`, którego `paid_amount` nie liczy,
kończy się odmową bazy z numerem dokumentu i ostrzeżeniem Sentry „RPC odmówiło
mimo zgody polityki”. Takie ostrzeżenie dotyczy powodów PR B. Nie ma blokady
wpłaty na szkic wycofany (D-A4-1b-3-PAY).

#### Po zapisie: błędna decyzja, usunięcie, korekty

- **Błędna decyzja.** K jest w KSeF i obowiązuje, więc zostaje. Baner na dokumencie
  X mówi klientowi, co zrobić: gdy „ta sama sprzedaż” była pomyłką, sprzedaż z
  dokumentu X wystawia się jako nową fakturę z nowym numerem; gdy „inna
  sprzedaż” była pomyłką, są dwie faktury tej samej sprzedaży, a wystawioną
  ponownie trzeba skorygować do zera. Inna decyzja po zapisie to
  „jest już zapisana”. Zmiana `original_check.decision` i
  `K.fa3_data.import.decision`: tylko za zgodą Bartosza.
- **Usunięcie albo nadanie numeru dokumentowi X.** Klient nie może (wyzwalacze
  `c_guard_ksef_retired_draft*` mają teksty `*_IMPORTED`). Rola serwisowa może, za
  zgodą Bartosza. Usunięcie X kasuje znacznik z decyzją (kaskada); dowód zostaje
  na K w `fa3_data.import.decision`, ale spójność (zapytanie (n)) przestaje go
  widzieć.
- **PDF i e-mail wycofanego dokumentu bez numeru** odmawiają tekstem, który
  nazywa dokument i wskazuje PDF faktury K. PDF faktury K działa jak każdej.
- **Korekta K.** Idzie zwykłą ścieżką. Na produkcyjnym KSeF korekty są wstrzymane
  (`KOR_HOLD`, C7), a dialogi mówią klientowi „napisz do nas”. Korekty faktury dla
  nabywcy bez NIP i bez numeru VAT-UE (PESEL, inny numer, brak identyfikatora)
  FaktWay jeszcze nie wystawia, także dla K z tej decyzji (D-A4-1b-3-KORB2C): klient
  dostaje zdanie z adresem pomoc@faktway.pl, sprawa do Bartosza. Tak samo korekty
  faktury z pozycją `zw` (do czasu C3), ze stawką FA(3) spoza FaktWay (`0 WDT`, `0 EX`,
  `22`, `7`, `4`, `3`) albo z pozycją bez ceny netto (ceny brutto, brak P_9A): panel,
  dialogi i baner po zapisie mają zdanie `CORRECTION_RATE` (D-A4-1b-3-KORZW), liczone
  z podglądu pliku na znaczniku. Przy więcej niż 20 pozycjach zdanie dochodzi tylko
  wtedy, gdy ocena pliku ma problem `rates`, `gross-prices` albo `line-fields`;
  pozycja `zw` poza pierwszymi 20 nie jest wykrywalna. Gdy klient napisze o takiej
  korekcie: sprawa do Bartosza, nie obiecuj terminu.
- **Płatności.** K ma `origin = 'ksef_import'`, więc przypomnienia o płatności jej
  nie obejmują (karta mówi to klientowi).

#### Alarmy Sentry

`level: warning`, `tags.area = 'ksef.duplicate-decision'`, odcisk
`[kind, invoiceId]` (jedno zgłoszenie na fakturę). Strony klienta i operatora
(w tym suchy przebieg) alarmów nie wysyłają.

| `tags.kind` | Kiedy | Kto reaguje |
|---|---|---|
| `ksef-duplicate-provenance-review` | runner: brama `review` | operator, przegląd pliku; po 72 h `I5R-72h` |
| `ksef-duplicate-recheck` | akcja: archiwum, zmiana bramy, `not-buildable` przy `importable` (razem z `recheckNeeded`) | nikt; cron I5; po trzech próbach w tygodniu operator; `not-buildable` przy `importable`: Bartosz |
| `ksef-duplicate-recheck-flag` | akcja: zapis `recheckNeeded` nieudany | operator: „Tylko uzgodnij” ręcznie |
| `ksef-duplicate-import-refused` | akcja: baza odmówiła projekcji (lustro w TS przepuściło) | Bartosz |
| `ksef-duplicate-release-failed` | akcja operatora: oddanie wycofane (XX000) | Bartosz |
| `ksef-duplicate-import-no-date` | po decyzji: K bez daty nadania | operator: skrypt daty |
| `ksef-duplicate-import-no-session` | po decyzji: K bez sesji | operator: UPO ręcznie |

Monitor: `I5R-72h` (krytyczny) po 72 h od `checkedAt`, od razu przy braku albo
nieczytelnej dacie; I3K nie alarmuje (jest w raporcie dziennym i w KPI), alarm z
akcji wystarcza; I5 `recheck-needed` alarmuje jak każde I5.

#### Zapisane osobno (nie naprawiane w PR C)

- **D-A4-1b-3-MI.** Szkic wycofany Z numerem (PR B, automat „numer zajęty”,
  oferta `released`) blokuje Magiczny import oryginału K („konflikt numeru … w
  bazie”) i oznacza zadanie importu „Import wymaga uzgodnienia”.
- **D-A4-1b-3-UPO.** Brak skryptu ręcznego UPO i limitu ponowień dla `failed` bez
  sesji (punkt „UPO faktury zapisanej z KSeF”).
- **D-A4-1b-3-SYS.** `SystemInfo` `KSeF SaaS v1.0` jest ogólne i nadpisywalne, a to
  jedyna podstawa powodu `faktflow-original`. Zmiana wartości przed KSeF PROD to
  osobna decyzja: runner rozpoznaje dziś tylko `KSeF SaaS v1.0`, a baza (00156)
  i jej lustro w TS także `FaktFlow <cyfra>`. Wartość `FaktWay <wersja>` wymaga
  nowej migracji (`CREATE OR REPLACE ksef_duplicate_check_allows`) i zmiany
  rozpoznawania w `duplicate-verdict.ts` i `duplicate-decision.ts`.
- **D-A4-1b-3-DATE.** Werdykt bez daty nadania nie alarmuje w runnerze; alarm idzie
  dopiero po zapisie K.
- **D-A4-1b-3-PDF.** PDF zwykłego szkicu nie ma oznaczenia „nie jest fakturą”.
- **D-A4-1b-3-PAY.** Brak blokady wpłaty na szkic wycofany (równoległy INSERT).
- **D-A4-1b-3-CAT.** Komunikat katalogu `KSEF_DUPLICATE_RECONCILE` („Zajmujemy się
  tym i damy znać”) przeczy „zdecyduj na karcie” przy `pair`.
- **D-A4-1b-3-LIST.** Lista faktur pokazuje X po zapisie K jako „(bez numeru)”.
- **D-A4-1b-3-EVID.** Decyzje PR B (`retire`) mają aktora i notatkę tylko w
  `audit_logs` (12 miesięcy).
- **D-A4-1b-3-XEDIT.** Treść szkicu wycofanego da się zmienić surowym PATCH z sesji
  klienta; kopia treści X jest w decyzji na znaczniku.
- **D-A4-1b-3-KORB2C.** Brak korekty dla nabywcy bez NIP i VAT-UE.
- **D-A4-1b-3-KORZW.** Brak korekty K z pozycją `zw`, ze stawką FA(3) spoza FaktWay
  (`0 WDT`, `0 EX`, `22`, `7`, `4`, `3`) albo z pozycją bez ceny netto
  (`unit_price_net` NULL: ceny brutto, brak P_9A). Klik „Korekta” kończy się odmową
  `vatRateFromDbForCorrectionLine` / `fetchParentInvoiceLines` bez nazwy dokumentu i
  kontaktu. W PR C klient widzi zdanie `CORRECTION_RATE` (jak `CORRECTION_PERSON`), a
  operator ostrzeżenie w `reviewRecordHint`. Pełne wyjście: C3 w planie dla `zw`
  (także dla K zapisanej przez PR C); K z przeglądu operatora ze stawką FA(3) albo
  z NULL ceny netto zostaje otwarte po C3. Osobno: komunikaty odmowy w
  `correction-actions.ts` nie mają kontaktu (wyjście dla każdej niekorygowalnej faktury).
- **D-A4-1b-3-FLO-NUM.** Audyt numeracji FLO liczy tylko `origin = 'app'`, więc po
  zapisie K zgłosi fałszywą lukę (naprawić przed wdrożeniem FLO).
- **D-A4-1b-3-TESTENV.** KSeF TEST jest wspólny: plik z oznaczeniem z innej instancji
  (dev, CI z tym samym fikcyjnym NIP) przejdzie bramę i zostanie zapisany.
- **GEN-PESEL-KRAJ, C5b-d+, IDX-ENV.** Generator pisze przy PESEL `KodKraju` z adresu
  nabywcy; import gubi telefon i GLN sprzedawcy, nazwę banku, GTIN, CN i PKWiU;
  indeks numeru jest per firma, nie per środowisko.
- **Reguła `totals` jest ścisła co do grosza** (nie ±0,01 jak w pierwotnej
  specyfikacji): kontrola zapisu wymaga równości, a plik „importable”, którego nie
  da się zapisać, krążyłby w ponownym sprawdzaniu bez wyjścia.

#### Wycofanie 00156

Decyzja Bartosza. **Najpierw** zapisz wynik `SELECT * FROM
ksef_lifecycle_violations() WHERE invariant = 'I3K'` (faktury z KSeF bez sesji UPO
albo daty; po wycofaniu nic ich nie pokaże) i wynik `SELECT count(*) FROM
ksef_submissions WHERE original_check->'decision' ? 'importedInvoiceId'`. Potem
wdróż kod bez PR C (worker id=2, potem aplikacja id=1): kod PR C woła funkcje,
które wycofanie usuwa (strona faktury `ksef_duplicate_decision_blocker_for_session`,
akcje `decide_ksef_duplicate_original`, `release_ksef_original_review` i
`flag_ksef_original_recheck`). Dopiero po tym SQL wycofania: w jednej transakcji
`CREATE OR REPLACE` ciałami z poprzednich migracji:
`decide_ksef_duplicate` z 00151, `ksef_lifecycle_violations` z 00155,
`ksef_duplicate_check_allows` i `ksef_duplicate_decision_blocker` z 00148, i
dopiero po nich `DROP FUNCTION` nowych funkcji (lista w nagłówku
`00156_ksef_duplicate_original.sql`). Kolejność ma znaczenie: ciała SQL nie mają
zależności w katalogu, więc `DROP` przeszedłby także przed nimi i zostawił opakowanie
bez `ksef_duplicate_decide_core`. `guard_ksef_retired_draft` zostaje z 00156 (decyzja
Bartosza): ciało z 00151 pokazałoby przy szkicu bez numeru fałszywy tekst „zajmuje
numer, który w KSeF ma już…”. Cofnąć ją można tylko wtedy, gdy zapytanie o
`importedInvoiceId` dało 0. Faktury zapisane z KSeF zostają (są poprawnym zapisem
wystawionych faktur), szkice wycofane bez numeru zostają bez numeru. Po SQL
`NOTIFY pgrst, 'reload schema'`. Nigdy nie odtwarzaj pliku 00149.

#### „Sprawdź ponownie” (D-A4-1b-3 PR D, bez migracji)

Klient (właściciel albo administrator) widzi na karcie faktury w
`failed / KSEF_DUPLICATE_RECONCILE` przycisk „Sprawdź ponownie”, gdy FaktWay nie ma jeszcze danych
oryginału z KSeF. Przycisk nie czeka na cron I5 (48 godzin) ani na operatora.

| Powód na znaczniku | Co widzi klient |
|---|---|
| brak zapisu sprawdzenia (`no-check`, znacznik sprzed 00144) | numer KSeF, „numer nadany {dzień}” (z `acquiredAt` albo z numeru KSeF), przycisk, „Nie wystawiaj tej faktury ponownie.” |
| `download-refused` | to samo; przy kodzie 403 dodatkowo: dane logowania KSeF w FaktWay (certyfikat) nie mają uprawnienia do odczytu faktur (`InvoiceRead`); sprawdź uprawnienia w Aplikacji Podatnika KSeF albo podłącz KSeF ponownie w Ustawieniach → KSeF, potem „Sprawdź ponownie” (klient nie ma tokenu do nadania uprawnienia) |
| `download-pending`, `storage-pending`, `archive-pending` | to samo bez wskazówki o `InvoiceRead` |
| `original_check.env` ≠ `KSEF_ENV` | „Dane oryginału pochodzą z innego środowiska KSeF…” i przycisk, bez zdania o automatycznym sprawdzeniu: powód decyzyjny (`no-own-file`, `known-number`, `faktflow-original`) z innego środowiska to I5D (blokada SQL nie patrzy na środowisko), a cron I5 ponawia tylko I5; alarm I5D liczy takie wiersze |

Nie dotyczy powodów z panelem decyzji (`no-own-file`, `known-number`, `faktflow-original` z oceną pliku)
ani deterministycznych (`same-content-other-program`, `archive-conflict`).

- **Co robi.** Akcja `recheckKsefDuplicateAction` wymaga roli właściciela albo administratora, otwartego wpisu
  `sent`/`intent` ze znacznikiem oryginału i tych samych faktów co „Tylko uzgodnij” operatora (kopia danych
  zdarzenia, rodzaj niewstrzymany, znane `KSEF_ENV`; wspólny rdzeń `reconcileOnlyBlocker` w
  `lib/ksef/duplicate-recheck.ts`). Kolejkuje `requeue_ksef_send(p_reconcile_only = true)` i zdarzenie
  z `reconcileOnly: true` w jednej transakcji pg-boss. Runner w tym trybie nigdy nie wysyła: pobiera oryginał
  jeszcze raz i wydaje nowy werdykt (panel decyzji, zapis K, albo ponownie brak danych).
- **Cooldown.** 10 minut od ostatniego wpisu audytu `invoice.duplicate_recheck` tej faktury (metadane:
  `reason`, `originalKsefNumber`, `sendAttemptId`). Klient dostaje zdanie z numerem dokumentu i minutami
  do końca; widok niesie czas względny (`cooldownMsLeft`), a karta sama odświeża się sekundę po jego końcu,
  więc przycisk wraca bez ręcznego odświeżania strony. Status `queued`/`sending`: „Sprawdzamy ponownie w KSeF… odśwież stronę za kilka minut”.
- **Hamulce.** Wyłącznik wysyłek (`killAllKsefSubmissions`), niemożność jego odczytu, brak certyfikatu KSeF
  i nieznane środowisko aplikacji (`KSEF_ENV`; `RECHECK.ENV_UNKNOWN`) zwracają zdania o sprawdzaniu (nie o wysyłce) z numerem dokumentu; faktura zostaje `failed`. W tym trybie
  nie działa Offline24 (wysyłałby fakturę).
- **Co widzi operator.** Wpis `invoice.send_requeued` z `reconcile_only = true` i aktorem = klient (RPC),
  `invoice.submit_requested` z `send = requeue` oraz `invoice.duplicate_recheck`. Karta `/admin/ksef/[id]`
  pokazuje nowy `original_check` po przebiegu. Cron I5 liczy swoje próby tylko z aktorem NULL, więc klikanie
  klienta nie zjada jego limitu.
- **Podwójne kliknięcie i ponowienie joba.** Zlecenie ma `singletonKey = faktura`, a `failed → queued` przechodzi
  raz; drugie kliknięcie widzi `queued`. Ponowienie joba tylko pyta KSeF o ten sam numer.
- **Zapytanie kontrolne.** `SELECT created_at, user_id, entity_id, metadata FROM audit_logs WHERE action =
  'invoice.duplicate_recheck' ORDER BY created_at DESC LIMIT 20;` Powtarzające się wpisy jednej faktury co 10 minut
  oznaczają, że werdykt wciąż nie zapada (np. 403 bez nadanego uprawnienia): sprawdź `original_check.reason`
  i `httpStatus` na karcie operatora.
- **Poza zakresem (zapisane).** 440 bez numeru oryginału (brak znacznika z `original_ksef_number`): karta nie
  ma wtedy panelu, więc przycisku też nie; wyjście to „Tylko uzgodnij” operatora i I5.

#### Zapytania kontrolne

`./scripts/ops/kontrola-faktur-ksef.sh`, sekcja 10, zapytania (h) do (p). Po
wdrożeniu PR C oczekiwane:

| Zapytanie | Oczekiwane |
|---|---|
| (h) oferta × blokada | każde `review-*` z poprawną bramą ma blokadę `provenance-review`, chyba że stoi przed nią `recheck-needed`, `payments`, `known-now` albo `cross-tenant`; wiersze `recheck-needed` mają znaną przyczynę (`recheckNeeded.kind` albo brak bramy sprzed 00156) i znikają po nowym werdykcie crona |
| (i) wersje reguł × rodzaj | jedna wersja, równa `ORIGINAL_GATE_RULES`; po podbiciu patrz „Podbicie wersji reguł bramy” |
| (j) I5R z wiekiem | brak wiersza ze stanem `ALARM I5R-72h` |
| (k) faktury z decyzji × UPO | `bez_daty = t` do uzupełnienia skryptem daty; `bez_sesji = t` do ręcznego UPO |
| (l) I3K | puste albo znane przypadki (UPO ręcznie, skrypt daty) |
| (m) szkice wycofane bez numeru | każdy ma fakturę K |
| (n) spójność | `niespójnych = 0`; inaczej (n2) pokazuje wiersze, zgłoś Bartoszowi |
| (o) decyzje wg trybu | `import` dla ofert `pair`, `record` i `review-*`; `no-import` tylko dla `released` (po oddaniu) |
| (p) oddania bez decyzji | puste albo świeże (klient ma e-mail) |

Po wdrożeniu sprawdź też: brak nowych I3, w logu workera „29/29 cronów” bez zmian,
sekcja 10 (b) bez kodów, których nie znasz.

## Najczęstsze kody — co znaczą, co robić

### Authentication / Authorization (21100-21199)

| Kod | Znaczenie | Klasa | Akcja |
|---|---|---|---|
| 21100 | Invalid signature / nieprawidłowy podpis | AUTH | Sprawdź `KSEF_CREDENTIALS_ENCRYPTION_KEY`, rotated? |
| 21101 | Token expired | AUTH | `lib/ksef/auth.ts` auto-refresh; jeśli pętla — bug |
| 21102 | Invalid token format | AUTH | Patrz `ksef_sessions` — zła kolumna? |
| 21103 | Unauthorized access | AUTH | Tenant nie ma uprawnień KSeF dla tego NIP |
| 21105 | Subject context required | AUTH | Brakuje context `tenant_nip` w request — bug |

### Submit / Validation (21200-21299)

| Kod | Znaczenie | Klasa | Akcja |
|---|---|---|---|
| 21200 | Invalid XML format | CLIENT_INPUT | Sprawdź `lib/xml/validator.ts` — walidacja XSD lokalna powinna złapać |
| 21202 | Schema validation failed | CLIENT_INPUT | XSD niezgodny — sprawdź wersję FA(3) |
| 21270 | Duplicate invoice number | CLIENT_INPUT | User próbuje wystawić tę samą fakturę 2× (unikalny `internal_number`) |
| 21280 | Invalid invoice type | CLIENT_INPUT | Generator XML wybrał zły szablon (advance/correction/final) |

### Status / UPO (21300-21399)

| Kod | Znaczenie | Klasa | Akcja |
|---|---|---|---|
| 21301 | Invoice not found | CLIENT_INPUT | Race condition — pytamy o status faktury, której KSeF jeszcze nie przetworzył |
| 21320 | UPO not ready | (poll) | Normalne; cron `upoRetryStaleJob` próbuje co 24h |

### Infrastruktura KSeF (21900-21999)

| Kod | Znaczenie | Klasa | Akcja |
|---|---|---|---|
| 21900 | Service unavailable | KSEF_DOWN | Retry schedule; alert `#urgent` gdy > 1 h |
| 21950 | Planned maintenance | MAINTENANCE | Offline24 od razu; user dostaje QR |
| 21999 | Internal server error | KSEF_DOWN | Retry; reportuj do MF jeśli persistent |

---

## Procedura debugowania błędu KSeF

User zgłosił "moja faktura ma błąd" (`/invoices/[id]` pokazuje czerwoną banner).

### Krok 1 — Zlokalizuj invoice w DB

```sql
SELECT id, internal_number, ksef_status, ksef_error_code,
       ksef_error_message, created_at
FROM invoices
WHERE id = '<uuid z URL>'
   OR internal_number = '<numer>';
```

### Krok 2 — Sprawdź historię prób

```sql
SELECT attempt_number, status, error_code, error_message,
       request_payload, response_body, created_at
FROM ksef_submissions
WHERE invoice_id = '<uuid>'
ORDER BY created_at;
```

Pokazuje wszystkie próby: pierwsza, retry'e, finalna. Każda ma raw response
z KSeF (`response_body`).

### Krok 3 — Sprawdź czy KSeF w ogóle żył

```sql
SELECT checked_at, status, response_time_ms
FROM ksef_health_log
WHERE checked_at > now() - interval '1 hour'
ORDER BY checked_at DESC;
```

Jeśli health był OK ale faktura padła — błąd po naszej stronie (CLIENT_INPUT).
Jeśli health był DOWN — KSEF_DOWN, retry powinien już zadziałać.

### Krok 4 — Polskie tłumaczenie kodu

```sql
SELECT code, pl_message, action_hint
FROM error_translations
WHERE code = '<kod z ksef_submissions.error_code>';
```

`action_hint` to wskazówka dla user-a (np. "Sprawdź NIP nabywcy"). Jeśli brak
mapowania → dodać do `error_translations` (migracja).

### Krok 5 — Decyzja

| Wynik dochodzenia | Akcja |
|---|---|
| Bug walidacji po naszej stronie (np. zły XML) | Fix XML generator + retest na test env |
| Bad input user-a (zły NIP, duplikat) | Pokaż user-owi `action_hint`, "skoryguj i wystaw ponownie" |
| KSeF down — retry działał | Powiedz user-owi "spróbuj za chwilę", jutro powinno pójść |
| Po retries → Offline24 | User ma już QR; przypomnij że ma 24h na ręczne złożenie |

---

## Specjalne przypadki

### "Faktura w stanie processing" > 30 min

UPO normalnie przychodzi w sekundach do minut. > 30 min = albo KSeF zatkany,
albo job `downloadUpo` padł. Patrz:
```sql
SELECT * FROM upo_receipts WHERE invoice_id = '<uuid>';
SELECT * FROM inngest_run_log WHERE function_id = 'download-upo' ORDER BY created_at DESC LIMIT 10;
```

### "Wszystkie faktury z dziś mają błąd 21100"

Globalny problem auth → najprawdopodobniej rotated `KSEF_CREDENTIALS_ENCRYPTION_KEY`
bez re-encrypt sesji w `ksef_sessions`. Patrz [key-rotation.md](./key-rotation.md).

### "Faktura zaakceptowana, ale nie mam UPO"

UPO retry cron (`upoRetryStaleJob`) powinien dorzucić w ciągu 24h. Manual
trigger: `pnpm trigger:submit` (skrypt). Faktura zapisana z KSeF decyzją przy 440
(K, `origin = 'ksef_import'`) bez sesji oryginału: sekcja „UPO faktury zapisanej
z KSeF” w „D-A4-1b-3 PR C”.

### "W historii wysyłek wisi zamiar `intent`" (A2, 00136)

Wpis `intent` w `ksef_submissions` powstaje po otwarciu sesji KSeF, PRZED
wysłaniem pliku. Jeśli został otwarty, odpowiedź na wysyłkę nie dotarła
(timeout, restart workera, błąd zapisu) i nie wiadomo, czy KSeF ma plik.

- **Co widzi klient:** faktura `failed` z kodem z katalogu; „Wróć do szkicu”
  jest zablokowane (zamiar to dowód kontaktu — treści nie wolno zmienić,
  dopóki nie wiadomo, co ma KSeF).
- **Co robi automat:** każda następna próba wysyłki (przycisk „Wyślij
  ponownie”, cron ponowień) najpierw zamyka tamtą sesję i pyta KSeF o jej
  faktury (`GET /sessions/{ref}/invoices`): plik jest → wpis `sent`
  i uzgodnienie po numerze referencyjnym; sesja pusta → `abandoned`
  (`error_code = NOT_IN_SESSION`) i wysyłka od nowa. Nigdy drugi POST.
- **Co klika operator:** `/admin/ksef/<id>` → „Tylko uzgodnij” (działa przy
  `sent` i przy `intent`). Po rozstrzygnięciu faktura jest `accepted`, albo —
  gdy KSeF jej nie ma i nie zostaje żaden dowód kontaktu — `failed
  NOT_IN_KSEF` (A2b, 00141): klient i operator mogą „Wyślij ponownie” albo
  „Wróć do szkicu”. Gdy inny dowód kontaktu zostaje (np. wpis `duplicate`),
  wynik to `RESULT_UNCERTAIN` dla operatora.
- **`NOT_IN_KSEF`** (klasa transient, bez automatu): KSeF potwierdził, że
  nie ma faktury z poprzedniej wysyłki. Cron NIE wysyła jej sam — ponowna
  wysyłka po kilku dniach to decyzja o dacie wystawienia (B1/B2 planu).
  Klient widzi: „KSeF nie ma tej faktury — poprzednia wysyłka do niego nie
  dotarła. Wyślij ją ponownie albo wróć do szkicu.”
- **Strażnik:** zamiar (albo wpis `sent`) starszy niż 48 h przy fakturze
  poza `sending` to I5 — od 00148 bez faktur czekających na decyzję klienta
  (te są w I5D, bez automatu i bez alarmu; wyżej, D-A4-1b-3 PR B). KSeF
  odpowiadający na pytanie o sesję kodem 21173
  („Brak sesji”) po 48 h zamyka zamiar jako `abandoned` z kodem `STALE`.
- **Cron (A3):** przy I5 i fakturze `failed`/`rejected` cron cyklu życia sam
  zleca „Tylko uzgodnij” (aktor NULL w audycie, `reconcile_only = true`),
  najwyżej raz na dobę. Po trzech próbach w tygodniu przestaje
  (`i5NeedsOperator`) — wtedy operator: karta faktury, historia wysyłek
  i ślad audytu pokazują, co KSeF odpowiadał. I5 przy fakturze w innym
  stanie (np. `accepted` z niezamkniętym wpisem) cron nie uzgadnia
  (`i5Other`) — to sprawa dla operatora.
- **Która faktura (A5, luka #2):** te decyzje nie zmieniają wiersza faktury,
  więc w bazie nie ma po nich śladu — identyfikator jest tylko w logu
  workera i w Sentry. Lista z ostatnich 30 min (do 200 wpisów, najpierw
  WARN; pusta lista mówi też, czy ostatni przebieg w ogóle sprawdzał I5–I7):
  `./scripts/ops/kontrola-faktur-ksef.sh`, sekcja 9, „faktury bez akcji
  automatu”. Log ma ostrzeżenie z `invoiceId` w każdym przebiegu, który
  dochodzi do I5–I7 (przy włączonym albo nieczytelnym wyłączniku wysyłek
  cron ich nie sprawdza): I5 po limicie — liczba prób i `lastAttemptAt`;
  I5 poza `failed`/`rejected` — `status`. Odmowa zbudowania zlecenia
  (brak danych, brak NIP-u, rodzaj wstrzymany, data minęła) ma w logu
  `invoiceId`, `invariant` (I5/I6/I7) i `reason`. Zbiorczy Sentry „Cykl
  życia faktury: faktury czekają na operatora” idzie jak dotąd przy
  `exhausted`, `i1Lost` albo `i5NeedsOperator`, a obok liczników ma do 20
  identyfikatorów na każdy niepusty rodzaj (`i5NeedsOperatorIds`,
  `i5OtherIds`, `skippedNoDataIds`, `skippedNoNipIds`, `skipped…Ids`).
  Pozostałe liczniki z identyfikatorami (`i5Other`, `skippedNoData`,
  `skippedNoNip`, `skippedHeld`, `skippedIssueDate`, `skippedConflict`) go
  nie wysyłają: zdarzenie nie ma deduplikacji, a stan trwały dawałby jedno
  zdarzenie na przebieg, czyli 96 na dobę już przy jednej fakturze.
  Ręcznie z `docker logs` zawsze z `2>&1` — ostrzeżenia idą na stderr
  kontenera.

---

## Aktualizacja `error_translations`

Po większym release KSeF (zwykle co kwartał MF publikuje nowe kody):

1. Pobierz aktualną listę z dokumentacji MF.
2. Diff z `error_translations` w DB.
3. Nowa migracja `00XXX_ksef_error_codes_<data>.sql` z INSERT-ami /
   UPDATE-ami.
4. Migracja na produkcję ręcznie wg `AGENTS.md`, „Wgrywanie migracji na produkcję” (`pnpm db:push:prod` NIE działa), potem wdrożenie web i worker.

## Powiązane

- [sentry-error-codes.md](./sentry-error-codes.md) — szerszy patron error-handling
- [docs/architecture/ksef-flow.md](../architecture/ksef-flow.md) — pełny flow
- [ADR-0004](../adr/0004-ksef-retry-i-offline24.md) — retry schedule
- `lib/ksef/error-classifier.ts` — klasyfikator kodów
- Tabele: `ksef_submissions`, `error_translations`, `ksef_health_log`
