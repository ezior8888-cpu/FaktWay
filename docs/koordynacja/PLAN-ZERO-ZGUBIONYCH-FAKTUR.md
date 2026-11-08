# Plan „zero zgubionych faktur” (wersja 2)

Stan na 05.11.2026, `main` f4fdd6c9; sekcja 0 oraz karty L1a i L1b na 08.11.2026, `main` 1faa3fc3. Właściciel: Bartosz. Obowiązuje „Protokół naprawy błędu” z `AGENTS.md`: ten plan mówi *co* i *w jakiej kolejności*, protokół mówi *jak*.

Historia: `PLAN-ZERO-ZGUBIONYCH-FAKTUR-DZIENNIK.md` (dziennik sesji), `PLAN-ZERO-ZGUBIONYCH-FAKTUR-ARCHIWUM.md` (wersja 1 dosłownie, w tym blok A i decyzje D-A4-1b-3).

> **Start sesji N** („Kontynuuj plan zero zgubionych faktur, sesja N”):
> 1. Przeczytaj sekcje 0–4 i tylko swoją kartę, nie cały plik:
>    `P=docs/koordynacja/PLAN-ZERO-ZGUBIONYCH-FAKTUR.md; sed -n '1,/^## 5\./p' $P; awk -v s=N '$0 ~ "^### "s"\\."{f=1;print;next} /^##/{f=0} f' $P`
> 2. Dziennik i archiwum czytasz tylko po kodzie: `grep -n 'KOD' <plik> | cut -c1-600`.
> 3. Robisz TYLKO swoją sesję. Na końcu poprawiasz jej wiersz w sekcji 0, nowe ustalenia wpisujesz do sekcji 8, a wiersz dopisujesz na końcu dziennika.

---

## 0. Następny krok i status

**Ustalenia z 05.11.2026 (Igor):** data przejścia na KSeF PROD nie jest potwierdzona. Plan nie czeka na prawnika: pracujemy na założeniach z karty B1, opartych na źródłach pierwotnych (sekcja 1), a całość pokazujemy prawnikowi na końcu (sekcja 9).

**Następny krok (08.11.2026):**
1. #409, #336, #411, #412 i #189 scalone 08.11 w #460 (na `main` przez #472). Workflow „KSeF TEST (wysyłka)” (#411) nie zależy od wdrożenia: pierwszy przebieg z harmonogramu w poniedziałek 09.11 o 06:17 UTC, ręcznie można go uruchomić od razu.
2. Sesja **B2a**: karta ma listę miejsc do zmiany. Numery linii przesunęły się po 05.11, szukaj po nazwie funkcji.
3. Do akceptacji Bartosza: nowe karty **L1a** (pauza firmy po 429, w bramce) i **L1b** (budżet na żądanie, po bramce, warunkowo), propozycja Igora z 08.11. Liczba slotów wysyłki zostaje przy sesji 15 planu skalowania (po pomiarze, kolejność Bartosza z 03.11).

Stan sprawdzony w kodzie 05.11.2026, wiersze A4-D, B3, G2, H1a, L1a i L1b 08.11.2026 (także F-093 w sekcji 8). „Nieustalone” znaczy, że sprawdzenie nie dało pewnego wyniku. Wdrożenia #460 ta sesja nie sprawdzała.

| Sesja | Stan | Dowód albo uwaga |
|---|---|---|
| A1–A3, A4a, A4b, A5 | zrobione | #219–#263, dziennik |
| D-A4-1b-3: A0, A, PR B, PR C | zrobione | #229, #230, #245, #248 |
| A4-D (D-A4-1b-3 PR D) | scalone | #336, w #460 08.11.2026 |
| B1 | założenia robocze | `cykl-zycia-faktury-ksef.md` §9 (D7–D9); prawnik na końcu (sekcja 9) |
| B2a, B2b | częściowo | `ISSUE_DATE_PASSED` tylko dla KOR, ZAL, ROZ (#242); zwykła faktura nie ma bezpiecznika |
| B3 | scalone | #412, w #460 08.11.2026: stan MF z Latarni w cronie i na banerze |
| C1 | nie | brak wspólnego modułu granic |
| C2 | nie | sprzedawca korekty z przeglądarki (`correction-actions.ts:259`); generator bez `PrefiksPodatnika`; S7, S8 częściowo |
| C3 | nie | generator korekt odmawia `zw` (`fa3-correction-generator.ts:285`) |
| C4 | nie | hamulce aktywne (`kind-holds.ts:9`) |
| C5 | częściowo | C5a–c zrobione (#231, #239, #241); S18, S19 nieustalone |
| C6 (nowa) | nie | okres JPK po `issue_date` (`data-fetcher.ts:286`) |
| D1 | nie | bez limitu prób na wpis, przycisku operatora i podziału I3 |
| D2 | częściowo | skrót z `xml_storage_path` faktury (`lib/pdf/invoice-data.ts:252`) |
| E1 | nie | `break` przy `hasMore` przed `isTruncated` (`inbox.ts:114`); wiersz bez środowiska rzuca błąd (`inbox-polling.ts:142`) |
| E2 | skreślona | decyzja Bartosza 22.10: Magiczny import znika |
| F1 | nie | brak runbooka przełączenia |
| F2 | częściowo | pulpit i analizy mają kontrolę środowiska, `kpir-data.ts` i portal księgowej nie |
| G1 | nie | `stopBoss()` bez limitu czasu (`boss.ts:50`) |
| G2 | częściowo | wysyłka ma `localConcurrency: 5` (`package-d.ts:67`), reszta `batchSize`; kolejność worker przed web w `/wdroz` zrobiona (#449, w #460) |
| L1a, L1b (nowe 08.11) | nie | propozycja do akceptacji Bartosza; sesja KSeF na każdą fakturę, limiter nie liczy pojedynczych żądań, 429 nie zatrzymuje firmy (karta L1a) |
| G3 | nieustalone | runnery `retention-delete.ts`, `archive-old-invoices.ts` istnieją, warunków z karty nie sprawdzono |
| H1a | scalone, bez przebiegu | #411, w #460 08.11.2026: wynik na prawdziwym KSeF TEST w karcie B1; pierwszy przebieg z harmonogramu 09.11 albo ręcznie |
| H1b, H2 | nie | `e2e-staging.yml` nie dotyka KSeF |
| I1 | częściowo | narzędzie jest, brak śladu wykonanej rotacji |
| I2 | częściowo | tabela kod → wyjście jest (#224), brak ćwiczenia |
| I3 | częściowo | procedura jest, brak śladu wykonanej próby |
| J | częściowo | S17 otwarte (`getOcrJobStatusAction`, `upo-actions`); S15, S20, S21 prawdopodobnie załatwione; S5, S23 nieustalone |

---

## 1. Terminy, podstawa prawna i data PROD

| Data | Co | Źródło | Uwaga |
|---|---|---|---|
| 1.01.2027 | KSeF obowiązuje wszystkich, koniec wyjątku do 10 tys. zł miesięcznie | [MF: terminy](https://ksef.podatki.gov.pl/informacje-ogolne-ksef-20/podstawy-prawne-oraz-kluczowe-terminy/) | nasza grupa docelowa |
| 1.01.2027 | w obowiązującej ustawie wchodzą kary z art. 106ni | t.j. Dz.U. 2026 poz. 1263, przypis do art. 106ni | sprawdzać przy każdym przeglądzie |
| 31.12.2027 (projekt) | rząd przyjął 20.10.2026 projekt odroczenia kar, idzie do parlamentu | [gov.pl](https://www.gov.pl/web/finanse/rada-ministrow-za-odroczeniem-kar-za-bledy-w-ksef-i-przedluzeniem-odwrotnego-obciazenia-vat) | nie zdejmuje obowiązku KSeF |
| 1.01.2027 | numer KSeF w płatnościach (art. 108g) | [Dz.U. 2025 poz. 1203](https://api.sejm.gov.pl/eli/acts/DU/2025/1203/text.pdf) | poza tym planem, wskazać właściciela |

**Podstawa prawna, odczyt 05.11.2026:** [t.j. Dz.U. 2026 poz. 1263](https://api.sejm.gov.pl/eli/acts/DU/2026/1263/text.pdf) z 28.09.2026. Technika: [dokumentacja KSeF](https://github.com/CIRFMF/ksef-docs), [Latarnia](https://github.com/CIRFMF/ksef-latarnia), [FAQ MF](https://ksef.podatki.gov.pl/pytania-i-odpowiedzi-ksef-20/).

| Przepis | Co mówi |
|---|---|
| art. 106i ust. 1 | fakturę wystawia się najpóźniej 15. dnia miesiąca po dostawie lub usłudze (z wyjątkami) |
| art. 106na ust. 1 | fakturę ustrukturyzowaną uznaje się za wystawioną w dniu przesłania do KSeF |
| art. 106nda ust. 1, 2 | offline24 to możliwość podatnika; przesłanie najpóźniej w następnym dniu roboczym po wystawieniu |
| art. 106nda ust. 6, 7 | przy wydaniu nabywcy poza KSeF: dwa kody, drugi wymaga certyfikatu |
| art. 106nda ust. 10, 16 | faktura przesłana później niż data P_1 jest fakturą offline24, datą wystawienia zostaje P_1; ust. 16 odsyła do ust. 4, 6 pkt 1, 8–10, 12, 13 |
| art. 106ne | komunikaty o awarii w BIP i w oprogramowaniu interfejsowym, informacja o niedostępności w BIP |
| art. 106nf ust. 4 | awaria: przesłanie w 7 dni roboczych od jej końca |
| art. 106ng | awaria całkowita: faktura poza KSeF, bez dosyłania |
| art. 106nh ust. 2 | niedostępność: przesłanie najpóźniej w następnym dniu roboczym po jej końcu |
| art. 106ni ust. 1 | kara do 100% VAT z faktury, a bez VAT do 18,7% należności: (1) nie wystawił w KSeF, (2) wystawił niezgodnie ze wzorem w awarii, niedostępności albo offline24, (3) nie przesłał w terminie |
| art. 19a ust. 1 | obowiązek podatkowy powstaje z chwilą dostawy lub wykonania usługi (z wyjątkami) |
| art. 108 ust. 1 | kto wystawi fakturę z wykazanym VAT, ma obowiązek go zapłacić |

**D0. Data przejścia na KSeF PROD nie jest potwierdzona.** Plan jej nie zakłada i na nią nie czeka. Bramka wymaga 14 dni obserwacji, więc przy celu 1.01.2027 obserwacja musiałaby ruszyć najpóźniej 17.12.2026. Rekomendacja na czas wyboru daty: pierwsze wydanie z korektami (KOR) i bez faktur rozliczających (ROZ, komunikat w produkcie), bo ROZ wymaga jeszcze #195.

---

## 2. Zasady

Lekcje z rundy października, każda kosztowała realny czas:

1. Jeden PR od `origin/main`, bez stosów (#206, #208: treść poszła do gałęzi zamiast do `main`).
2. Plik `'use server'` eksportuje tylko funkcje asynchroniczne, reszta w `lib/**`. Build obowiązkowy przy każdym dotknięciu akcji.
3. Fixture zdarzenia to pełny, poprawny payload, inaczej `INVALID_EVENT` udaje inny błąd.
4. Wyzwalacz, RPC, RLS: testy na bazie (`tests/rls-*.test.ts`). Asercja sprawdza skutek, nie kod błędu.
5. Test niestabilny to defekt testu: osobny mały PR od razu. Bez `vi.resetModules` i `vi.doMock` w locie.
6. Decyzje współdzielone w czystych modułach (`ksef-send-policy.ts`, `ksef-operator-policy.ts`, `send-error-classes.ts`): przycisk i akcja decydują z tej samej tabeli.
7. Migracje: numer z rejestru, nagłówek przed/PO wdrożeniu, zero `DROP TABLE/COLUMN`, `UPDATE` danych tylko za zgodą, typy bazy z produkcji.
8. Nowy kod albo blokada najpierw w `ksef-operator-policy.ts` i `ksef-error-codes.md`.
9. Produkcję czytasz tylko przez `scripts/ops/kontrola-faktur-ksef.sh` i procedury z `AGENTS.md`.

Nowe w wersji 2:

10. Każda sesja dopisuje swój scenariusz do H1, jeśli da się go sprawdzić na KSeF TEST. „Zrobione” wymaga zielonego przebiegu.
11. Nowe ustalenie trafia do sekcji 8 z przydziałem: bramka, sesja albo po bramce. Samo „zapisane” w dzienniku nie wystarcza.
12. Gdy sesja wymaga więcej niż 2 PR: stop i pytanie do Bartosza (A4 urosła z jednej sesji do kilkunastu PR).

Oszczędność limitu, bez zmiany dowodów:

13. Sesja nie czyta całego planu, dziennika ani archiwum.
14. Szukanie w kodzie: `git grep` albo tańszy model. Projekt i decyzja zostają w głównym wątku.
15. Recenzja wielosoczewkowa zostaje dla runnera, RPC, wyzwalaczy, migracji i XML. Dokumenty, skrypty tylko do odczytu i teksty: jeden przegląd.

Czego nie robić: nie dodawać funkcji; nie zdejmować hamulców na próbę; nie naprawiać dwóch rzeczy w jednym PR; nie uznawać za naprawione niczego bez testu na prawdziwej ścieżce; nie pisać `ksef_status` poza RPC z 00131 i workerem; nie budować statystyk ani pulpitów (tor centrum dowodzenia).

---

## 3. Cel i mapa ryzyk

**Cel:** klient FaktWay nie dostaje kary ani odsetek z powodu tego, co zrobiła albo czego nie zrobiła aplikacja. Faktura „zgubiona po cichu” to stan w FaktWay inny niż stan prawny, o którym przez 15 minut nikt nie dostał sygnału z wyjściem.

**Definicja sukcesu:**
1. Każdy stan końcowy faktury wychodzącej ma wyjście: automat, klient albo operator (`/admin/ksef`).
2. `ksef_lifecycle_violations()` bez I5D = 0 przez 14 dni produkcji (I5D-env = 0), alarm strażnika bez nieznanej przyczyny.
3. Każda faktura `accepted` ma w 24 h numer, XML próby, wpis `xml_documents` i UPO (I3 = 0).
4. Dokument wychodzący do KSeF przechodzi te same kontrole treści co formularz.
5. Scenariusze z sekcji 6 przechodzą co tydzień w CI.
6. Przełączenie TEST → PROD ma runbook przećwiczony na kopii bazy.

Plan nie obiecuje zera błędów. Obiecuje, że błąd w wysyłce nie zostaje niewidoczny i nie kończy się karą.

| # | Ryzyko | Skutek prawny (sprawdzone 05.11.2026) | Sesje |
|---|---|---|---|
| M1 | Faktura nie wyszła w dniu P_1 | Z mocy art. 106nda ust. 16 to faktura offline24, datą wystawienia zostaje P_1. Kara grozi za przekroczenie terminu (art. 106ni ust. 1 pkt 3), nie za samą różnicę dat. Zewnętrzną granicą jest też termin z art. 106i | B1, B2 |
| M6 | Awaria KSeF | Trzy tryby: niedostępność (art. 106nh, następny dzień roboczy po końcu), awaria (art. 106nf, 7 dni roboczych), awaria całkowita (art. 106ng, bez dosyłania). MF publikuje je w Latarni | B1, B3 |
| M3 | Błędna treść przyjęta przez KSeF | Korekta, możliwa zaległość VAT | C1–C4 |
| M8 | Zły okres albo dane w JPK i KPiR | Zaległość i odsetki (art. 19a). Szczegóły reguły okresu potwierdza księgowa | C5, C6 |
| M4 | Złe środowisko | Dokument z TEST nie jest fakturą, a z PROD nie da się go cofnąć | F1, F2 |
| M2 | Duplikat | KSeF odrzuca (440) po NIP sprzedawcy, rodzaju i numerze przez 10 lat; art. 106ni go nie wymienia. Ryzyko to ta sama sprzedaż pod innym numerem: VAT z obu faktur (art. 108) | H1 (A2 zrobione) |
| M5 | Brak UPO lub XML | Ryzyko dowodowe, nie kara: art. 106ni ust. 1 tego nie wymienia. MF: KSeF archiwizuje faktury 10 lat | D1, D2 |
| M7 | Nieodebrane faktury zakupu | Odliczenie VAT i koszty, nie kara | E1 |
| M9, M10 | Zabity worker, operator nie wie | Operacyjne | G1, B3, I2 |
| M11 | Przekroczenie limitów KSeF (429) | Pośredni: blokada firmy opóźnia jej faktury (M1). MF liczy limity na parę (NIP, adres IP), a powtórki wydłużają blokadę; w skrajnym przypadku MF może zablokować zakres adresów IP, czyli wszystkie firmy naraz, bo platforma wysyła z jednego adresu | L1a, L1b |

---

## 4. Kolejność

```
A4-D (#336) ───────────────────────────────────────┐
H1a (#411) ─► sesje dopisują scenariusze ─► H1b ───┤
B2a ─► B2b (po B3; na założeniach z B1) ───────────┤
B3 (#412) ─────────────────────────────────────────┤
C1 ─► C2 ─► C3 ─► C4 ──────────────────────────────┼─► bramka, na końcu prawnik (sekcja 9)
C6, D1, E1, F1, F2 (niezależne) ───────────────────┤
L1a (L1b po bramce) ────────────────────────────────┤
G1 ─► H2 ──────────────────────────────────────────┤
I1, I3 (operacje, w dowolnym momencie) ────────────┘
Po bramce: PR E, reszta C5, D2, G2, G3, I2, blok J, L1b (warunkowo), L2–L5.
```

Równolegle tylko bez wspólnych plików, np. C1 z E1, D1 z F1. L1a i L1b dotykają runnera (czekanie przed przejęciem wysyłki), więc idą po B2a albo na zmianę z nią, nie równolegle. B2a, B2b i H1b prowadzi jedna linia sesji. Otwarte PR z sekcji 8 rozstrzyga sesja, do której są przypisane.

---

## 5. Karty sesji

Każda sesja to 1 PR (wyjątkowo 2, gdy migracja musi iść osobno), czerwony test najpierw.

### B1. Założenia prawne i produktowe (bez kodu)
Założenia robocze z 05.11.2026, zapisane w `docs/architecture/cykl-zycia-faktury-ksef.md` §9. Sesje na nich pracują, prawnik widzi je na końcu (sekcja 9). Przepisy: sekcja 1.

Co ustalono ze źródeł:
- KSeF przyjmuje fakturę z P_1 wcześniejszą niż dzień przesłania i sam może przypisać tryb offline (`ksef-docs/tryby-offline.md`). Odrzuca tylko P_1 późniejszą niż data przyjęcia (`faktury/weryfikacja-faktury.md`). FAQ MF: data przesłania jest datą wystawienia, o ile zgadza się z P_1.
- Ust. 16 nie odsyła do ust. 6 pkt 2 i ust. 7, więc taka faktura nie wymaga drugiego kodu ani certyfikatu. Nie odsyła też do ust. 2, ale jest „fakturą z ust. 1”, a art. 106ni ust. 1 pkt 3 karze za nieprzesłanie takiej faktury w terminie. Działamy, jakby termin obowiązywał.
- Ogłoszona awaria przesuwa termin dosłania (`tryby-offline.md`, „Termin przesłania przy kolejnych zdarzeniach”).
- **Sprawdzone na prawdziwym KSeF TEST 05.11.2026 (#411):** P_1 = wczoraj i P_1 = 5 dni temu przyjęte z trybem `Offline`, bez `offlineMode`. P_1 = jutro odrzucone kodem 450. KSeF nie pilnuje więc terminu dosłania: musi to robić aplikacja.

Założenia:
- **(a)** Fakturę, która nie wyszła w dniu P_1, wysyłamy bez zmian do końca następnego dnia roboczego. Potem zatrzymanie i nowy dokument z nową datą.
- **(b)** Offline24 z wydaniem dokumentu nabywcy przed wysłaniem (drugi kod, certyfikat Offline) nie wchodzi do pierwszego wydania: art. 106nda ust. 1 daje uprawnienie podatnikowi, nie obowiązek programowi. Tekst mówi, co klient może zrobić poza aplikacją.
- **(c)** Awarię komunikujemy banerem według stanu Latarni (B3). Mail idzie przy fakturach, którym zbliża się termin (B2b).
- **(d)** `ISSUE_DATE_PASSED` dla KOR, ZAL, ROZ (decyzja Bartosza 06.10) zostaje bez zmian, dopóki Bartosz nie zdecyduje inaczej.

### B2a. Bezpiecznik terminu dla zwykłej faktury
- Problem: zwykła faktura nie ma bezpiecznika daty. „Wyślij ponownie” i cron wyślą ją także po terminie, a KSeF ją przyjmie (scenariusz 13b), choć termin z art. 106nda ust. 2 minął.
- Zakres wg założenia B1(a): termin z istniejącego `calculateOfflineDeadline(issueDate, false)` (`lib/ksef/idempotency.ts`; koniec następnego dnia roboczego w czasie polskim, sobota nie jest dniem roboczym). Po terminie `ISSUE_DATE_PASSED` także dla zwykłej faktury. Do terminu ponowienie działa bez zmian treści.
- Miejsca do zmiany razem: `submit-invoice.ts:1738` (runner), `submit-invoice-full.ts:164` (hak sesji), `ksef-requeue-event.ts:142` (fakty), `ksef-send-policy.ts:254` i `:331` (klient), `ksef-operator-policy.ts:424` (operator), `ksef-lifecycle-reconcile.ts:215` (cron), macierz `ksef-wyjscia-kodow.test.ts`.
- Tekst dla zwykłej faktury: najpierw sprawdzić, czy szkic po resecie da się poprawić (D3), bo teksty dokumentów specjalnych każą go usunąć. Jeśli prawnik odrzuci założenie: cron 23:45 z wersji 1 (archiwum, B2).
- Czerwony test: faktura `failed INFRA` z P_1 w piątek: ponowienie w sobotę i w poniedziałek przechodzi, we wtorek nie, także po stronie workera; to samo ze świętem w środku tygodnia. Klient widzi dlaczego i co zrobić.
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

### B2b. Automat do terminu, alarm i mail
- Dziś automat kończy po 24 próbach (`LIFECYCLE_REQUEUE_MAX`), więc faktura z piątkowego wieczoru stoi od soboty, choć termin mija w poniedziałek. Zakres: ponawianie do terminu, alarm dla klienta i operatora przed terminem, mail.
- Przedłużenie o ogłoszoną awarię: `/messages` z Latarni, po scaleniu B3. Termin przy awarii: 7 dni roboczych od jej końca (art. 106nf ust. 4), `calculateOfflineDeadline` liczy dziś od daty wystawienia.
- Osobne małe PR z rejestru: `-PDF`, `-XEDIT`, `OFFLINE`, tekst `draft-invoice-actions.tsx:48` (obiecuje kolejkę offline, która jest wyłączona).

### B3. Stan KSeF: Latarnia i własna sonda
- Stan: #412. Cron czyta `GET /status` z Latarni (`https://api-latarnia.ksef.mf.gov.pl`, test: `api-latarnia-test`, bez autoryzacji, stany `AVAILABLE`, `MAINTENANCE`, `FAILURE`, `TOTAL_FAILURE`, repo `CIRFMF/ksef-latarnia`), a baner pokazuje stan MF także przy działającej sondzie. `level` zostaje liczony z sondy, więc decyzje o wysyłce się nie zmieniły.
- Poza zakresem: zapis do bazy bez Redisa i `isKsefHealthy` z bazy (rejestr, po bramce), bo na produkcji Redis działa (odczyt 25.10).

### C1. Granice XSD w formularzach ZAL/KOR/ROZ (W4, W6)
- `lib/validators/invoice-validators.ts` kontra `lib/schemas/invoice-form.ts`: `P_7` 512, `PrzyczynaKorekty` 256, adres 512, znaki sterujące. Dziś faktura pada w jobie jako `failed` z technicznym komunikatem.
- `P_8A` ma w XSD 256 znaków (`schemat.xsd:3129`), a 50 to kolumna `VARCHAR(50)`. Moduł rozdziela limity XSD i bazy. „unit > 20” z wersji 1 było błędem.
- Czerwony test: generator FA(3) + XSD dla każdej granicy (golden files w `tests/xml/`); formularz odmawia tych samych wartości.
- DoD: jeden moduł granic (`lib/xml/fa3-limits.ts`) importowany przez schematy formularzy, walidatory i generatory.

### C2. Nabywca i sprzedawca — prawda w dokumencie (W8, S6, S7, S8)
- W8: `Podmiot1/PrefiksPodatnika = PL` dla UE / np II w XML, JPK_FA `P_4A`, PDF.
- S6: sprzedawca w KOR z `requireTenantSeller` (jak ZAL/ROZ), nie z przeglądarki.
- S7: paszport nabywcy → `KodKraju` z formularza, nie `PL` na sztywno.
- S8: VAT-UE per kraj (`lib/invoices/vat-ue.ts`): wzorce krajowe, AT z „U”,
  bez spacji/prefiksu podwójnego.
- Czerwony test: po jednym na pozycję (XSD + golden); DoD: PDF, XML, JPK
  pokazują to samo.
- Stan: S6 otwarte (`correction-actions.ts:259` bierze sprzedawcę z przeglądarki), W8 otwarte (generator nie pisze `PrefiksPodatnika`), S7 i S8 częściowo.

### C3. `zw` w korektach i firmy zwolnione z VAT (W7)
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

### C4. Zdjęcie `KOR_HOLD` i `ROZ_HOLD` (po C1–C3 i #217)
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
- Z rejestru (sekcja 8): F-005 (#283), C5b-e, -KORB2C; ROZ: #195 albo decyzja D0.

### C5. Reszta: eksport i pulpit odporne na jeden dokument (S18, S19)
- C5a–c zrobione. Zostaje: eksport i pulpit nie padają na jednym dokumencie, błąd per dokument z nazwą, reszta liczy się dalej. Najpierw ustalić, czy to nie zostało już zrobione inną drogą.

### C6. Okres VAT w JPK_V7M (z C5b-f)
- Problem: `lib/exports/data-fetcher.ts:286` wybiera sprzedaż po `issue_date`; runbook `import-stawki-vat.md:176` zapisuje to jako C5b-f, także dla faktur FaktWay. Sprzedaż z 30.10 z fakturą z 3.11 idzie do JPK za listopad zamiast za październik.
- Najpierw księgowa potwierdza regułę okresu (art. 19a, metoda kasowa `P_16`, `OkresFa`, zaliczki).
- Czerwony test: JPK_V7M za październik z fakturą jak wyżej.
- DoD: reguła okresu w jednym module, użyta przez JPK; złoty przypadek od księgowej.

### D1. UPO dla każdej przyjętej faktury (W12, I3)
- Problem: `upo-retry-stale` bez limitu prób, trwale nieudane wypychają nowe.
- Zakres: `download_attempts` z limitem i wykluczeniem kodów nieretryowalnych;
  po limicie `failed` UPO z kodem i wyjście operatora w `/admin/ksef` (karta
  faktury: „Pobierz UPO ponownie”); I3 w strażniku rozdzielone na „bez UPO
  < 24 h” (ostrzeżenie) i „> 24 h” (naruszenie).
- Czerwony test: 60 wpisów UPO: 50 trwale 4xx, 10 świeżych — świeże
  pobrane w jednym przebiegu.
- Stan: `upo-retry-stale.ts:129` bierze najstarsze wpisy, a `download_attempts` jest tylko odczytywane (limit 100 na przebieg, nie na wpis). Obejmuje -UPO.
- Z rejestru: UPO-429. 429 nie jest trwałym 4xx: ponowienie po `Retry-After` (pauza firmy z L1a), bez zużycia limitu `download_attempts`. W czerwonym teście 429 nie należy do 50 trwałych.

### D2. Dowód treści: skrót XML w każdym PDF i w portalu
- PDF z KOD I liczy skrót z pliku próby (D5); dla faktur sprzed D5 — z pliku
  historycznego; brak pliku = PDF bez kodu z wyraźnym komunikatem (B14 jest),
  plus alarm I3.
- Czerwony test: `generateInvoicePdf` dla faktury z `xml_storage_path` próby.
- Z rejestru: C-12, C-20 (#369, #190).

### E1. Skrzynka bez luk (W10, S12, S9)
- W10: `isTruncated` honorowany niezależnie od `hasMore` (`lib/ksef/inbox.ts:114-116`).
- S12: legacy wiersz bez `ksef_environment` w oknie kursora — uzgodnienie
  per firma w `/admin` zamiast zatrzymania skrzynki (fail-closed z wyjściem).
- S9: PDF faktury ze skrzynki nie rzuca 500 — podgląd z `fa3_data` albo
  komunikat „oryginał XML w KSeF”.
- Czerwony test: skrzynka z 10 001 faktur w oknie (atrapa) → 10 001 wierszy,
  HWM nie przeskakuje.

### F1. Runbook przełączenia TEST → PROD (W15, S13)
- Dziś przełączenie `KSEF_ENV` wyłączy KPiR, eksporty i stronę zaległości
  u firm z fakturami przyjętymi na TEST; zmiana `ksef_environment` tylko
  rolą `postgres`.
- Zakres: `docs/runbooks/go-live-ksef-prod.md` (kolejność: hamulce, flagi,
  env obu aplikacji, weryfikacja), oznaczenie faktur TEST per firma
  (kolumna/filtr), komunikaty zamiast wyjątków na pulpicie; przećwiczone
  na kopii bazy (I3).
- DoD: próbne przełączenie na kopii bez „Coś poszło nie tak”.
- Z pomiaru FaktWay 1.0 (#357, 00161): w kroku przełączenia wyzeruj
  `tenants.first_invoice_accepted_at` i policz ją od nowa z faktur nowego
  środowiska (SQL w `docs/analytics/lejek-faktway.md`, „Przełączenie TEST →
  PROD”). Inaczej `/admin` pokaże „Fakturę” z TEST, a pierwsza prawdziwa
  faktura nie wyśle `first_invoice_sent`.
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
- Z rejestru: -SYS.

### F2. Firma z fakturami TEST po go-live
- Widok „dokumenty testowe” oddzielony od księgowych; portal księgowej
  bez faktur TEST (S10); eksporty tylko PROD.
- Z rejestru: ZAP-01-f, S10, D-A4-2.

### G1. Zabity worker (S4)
- `stopBoss({ timeout })` dopasowane do czasu łaski kontenera (Coolify
  10 s) + idempotencja jobów, które dziś dublują: sekwencja maili próbnych
  (W14, klucz `seq/<userId>/<stage>`), przypomnienia, eksporty.
- Czerwony test (chaos, H2): SIGKILL w trakcie `submit-invoice` po POST →
  po restarcie uzgodnienie, nie drugi POST.

### G2. Równoległość (S3, S16)
- Stan: wysyłka ma `localConcurrency: 5` i limit na firmę 100 (`package-d.ts:65-67`), więc w praktyce limitu na firmę nie ma. Liczba slotów wysyłki należy do sesji 15 planu skalowania (po pomiarze), limit na firmę do karty L1a. Kolejność worker przed web w `/wdroz` zrobiona (#449, scalone 08.11 w #460). Zostają inne kolejki z `batchSize` (`package-c.ts`).

### L1a. Limity KSeF: pauza firmy po 429 (propozycja 08.11.2026, do akceptacji Bartosza)
- Problem: MF liczy limity na parę (NIP, adres IP), a cała platforma wysyła z jednego adresu. Limity z `ksef-docs/limity/limity-api.md` i `open-api.json` (API 2.9.0), odczyt 08.11.2026, na sekundę / minutę / godzinę:

  | Żądanie (grupa MF) | Limit | Kto u nas zużywa |
  |---|---|---|
  | otwarcie sesji online (`onlineSession`) | 10 / 30 / 120 | każda wysyłka i każde jej ponowienie (sesja na fakturę) |
  | wysyłka faktury w sesji (`invoiceSend`) | 10 / 30 / 180 | wysyłka |
  | zamknięcie sesji (`onlineSessionClose`) | 20 / 60 / 240 | wysyłka, rozstrzygnięcie zamiaru (A2) |
  | status faktury (`invoiceStatus`) | 30 / 120 / 1200 | odpytywanie po wysyłce, uzgodnienie po referencji, I5, „Tylko uzgodnij” |
  | lista faktur sesji (`sessionInvoiceList`) | 10 / 20 / 200 | rozstrzygnięcie zamiaru (A2) |
  | pozostałe `GET /sessions/*` (`sessionMisc`) | 10 / 120 / 1200 | UPO i `upo-retry-stale` |
  | metadane faktur (`invoiceMetadata`) | 8 / 16 / 20 | skrzynka (do 16 na godzinę, `skrzynka-ksef-pojemnosc.md`), historia, data oryginału przy 440 (`submit.ts:444`) |
  | faktura po numerze KSeF (`invoiceDownload`) | 8 / 16 / 64 | XML skrzynki, historia, oryginał przy 440 (`submit.ts:402`) |
  | `/auth/*` | 60 / s (OpenAPI); tylko dla `/auth/challenge` MF pisze wprost, że na jeden adres IP | pełne logowanie po restarcie workera (tokeny są tylko w pamięci) i po odrzuceniu refresh tokenu |

  Okna są przesuwne (ostatnia sekunda, minuta, godzina) i działają jednocześnie. Po przekroczeniu MF odpowiada 429 z `Retry-After` i tymczasowo blokuje kolejne żądania; dokument nie mówi, czy samej grupy, czy całego kontekstu. Przy powtarzających się naruszeniach MF może zablokować podmiot albo zakres adresów IP. Limity są wstępne i MF może je czasowo obniżyć. Według zmian API 2.8.0 MF przygotował grupę `global` na przyszły limit na sam adres IP, dla dostawców obsługujących wiele podmiotów, czyli dla nas; na razie jest wyłączona. Faktyczne limity kontekstu podaje `GET /rate-limits`, którego kod dziś nie woła.
- Stan w kodzie, sprawdzony 08.11.2026:
  - Każda faktura otwiera własną sesję (`lib/ksef/submit.ts:134`), więc sufit to 120 wysyłek na godzinę na firmę, razem z ponowieniami.
  - `ksefRateLimiter` (`lib/ksef/rate-limiter.ts:24-27`: 50 na sekundę, 10 naraz) liczy zadania, nie żądania. Wywołania wysyłki, uzgodnienia, skrzynki i historii idą przez niego jako zadania, a `submitInvoice` to jedno zadanie z logowaniem (gdy trzeba), otwarciem, wysyłką, do 30 zapytań o status i zamknięciem (`submit.ts:113-245`). Poza limiterem idą samo żądanie UPO (`upo-client.ts:146`) i logowanie przy otwarciu sesji historii (`ksef-history-sync.ts:627`). Komentarz o „limicie 100/s” nie ma źródła, a komentarze o limiterze w kliencie i „60 wysyłek/min” (`package-d.ts:21`, `submit-invoice.ts:155-159`) opisują stan z Inngest. Limiter żyje w pamięci workera. Aplikacja go nie używa, a jej jedyne wywołanie KSeF to logowanie w kreatorze połączenia (`components/settings/actions.ts:174`). Oba procesy działają dziś na `app-1`, więc liczą się do tej samej pary (NIP, IP).
  - Jedna firma może zająć wszystkie sloty: `localConcurrency: 5` i `groupConcurrency: 100` (`package-d.ts:65-67`), a pg-boss pobiera zadania po kolei, bez podziału między firmy.
  - Odpytywanie co 2 s, najwyżej 30 razy, w slocie (`submit.ts:529-530`): 5 równoległych wysyłek jednej firmy to ok. 150 zapytań o status na minutę przy limicie 120.
  - 429 nie zatrzymuje firmy. Ponawiana jest tylko ta faktura i zużywa zwykłą próbę (`KSEF_MAX_RETRIES = 5`), a kolejne zadania tej firmy dalej uderzają w limit. `Retry-After` (obcięty do 3600 s) honorują krok wysyłki i pobranie oryginału przy 440 (`submit-invoice.ts:1444`). Uzgodnienie po referencji i rozstrzygnięcie zamiaru biorą stały harmonogram 30 s / 2 min / 5 min / 15 min / 1 h, bez rozrzutu, więc faktury, które padły razem, wracają razem. Faktura nie ginie (po wyczerpaniu `failed`, cron I6 najpierw uzgadnia), ale seria 429 wydłuża blokadę.
  - 429 przy pobraniu UPO jest traktowane jak błąd ostateczny; UPO wraca dopiero z `upo-retry-stale` po 24 h (`upo-client.ts:180-186`).
  - Cron cyklu życia (co 15 min) wznawia do `LIFECYCLE_BATCH = 100` faktur na każde zapytanie (I6 i I7, osobno zwykłe i specjalne, do tego I5), bez limitu na firmę i bez rozłożenia w czasie. Po awarii KSeF zaległość jednej firmy trafia do kolejki w jednej chwili.
  - Kolejka wysyłki grupuje po firmie w aplikacji (`groupId = tenantId`), a limity MF liczą się po NIP. Kilka firm w aplikacji z tym samym NIP dzieli jeden budżet MF.
  - Gdzie widać 429: `ksef_send_attempts.ksef_http_status` (job wysyłki, także I5 i „Tylko uzgodnij”, bo idą tym samym jobem); przy pobraniu oryginału po 440 już nie, bo `pending()` podmienia przyczynę (`submit-invoice.ts:1283-1286`). 429 przy UPO i w skrzynce trafia do `audit_logs` (`ksef.upo.download`, `inbox.poll`).
- Zakres (jeden PR; jeśli się nie mieści, stop i pytanie do Bartosza, zasada 12):
  1. Pauza firmy po 429: pełny `Retry-After`, bez obcięcia do 3600 s, zapisany dla (środowisko, NIP). W czasie pauzy czekają wszystkie żądania KSeF tej firmy: wysyłka, UPO, skrzynka i historia. Węższa pauza, na samą grupę, dopiero gdy scenariusz 17 na TEST pokaże, że MF blokuje tylko grupę. Skrzynka czyta i zapisuje tę samą pauzę zamiast osobnego stanu w `nextInboxPollAfterError`.
  2. Zadanie w pauzie czeka z rozrzutem do jej końca i nie zużywa ani próby, ani budżetu odczekań `MAX_WAIT_RETRIES` (24 × 5 min, wspólny z czekaniem na dzierżawę): pauza ma własny licznik albo nie ma limitu. Po każdym powrocie zadanie najpierw sprawdza pauzę. Czekanie wypada przed przejęciem wysyłki (`claim_ksef_send`).
  3. Hamulec wysyłki przy 429 z wielu firm naraz, jak `inboxRateLimitBrake` (`inbox-schedule.ts:283`), bo to sygnał zbliżania się do blokady zakresu IP (M11).
  4. `Retry-After` także w uzgodnieniu i rozstrzygnięciu zamiaru; rozrzut w harmonogramie ponowień.
  5. Limit na firmę: `groupConcurrency` 2–3 zamiast 100 (`KSEF_TENANT_CONCURRENCY_LIMIT`). Liczba slotów razem bez zmian (5); podnosi ją sesja 15 planu skalowania po pomiarze, w kolejności Bartosza z 03.11 (na CX23 6–8).
  6. 429 przy pobraniu oryginału po 440 w dzienniku prób: `pending()` przenosi `KsefApiError` jako przyczynę. Komentarze w `rate-limiter.ts`, `package-d.ts` i `submit-invoice.ts` zgodne z dokumentacją MF i stanem po Inngest.
- Czerwony test (atrapa KSeF, sztuczny zegar): atrapa odpowiada 429 z `Retry-After: 30`, przez 30 s nie idzie żadne żądanie tej firmy (wysyłka, UPO, skrzynka), a faktura drugiej firmy wychodzi bez czekania na serię pierwszej. 30 kolejnych pauz nie kończy faktury w `failed`. Pauza nie zostawia faktury w `sending` (strażnik bez I1 i I2).
- Ponowienie od zera: czekanie wypada przed przejęciem wysyłki albo po jego zwolnieniu, nigdy z fakturą w `sending`, bo pauza trwa tyle, ile podał MF, a dzierżawa `KSEF_SEND_LEASE_SECONDS` to 15 min. Kolejność A2 (zamiar przed plikiem) bez zmian. Po przyjęciu pliku czeka tylko odpytywanie, więc pauza nie może wywołać drugiej wysyłki.
- Scenariusz 17 lokalnie i na TEST z limitami ustawionymi przez `POST /testdata/rate-limits` (zasada 10). Źródła MF są sprzeczne co do domyślnych limitów TEST (`limity-api.md`: 10 razy wyższe, zmiany API 2.5.0: równe PROD), więc bez ustawienia limitów przebieg na TEST nic nie dowodzi.
- DoD: scenariusz 17 zielony lokalnie, dopisany do `scripts/test-ksef-wysylka.ts` i zielony na TEST; przebieg zapisuje, czy po 429 MF blokuje samą grupę, czy cały kontekst.
- Dlaczego w bramce: celem planu jest brak kary, a długa, eskalowana blokada firmy (albo zakresu IP) zatrzymałaby faktury po terminie. Przed nią chroni pauza; sam budżet na żądanie (L1b) to już wydajność.

### L1b. Limity KSeF: budżet na żądanie (po bramce, warunkowo)
- Warunek startu: pierwszy 429 w `ksef_send_attempts` po L1a albo firma z ponad 30 fakturami w godzinie. Do tego czasu wystarcza L1a. Tabela limitów i stan w kodzie: karta L1a.
- Zakres (jeden PR):
  1. Budżet dla każdej grupy z tabeli, klucz (środowisko, NIP), liczony przy każdym żądaniu (`ksefFetch` i surowe żądanie UPO), a nie na zadanie. Także `invoiceMetadata` i `invoiceDownload`: jeden licznik dla skrzynki, historii i ścieżki 440; skrzynka zostawia zapas na 440. Odpytywanie statusu w budżecie grupy `invoiceStatus`, częstotliwość bez zmian (L3).
  2. Przed `claim_ksef_send` runner rezerwuje w budżecie całą wysyłkę: otwarcie, plik, zamknięcie i pierwsze zapytania o status. Brak budżetu daje czekanie z L1a przed przejęciem. W `sending` czeka tylko odpytywanie, najwyżej kilka sekund; dłużej oznacza koniec próby i uzgodnienie po referencji, a nie zamiar bez pliku.
  3. Licznik w Redisie (`lib/cache/redis.ts`; jest limiter z oknem przesuwnym i zapasem w pamięci, `lib/rate-limit/index.ts`, oraz nieużywany klucz `submitRateLimit` w `lib/cache/keys.ts:69-71`), żeby przetrwał restart workera (okno godzinowe). Bez Redisa albo przy odpowiedzi dłuższej niż ok. 1 s budżet w pamięci procesu, a nie blokada wysyłki: limit i tak egzekwuje MF, a blokada bez wyjścia to nowy błąd (zasada 4 protokołu). Drugiego workera plan skalowania nie przewiduje. Po przeniesieniu workera na osobną maszynę (etap 3 planu skalowania) kreator w aplikacji i worker mają różne adresy IP, więc MF liczy je osobno.
  4. `/auth/*`: ostrożnie jeden budżet na adres IP dla wszystkich firm, żeby masowe logowanie po restarcie workera nie przekroczyło limitu. Ten sam licznik IP przyda się, gdy MF włączy grupę `global`.
  5. Limity z `GET /rate-limits` na kontekst i środowisko (żądanie z grupy domyślnej 10 / 30 / 120, więc z pamięcią podręczną), a tabela jako wartość domyślna.
- Czerwony test (atrapa z limitami PROD): 60 faktur jednej firmy w kolejce, wszystkie przyjęte bez żadnego 429, w każdej minucie najwyżej 30 otwarć sesji i 120 zapytań o status; brak budżetu nie zostawia zamiaru bez pliku. Scenariusz 16 lokalnie i na TEST z `POST /testdata/rate-limits/production`.
- Ponowienie od zera: rezerwacja przed przejęciem nie zmienia kolejności A2; zwrot niewykorzystanej rezerwacji nie może wywołać wysyłki.
- Poza zakresem (sekcja 8, po bramce): **L2** czasy każdego kroku w `scripts/test-ksef-wysylka.ts` (pomiar przed L3 i L4); **L3** odpytywanie adaptacyjne (pierwsze zapytanie po ok. 0,5 s, potem rzadziej) i krótszy sen w slocie, dalej istniejącą ścieżką uzgodnienia; **L4** kilka faktur jednej firmy w jednej sesji (do 10 000 faktur, 12 h), co podnosi sufit ze 120 do 180 na godzinę (dopasowanie zamiaru po skrócie pliku już na to pozwala, `submit-invoice.ts:187`, ale rozstrzygnięcie zamiaru zamyka sesję, `submit.ts:490`); **L5** sesja wsadowa, którą MF zaleca dla większej liczby faktur, dopiero gdy pojawi się wysyłka hurtowa.

### G3. Retencja bez półśrodków (W13)
- Referencje (FK) sprawdzane przed kasowaniem plików; DELETE per faktura;
  pliki prób (D5) w jednym przebiegu z wierszem.
- Stan: najpierw przeczytać `retention-delete.ts` i `archive-old-invoices.ts`; plan skalowania (sesja 30) też dotyka archiwizacji.

### H1a. Szkielet na prawdziwym KSeF TEST
- Stan: #411. `scripts/test-ksef-wysylka.ts` idzie drogą workera od XML do KSeF, bez bazy i magazynu plików. Workflow `ksef-test-wysylka.yml`: tylko `schedule` i `workflow_dispatch`, nigdy `pull_request`, poza oknem serwisowym TEST (16:00–18:00). Bez sekretów: fikcyjny NIP i certyfikat samopodpisany powstają w locie. Runbook: `ksef-test-wysylka.md`.
- Scenariusze: 1, 2, 3, 13, 13b. Po scaleniu uruchomić workflow raz ręcznie.

### H1b. Pełna lista scenariuszy
- Pełny runner: baza lokalna jak „RLS isolation”, worker w procesie, reszta sekcji 6 oraz: reset → poprawa → ponowna wysyłka (nowy klucz XML), „tylko uzgodnij”, uzgodnienie po referencji, skrót oryginału = `invoiceHash` i UPO z sesji spoza FaktWay (D-A4-1a).
- Warunek spełniony w kodzie: #189 (F-093) scalony 08.11.2026 w #460, kod błędu KSeF czytany także z odpowiedzi `problem+json`. Na produkcji dopiero po wdrożeniu #460.
- Numer faktury z identyfikatorem przebiegu, bo KSeF pilnuje unikalności przez 10 lat. Dane TEST są współdzielone między integratorami, więc testy nie zakładają pustego konta (`-TESTENV`).
- DoD: każdy scenariusz zielony w 3 kolejnych tygodniach przed wydaniem.

### H2. Chaos na kopii bazy (game day)
- Skrypt `scripts/ops/game-day.sh` (na kopii, nigdy na produkcji): zabij
  worker w `sending`; odetnij R2 w uploadzie; odetnij bazę w `enqueue`;
  wyłącz PostgREST na 2 min; zmień klucz szyfrowania bez `_PREVIOUS`.
  Po każdym: strażnik, `/admin/ksef`, alarmy — wszystko ma wskazać fakturę
  i wyjście.
- DoD: tabela „awaria → sygnał w ≤ 15 min → wyjście” bez pustych pól.

### I1. Rotacja kluczy (dług z Vercela)
- `KSEF_CREDENTIALS_ENCRYPTION_KEY` z `_PREVIOUS` i skryptem reencrypt
  (AUD-52 ✅) — wykonać rotację naprawdę; `CREDENTIALS_UNAVAILABLE` ma test
  na prawdziwej rotacji (H2). Pozostałe klucze wg `docs/runbooks/key-rotation.md`.

### I2. Runbook operatora per kod + ćwiczenie
- `docs/runbooks/ksef-error-codes.md`: dla każdego kodu — co widzi klient,
  co robi automat, co klika operator, kiedy dzwonić do klienta. Jedno
  ćwiczenie Bartosza na kopii bazy z fakturami w każdym stanie.

### I3. Backup i odtworzenie z weryfikacją faktur
- `docs/runbooks/backup-restore.md` wykonany na kopii: po odtworzeniu
  `ksef_lifecycle_violations()` bez I5D = 0, liczby faktur per stan zgodne,
  pliki XML prób dostępne.

### J. Pozostałe ustalenia (po bramce)
S5 (cron ponagleń proponuje ROZ/KOR z błędną kwotą), S15 (usunięcie
użytkownika omija RODO), S17 (AUD-58: MFA w `getOcrJobStatusAction`,
`upo-actions`, support chat), S20/S21 (env `RESEND_FROM_EMAIL`,
`STRIPE_PRICE_ANNUAL`), S23 (eksport RODO), NISKIE z raportu. Każde osobnym
PR według protokołu; nie dotyczą kar, więc po bramce z sekcji 8.

### A4-D. „Sprawdź ponownie” dla 440 bez danych oryginału (D-A4-1b-3 PR D)
- Stan: #336 ma test czerwony przed naprawą, recenzję i 18 tekstów do prawnika, ale jest 244 commity za `main`.
- Zakres: dogonić `main` przez merge, powtórzyć pełną weryfikację, sprawdzić, czy zmiany z `main` nie unieważniły założeń, zdjąć szkic. Scalenie tylko na polecenie Bartosza.
- Dlaczego w bramce: klient przy powodach `download-refused`, `download-pending`, `storage-pending`, `archive-pending` nie ma dziś żadnego wyjścia (definicja sukcesu, pkt 1).
- Poza zakresem: 440 bez numeru oryginału (rejestr, po bramce) i PR E.

---

## 6. Scenariusze

Dokumentacja KSeF nie opisuje symulowania awarii na TEST, więc awarie idą przez blokadę sieci.

| # | Scenariusz | Oczekiwany stan końcowy | Dowód | Gdzie |
|---|---|---|---|---|
| 1 | Zwykła faktura VAT | `accepted`, numer, XML próby, `xml_documents`, UPO ≤ 24 h | karta `/admin/ksef`; strażnik 0 | TEST |
| 2 | Ta sama faktura dwa razy | jedna wysyłka; druga → `singletonKey` albo 440 → własny duplikat | 1 wpis `accepted` | TEST |
| 3 | Odrzucenie semantyczne (450), np. P_1 = jutro | `rejected KSEF_REJECTED`, „Wróć do szkicu” | brak wpisu `sent` | TEST |
| 4 | Reset → poprawa → ponowna wysyłka | `accepted`, nowy klucz XML, stary plik nietknięty | dwa pliki | TEST |
| 5 | POST wysłany, worker zabity przed statusem | uzgodnienie, `accepted`, bez drugiego POST | 1 wpis `sent → accepted` | TEST + zabicie procesu |
| 6 | KSeF niedostępny 2 h | `failed KSEF_UNAVAILABLE` → automat → `accepted` | audyt `send_requeued` | blokada sieci |
| 7 | KSeF niedostępny dłużej niż termin | alarm i decyzja z B1/B2 | raport dzienny | blokada sieci, sztuczny zegar |
| 8 | Korekta „przed/po”, potem druga | P_15 drugiej = różnica od stanu po pierwszej | XML golden | TEST |
| 9 | Stara sesja przy uzgadnianiu | kod odpowiedzi zapisany (MF nie planuje retencji statusów sesji, changelog v2.4.0) | log CI | TEST |
| 10 | Brak certyfikatu, NIP niezweryfikowany | `failed NO_CERTIFICATE / NOT_VERIFIED`, link do ustawień | przycisk | lokalnie |
| 11 | Zdarzenie z innego środowiska | `failed ENV_MISMATCH`, alarm, operator | Sentry | lokalnie |
| 12 | Faktura przychodząca | `received`, koszt, XML, KOD I w PDF | skrzynka | TEST, druga firma |
| 13 | P_1 = wczoraj, wysłana dziś | `accepted`, numer, tryb `Offline` | log CI | TEST |
| 13b | P_1 = 5 dni temu | KSeF przyjmuje z trybem `Offline`, więc termin pilnuje aplikacja (B2a) | log CI | TEST |
| 14 | Nabywca bez NIP | `accepted`, PDF z KOD I | PDF | TEST |
| 15 | Wysyłka tuż po północy, P_1 = dziś w Warszawie | przyjęta; dokumentacja nie podaje strefy porównania dat, wynik krytyczny dla A1 | log CI | TEST, ręcznie |
| 16 | Seria 60 faktur jednej firmy (L1b, po bramce) | wszystkie `accepted` bez 429, w każdej minucie najwyżej 30 otwarć sesji | test L1b, dziennik prób bez HTTP 429 | lokalnie, atrapa z limitami PROD; TEST z `POST /testdata/rate-limits/production` |
| 17 | KSeF odpowiada 429 z `Retry-After`, w tym czasie faktura drugiej firmy | pauza całej tej firmy (wysyłka, UPO, skrzynka), potem `accepted`; faktura nie przechodzi w `failed`; druga firma bez opóźnienia | test L1a; zapis, czy MF zablokował grupę, czy kontekst | lokalnie, atrapa; TEST z `POST /testdata/rate-limits` |

---

## 7. Bramka wydania

Wydanie na KSeF PROD dla płacących klientów, gdy wszystkie punkty mają datę i numer PR albo raportu. `GOTOWOSC-DO-WYDANIA.md` opisuje niższy próg Closed Alpha (7 dni) i obowiązuje dalej; jego G3 („wyłączony KSeF TEST”) czytaj jak scenariusz 6.

- [ ] Sesje A4-D, B2a, B2b, B3, C1–C4, C6, D1, E1, F1, F2, G1, H1a, H1b, H2, L1a scalone i wdrożone.
- [ ] Scenariusze z sekcji 6 zielone w 3 kolejnych tygodniowych przebiegach, każdy w swoim miejscu (bez 16, który należy do L1b po bramce).
- [ ] Strażnik bez I5D = 0 przez 14 dni (I5D-env = 0); raport dzienny bez `exhausted` i `i1Lost` niewyjaśnionych.
- [ ] Każdy kod błędu, także `OFFLINE_*`, ma wiersz w runbooku z wyjściem i testem.
- [ ] Game day (H2): każda z 5 awarii → sygnał ≤ 15 min → wyjście.
- [ ] Rotacja kluczy wykonana (I1), odtworzenie z kopii wykonane (I3), oba z datą.
- [ ] Runbook go-live przećwiczony na kopii (F1).
- [ ] Hamulce zdjęte świadomie (C4) albo decyzja o ich zostawieniu, widoczna w produkcie jako komunikat, nie `failed`.
- [ ] Offline24 działa albo jest jawnie poza produktem (B1 b).
- [ ] `kontrola-faktur-ksef.sh` codziennie przez 14 dni bez nieznanych stanów.
- [ ] Sekcja 8: pozycje BRAMKA zamknięte.
- [ ] Na końcu: prawnik przejrzał pakiet z sekcji 9, poprawki po przeglądzie wdrożone. TEST bez blokady.

Po bramce: tygodniowy przegląd (raport dzienny, strażnik, Sentry) przez pierwszy kwartał, w nim `ksef_send_attempts.ksef_http_status` bez 429 (warunek startu L1b).

---

## 8. Rejestr otwartych ustaleń

Dotąd leżały w kolumnie „co zostało” dziennika, bez właściciela. Przydział jest propozycją do akceptacji Bartosza. „Sprawdzone” = potwierdzone w kodzie 05.11.2026.

**BRAMKA:**

| Kod | Co | Sesja | Stan |
|---|---|---|---|
| D-A4-1b-3-SYS | `SystemInfo` jedyną podstawą powodu, zmiana przed KSeF PROD | F1 | sprawdzone: otwarte |
| D-A4-1b-3-XEDIT | treść szkicu wycofanego zmienialna surowym PATCH | B2b | sprawdzone: otwarte |
| D-A4-1b-3-PDF | PDF szkicu bez oznaczenia „nie jest fakturą” | B2b | sprawdzone: otwarte |
| OFFLINE | kody `OFFLINE_*` poza katalogiem, `offline_queued` bez wyjścia (luka #5) | B2b | sprawdzone: otwarte |
| ZAP-01-f | KPiR bez `assertAcceptedEnvironmentKnown`: przyjęte bez środowiska znikają po cichu | F2 | sprawdzone: otwarte |
| S10 | portal księgowej bez filtra środowiska | F2 | sprawdzone: brak filtra |
| D-A4-2 | `ksef_submissions` bez środowiska, I5 uzgadnia dokument z TEST w bieżącym środowisku | F2 | do sprawdzenia |
| F-093 | `ksef_code` pusty dla `problem+json` | H1b | zamknięte: #189 scalony 08.11.2026 (#460) |
| F-005 | korekta faktury spoza 50 najnowszych | C4 | #283 otwarty od 17.10 |
| C5b-e | KOR faktury z importu z procedurami wpisuje 2/N | C4 | do sprawdzenia |
| D-A4-1b-3-KORB2C | brak korekty dla nabywcy bez NIP i VAT-UE | C4 | do sprawdzenia |
| D-A4-1b-3-KORZW | korekta K z `zw` | C3 | w DoD C3 |
| C-09, C-10, C-16 | ROZ z bazy i środowiska | C4 albo pierwsze wydanie bez ROZ | #195 konflikt od 03.10 |
| C-12, C-20 | niezmienny dowód XML | D2 | #369, #190 (szkice) |
| C5c-c | `P_14_x` z sumy VAT pozycji | sekcja 9 | pytanie do doradcy |
| UPO-429 | 429 przy pobraniu UPO = błąd ostateczny, UPO wraca dopiero po 24 h (`upo-client.ts:180-186`) | D1 | sprawdzone 08.11: otwarte |

**Po bramce** (opis w dzienniku i `ksef-error-codes.md`, stan niesprawdzony): D-A4-1b-3-MI (prawdopodobnie nieaktualne po decyzji 22.10), 440 bez numeru oryginału (z #336: wyjściem zostają I5 i „Tylko uzgodnij”), -UPO (w D1), -DATE, -PAY, -CAT, -LIST, -EVID, -FLO-NUM, GEN-PESEL-KRAJ, C5b-b, C5b-c, C5b-d, C5c-b, C5c-e, W9-b, W9-c, W9-e, W9-g, IMP-ACC, IMP-PROD, IMP-KOR, IMP-STAWKA, IMP-B2C-NRINNY, IMP-STOPKA-WIELE, IMP-ID-XSD, IDX-ENV, ZAP-01-a do ZAP-01-e, CQ-IDENT, zapis stanu KSeF do bazy bez Redisa (z B3), typy bazy z produkcji (`types/database.ts` kończy się na 00154), limity 5 s w `ksef-connect-credentials*` pod obciążeniem (zasada 5), L1b (warunkowo) i L2–L5 (wydajność wysyłki, karty L1a i L1b) oraz ustalenia bez kodu z dziennika (m.in. I5 przy konflikcie 23505, ponowny push po błędzie Resend, błąd Resend w pętli `cert-expiry-alert`).

---

## 9. Pakiet dla prawnika (na końcu)

Pokazujemy, gdy reszta bramki jest gotowa. Poprawki po przeglądzie idą osobnymi PR.

1. Założenia z karty B1, z pytaniami:
   - Czy termin z art. 106nda ust. 2 obowiązuje fakturę z ust. 16, skoro ust. 16 go nie wymienia? Działamy, jakby obowiązywał.
   - Czy po terminie wolno wystawić dokument z nową datą, gdy nabywca nie dostał poprzedniego?
   - Czy wysłanie takiej faktury z `offlineMode: false`, gdy KSeF sam przypisuje tryb, jest wystarczające?
2. Teksty dla klienta: migawka `tests/unit/__snapshots__/ksef-duplikat-decyzja-teksty.txt` (D-A4-1b-3 PR B, PR C, PR D; szczegółowa lista: archiwum, sekcja 8) oraz teksty o terminie i awarii z B2 i B3.
3. Do księgowej lub doradcy: reguła okresu VAT w JPK (C6) i C5c-c (`P_14_x` z sumy VAT pozycji).
4. Sprawdzenie, czy projekt odroczenia kar został uchwalony i czy jest nowszy tekst jednolity ustawy.
