# Plan etapu 2: samodzielna księgowość JDG w FaktWay

> **„Kontynuuj plan księgowość JDG”**: sesja czyta ten plik od góry, robi
> checklistę startową (sekcja 0) i pracuje od wiersza „Następny krok”
> w dzienniku (sekcja 15). Po każdym kroku dopisuje wiersz w dzienniku,
> aktualizuje „Następny krok”, składa raport i STOP. Ten plik jest jedynym
> źródłem prawdy o module księgowości.
>
> **Gdzie leży:** obowiązuje ta kopia w repo,
> `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`, przeniesiona w kroku K0.
> Fraza „Kontynuuj plan księgowość JDG” jest w bloku na górze `AGENTS.md`.
> Pierwsza wersja z 4.11.2026 leży poza gitem
> (`docs/launch/analiza-rynku-2026-10/` w głównym katalogu repo) i nie jest
> już aktualizowana.

Przygotowanie: 4.11.2026, odczyt kodu `origin/main` @ `7a249d3f` (po #368) i przepisów ze źródeł urzędowych. Kontekst biznesowy: `docs/launch/analiza-rynku-2026-10/FAKTWAY-1-0.md`, etap 2 (poza gitem).

---

## 0. Start sesji: checklista

1. `git fetch origin && git log --oneline -1 origin/main`. Gałąź kroku zawsze od świeżego `origin/main`: `claude/ksiegowosc-kN-<temat>`.
2. Przeczytaj sekcje 1-5 tego planu, krok wskazany w „Następny krok”, `AGENTS.md` (protokół, migracje, scalanie) i `docs/koordynacja/PLAN-FINORA.md` §2.4 (wspólne zasady liczenia).
3. Numer migracji z rejestru `docs/koordynacja/CLAUDE-DO-CODEXA.md`, wiersz „następny wolny” (4.11.2026: **00164**). Przed nadaniem sprawdź otwarte PR-y i gałęzie zdalne. Wiersz rejestru dopisz w tym samym PR.
4. Przed każdym PR: `pnpm run ci && pnpm build`. W świeżym kontenerze najpierw `xmllint --version` (bez niego padają testy XSD).
5. Scalanie i wdrożenie tylko na polecenie Bartosza (`AGENTS.md`). Sesja bez `.agents/infra.env` nie wgrywa migracji, tylko pisze w PR „Do wgrania: 00NNN, przed wdrożeniem”.
6. Wszystko za wyłącznikiem `ksiegowosc` (powstaje w K1). Żaden klient nic nie widzi przed bramą z sekcji 11.
7. Wygląd: nowe ekrany składasz z istniejących komponentów Finory. **Istniejących ekranów na Macu nie zmieniasz.** Zmiany „na telefon” tylko za prefiksami (`max-sm:`, `sm:hidden`) albo w `@media (hover: none) and (pointer: coarse)`.
8. Równolegle mogą iść sesje etapu 1 (waluty, faktura do paragonu, przeprowadzka, sklepy). Przed startem: `gh pr list --state open` i unikaj tych samych plików.
9. Po kroku: wiersz w dzienniku, nowy „Następny krok”, raport (status, tabela weryfikacji, numer PR, co dalej) i STOP.

---

## 1. Cel i zakres

**Cel.** Klient JDG rozlicza się sam. Co miesiąc widzi, ile i do kiedy zapłacić: podatek albo ryczałt, ZUS, składkę zdrowotną i VAT. Ma ewidencję albo KPiR prowadzoną w programie (od 2027 obowiązek dla wszystkich na PIT) i wysyła JPK_V7M bez wychodzenia z FaktWay. To płatny rdzeń planu 29,99 zł.

**Wchodzi do v1**
- JDG bez pracowników.
- PIT: ryczałt (wszystkie stawki, także próg 100 tys. zł przy najmie), skala, liniowy.
- VAT: czynny miesięczny (JPK_V7M) i zwolniony podmiotowo.
- ZUS:
  - ulga na start;
  - preferencyjny;
  - pełny;
  - „etat obok”: przy zbiegu tytułów nie ma składek społecznych, zdrowotna zostaje;
  - chorobowe dobrowolne.
- Składka zdrowotna dla trzech form.
- Terminy, przypomnienia, „ile odłożyć”.
- Ewidencja przychodów i KPiR w programie, pliki JPK_EWP(4) i JPK_PKPIR(3).
- Wysyłka JPK_V7M przez API MF.

**Poza v1 (krok K9 albo 2028)**
- Mały ZUS Plus.
- Rozliczenia kwartalne: V7K, ryczałt kwartalny, zaliczki kwartalne.
- Roczne PIT-28/36/36L i roczne rozliczenie zdrowotnej. Za 2027 składa się je w 2028.
- Wysyłka JPK_EWP/PKPIR z zeznaniem. Grupa spoza V7M pierwszy raz w 2028.
- Środki trwałe i amortyzacja (JPK_ST).
- Pracownicy.
- VAT marża, WNT/WDT/import usług ponad to, co obsługuje generator.
- Ulgi (IP Box, B+R, internet, dzieci), wspólne rozliczenie.
- **Porównanie form opodatkowania** (`tax.simulate`). To pozycja „czerwona”: bez pisemnej opinii prawnika nie budujemy.

**Dlaczego ryczałt pierwszy:**
- to najliczniejsza grupa: ponad 945 tys. zeznań PIT-28 za 2025;
- ma najprostszy rachunek;
- na nim stoi hasło „zamiast księgowej za 300 zł” (na Wykopie młodzi na B2B piszą o 260-400 zł netto miesięcznie przy kilku dokumentach).

---

## 2. Decyzje

„Zapadła” oznacza, że wynika z analiz i ustaleń 28-29.10. „Do potwierdzenia” Bartosz zatwierdza w K0.

| # | Decyzja | Stan |
|---|---|---|
| D1 | Zakres v1 jak w sekcji 1 | zapadła: Bartosz potwierdził bez zmian 5.11.2026 (K0) |
| D2 | Kolejność: parametry, profil, ewidencja ryczałtu, silniki ryczałtu, terminy, VAT z wysyłką, skala i liniowy, pilot | zapadła: Bartosz potwierdził bez zmian 5.11.2026 (K0) |
| D3 | Profil podatkowy w nowej tabeli `tax_profiles` z historią (`valid_from`). Nie w `flo_prefs.tax_profile`, bo nic go nie zapisuje, i nie w kolejnych kolumnach `tenants`. Status VAT zostaje w `tenants.vat_exemption_basis`, bo używa go KSeF | zapadła |
| D4 | Stawka ryczałtu na pozycji faktury w `invoice_line_items.ryczalt_rate`. Kolumna istnieje od 00001 i jest nieużywana. Domyślna stawka pochodzi z profilu albo produktu. **Stawkę wybiera klient, program jej nie dobiera** (opis i odnośnik do podatki.gov.pl) | zapadła |
| D5 | Ewidencja i KPiR liczone na żywo z faktur i kosztów (jak dziś `lib/reports/kpir-data.ts`), do tego nowa tabela wpisów ręcznych. `kpir_entries` zostaje nietknięta; DROP tylko za zgodą Bartosza | zapadła |
| D6 | Rozliczenie miesiąca to migawka w `tax_settlements`. Szkic liczy się od nowa, zatwierdzone jest niezmienne. Zmiana danych po zatwierdzeniu tworzy nową wersję i komunikat dla klienta | zapadła |
| D7 | Parametry tylko z `lib/ksiegowosc/parametry/`: rok po roku, źródło i data przy każdej liczbie, flaga „sprawdziła księgowa” dla każdej sekcji. Atrapy z `lib/flo/tax-params.ts` (ZUS 400/700/1600) usuwamy. Brak sprawdzonych parametrów oznacza brak kwoty i komunikat z wyjściem | zapadła |
| D8 | Bez porad. Liczymy z danych klienta, nie zalecamy formy ani stawki i nie piszemy w trybie rozkazującym („Według Twoich danych wychodzi 1 234 zł, termin 20 marca”). Model językowy nie liczy i nie objaśnia przepisów (`lib/flo/tax-topic.ts`) | zapadła |
| D9 | Wysyłka JPK_V7M przez API MF. Klient wpisuje dane autoryzujące przy każdej wysyłce i nie zapisujemy ich. Najpierw próba na środowisku testowym i opinia prawnika. Do tego czasu plik do pobrania | zapadła: Bartosz potwierdził bez zmian 5.11.2026 (K0) |
| D10 | Wyłączniki: globalny `killKsiegowosc` w `global_feature_flags`, blokada w kodzie dla każdej sekcji, włączenie dla konkretnej firmy (pilot). Wzór warstw z `lib/flo/kind-switch.ts`, ale osobny moduł | zapadła |
| D11 | Klientom włączamy dopiero po bramie z sekcji 11: spółka, prawnik, OC, księgowa, pilot | zapadła |
| D12 | Kwoty w silnikach w groszach jako liczby całkowite; zaokrąglenia według sekcji 4 | zapadła |
| D13 | Karta „Odłóż na podatek” przestaje liczyć „19 % liniowy” dla wszystkich. Przy profilu bierze kwoty z modułu, bez profilu pokazuje „uzupełnij ustawienia podatkowe” | zapadła |
| D14 | Z FLO bierzemy tylko czyste funkcje: `taxDeadline`, kalendarz świąt, `vat-limit`, logikę z `tax-relief`, a `tax-setaside` jako wzór. Znacznik NIEAKTYWNE zdejmujemy tam, gdzie funkcja zyskuje importera. Propozycje agenta zostają wyłączone | zapadła |
| D15 | Zapłata spoza wyliczenia (dawna decyzja (1)): składki zapłacone za okres, którego moduł nie liczy (np. za grudzień 2025 r., niepełny miesiąc), klient zapisuje z kwotą z PUE ZUS. Zapis to wersja rozliczenia w `tax_settlements` z `migawka.reczna`, więc pomniejsza podatek jak zapłata wyliczonej kwoty, a późniejsze wyliczenie tego okresu dolicza tylko różnicę; okres od 2025 r. (00172) | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”); K7.2 |
| D16 | Eksport JPK_V7M (dawna decyzja (2)): zostaje wyłączony do bramy z sekcji 11, a JDG ma poprawny plik osoby fizycznej w zakładce „VAT”. Przy włączeniu modułu dla wszystkich eksport dostanie dane osoby fizycznej tak jak ekran VAT (zamiast odwieszania tylko dla spółek: forma prawna firmy nie jest w danych pewna) | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”) |
| D17 | VAT w „Ten miesiąc” i przypomnienie przed 25. (dawna decyzja (3)) | zapadła: Bartosz wybrał 8.11.2026; K7.1 (#452) |
| D18 | Produkcyjny certyfikat MF (dawna decyzja (4)): pobranie razem z włączeniem wysyłki po opinii prawnika (B2); do tego czasu produkcja odmawia przed wysyłką, więc wcześniejsze pobranie nic nie daje | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”) |
| D19 | Spis z natury (dawna decyzja (5)): klient zapisuje spis z natury (data, wartość); JPK_PKPIR bierze z niego P_1 i P_2, a KPiR pokazuje go przy zakupie towarów | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”); K7.4 |
| D20 | Raport `/reports/kpir` (dawna decyzja (6)): firma z modułem widzi w nim odesłanie do księgi modułu (KPiR przy skali i liniowym, ewidencja przy ryczałcie), żeby nie było dwóch różnych ksiąg; firma bez modułu ma raport bez zmian | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”); K8 |
| D21 | Fundusz Pracy (dawna decyzja (7)): FaktWay sam dopisuje do KPiR (kolumna 13) Fundusz Pracy i FS z zapłaconych składek ZUS, w dniu zapłaty, także z zapłaty spoza wyliczenia | zapadła: Bartosz zlecił 8.11.2026 („decyzje z planu podejmij za mnie na najbardziej korzystne”); K7.3 |

---

## 3. Fakty z kodu (`origin/main` @ `7a249d3f`, 4.11.2026)

| Obszar | Stan | Pliki |
|---|---|---|
| Profil podatkowy FLO | martwy: JSON w `flo_prefs.tax_profile` z jedną stawką ryczałtu, żaden formularz go nie zapisuje | `lib/flo/tax-profile.ts:48-138`, `supabase/migrations/00061_flo.sql:148-159` |
| Dane podatkowe firmy, które działają | `tenants.vat_exemption_basis` (00091), `tax_office_code` (00092), `vat_cash_method` (00094), `business_started_on` (00153; nowe kolumny wymagają jawnego GRANT SELECT, 00112) | `components/settings/*`, `app/actions/{vat-exemption,tax-office,cash-method,business-start}.ts` |
| Brakuje | forma opodatkowania, stawki ryczałtu dla rodzajów przychodu, etap ZUS, daty ulg, chorobowe, okres rozliczeń | |
| Parametry | `lib/flo/tax-params.ts`: jeden wiersz 2026, `PARAMS_VERIFIED=false`, `source=''`, ZUS to atrapy. Kalendarz świąt i `taxDeadline` są prawdziwe. Limit VAT 240 000 z tej tabeli używa pulpit | `lib/flo/tax-params.ts:33-286`, `tests/unit/flo-tax-params.test.ts:45-72` (test pęknie po 29.08.2027) |
| Funkcje FLO | `vat-limit` działa na pulpicie. `tax-deadline`, `tax-relief`, `tax-setaside` to czyste funkcje, wyłączone i bez importera. `tax-simulate` nie istnieje | `lib/flo/functions/*`, `lib/flo/flags.ts:39-95`, strażnik `tests/unit/flo-nieaktywne.test.ts` |
| KPiR | liczona na żywo z faktur i `expenses`, eksport do Excela (17 kolumn, prawdopodobnie stary wzór). Brak JPK_PKPIR i wpisów ręcznych. `kpir_entries` nieużywana | `lib/reports/kpir-data.ts`, `components/reports/kpir/kpir-model.ts`, `lib/exports/kpir-generator.ts` |
| Koszty | z KSeF przez `runAutoCategorizeInbox`, ze zdjęć przez `runProcessOcr`; kolumna KPiR, VAT odliczalny i przeliczenie NBP są gotowe | `lib/jobs/runners/auto-categorize-inbox.ts`, `lib/categorization/*` |
| JPK_V7M(3) | generator i walidator XSD gotowe. **Format wyłączony w interfejsie** (`SUSPENDED_EXPORT_FORMATS`). Brak odwrotnego obciążenia (błąd jawny) i przeniesienia nadwyżki (P_39) | `lib/exports/jpk-v7m-generator.ts`, `lib/exports/suspended-formats.ts:19-41`, `tests/unit/jpk-v7m-wstrzymany*.test.ts` |
| Pulpit | szacunek podatku na sztywno 19 % liniowego bez ZUS (`LINEAR_PIT_RATE`) | `lib/dashboard/tax-estimate.ts:17`, `components/przeplywy/finora-1do1/adaptery.ts:214` |
| Crony | 29 w `CRON_JOBS`. Testy na sztywno: 29 i 50 zadań. Wzór idempotencji: `trial-countdown-emails` z `billing_notifications` UNIQUE | `lib/jobs/queues.ts:89-140`, `tests/unit/jobs-foundation.test.ts:211`, `tests/unit/jobs-registry.test.ts:208` |
| Wpłaty | `payments` tylko dla faktur sprzedaży. RPC `mark_invoice_paid` (00158). Oznaczania zapłaty kosztów brak | `supabase/migrations/00158_invoice_manual_payment.sql` |
| Przypomnienia | tylko płatności faktur. Push: `sendPushToUser`/`sendPushToTenant`. Mail: `sendEmail` | `lib/reminders/*`, `lib/push/sender.ts`, `lib/email/send.ts:344` |

---

## 4. Zasady liczenia: ŁAMANIE ICH TO BŁĄD KRYTYCZNY

1. **Przychód** liczymy tylko z faktur przyjętych w aktywnym środowisku KSeF (`direction='outgoing'`, nigdy `'issued'`) i z wpisów ręcznych:
   - korekta wchodzi jako różnica w swoim miesiącu;
   - zaliczek nie dublujemy (`lib/invoices/settled-advances.ts`);
   - data przychodu według przepisów PIT, wspólna z KPiR (`kpirSaleEventDate`).
2. **Faktura do paragonu** nie jest drugim przychodem, jeśli sprzedaż weszła już z raportu kasy. Oznaczenie FP wyklucza ją z przychodu.
3. **Waluty:** przychód i koszt w walucie przeliczamy po średnim kursie NBP z ostatniego dnia roboczego przed dniem przychodu albo kosztu (`lib/nbp/client.ts`). Nie sumujemy EUR z PLN.
4. **Paginacja:** sumy po wielu wierszach przez `lib/accounting/read-complete-pages.ts`.
5. **Miesiąc** liczymy w strefie Europe/Warsaw (`todayInWarsaw`, `lib/format/warsaw-date.ts`).
6. **Zaokrąglenia** (art. 63 Ordynacji podatkowej):
   - podstawy opodatkowania i podatek do pełnych złotych;
   - składki ZUS i zdrowotna do groszy;
   - kwoty w części deklaracyjnej JPK_V7M do pełnych złotych;
   - ewidencje do groszy.

   Każda reguła ma test.
7. **Parametry** tylko z `lib/ksiegowosc/parametry/`. Żadnych stawek na sztywno w kodzie, w tym w kartach pulpitu.
8. **Fail-closed z wyjściem:** brak profilu albo niesprawdzone parametry oznaczają brak kwoty. Zamiast niej komunikat z nazwą braku i tym, co klient ma zrobić, oraz ścieżka operatora (ekran w `/admin` albo PR z parametrami).
9. **Bez porad** (D8). Tekst nie zaleca, nie porównuje form i nie mówi „zapłać”. Mówi, ile wychodzi z danych i jaki jest termin z przepisów.
10. **Zatwierdzone rozliczenie jest niezmienne** (D6).
11. **RLS na każdej nowej tabeli.** Strony i akcje używają klienta z sesji, klucz serwisowy tylko w zadaniach. Każda zmiana profilu i zatwierdzenie idą do `audit_logs`.
12. **Zadania w tle:** każde ponowienie zaczyna od zera, więc każdy krok z efektem (mail, push, wysyłka JPK) ma klucz idempotencji.

---

## 5. Przepisy i parametry

Źródła odczytane 4.11.2026; listę adresów zawiera sekcja 14. **Wszystko o pewności średniej albo niskiej księgowa potwierdza przed bramą z sekcji 11.**

| Obszar | 2026 | 2027 | Pewność | Uwagi |
|---|---|---|---|---|
| Ryczałt: stawki | 17 % wolne zawody; 15 % część usług niematerialnych; 14 % zdrowie, architektura, inżynieria; 12 % wybrane usługi IT; 10 % obrót nieruchomościami; 8,5 % najem (powyżej 100 tys. zł 12,5 %) i pozostałe usługi; 5,5 % wytwórczość, budowlanka; 3 % handel, gastronomia | bez zmian w źródłach | wysoka | stawkę usług ustala się zwykle po PKWiU |
| Ryczałt: odliczenia | od przychodu: zapłacone składki społeczne i 50 % zapłaconej zdrowotnej | bez zmian | wysoka | niewykorzystane odliczenie przechodzi na kolejne miesiące roku |
| Ryczałt: termin | do 20. za poprzedni miesiąc, za grudzień do 20 stycznia; formularz PPE na mikrorachunek | bez zmian | wysoka | kwartalny: K9 |
| Ryczałt: limity | 2 mln euro = 8 517 200 zł; wpłaty kwartalne 200 tys. euro = 851 720 zł (kurs 4,2586 z 1.10.2025) | przeliczyć po kursie NBP z 1.10.2026 | wysoka (2026) | |
| Skala | 12 % do 120 000 zł, kwota zmniejszająca 3 600 zł; powyżej 10 800 zł + 32 % nadwyżki; zaliczki do 20.; składki społeczne odliczane od dochodu; zdrowotna nieodliczana | bez zapowiedzi zmian | wysoka (stawki), średnia (zaliczki) | |
| Liniowy | 19 %; zdrowotna odliczana od dochodu do limitu rocznego: 14 100 zł (podatki.gov.pl, sprawdzone w K1) | bez zmian stawki; limit 2027 ogłasza MF w grudniu | wysoka (stawka, limit 2026) | art. 30c ustawy o PIT |
| Zdrowotna, ryczałt | 9 % od 60 / 100 / 180 % przeciętnego wynagrodzenia z IV kw. roku poprzedniego, progi przychodu 60 / 300 tys. zł: **498,35 / 830,58 / 1 495,04 zł** | **nieznane do stycznia 2027** (GUS, IV kw. 2026) | średnia | rok składkowy luty-styczeń |
| Zdrowotna, skala | 9 % dochodu, minimum 9 % płacy minimalnej: 432,54 zł | minimum **445,50 zł** (9 % × 4 950 zł) od lutego 2027 | średnia | podstawą jest dochód z poprzedniego miesiąca |
| Zdrowotna, liniowy | 4,9 % dochodu, minimum jak skala | jak skala | średnia | |
| Reforma zdrowotnej | zawetowana w 2025; projekt UD428 (zwrot nadpłat z urzędu) nieuchwalony | brak reformy w źródłach | niska | sprawdzić w styczniu |
| Płaca minimalna | 4 806 zł | **4 950 zł** (Dz.U. 2026 poz. 1213) | wysoka | |
| Prognozowane przeciętne wynagrodzenie | 9 420 zł (podstawa pełnego ZUS 5 652 zł) | **10 033 zł w projekcie budżetu** (podstawa 6 019,80 zł) | średnia (2027) | ostatecznie po ustawie budżetowej i komunikacie ZUS |
| ZUS pełny | społeczne z chorobową i Funduszem Pracy: 1 926,76 zł | ok. 2 052,14 zł (przy 10 033 zł) | średnia | stopę wypadkową dla płatników do 9 osób ZUS zmienia co roku od 1 kwietnia |
| ZUS preferencyjny | podstawa 30 % płacy minimalnej (1 441,80 zł), społeczne z chorobową 456,18 zł (tabela ZUS z 2.02.2026, sprawdzone w K1), 24 mies. | podstawa 1 485 zł, ok. 469,85 zł | średnia | bez Funduszu Pracy |
| Ulga na start | 6 mies. bez społecznych, zdrowotna płatna | bez zmian | średnia | |
| ZUS: termin, DRA | do 20., na rachunek składkowy (NRS) | bez zmian | niska | kiedy DRA jest obowiązkowa: potwierdzić na zus.pl |
| VAT | JPK_V7M(3) / V7K(3) od 1.02.2026, do 25.; limit zwolnienia 240 000 zł | bez zmian w źródłach | wysoka (schematy), średnia (limit) | przestrzeń V7M(3): `http://crd.gov.pl/wzor/2025/12/19/14090/` |
| Księgi w programie | od 1.01.2026 podatnicy z JPK_V7M | od 1.01.2027 **wszyscy pozostali** na PIT | wysoka | nowy wzór KPiR od 2026 (Dz.U. 2025 poz. 1299) z numerem KSeF i identyfikatorem kontrahenta |
| JPK_PKPIR / JPK_EWP | przesyłane w terminie zeznania | w 2027 tylko grupa V7M za 2026 (do 30.04.2027); pozostali za 2027 w 2028 | wysoka | JPK_PKPIR(3): `http://jpk.mf.gov.pl/wzor/2024/10/30/10302/`; JPK_EWP(4): `.../10301/` |
| PIT roczne | PIT-28/36/36L od 15 lutego do 30 kwietnia | jak 2026 | wysoka | K9 |
| Mikrorachunek | 26 cyfr: 2 cyfry kontrolne, 10100071, 222, cyfra typu (2 = NIP), identyfikator, zera (w K1 poprawione z „22” według podatki.gov.pl); PIT, ryczałt (PPE) i VAT | bez zmian | wysoka | cyfry kontrolne mod 97 jak NRB; wektor testowy z generatora podatki.gov.pl |
| Rachunek ZUS (NRS) | indywidualny, z PUE ZUS | bez zmian | niska | klient wpisuje sam |
| Ewidencja: zaliczki | ZAL w miesiącu zaliczki, ROZ pomniejszona o rozliczone zaliczki, jak KPiR (`kpirRevenueNet`) | bez zmian | niska | art. 14 ust. 3 pkt 1 ustawy o PIT: zaliczka na dostawę wykonaną w następnym okresie nie jest przychodem. Księgowa rozstrzyga przed bramą; zmiana dotyczy też KPiR (K3) |
| Ewidencja: korekty | różnica w dniu wystawienia korekty | bez zmian | średnia | korekta z powodu błędu rachunkowego albo oczywistej omyłki zmienia okres pierwotny (art. 14 ustawy o PIT); program tego nie rozpozna. Księgowa potwierdza (K3) |
| JPK_EWP(4) | schemat `http://jpk.mf.gov.pl/wzor/2024/10/30/10301/` (pobrany 5.11.2026, `lib/exports/schemas/jpk-ewp4/`); jeden wiersz to jeden przychód z jedną stawką; osoba fizyczna: NIP, imię, nazwisko, data urodzenia | bez zmian w źródłach | wysoka | próg 100 tys. zł przy najmie (K_9 = 12,5) i znacznik `Kasowy_PIT`: K4 |
| Zdrowotna, ryczałt: próg (K4) | przychód od początku roku pomniejszony o zapłacone składki społeczne bez FP; wyższa składka od miesiąca przekroczenia, bez korekty miesięcy wcześniejszych (biznes.gov.pl, ZUS) | bez zmian | średnia | czy pomniejszenie dotyczy testu progu, źródła nie mówią wprost; księgowa potwierdza w G1 i G5 |
| Ryczałt: kilka stawek (K4) | odliczenia proporcjonalnie do przychodu z każdej stawki (zdrowotna: podatki.gov.pl; społeczne: podział neutralny, D8); podstawa każdej stawki i ryczałt z sumy do pełnych złotych | bez zmian | średnia | księgowa potwierdza w G4 |
| Odliczenia ryczałtu (K4) | składki zapłacone w miesiącu to te oznaczone w FaktWay „Zapłacone” z datą; przy kolejnej wersji rozliczenia liczy się dopłata | bez zmian | wysoka (zasada), — (dane) | składki płacone poza programem trzeba oznaczyć, inaczej odliczenia nie ma (ryczałt wychodzi wyższy, nie niższy) |
| Składki: miesiąc niepełny (K4) | etap ZUS zaczyna się albo kończy w trakcie miesiąca (poza startem ulgi): brak samych składek społecznych z wyjściem (PUE ZUS, księgowa); ryczałt i zdrowotna liczą się dalej | bez zmian | — | podstawa proporcjonalna do dni: po pilotażu, jeśli będzie potrzebna (G13) |
| Start w trakcie miesiąca (K4) | miesiąc liczy się z pierwszej wersji ustawień z tego miesiąca; zdrowotna w pełnej kwocie (bez proporcji za niepełny miesiąc); składki: ulga to zero, pełne od dnia w trakcie miesiąca to brak (proporcja) | bez zmian | średnia | księgowa potwierdza pełną zdrowotną (G13) |
| Korekta większa niż przychód (K4) | zmniejsza przychód tej samej stawki w kolejnych miesiącach roku (art. 14 ust. 1m i 1n ustawy o PIT przez art. 6 ust. 1a ustawy o ryczałcie) | bez zmian | średnia | ujemna reszta po grudniu zostaje do zeznania rocznego (K9) |
| Najem: korekta po progu (K4) | korekta in minus po przekroczeniu 100 tys. zł najpierw zmniejsza nadwyżkę 12,5 %, resztę 8,5 % (roczny ryczałt to 8,5 % do progu i 12,5 % ponad nim) | bez zmian | średnia | księgowa potwierdza w G3 |
| Zdrowotna: styczeń przy kontynuacji ryczałtu (K4) | kod liczy próg za styczeń od przychodu stycznia; ZUS może wymagać progu z przychodu całego poprzedniego roku, bo styczeń należy do roku składkowego luty-styczeń | bez zmian | niska | księgowa rozstrzyga w G5 przed pilotażem (kwot i tak nie widać przed podpisem parametrów, D7) |
| Zapłata spoza wyliczenia (po K4) | składki za miesiąc, którego FaktWay nie liczy (brak, np. niepełny miesiąc albo zdrowotna za styczeń 2026 bez parametrów 2025/2026) i za grudzień 2025 nie mają wiersza do „Zapłacone”, więc nie pomniejszają ryczałtu (wychodzi wyższy, nie niższy) | bez zmian | — | do decyzji Bartosza: ręczna zapłata z kwotą z PUE ZUS (krok K4.1 albo część K5) |
| Metoda kasowa PIT (K4) | poza v1: profil jej nie ma, `Kasowy_PIT` w JPK_EWP pomijany (NIE) | bez zmian | — | do decyzji Bartosza, jeśli piloci jej potrzebują |
| Skala i liniowy: zaliczka (K7) | dochód od początku roku z KPiR (przychód minus koszty) minus składki społeczne bez FP oznaczone w roku jako zapłacone, najwyżej do wysokości dochodu; przy liniowym także zapłacona zdrowotna do limitu rocznego; podstawa do pełnych złotych; zaliczka to podatek od początku roku minus zaliczki należne za wcześniejsze miesiące, nie mniej niż zero (art. 44 ust. 3f ustawy o PIT) | jak 2026; limitu liniowego 2027 jeszcze nie ma, więc zaliczka liniowa za 2027 to brak | średnia | księgowa potwierdza w G8-G11; strata miesiąca zmniejsza dochód od początku roku, strata roku zostaje do zeznania (K9) |
| Zdrowotna od dochodu (K7) | 9 % (skala) albo 4,9 % (liniowy) dochodu z poprzedniego miesiąca: przychód minus koszty z KPiR minus składki społeczne zapłacone w tamtym miesiącu; nie mniej niż minimum roku składkowego (432,54 zł); za styczeń dochód z grudnia | minimum od lutego 2027 z płacy minimalnej 4 950 zł | średnia | strata albo dochód poniżej podstawy minimum daje minimum; roczne rozliczenie zdrowotnej (K9) |
| KPiR: kolumny (K7) | wzór 2026: koszt z modułu Koszty wchodzi do kolumny ustawionej przy koszcie (10-13; koszt B+R do 13 z opisem w 16); koszt bez kolumny albo z kolumną przychodu to brak z wyjściem do Kosztów; wpis ręczny ma kolumnę 7, 8 albo 10-13; kolumny 9 i 14 liczy program | bez zmian | wysoka (wzór), — (dane) | numer KSeF w kolumnie 3, identyfikator kontrahenta w 4; nazwa i adres kontrahenta (K_5A, K_5B) są w schemacie obowiązkowe, więc bez danych idzie „BRAK” jak w JPK_V7M (broszura JPK_PKPIR tego nie opisuje; księgowa potwierdza) |
| KPiR: Fundusz Pracy i składki (K7, K7.3) | FP i FS z zapłaconych składek to przy skali i liniowym koszt (kolumna 13) w dniu zapłaty: FaktWay dopisuje je do KPiR sam z zapłaconych wersji składek społecznych (przyrost jak przy odliczeniach, także z zapłat spoza wyliczenia, D21); składki społeczne (przy liniowym także zdrowotna) idą do odliczenia od dochodu, nie do KPiR, inaczej odliczyłyby się dwa razy | bez zmian | wysoka (zasada), — (dane) | wiersz ma dowód „Składki ZUS za MM/RRRR” i kontrahenta ZUS; JPK_PKPIR go zawiera |
| KPiR: spis z natury (K7, K7.4) | klient zapisuje spis z natury (data, wartość); JPK_PKPIR: P_1 to spis z 31 grudnia poprzedniego roku albo z 1 stycznia, P_2 spis z 31 grudnia (tylko w pliku za cały rok), pozostałe spisy z okresu w PKPIRSpis; P_3 to wydatki plus P_1 minus P_2, P_4 przychód minus P_3 (objaśnienia do KPiR, broszura JPK_PKPIR(3)) | bez zmian | wysoka (pola), średnia (P_1 przy starcie w trakcie roku) | zaliczki miesięczne spisu nie biorą (spis zmienia dochód roczny, K9); przy starcie w trakcie roku spis z dnia startu trafia do PKPIRSpis, nie do P_1: księgowa potwierdza |

**Kalendarz 2027 (do sprawdzenia przez `taxDeadline` z przesunięciami weekendów i świąt)**

| Termin | Obowiązek | Kogo dotyczy |
|---|---|---|
| 20.01 | zaliczka PIT/ryczałt i ZUS za grudzień 2026 | wszyscy |
| 25.01 | JPK_V7M za grudzień i VAT | czynni VAT |
| 1.02 | nowy rok składkowy zdrowotnej, minimum 445,50 zł; nowe kwoty ryczałtu po komunikacie GUS | wszyscy |
| 15.02 | start składania PIT-28/36/36L za 2026 | wszyscy |
| 22.02 | zaliczki i ZUS za styczeń; ostatni dzień wyboru liniowego (20.02 to sobota) | wszyscy |
| 20. (z przesunięciem): 22.03, 20.04, 20.05, 21.06, 20.07, 20.08, 20.09, 20.10, 22.11, 20.12 | zaliczka PIT/ryczałt i ZUS za poprzedni miesiąc | wszyscy |
| 25. (z przesunięciem): 25.02, 25.03, 26.04, 25.05, 25.06, 26.07, 25.08, 27.09, 25.10, 25.11, 27.12 | JPK_V7M i VAT | czynni VAT |
| 30.04 | PIT-28/36/36L za 2026; JPK_PKPIR/EWP za 2026 dla grupy V7M | wszyscy / V7M |
| 20.05 (do potwierdzenia) | roczne rozliczenie zdrowotnej | wszyscy |

---

## 6. Model danych (propozycja do K2-K6)

Wszystkie tabele mają `tenant_id`, RLS, polityki dla `authenticated` i testy w `tests/rls-ksiegowosc-*.test.ts`. Zapis profilu idzie przez akcje z audytem.

| Tabela | Kolumny (najważniejsze) | Krok |
|---|---|---|
| `tax_profiles` | `tenant_id`, `valid_from` (zmiana formy tylko od 1 stycznia albo od startu), `forma` (`ryczalt`/`skala`/`liniowy`), `okres` (`M`; `K` w K9), `stawka_domyslna` (dla ryczałtu), `zus_etap` (`ulga_na_start`/`preferencyjny`/`pelny`/`etat_obok`; `maly_zus_plus` w K9), `zus_od`, `chorobowe`, `nrs_zus` (opcjonalnie), `created_by` | K2 |
| `invoice_line_items.ryczalt_rate` | istnieje; wypełniamy przy wystawianiu z profilu albo produktu | K2-K3 |
| `ledger_manual_entries` | przychody i koszty bez faktury z KSeF (raport kasy za miesiąc, inne), dokument, data, kwota, stawka, kolumna KPiR, opis; od 00171 wpis ma stawkę ryczałtu albo kolumnę KPiR (`k7`, `k8`, `k10`-`k13`), nigdy oba i nigdy żadne (CHECK) | K3, K7 |
| `tax_settlements` | `okres` (pierwszy dzień miesiąca; od 2025 r. tylko dla zapłat spoza wyliczenia, 00172), `rodzaj` (`ryczalt`/`pit`/`vat`/`zus_spoleczne`/`zdrowotna`), `kwota_gr`, `termin`, `status` (`szkic`/`zatwierdzone`/`zaplacone`), `migawka` jsonb (wejścia, parametry, wersja), `parametry_wersja`, `wejscia_hash`, `zatwierdzone_przez/_o`, `zaplacone_o`, `wersja`, `zastapione_przez` | K4 |
| `tax_notifications` | `rozliczenie` (RRRR-MM), `etap` (`wyliczone`, `termin-5:RRRR-MM-DD`, `termin-1:RRRR-MM-DD`), `status` (`sending`/`sent`/`failed`), `wynik`, `blad`; klucz UNIQUE (`tenant_id`, `rozliczenie`, `etap`) jako idempotencja cronów; tylko service_role (00169) | K5 |
| `jpk_submissions` | `okres`, `rodzaj` (`JPK_V7M`), `cel`, `srodowisko` (`test`/`produkcja`), `skrot_pliku` (SHA-256 w Base64), `deklaracja` (P_38-P_62 w pełnych złotych; P_62 przyjętej deklaracji to P_39 następnego miesiąca), `stan` (`wysylanie`/`w_toku`/`przyjeta`/`odrzucona`/`przerwana`), `numer_referencyjny`, `status_kod`, `status_opis`, `upo_sciezka`, `blad`, znaczniki czasu; jedna wysyłka w toku na miesiąc (indeks częściowy), przejścia stanów w wyzwalaczu; bez danych autoryzujących i bez pliku (00170) | K6 |
| `ledger_inventory_counts` | spis z natury: `data` (od 31.12.2025), `kwota_gr`, `opis`; jeden na dzień, bez UPDATE, zapis i usunięcie owner/admin (00173) | K7.4 |

Nowe kolumny w `tenants` (jeśli jednak potrzebne) wymagają jawnego GRANT SELECT według 00112 i testu `tests/unit/dane-ksef-uprawnienia-kolumn.test.ts`.

---

## 7. Silniki (`lib/ksiegowosc/`, czyste funkcje, kwoty w groszach)

| Plik | Co liczy | Krok |
|---|---|---|
| `parametry/index.ts`, `parametry/2026.ts`, `parametry/2027.ts` | parametry z polami `zrodlo`, `odczyt`, `sprawdzila` (księgowa i data) dla każdej sekcji; `parametryNa(data)`; `brakujace(data)` dla komunikatu fail-closed | K1 |
| `kalendarz.ts` | święta, dni robocze, terminy (przeniesione z `lib/flo/tax-params.ts`, FLO importuje stąd) | K1 |
| `mikrorachunek.ts` | numer z NIP i walidacja | K1 |
| `ewidencja.ts` | ewidencja przychodów z faktur i wpisów ręcznych (zasady z sekcji 4) | K3 |
| `kpir.ts` | KPiR według wzoru 2026 (K_1-K_17) z faktur, kosztów i wpisów ręcznych, sumy miesiąca i braki z wyjściem; odczyt w `kpir-dane.ts` (faktury wspólne z ewidencją, koszty jak raport KPiR) | K7 |
| `ryczalt.ts` | ryczałt za miesiąc: przychód według stawek (z progiem najmu), minus odliczenia (społeczne, 50 % zdrowotnej) z przeniesieniem nadwyżki, zaokrąglenie | K4 |
| `zdrowotna.ts` | ryczałt: próg z przychodu narastająco; skala i liniowy: od dochodu z poprzedniego miesiąca z minimum; rok składkowy luty-styczeń | K4, K7 |
| `zus.ts` | składki społeczne według etapu, chorobowe, Fundusz Pracy, „etat obok” | K4 |
| `pit.ts` | zaliczki narastająco: skala (12/32, kwota zmniejszająca) i liniowy (odliczenie zdrowotnej do limitu) | K7 |
| `vat.ts` | VAT do zapłaty z JPK_V7M (`summarizeJpkV7m`) z przeniesieniem nadwyżki (P_39) | K6 |
| `odlozyc.ts` | „ile odłożyć”: suma przewidywanych zobowiązań bieżącego miesiąca z danych do dziś, oznaczona jako szacunek | K5 |
| `jpk-ewp.ts`, `jpk-pkpir.ts` | generatory z walidacją XSD (xmllint jak w `jpk-v7m-validator.ts`, wspólny walidator w `jpk-ewp-walidator.ts`; schematy w `lib/exports/schemas/jpk-ewp4/` i `jpk-pkpir3/`) | K3, K7 |

**Złote przypadki.** Testy silników opierają się na arkuszu, który policzy i podpisze księgowa (`tests/fixtures/ksiegowosc/zlote/*.json`, pola `policzyla`, `data`). Test sprawdza wynik co do grosza dla każdego miesiąca roku:

| # | Przypadek |
|---|---|
| G1 | Ryczałt 12 % (IT), VAT czynny, ulga na start, przychód 15 000 zł miesięcznie, zmiana progu zdrowotnej w trakcie roku |
| G2 | Ryczałt 12 %, ZUS preferencyjny, zwolniony z VAT, 8 000 zł miesięcznie |
| G3 | Ryczałt 8,5 % najem, przekroczenie 100 tys. zł (12,5 %) |
| G4 | Dwie stawki ryczałtu w jednym miesiącu |
| G5 | Ryczałt, pełny ZUS, przekroczenie 300 tys. zł przychodu w trakcie roku |
| G6 | Ryczałt, etat obok (bez społecznych) |
| G7 | Ryczałt, odliczenia większe niż ryczałt w miesiącu (przeniesienie) |
| G8 | Skala, ZUS preferencyjny, 6 000 zł dochodu miesięcznie |
| G9 | Skala, przekroczenie 120 tys. zł w trakcie roku |
| G10 | Liniowy, pełny ZUS, odliczenie zdrowotnej do limitu |
| G11 | Skala albo liniowy, strata w miesiącu i minimalna zdrowotna |
| G12 | VAT: 23 %, zakup z odliczeniem 50 % (samochód), korekta, nadwyżka z poprzedniego miesiąca |
| G13 | Start działalności w trakcie roku (proporcja limitu VAT, pierwszy termin) |
| G14 | Grudzień i terminy w styczniu, przesunięcia weekendów |

---

## 8. Ekrany i treści

Miejsce: sekcja „Księgowość” w menu (dziś KPiR i eksport) dostaje cztery podstrony:
- „Ten miesiąc”;
- „Ewidencja”, a przy skali i liniowym „KPiR”;
- „VAT”;
- „Ustawienia podatkowe”.

Wszystko za wyłącznikiem `ksiegowosc` i z komponentów Finory.

- **Kreator ustawień podatkowych** (pierwsze wejście):
  - forma;
  - stawka ryczałtu z opisem grup i odnośnikiem do podatki.gov.pl, bez podpowiadania;
  - status VAT z istniejących ustawień;
  - etap ZUS i data;
  - chorobowe;
  - „pracuję na etacie co najmniej za płacę minimalną”;
  - rachunek ZUS (opcjonalnie).
- **Ten miesiąc:**
  - kafle: przychód, koszty, podatek albo ryczałt, ZUS, zdrowotna, VAT;
  - lista „Do zapłaty” z terminami i danymi do przelewu (mikrorachunek, tytuł, kwota) i przyciskiem „Zapłacone”;
  - przycisk „Zatwierdź miesiąc”;
  - historia wersji.
- **Ewidencja / KPiR** (K7: zakładka modułu zostaje „Ewidencja”, bo „KPiR” to istniejący raport `/reports/kpir` widoczny dla wszystkich firm; przy skali i liniowym strona pokazuje KPiR za miesiąc):
  - pozycje z faktur i kosztów;
  - wpisy ręczne (raport kasy);
  - pliki JPK_EWP/JPK_PKPIR do pobrania.
- **VAT:**
  - podgląd JPK_V7M;
  - „Wyślij do MF” (K6): dane autoryzujące wpisywane przy wysyłce;
  - status i UPO.
- **Pulpit:** karta „Odłóż na podatek” liczy z modułu (D13).
- **Treści:**
  - bez trybu rozkazującego, bez „AI”, bez długich myślników i plakietek;
  - każda kwota ma podpis „według Twoich danych i stawek na {rok}”;
  - każdy brak ma komunikat z tym, co zrobić.

---

## 9. Zadania w tle

| Cron | Kiedy | Co robi | Idempotencja |
|---|---|---|---|
| `cron.ksiegowosc-miesiac` | 1-3. dnia miesiąca, 07:00 | liczy poprzedni miesiąc firm w pilotażu i wysyła push „Rozliczenie za marzec jest wyliczone”, gdy moduł liczy kwoty | `tax_notifications`, etap `wyliczone` (szkic nie trafia do bazy, 00168) |
| `cron.ksiegowosc-terminy` | codziennie 08:00 | przypomnienia 5 i 1 dzień przed terminem o rozliczeniach bez oznaczonej zapłaty: push do członków firmy i mail do właściciela; ryczałt albo zaliczka PIT (według formy z profilu, od K7) i składki z tym samym dniem terminu w jednym; VAT (od K7.1) osobno, 5 i 1 dzień przed 25., tylko płatnikowi VAT | `tax_notifications`, etap `termin-N:RRRR-MM-DD`, plus klucz idempotencji Resend |

W pilotażu (kilka firm) oba crony idą pętlą po firmach w jednym zadaniu (`lib/ksiegowosc/powiadomienia.ts`, jawny błąd przy 1000 firm); fan-out przez event w `EVENT_QUEUE_MAP` (wzór `inbox.poll.tenant`) dojdzie przy włączeniu dla wszystkich (K8). Testy na sztywno podbite z komentarzem w K5: `jobs-foundation` 29 → 31, `jobs-registry` 50 → 52 (paczka B 17 → 19). Rejestracja w `lib/jobs/handlers/package-b.ts`, wzór `cronJob`.

---

## 10. Wysyłka JPK do MF (K6)

- API: `https://e-dokumenty.mf.gov.pl/api/Storage/InitUploadSigned`, `FinishUpload`, `Status/{referenceNumber}`. Test: `https://test-e-dokumenty.mf.gov.pl/`, te same ścieżki. Pliki idą metodą Put Blob do magazynu Azure (`taxdocumentstorageNN.blob.core.windows.net`, test: `…NNtst…`).
- **Specyfikacja 5.6.0** (10.09.2026) przeczytana 7.11.2026. Od 5.2.0 protokół bez zmian; doszły: kody 400 przy `InitUploadSigned` (142, usunięty 99), TLS tylko 1.2 i 1.3 z szyframi ECDHE/AES-GCM, autoryzacja kwotą przychodu (dane autoryzujące) dla wybranych schem, w tym JPK_V7M(3).
- Kolejność (`lib/ksiegowosc/wysylka-jpk/`):
  1. XML zgodny z XSD; przy danych autoryzujących `Podmiot1/OsobaFizyczna` (NIP, imię, nazwisko, data urodzenia, e-mail), bo inaczej status 422. Generator: pole `naturalPerson`.
  2. ZIP (DEFLATE, jeden plik, bez dzielenia ZIP); część do 60 MB, więcej to odmowa (JDG się mieści).
  3. AES-256-CBC z PKCS#7, klucz i IV losowe na wysyłkę; klucz zaszyfrowany RSA/ECB/PKCS#1 v1.5 kluczem z certyfikatu MF (`certyfikaty.ts`).
  4. Metadane `InitUpload` (wersja API `01.02.01.20160617`, deklaracja dokładnie `encoding="utf-8"`, nazwy plików `[a-zA-Z0-9_.-]{5,55}`, SHA-256 pliku i MD5 części w Base64) z `AuthData` na końcu: dokument SIG-2008_v2-0 (`podp:DaneAutoryzujace`: NIP, ImiePierwsze, Nazwisko, DataUrodzenia, Kwota) zaszyfrowany tym samym kluczem i IV. Bez podpisu XAdES (podpis i dane autoryzujące razem to kod 136).
  5. Put Blob tylko na adres z domen MF (inny adres: odmowa bez wysyłki), nagłówki z odpowiedzi MF.
  6. `FinishUpload`.
  7. Status i UPO; UPO w magazynie pod `upo/{firma}/jpk/{RRRR-MM}/{numer}.xml`.
- Statusy (`statusy.ts`): 1xx i 3xx poza 300 to „w toku”; 200 to UPO; odmowy klienta z treścią: 407 i 411 (duplikat), 419 (dane autoryzujące niezgodne z urzędem), 420 (brak pełnomocnictwa), 422 (tylko osoba fizyczna), 424 (plik nie do podpisania danymi autoryzującymi), 425; reszta 4xx i 300 to błąd techniczny FaktWay ze zgłoszeniem w Sentry. Przy `InitUploadSigned` kod 158 to chwilowa odmowa, a 170 (duplikat przetworzonego pliku) daje numer oryginału zamiast błędu.
- Dane autoryzujące wpisuje klient przy każdej wysyłce. Nie zapisujemy ich ani nie logujemy. Wysyłka idzie w żądaniu klienta, nie w kolejce zadań (pg-boss zapisuje treść zadania). Imię, nazwisko i data urodzenia są w pliku, więc pliku też nie zapisujemy (jak JPK_EWP w K3): `jpk_submissions` trzyma skrót i kwoty deklaracji.
- **K6.0, próba techniczna 7.11.2026** (`scripts/test-jpk-mf.ts`, za zgodą Bartosza, jedna wysyłka, dane fikcyjne: NIP testowy z `AGENTS.md`, „Jan Testowy”): numer `b7a0810e02818670000000b92c9f5343`, status 200 przy pierwszym odpytaniu (po 15 s), UPO `Potwierdzenie` w wersji 7.0, `NazwaStrukturyLogicznej` `Schemat_JPK_V7M(3)_v1-0E.xsd`, `Przyjeto` `true` (`tests/fixtures/ksiegowosc/upo-jpk-v7m-test-mf.xml`). Środowisko testowe nie sprawdza danych autoryzujących ani sumy kontrolnej NIP, więc próba potwierdza technikę (szyfrowanie, metadane, magazyn, status, UPO), a nie zgodność danych.
- Środowisko wysyłki: zmienna `JPK_MF_ENV` (`test` albo `produkcja`); pusta to brak wysyłki. Certyfikatu produkcyjnego MF w kodzie jeszcze nie ma (plik `jpk_e_dokumenty_mf_gov_pl_certum_2025.zip` z 18.07.2025 do pobrania za zgodą); do tego czasu produkcja odmawia przed wysyłką. Certyfikat testowy wygasa 7.07.2027.
- Ekran VAT (`/reports/vat`, obszar `vat` od K6) liczy kwoty i wydaje plik; „Wyślij do MF” pokazuje się dopiero przy obszarze `wysylka_jpk` (zablokowany w kodzie do opinii prawnika, D9) i ustawionym `JPK_MF_ENV`.
- Pytanie do prawnika i do `jpkPD.helpdesk@mf.gov.pl`: czy program może wysłać plik podpisany danymi autoryzującymi, które klient wpisał w naszym interfejsie.
- **Eksport JPK_V7M zostaje wyłączony** (`SUSPENDED_EXPORT_FORMATS`), choć plan wiązał odwieszenie z K6: eksport pisze `Podmiot1/OsobaNiefizyczna` z nazwą firmy, co dla JDG jest niezgodne z danymi podatnika, a odwieszenie zmienia ekran eksportu wszystkim klientom przed bramą (sekcja 0, pkt 6). Decyzja Bartosza: odwiesić tylko dla spółek, dodać do eksportu dane osoby fizycznej jak w pobraniu z ekranu VAT, albo zostawić plik tylko w module.

---

## 11. Brama prawna i włączanie klientom

Kod można pisać od razu, za wyłącznikiem. Klientom moduł włączamy dopiero, gdy wszystkie punkty są odhaczone z datą:

| # | Warunek | Kto | Stan 8.11.2026 |
|---|---|---|---|
| B1 | Spółka (OC, regulamin, umowy) | Bartosz | brak; Bartosz 8.11: na samym końcu, po pracach nad kodem |
| B2 | Pisemna opinia prawnika (pytania niżej) | Bartosz | brak; Bartosz 8.11: na samym końcu, po pracach nad kodem |
| B3 | Polisa OC (wzór: mojaKsięgowa.ai, 1 mln zł) | Bartosz | brak; Bartosz 8.11: na samym końcu, po pracach nad kodem |
| B4 | Księgowa sprawdziła parametry roku i podpisała złote przypadki G1-G14 | Bartosz + sesja | brak; Bartosz 8.11: na samym końcu, po pracach nad kodem |
| B5 | Regulamin modułu (odpowiedzialność, JDG jako konsument, dane podatkowe w RODO) | prawnik | brak; Bartosz 8.11: na samym końcu, po pracach nad kodem |
| B6 | Pilot: 3-5 firm, księgowa kontroluje 2 pierwsze miesiące | Bartosz + sesja | technicznie gotowy (K8): przełącznik „Księgowość (pilotaż)” w `/admin/flags`; firmy po B1-B5 |

**Lista kontrolna pilotażu (K8, operator):**
1. Migracje z `main` na db-1 przed wdrożeniem: 00172 i 00173 (`./scripts/ops/wgraj-migracje.sh 00172 00173`); 00165-00171 już są.
2. Wdrożenie: worker (`id=2`), potem aplikacja (`id=1`), `./scripts/ops/wdroz-produkcje.sh`.
3. Firma pilotażowa: `/admin/flags`, kolumna „Księgowość (pilotaż)”, przełącznik WŁ (audyt `admin.flag.toggled`). Obszary rozstrzyga `lib/ksiegowosc/wylacznik.ts`; `wysylka_jpk` zostaje zablokowany do B2.
4. Klient przechodzi kreator „Ustawienia podatkowe”; składki za okresy, których moduł nie liczy (np. grudzień 2025 r.), zapisuje jako zapłaty spoza wyliczenia.
5. Księgowa (rola „księgowa” w firmie) co miesiąc porównuje „Ten miesiąc” (kwoty i wejścia z migawki) z własnym wyliczeniem; rozbieżność to zgłoszenie z miesiącem i pozycją, poprawka według protokołu naprawy błędu.
6. Kwoty pokazują się dopiero po podpisie sekcji parametrów roku przez księgową (`sprawdzila`, D7, B4); do tego czasu „Ten miesiąc” ma braki, VAT liczy się bez parametrów.
7. Po dwóch miesiącach bez rozbieżności: włączenie dla wszystkich (krok po bramie): usunięcie `LINEAR_PIT_RATE`, rozsyłka cronów przez zdarzenia zamiast pętli, eksport JPK_V7M z danymi osoby fizycznej (D16), certyfikat produkcyjny MF (D18).

**Pytania do prawnika:**
1. Czy samoobsługowe wyliczenie podatku, ZUS i terminów z danych klienta to czynność doradztwa podatkowego? Jakie sformułowania są bezpieczne?
2. Czy to „usługowe prowadzenie ksiąg” (art. 76a ustawy o rachunkowości) z obowiązkiem OC?
3. Czy możemy wysyłać JPK podpisany danymi autoryzującymi, które klient wpisuje u nas przy każdej wysyłce? Czy potrzebne jest upoważnienie albo pełnomocnictwo?
4. Jak sformułować odpowiedzialność w regulaminie, skoro JDG ma prawa konsumenta?
5. Czy hasło „księgowość bez księgowej” jest dopuszczalne w reklamie?
6. RODO: przetwarzanie danych podatkowych i danych autoryzujących, okres przechowywania (KPiR 5 lat, faktury 10 lat).

---

## 12. Kroki

Jeden krok to jeden PR i jedna gałąź `claude/ksiegowosc-kN-<temat>`. Rozmiary: S mały, M średni, L duży.

| Krok | Rozmiar | Zakres | Migracja | Testy i kryteria odbioru |
|---|---|---|---|---|
| **K0** Plan w repo | S | plik do `docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md`, fraza w `AGENTS.md`, `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md`, szablon złotych przypadków dla księgowej (`docs/ksiegowosc/ZLOTE-PRZYPADKI.md` + pusty JSON), D1, D2 i D9 potwierdzone przez Bartosza | nie | `pnpm run ci`; fraza działa w nowej sesji |
| **K1** Parametry i kalendarz | M | `lib/ksiegowosc/parametry/{index,2026,2027}.ts` ze źródłami; kalendarz i `taxDeadline` przeniesione z `lib/flo/tax-params.ts` (FLO importuje); atrapy ZUS usunięte; limit VAT dla pulpitu z nowego modułu; `mikrorachunek.ts`; wyłącznik `ksiegowosc` (globalny i per firma) | może (flaga w `global_feature_flags`) | testy parametrów (każda liczba ma źródło; brak roku = fail-closed), kalendarza 2027 (sekcja 5), mikrorachunku (wektor z podatki.gov.pl), strażnik NIEAKTYWNE zaktualizowany |
| **K2** Profil podatkowy | M | `tax_profiles`, akcje z audytem, kreator w ustawieniach za wyłącznikiem, `ryczalt_rate` na pozycji faktury z profilu albo produktu | tak (00164+) | testy RLS, akcji i kreatora; zmiana formy tylko od 1 stycznia; profil bez danych daje komunikat |
| **K3** Ewidencja przychodów | L | `ewidencja.ts` dla ryczałtu (faktury, korekty, zaliczki, FP, waluty), `ledger_manual_entries` z ekranem (raport kasy), `jpk-ewp.ts` z XSD, pobieranie pliku | tak | testy zasad z sekcji 4 (każda reguła), XSD JPK_EWP(4), RLS |
| **K4** Ryczałt, ZUS i zdrowotna, ekran „Ten miesiąc” | L | `ryczalt.ts`, `zdrowotna.ts`, `zus.ts`, `tax_settlements`, ekran z listą „Do zapłaty”, mikrorachunkiem i „Zapłacone”, zatwierdzanie i wersje | tak | złote przypadki G1-G7 i G14 (najpierw szkielet z oczekiwanymi wartościami do podpisu; zielone dopiero po B4), RLS, niezmienność zatwierdzonych |
| **K5** Terminy, przypomnienia, „ile odłożyć” | M | dwa crony, push i mail, `tax_notifications`, `odlozyc.ts`, karta pulpitu bez `LINEAR_PIT_RATE` | tak | idempotencja (dwa przebiegi = jedno przypomnienie), testy cronów 29 → 31 i 50 → 52, karta bez profilu pokazuje komunikat |
| **K6** VAT i wysyłka JPK_V7M | L | K6.0 próba na środowisku testowym; `vat.ts` z P_39; `jpk_submissions`; ekran VAT z wysyłką, statusem i UPO; odwieszenie eksportu po testach | tak | G12; testy statusów API na atrapie HTTP; UPO zapisane; dane autoryzujące nigdzie nie zapisane (test logów) |
| **K7** Skala i liniowy | L | KPiR według wzoru 2026 (numer KSeF, identyfikator kontrahenta), wpisy ręczne, `pit.ts`, zdrowotna od dochodu, limit odliczenia, `jpk-pkpir.ts` z XSD | tak | G8-G11, XSD JPK_PKPIR(3) |
| **K8** Pilot | M | włączenie dla 3-5 firm, kontrola księgowej przez 2 miesiące, poprawki; potem Komplet w komunikacji | nie | B1-B6 odhaczone; zero rozbieżności w kontroli księgowej |
| **K9** Później | L | Mały ZUS Plus, kwartalne, roczne PIT i zdrowotna (za 2027 w 2028), wysyłka JPK_PD z zeznaniem, środki trwałe | tak | osobny plan |

Każda naprawa błędu w trakcie idzie według „Protokołu naprawy błędu” z `AGENTS.md`: najpierw czerwony test, jedna naprawa w jednym PR.

---

## 13. Pułapki znane z tego repo

- `flo_prefs.tax_profile` jest martwy. Nie buduj na nim.
- `lib/flo/tax-params.ts`: od K1 bez atrap ZUS, kalendarz i terminy tylko jako aliasy `lib/ksiegowosc/kalendarz.ts`, a Pulpit bierze limit VAT z `lib/ksiegowosc/parametry`. Tabela FLO została dla nieaktywnych funkcji, `PARAMS_VERIFIED=false`, a jej test świeżości pęknie po 29.08.2027.
- Bezpiecznik roku (`tests/unit/ksiegowosc-parametry.test.ts`): od 1 grudnia psuje CI, jeśli nie ma pliku parametrów na następny rok.
- `lib/dashboard/tax-estimate.ts` i `components/przeplywy/finora-1do1/adaptery.ts` mają 19 % na sztywno (D13).
- JPK_V7M jest wyłączony w eksporcie (`SUSPENDED_EXPORT_FORMATS`), pilnują tego testy `jpk-v7m-wstrzymany*`; K6 go nie odwiesił (sekcja 10). Generator odrzuca odwrotne obciążenie; P_39 podaje mu ekran VAT (`vat-dane.ts`: P_62 deklaracji za poprzedni miesiąc przyjętej przez MF z FaktWay, potem kwota wpisana przez klienta, potem od K7.1 P_62 rozliczenia VAT za poprzedni miesiąc zatwierdzonego w „Ten miesiąc”, potem P_39 z zatwierdzonego rozliczenia tego miesiąca; bez zgadywania zera). Pierwszy miesiąc VAT w FaktWay wymaga wpisu, a każde zatwierdzenie ustala P_39 kolejnego. Poprzedni miesiąc ma pierwszeństwo przed migawką tego, więc jego korekta daje temu miesiącowi nową wersję.
- Środowisko testowe MF przyjmuje fikcyjne dane autoryzujące i NIP bez poprawnej sumy kontrolnej. „Przyjęty” na teście nie mówi nic o danych klienta; wynik na teście nie zasila też P_39 produkcji (`nadwyzkaPrzyjetej` filtruje po środowisku).
- Odnośnik „Struktura logiczna pliku metadanych (initupload)” na podatki.gov.pl prowadzi do XSD JPK_V7M w przestrzeni `2025/06/18/06181`. MF test przyjął plik w przestrzeni `2025/12/19/14090` z repo (UPO z próby: `Schemat_JPK_V7M(3)_v1-0E.xsd`).
- Node 22 w CI nie odszyfrowuje RSA PKCS#1 v1.5 (`privateDecrypt`, CVE-2023-46809); atrapa MF w teście zdejmuje dopełnienie ręcznie (`RSA_NO_PADDING`). Szyfrowanie (`publicEncrypt`) działa normalnie.
- `jpk_submissions` (00170): jedna wysyłka w toku na miesiąc. Wiersz „wysylanie” starszy niż 15 minut zamyka następna wysyłka (`zamknijPrzerwane`); „w_toku” rozstrzyga status MF. Gdy plik doszedł do MF, a zapis numeru padł, numer jest w audycie `jpk_v7m.sent` (`zapisany: false`) i w Sentry: operator dopisuje go kluczem serwisowym.
- `kpir_entries` istnieje, ale jest nieużywana. Nie myl jej z KPiR liczoną na żywo.
- KPiR modułu (K7, `kpir.ts`) to nie raport `/reports/kpir` (`lib/reports/kpir-data.ts`): raport zostaje dla wszystkich firm bez zmian, moduł liczy według wzoru 2026 z wpisami ręcznymi i brakami. Co z raportem po włączeniu modułu dla wszystkich, rozstrzyga K8.
- `ledger_manual_entries` po 00171: ewidencja czyta tylko wpisy ze stawką, KPiR tylko wpisy z kolumną. Przed wgraniem 00171 odczyt KPiR traktuje brak kolumny (42703) jak brak wpisów, a zapis wpisu KPiR odmawia błędem bazy.
- Zaliczka PIT i zdrowotna od dochodu liczą się z KPiR całego roku (styczeń zdrowotnej z grudnia poprzedniego roku), więc brak w jednym miesiącu zatrzymuje kwoty kolejnych miesięcy z komunikatem, które miesiące mają braki. Parametry 2027: stopa wypadkowa od kwietnia i limit liniowy jeszcze nieogłoszone, więc składki od kwietnia 2027 i zaliczka liniowa za 2027 to brak (D7).
- Obszar `kpir` wyłącznika (K7) nie ma własnego ekranu: zatrzymuje skalę i liniowy na stronie „Ewidencja”, w odczycie „Ten miesiąc” (także w cronach) i w akcjach KPiR, bez ruszania ryczałtu. Sprawdza się go `statusObszaru('kpir')`, bo globalny stop i flagę firmy sprawdził już obszar ekranu.
- JPK_PKPIR(3): `CelZlozenia` 1 (pierwsze złożenie obowiązkowego pliku) tylko za pełny zamknięty rok, za część roku 0 (plik na żądanie urzędu); korekty (2) moduł jeszcze nie wydaje. P_1 i P_2 (spis z natury) zawsze zero (sekcja 5).
- Ewidencja (K3) liczy przychód na żywo przy każdym otwarciu, z kursem NBP pobieranym wtedy z API. `invoice_line_items.ryczalt_rate` nikt jeszcze nie zapisuje, więc stawka pochodzi z profilu; korekta albo zaliczka z kilkoma stawkami na pozycjach to brak, a nie zgadywanie.
- `ledger_manual_entries` (00167) nie ma UPDATE: poprawka to usunięcie i nowy wpis, oba z audytem. Daty wpisu i autora nie podstawi klucz użytkownika (granty kolumnowe).
- `tax_settlements` (00168) trzyma tylko ZATWIERDZONE wersje; szkic liczy się na żywo. Od K7.2 także zapłaty spoza wyliczenia (`migawka.reczna`, kwota z PUE ZUS, okres od 2025 r.): to zwykłe wersje, więc odliczenie liczy tylko przyrost ponad najwyższą zapłaconą wersję okresu, a późniejsze wyliczenie tego samego okresu dolicza różnicę. Odczyt „Ten miesiąc” pokazuje je na stronie miesiąca zapłaty, a te bez daty na każdej stronie (wyjście, gdy drugi zapis akcji się nie uda). Aktualna wersja to najwyższy numer, a kwoty nie zmieni ani klucz użytkownika (granty kolumnowe), ani serwisowy (wyzwalacz `guard_tax_settlement_immutable`). Zmiana danych po zatwierdzeniu daje inny skrót wejść i nową wersję.
- Odliczenia ryczałtu liczą się po dniu zapłaty, więc odczyt „Ten miesiąc” bierze wszystkie zapłacone wersje do miesiąca (także zaległe za wcześniejsze okresy), a nie tylko od grudnia. Skrót wersji (D6) to kwota i jej bezpośrednie wejścia: parametry roku i ich opisy do niego nie wchodzą, więc poprawka opisu albo liczby, której pozycja nie używa, nie tworzy nowych wersji.
- Każda pozycja „Ten miesiąc” (ryczałt, składki społeczne, zdrowotna) ma własny wynik albo brak; bramka D7 działa osobno dla każdej sekcji, a liczbę bez wartości (np. stopa wypadkowa ogłaszana w kwietniu) sprawdza silnik, który jej używa.
- Dopóki księgowa nie potwierdzi sekcji parametrów (`sprawdzila`), „Ten miesiąc” pokazuje braki zamiast kwot: tak ma być (D7). Testy i złote przypadki podają parametry wprost do czystych silników.
- Karta „Odłóż na podatek” na Przepływach liczy z modułu (`odlozyc.ts`) tylko dla firmy w pilotażu (obszar `terminy`); pozostałe firmy widzą ją jak dotąd z `LINEAR_PIT_RATE` (19 %), bo przed bramą nic się dla nich nie zmienia. `LINEAR_PIT_RATE` usuwa się przy włączeniu modułu dla wszystkich (K8). Firma zwolniona z VAT ma w tym miejscu limit zwolnienia, więc szacunek widzi w „Ten miesiąc” za bieżący miesiąc.
- Push modułu to typ `ksiegowosc` (`push_subscriptions.notify_ksiegowosc`, 00169); przełącznik w ustawieniach powiadomień widzi tylko firma w pilotażu. Przypomnienia o terminach biorą grupy według formy z profilu: ryczałt albo zaliczka PIT (od K7), zawsze składki, a VAT (od K7.1) tylko płatnik VAT przy obszarze `vat`. Przypomnienie wychodzi dokładnie 5 i 1 dzień przed terminem; dzień, w którym cron nie ruszy, nie jest nadrabiany (do rozważenia przy K8). Błąd odczytu rozliczeń to ponowienie zadania, nigdy przypomnienie „bez zapłaty”.
- `currency-guard.ts` odrzuca waluty w eksportach. Etap 1 (waluty) to zmienia, więc uzgodnij to z jego sesją.
- Nowe kolumny w `tenants` wymagają jawnego GRANT SELECT (00112).
- Crony i zadania mają liczby na sztywno w testach (29 i 50). Podbijasz je świadomie, z komentarzem.
- Strażnik `flo-nieaktywne.test.ts`: funkcja FLO, która dostaje importera produkcyjnego, traci znacznik NIEAKTYWNE.
- Desktop zamrożony; telefon tylko za prefiksami.
- `direction` ma tylko `outgoing` i `incoming`.
- PostgREST ucina wynik po 1000 wierszach. Sumy licz przez `read-complete-pages`.
- `pnpm build` łapie błędy, których `pnpm typecheck` nie łapie (np. plik `'use server'`).

---

## 14. Źródła (odczyt 4.11.2026)

- Stawki i limity PIT, ryczałt: https://podatki.gov.pl/podatki-firmowe/pit/stawki-i-limity/ ; https://podatki.gov.pl/podatki-firmowe/pit/informacje-podstawowe/co-jest-opodatkowane/opodatkowanie-ryczaltem-od-przychodow-ewidencjonowanych
- PIT-28: https://www.podatki.gov.pl/twoj-e-pit/pit-28-za-2025-rok
- Płaca minimalna 2027: https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU20260001213/O/D20261213.pdf
- Księgi w programie i JPK_PD: https://www.gov.pl/web/kas/elektroniczna-dokumentacja-ksiegowa-dla-przedsiebiorcow-placacych-pit-obowiazkowa-od-2026-r
- Struktury JPK w PIT (XSD JPK_PKPIR(3), JPK_EWP(4), JPK_ST(1)): https://www.gov.pl/web/kas/struktury-jpk-w-podatkach-dochodowych ; broszury: https://podatki.gov.pl/media/pbqdgqcp/broszura_informacyjna_dot_jpk_pkpir-3.pdf , https://www.podatki.gov.pl/media/0qmfysqh/broszura_informacyjna_dot_jpk_ewp-4.pdf
- Struktury JPK VAT: https://www.gov.pl/web/kas/struktury-jpk
- Specyfikacja interfejsów JPK 5.6.0 (odczyt 7.11.2026): https://podatki.gov.pl/media/bngboylg/specyfikacja-interfejsów-usług-jpk-wersja-560.pdf ; certyfikat klucza publicznego MF dla środowiska testowego: https://podatki.gov.pl/media/4qxjgyvn/test_e_dokumenty_mf_gov_pl_certum_2025.zip ; przykład `initupload-jpk_v7m-3.xml`: https://podatki.gov.pl/media/zlnfyez0/initupload-jpk_v7m-3.xml ; schemat danych autoryzujących SIG-2008_v2-0: https://podatki-arch.mf.gov.pl/media/10553/sig-2008_v2-0.xsd
- Specyfikacja interfejsów JPK 5.2.0: https://www.podatki.gov.pl/media/c2sdatex/specyfikacja-interfejs%C3%B3w-us%C5%82ug-jpk-wersja-520.pdf ; lista wersji: https://www.podatki.gov.pl/podatki-firmowe/jednolity-plik-kontrolny/jpk_pd/pliki-do-pobrania-jpk_pd
- Mikrorachunek: https://www.podatki.gov.pl/mikrorachunek-podatkowy
- Składka zdrowotna 2026 (branżowe, do potwierdzenia na zus.pl): https://www.infakt.pl/blog/skladka-zdrowotna-dla-ryczaltu-w-2026-r/
- ZUS 2027 (branżowe): https://www.podatki.biz/artykuly/duzy-zus-2027-skladki-spoleczne-przekrocza-juz-2-tys-zl-miesiecznie_34_63659.htm ; https://www.podatki.biz/artykuly/maly-zus-2027-wyzsze-wynagrodzenie-minimalne-to-takze-wyzsze-skladki_33_63608.htm
- Regulaminy konkurencji: https://fakturownia.pl/regulamin-samodzielna-ksiegowosc ; https://www.infakt.pl/regulamin/adkzk/
- Surowe odczyty z rozpoznania: katalog roboczy sesji z 4.11 (`scratchpad/etap2`: spec52.txt, bro_pkpir3.txt, bro_ewp4.txt, sjpk.txt, edok.txt)

---

## 15. Dziennik

| Data | Krok | PR | Stan | Wdrożone (SHA) | Uwagi |
|---|---|---|---|---|---|
| 4.11.2026 | plan | — | gotowy | — | rozpoznanie kodu (`7a249d3f`) i przepisów; plan poza gitem |
| 5.11.2026 | K0 | #375 | scalony 5.11 (`c4600b3d`) | nie dotyczy (tylko dokumentacja) | plan w repo i fraza w `AGENTS.md`; `docs/ksiegowosc/PYTANIA-DO-PRAWNIKA.md`; arkusz `docs/ksiegowosc/ZLOTE-PRZYPADKI.md` i pusty `tests/fixtures/ksiegowosc/zlote/szablon.json` (bez kwot); D1, D2 i D9 Bartosz potwierdził bez zmian; 00164 zajmuje szkic #369 |
| 5.11.2026 | K1 | #380 | scalony 5.11 (`f251d8dd`) | nie; 00165 wgrana na db-1 5.11 | `lib/ksiegowosc/parametry` (2026 i 2027, każda liczba ze źródłem urzędowym z odczytu 5.11; liczby 2026 odtwarzają tabele ZUS co do grosza), terminy po dacie obowiązywania, `kalendarz.ts` z FLO plus Wigilia od 2025 r. (kalendarz FLO jej nie znał), `mikrorachunek.ts` z wektorem z generatora MF, `wylacznik.ts` (`killKsiegowosc`, blokada w kodzie, `ksiegowosc_enabled`) z migracją 00165 (do wgrania przed wdrożeniem); atrapy ZUS usunięte z FLO; Pulpit bierze limit VAT z nowego modułu (bez warunku `sprawdzila`); w planie poprawione: mikrorachunek „222”, preferencyjny 456,18 zł, limit liniowy 2026 14 100 zł; czeka na ogłoszenie: limity ryczałtu 2027 (grudzień), limit liniowy 2027 (grudzień), podstawa pełnego ZUS 2027 (listopad), zdrowotna ryczałtu 2027 (styczeń), wypadkowa od 1.04.2027 |
| 5.11.2026 | K2 | #408 | scalony 5.11 (`f4fdd6c9`) | nie; 00166 wgrana na db-1 5.11 | `tax_profiles` z migracją 00166 (do wgrania przed wdrożeniem): wersje po `valid_from`, wyzwalacz „forma tylko od 1 stycznia”, CHECK-i stawki i daty etapu ZUS, zapis tylko owner/admin, bez DELETE; `zapiszProfilPodatkowyAction` z audytem `tax_profile.saved`; kreator `/reports/ustawienia-podatkowe` jako zakładka Księgowości za wyłącznikiem (obszar `ustawienia` odblokowany w kodzie, o firmie decyduje `ksiegowosc_enabled`, reszta dostaje 404); stawkę ryczałtu pozycji rozstrzyga `stawkaRyczaltuPozycji` przy odczycie (stawka z pozycji, bez niej domyślna z wersji profilu na dzień sprzedaży), więc ścieżka wystawiania faktury jest nietknięta, a stawka na produkcie odłożona do K3; odmowa zmiany formy podaje, od kiedy nowa forma może obowiązywać; typy z produkcji po 00165; test RLS na prawdziwej bazie złapał CHECK przepuszczający ryczałt bez stawki (NULL), poprawione przed wgraniem; sprawdzone lokalnie na osobnej bazie ze wszystkimi migracjami i w przeglądarce (desktop i 375 px) |
| 7.11.2026 | K3 | #421 | scalony 7.11 (`2c0d36fc`) | nie (kod); 00167-00171 na db-1 (sprawdzone 8.11) | `ledger_manual_entries` z migracją 00167 (do wgrania przed wdrożeniem): wpisy ręczne bez UPDATE, data wpisu i autor z bazy (granty kolumnowe), zapis i usunięcie owner/admin z audytem; `lib/ksiegowosc/ewidencja.ts` (zasady z sekcji 4: KSeF, korekta w dniu wystawienia, zaliczki jak KPiR, FP poza przychodem, waluty po NBP, stawka z pozycji albo profilu, braki z wyjściem) i odczyt z filtrami KPiR; JPK_EWP(4) z walidacją na oficjalnym XSD (schemat pobrany z gov.pl za zgodą Bartosza); strona „Ewidencja” za wyłącznikiem z wpisami ręcznymi i pobraniem pliku (imię, nazwisko i data urodzenia tylko w pliku); typy z produkcji po 00166; w sekcji 5 zaliczki (pewność niska) i korekty (średnia) do potwierdzenia przez księgową; przeglądarka na osobnej bazie złapała ginący audyt pobrania (`entity_id` to uuid), naprawione w tym PR |
| 7.11.2026 | K4 | #428 | scalony 7.11 (`b987b53b`) | nie (kod); 00167-00171 na db-1 (sprawdzone 8.11) | `tax_settlements` z migracją 00168 (do wgrania przed wdrożeniem, po 00167): zatwierdzone rozliczenia w wersjach (D6; aktualna to najwyższy numer, wyzwalacz puszcza tylko zapłatę, data zapłaty nie sprzed okresu i nie z przyszłości, granty kolumnowe, owner/admin) i `tax_profiles.najem`; silniki `zus.ts` (etapy z profilu, tabele ZUS 2026 co do grosza), `zdrowotna.ts` (próg 60/300 tys. zł, rok składkowy luty-styczeń), `ryczalt.ts` (odliczenia z oznaczonych zapłat, przeniesienie nadwyżki i korekt większych niż przychód, podział między stawki); ekran „Ten miesiąc” z kaflami Finory, terminami, mikrorachunkiem, „Zatwierdź miesiąc” tylko dla kwot z ekranu i „Zapłacone” z dopłatą liczoną od najwyższej zapłaconej wersji (audyt `tax_settlement.*`); każda pozycja ma własny wynik albo brak; próg najmu w ewidencji i K_9 z potwierdzonych parametrów; szkielety G1-G7 i G14 (rok 2027) z historią 2026 jako danymi; drugi czytelnik (`/code-review`, 10 przeglądów, weryfikacja, przegląd luk): 40 kandydatów, 33 potwierdzone, poprawki w tym PR z czerwonymi testami; otwarte do decyzji: zapłata spoza wyliczenia i próg zdrowotnej za styczeń (sekcja 5); `Kasowy_PIT` poza v1; typy z produkcji (`ledger_manual_entries`, `tax_settlements`) przeniesione do K5, bo 00167 i 00168 nie są wgrane |
| 7.11.2026 | K5 | #433 | scalony 7.11 (`83d8e3e3`) | nie (kod); 00167-00171 na db-1 (sprawdzone 8.11) | `tax_notifications` z migracją 00169 (do wgrania przed wdrożeniem, po 00167 i 00168): jedno powiadomienie na firmę, miesiąc i etap (UNIQUE), tylko service_role, oraz `push_subscriptions.notify_ksiegowosc`; crony `ksiegowosc-miesiac` (1-3. dnia, push o wyliczonym miesiącu) i `ksiegowosc-terminy` (5 i 1 dzień przed terminem, push i mail do właściciela, jedno przypomnienie na dzień terminu, tylko rozliczenia bez oznaczonej zapłaty, tylko ryczałt), pętlą po firmach pilotażu, z wpisem przed wysyłką; `odlozyc.ts` i karta „Odłóż na podatek” z modułu tylko w pilotażu (pozostałe firmy z 19 % do K8); przełącznik push „Księgowość” tylko w pilotażu; podbite z komentarzem: crony 29 → 31, zadania 50 → 52, odczyty Przepływów 51 → 52; drugi czytelnik (`/code-review` high): 6 ustaleń, 4 poprawione (m.in. błąd odczytu rozliczeń dawał przypomnienie „bez zapłaty”); `main` scalany w PR przez GitHub, bo scalenie lokalne zmienia chronione pliki `.claude/` |
| 7.11.2026 | K6 | #442 | scalony 7.11 (`bb90b60e`) | nie (kod); 00167-00171 na db-1 (sprawdzone 8.11) | K6.0: klient bramki MF (`lib/ksiegowosc/wysylka-jpk/`) według specyfikacji 5.6.0 i próba na środowisku testowym MF za zgodą Bartosza (dane fikcyjne): status 200 i UPO przy pierwszym odpytaniu; `vat.ts` (część deklaracyjna z `summarizeJpkV7m`, P_39 z deklaracji przyjętej przez MF albo od klienta, bez zgadywania zera), szkielet G12; `jpk_submissions` z migracją 00170 (do wgrania przed wdrożeniem, po 00167-00169); zakładka „VAT” z plikiem JPK_V7M(3) osoby fizycznej do pobrania, listą wysyłek, statusem i UPO; „Wyślij do MF” za obszarem `wysylka_jpk` (zablokowany do opinii prawnika) i `JPK_MF_ENV`; korekta (CelZlozenia 2) po przyjętej deklaracji; eksport JPK_V7M świadomie nieodwieszony (sekcja 10, decyzja Bartosza); VAT w „Ten miesiąc” i w przypomnieniach jeszcze nie; drugi czytelnik (`/code-review` high): 7 ustaleń, 6 poprawionych z testami czerwonymi przed poprawką; CI złapało dwa strażniki (FIR-01, `KSEF_ENV` przed kluczem serwisowym), poprawione |
| 8.11.2026 | K7 | #446 | scalony 8.11 (`41c1db25`) | nie (kod); 00167-00171 na db-1 (sprawdzone 8.11) | `pit.ts`: zaliczki narastająco (skala 12/32 % z kwotą zmniejszającą 3 600 zł, liniowy 19 % z odliczeniem zapłaconej zdrowotnej do limitu 14 100 zł), od dochodu z KPiR po odliczeniu składek społecznych bez FP oznaczonych jako zapłacone, podstawa do pełnych złotych, minus zaliczki należne za wcześniejsze miesiące; `zdrowotna.ts`: od dochodu z poprzedniego miesiąca (9 % albo 4,9 %, minimum 432,54 zł, styczeń z grudnia); `kpir.ts` i `kpir-dane.ts`: KPiR według wzoru 2026 (numer KSeF, identyfikator, nazwa i adres kontrahenta; koszty z kolumną z Kosztów, B+R do 13 z opisem w 16; braki z wyjściem); wpisy ręczne KPiR z kolumną (migracja 00171, do wgrania przed wdrożeniem, po 00167-00170); JPK_PKPIR(3) z walidacją na oficjalnym XSD (pobranym z gov.pl za zgodą Bartosza), plik osoby fizycznej do pobrania, dane osoby tylko w pliku; „Ten miesiąc” przy skali i liniowym: zaliczka PIT, koszty, zdrowotna od dochodu, symbol PIT-36 albo PIT-36L przy mikrorachunku, bramka D7 według sekcji formy; przypomnienia o terminach także dla zaliczki PIT; strona „Ewidencja” przy skali i liniowym pokazuje KPiR (nazwa zakładki bez zmian, sekcja 8); szkielety G8-G11 (rok 2027 z historią 2026) do podpisu księgowej; spis z natury poza v1 (sekcja 5); RLS 00165-00171 na osobnej bazie: 38/38; parametry 2027 (wypadkowa od kwietnia, limit liniowy) jeszcze nieogłoszone, więc te kwoty to braki (D7); drugi czytelnik (`/code-review` high): 7 ustaleń, wszystkie poprawione z testami czerwonymi przed poprawką (m.in. audyt usunięcia wpisu KPiR bez kolumny, błąd odczytu walut opisany jako przegląd kursu, styczeń bez przyczyny braku KPiR z grudnia, Fundusz Pracy bez informacji w widoku); typecheck złapał też typ w uruchamianiu złotych przypadków; obszar `kpir` wyłącznika (zarezerwowany w K1) teraz zatrzymuje skalę i liniowy i jest puszczony w kodzie |
| 8.11.2026 | K7.1 | #452 | scalony 8.11 (`a4952f7c`) | nie (kod); 00167-00171 na db-1 | decyzja (3), wybrana przez Bartosza 8.11: pozycja „Podatek VAT” w „Ten miesiąc” z P_51, terminem 25. i mikrorachunkiem z symbolem VAT-7, przy czynnym VAT i obszarze `vat`; P_39 z deklaracji przyjętej przez MF, potem z kwoty wpisanej przez klienta (pole przy pozycji, adres `?nadwyzka=` jak na ekranie VAT), potem z P_62 rozliczenia VAT za poprzedni miesiąc zatwierdzonego w „Ten miesiąc”, potem z P_39 zatwierdzonego rozliczenia tego miesiąca (ten sam łańcuch na ekranie VAT, audyt pliku podaje źródło); sprawdzenie w przeglądarce na osobnej bazie (firma na skali, czynny VAT): pole, przeliczenie, zatwierdzenie i listopad z P_39 z października; złapało, że zatwierdzony miesiąc bez zatwierdzonego poprzedniego gubił kwotę po powrocie na stronę, poprawione z testem; zatwierdzenie liczy VAT z nadwyżką z ekranu i zapisuje P_62 w migawce; przypomnienie 5 i 1 dzień przed 25. tylko płatnikowi VAT (zwolnienie czytane w dniu przypomnienia); VAT wchodzi do pusha o wyliczonym miesiącu i do „Odłóż na podatek”; VAT nie zależy od parametrów, więc przy D7 dla wszystkich sekcji miesiąc liczy się dalej, gdy VAT ma kwotę albo pole; bez migracji; drugi czytelnik (`/code-review` high): 4 ustalenia, 3 poprawione z testami czerwonymi przed poprawką (liczby dokumentów poza skrótem VAT, podtytuł, komunikat odczytu), wspólny pomocnik „brak tabeli” odłożony |
| 8.11.2026 | K7.2 | PR `claude/ksiegowosc-k7-2-zaplata-spoza-wyliczenia` | gotowy, PR otwarty | — | decyzje z planu podjęte za Bartosza (D15-D21, 8.11, „najbardziej korzystne”); D15: zapłata spoza wyliczenia (składki za okres, którego moduł nie liczy, np. za grudzień 2025 r., z kwotą z PUE ZUS) jako wersja rozliczenia z `migawka.reczna`, od razu zapłacona, w karcie „Zapłaty spoza wyliczenia” na „Ten miesiąc” (także przy brakach miesiąca), z audytem `tax_settlement.manual_paid`; migracja 00172 (CHECK okresu od 2025 r., do wgrania przed wdrożeniem); 00167-00171 sprawdzone na db-1 (już były wgrane); typy bazy z produkcji po 00171; RLS 00168 z 00172 na osobnej bazie: 9/9 |
| 8.11.2026 | K7.3 | PR `claude/ksiegowosc-k7-3-fundusz-pracy-kpir` | gotowy, PR otwarty | — | D21: KPiR dostaje Fundusz Pracy i FS z zapłaconych składek ZUS (kolumna 13, w dniu zapłaty, dowód „Składki ZUS za MM/RRRR”), z przyrostu ponad wcześniejsze zapłacone wersje okresu, także z zapłat spoza wyliczenia; zaliczka PIT i podstawa zdrowotnej od dochodu biorą go z KPiR; widok KPiR mówi, że FP dopisuje FaktWay; złote przypadki dopisują FP z zapłat jak aplikacja (konwencja arkusza zmieniona: „Koszty w KPiR” bez FP); bez migracji |
| 8.11.2026 | K7.4 | PR `claude/ksiegowosc-k7-4-spis-z-natury` | gotowy, PR otwarty | — | D19: spis z natury w module (`ledger_inventory_counts`, migracja 00173 do wgrania przed wdrożeniem): karta „Spis z natury” w KPiR z formularzem i usuwaniem (audyt `ledger_inventory.*`), plik JPK_PKPIR(3) z P_1, P_2, P_3 = wydatki + P_1 − P_2, P_4 i PKPIRSpis (XSD), karta pliku mówi, jakie spisy są w pliku; RLS 00173 na osobnej bazie 4/4 (z 00168 i 00171: 17/17) |
| 8.11.2026 | K8 | PR `claude/ksiegowosc-k8-pilotaz` | gotowy, PR otwarty | — | pilotaż technicznie gotowy: flaga `ksiegowosc_enabled` w `/admin/flags` (kolumna „Księgowość (pilotaż)”, audyt, czyszczenie cache) zamiast UPDATE kluczem serwisowym; D20: stary raport `/reports/kpir` u firmy z modułem odsyła do księgi modułu (KPiR albo ewidencja), po odczycie danych raportu, więc strażnik środowiska KSeF dalej zatrzymuje stronę przed innymi odczytami; lista kontrolna pilotażu w sekcji 11; brama B1-B5 na samym końcu (Bartosz 8.11); bez migracji |

**Następny krok:** kod planu (K0-K8 z K7.1-K7.4) jest gotowy. Zostaje po stronie Bartosza: scalenie stosu PR K7.2-K8, migracje 00172 i 00173 na db-1, wdrożenie, brama z sekcji 11 (B1-B5) i pilotaż według listy kontrolnej (B6). Potem K9 (Mały ZUS Plus, rozliczenia kwartalne, roczne PIT i zdrowotna, wysyłka JPK_PD z zeznaniem, środki trwałe) jako osobny plan.
