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
| `ledger_manual_entries` | przychody i koszty bez faktury z KSeF (raport kasy za miesiąc, inne), dokument, data, kwota, stawka, kolumna KPiR, opis | K3 |
| `tax_settlements` | `okres` (pierwszy dzień miesiąca), `rodzaj` (`ryczalt`/`pit`/`vat`/`zus_spoleczne`/`zdrowotna`), `kwota_gr`, `termin`, `status` (`szkic`/`zatwierdzone`/`zaplacone`), `migawka` jsonb (wejścia, parametry, wersja), `parametry_wersja`, `wejscia_hash`, `zatwierdzone_przez/_o`, `zaplacone_o`, `wersja`, `zastapione_przez` | K4 |
| `tax_notifications` | klucz UNIQUE (`tenant_id`, `rozliczenie`, `etap`) dla przypomnień | K5 |
| `jpk_submissions` | okres, rodzaj pliku, skrót pliku, numer referencyjny MF, status, ścieżka UPO w magazynie, błędy, znaczniki czasu | K6 |

Nowe kolumny w `tenants` (jeśli jednak potrzebne) wymagają jawnego GRANT SELECT według 00112 i testu `tests/unit/dane-ksef-uprawnienia-kolumn.test.ts`.

---

## 7. Silniki (`lib/ksiegowosc/`, czyste funkcje, kwoty w groszach)

| Plik | Co liczy | Krok |
|---|---|---|
| `parametry/index.ts`, `parametry/2026.ts`, `parametry/2027.ts` | parametry z polami `zrodlo`, `odczyt`, `sprawdzila` (księgowa i data) dla każdej sekcji; `parametryNa(data)`; `brakujace(data)` dla komunikatu fail-closed | K1 |
| `kalendarz.ts` | święta, dni robocze, terminy (przeniesione z `lib/flo/tax-params.ts`, FLO importuje stąd) | K1 |
| `mikrorachunek.ts` | numer z NIP i walidacja | K1 |
| `ewidencja.ts` | ewidencja przychodów i KPiR z faktur, kosztów i wpisów ręcznych (zasady z sekcji 4) | K3, K7 |
| `ryczalt.ts` | ryczałt za miesiąc: przychód według stawek (z progiem najmu), minus odliczenia (społeczne, 50 % zdrowotnej) z przeniesieniem nadwyżki, zaokrąglenie | K4 |
| `zdrowotna.ts` | ryczałt: próg z przychodu narastająco; skala i liniowy: od dochodu z poprzedniego miesiąca z minimum; rok składkowy luty-styczeń | K4, K7 |
| `zus.ts` | składki społeczne według etapu, chorobowe, Fundusz Pracy, „etat obok” | K4 |
| `pit.ts` | zaliczki narastająco: skala (12/32, kwota zmniejszająca) i liniowy (odliczenie zdrowotnej do limitu) | K7 |
| `vat.ts` | VAT do zapłaty z JPK_V7M (`summarizeJpkV7m`) z przeniesieniem nadwyżki (P_39) | K6 |
| `odlozyc.ts` | „ile odłożyć”: suma przewidywanych zobowiązań bieżącego miesiąca z danych do dziś, oznaczona jako szacunek | K5 |
| `jpk-ewp.ts`, `jpk-pkpir.ts` | generatory z walidacją XSD (xmllint jak w `jpk-v7m-validator.ts`) | K3, K7 |

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
- **Ewidencja / KPiR:**
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
| `cron.ksiegowosc-miesiac` | 1-3. dnia miesiąca, 07:00 | szkic rozliczeń za poprzedni miesiąc, push „Wyliczyliśmy marzec” | `tax_settlements` (okres, rodzaj, wersja) |
| `cron.ksiegowosc-terminy` | codziennie 08:00 | przypomnienia 5 i 1 dzień przed terminem, jeśli niezapłacone | `tax_notifications` UNIQUE |

Fan-out na firmy przez event w `EVENT_QUEUE_MAP` (wzór `inbox.poll.tenant`). Testy na sztywno do podbicia z komentarzem: `jobs-foundation` 29 → 31, `jobs-registry` 50 → 52. Rejestracja w `lib/jobs/handlers/package-b.ts`, wzór `cronJob`.

---

## 10. Wysyłka JPK do MF (K6)

- API: `https://e-dokumenty.mf.gov.pl/api/Storage/InitUploadSigned`, `FinishUpload`, `Status/{referenceNumber}`. Test: `https://test-e-dokumenty.mf.gov.pl/`, te same ścieżki. Specyfikacja 5.2.0 przeczytana; **przed kodem pobierz 5.6.0 i porównaj**.
- Kolejność:
  1. XML zgodny z XSD.
  2. ZIP.
  3. Szyfrowanie AES-256, klucz zaszyfrowany kluczem publicznym MF (RSA-2048).
  4. Metadane podpisane danymi autoryzującymi: dokument SIG-2008_v2-0, czyli NIP, imię, nazwisko, data urodzenia i przychód z zeznania za rok n-2 (dla podpisów w 2027 za 2025).
  5. Wysłanie części do magazynu.
  6. `FinishUpload`.
  7. Odpytywanie statusu i UPO (zapis w MinIO).
- Statusy do obsłużenia:
  - 120 (w toku);
  - 200 (UPO);
  - 411 (duplikat);
  - 420 (brak pełnomocnictwa);
  - 422 (dane autoryzujące tylko dla osoby fizycznej);
  - 424 (typ pliku nie może być tak podpisany).
- Dane autoryzujące wpisuje klient przy każdej wysyłce. Nie zapisujemy ich ani nie logujemy.
- **K6.0 to próba techniczna** na środowisku testowym z jednym plikiem, zanim powstanie ekran.
- Pytanie do prawnika i do `jpkPD.helpdesk@mf.gov.pl`: czy program może wysłać plik podpisany danymi autoryzującymi, które klient wpisał w naszym interfejsie.
- Odwieszenie eksportu JPK_V7M (`SUSPENDED_EXPORT_FORMATS`) dopiero po K6 i testach `jpk-v7m-wstrzymany*`.

---

## 11. Brama prawna i włączanie klientom

Kod można pisać od razu, za wyłącznikiem. Klientom moduł włączamy dopiero, gdy wszystkie punkty są odhaczone z datą:

| # | Warunek | Kto | Stan 4.11.2026 |
|---|---|---|---|
| B1 | Spółka (OC, regulamin, umowy) | Bartosz | brak (03.11: „firmy jeszcze nie ma”) |
| B2 | Pisemna opinia prawnika (pytania niżej) | Bartosz | brak |
| B3 | Polisa OC (wzór: mojaKsięgowa.ai, 1 mln zł) | Bartosz | brak |
| B4 | Księgowa sprawdziła parametry roku i podpisała złote przypadki G1-G14 | Bartosz + sesja | brak; kwoty 2027 dopiero po komunikatach ze stycznia |
| B5 | Regulamin modułu (odpowiedzialność, JDG jako konsument, dane podatkowe w RODO) | prawnik | brak |
| B6 | Pilot: 3-5 firm, księgowa kontroluje 2 pierwsze miesiące | Bartosz + sesja | brak |

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
- JPK_V7M jest wyłączony w interfejsie (`SUSPENDED_EXPORT_FORMATS`). Pilnują tego testy `jpk-v7m-wstrzymany*`. Generator odrzuca odwrotne obciążenie i nie śledzi P_39.
- `kpir_entries` istnieje, ale jest nieużywana. Nie myl jej z KPiR liczoną na żywo.
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
| 5.11.2026 | K2 | #408 | gotowy, PR otwarty | — | `tax_profiles` z migracją 00166 (do wgrania przed wdrożeniem): wersje po `valid_from`, wyzwalacz „forma tylko od 1 stycznia”, CHECK-i stawki i daty etapu ZUS, zapis tylko owner/admin, bez DELETE; `zapiszProfilPodatkowyAction` z audytem `tax_profile.saved`; kreator `/reports/ustawienia-podatkowe` jako zakładka Księgowości za wyłącznikiem (obszar `ustawienia` odblokowany w kodzie, o firmie decyduje `ksiegowosc_enabled`, reszta dostaje 404); stawkę ryczałtu pozycji rozstrzyga `stawkaRyczaltuPozycji` przy odczycie (stawka z pozycji, bez niej domyślna z wersji profilu na dzień sprzedaży), więc ścieżka wystawiania faktury jest nietknięta, a stawka na produkcie odłożona do K3; odmowa zmiany formy podaje, od kiedy nowa forma może obowiązywać; typy z produkcji po 00165; test RLS na prawdziwej bazie złapał CHECK przepuszczający ryczałt bez stawki (NULL), poprawione przed wgraniem; sprawdzone lokalnie na osobnej bazie ze wszystkimi migracjami i w przeglądarce (desktop i 375 px) |

**Następny krok:** K3, ewidencja przychodów (sekcja 12): `lib/ksiegowosc/ewidencja.ts` dla ryczałtu (faktury, korekty, zaliczki, FP, waluty) według zasad z sekcji 4, `ledger_manual_entries` z ekranem (raport kasy), `jpk-ewp.ts` walidowany XSD JPK_EWP(4) i pobieranie pliku. Stawka pozycji: `stawkaRyczaltuPozycji(pozycja.ryczalt_rate, wersjaNa(wersje, dzień sprzedaży))` z `lib/ksiegowosc/profil.ts`; pozycja bez stawki przy profilu bez stawki domyślnej i dzień bez profilu (`komunikatBrakuProfilu`) to odmowa z komunikatem, nigdy zero. Do rozstrzygnięcia w K3: poprawka wersji profilu zmienia wstecz stawkę pozycji bez własnej stawki, więc ewidencja za zamknięty miesiąc musi to pokazać albo zamrozić (np. zrzut przy pobraniu JPK); stawka na produkcie tylko wtedy, gdy ewidencja jej potrzebuje. Migracja: numer z rejestru (po 00166 następny wolny 00167; sprawdź otwarte PR i gałęzie). Gałąź `claude/ksiegowosc-k3-ewidencja` od świeżego `origin/main`, po scaleniu PR K2; 00166 musi być wgrana na db-1 przed wdrożeniem K2, a typy `tax_profiles` z produkcji idą do PR K3. Uwaga dla K4 i G4: przy kilku stawkach ryczałtu 50 % zdrowotnej odlicza się proporcjonalnie do przychodów z każdej stawki (podatki.gov.pl, zapisane przy `odliczenieZdrowotnej`).
