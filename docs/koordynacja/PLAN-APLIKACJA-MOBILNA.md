# Plan: aplikacja FaktWay na iPhone'a i Androida

> **„Kontynuuj plan aplikacji mobilnej”**: sesja czyta ten plik od góry, robi
> checklistę startową (sekcja 0) i pracuje od wiersza „Następny krok”
> w dzienniku (sekcja 9). Robi tylko ten jeden etap, dopisuje wiersz
> w dzienniku z numerem PR, aktualizuje „Następny krok”, składa raport i STOP.
>
> Zasady wyglądu: [`docs/mobile/ZASADY-DESIGNU.md`](../mobile/ZASADY-DESIGNU.md).
> Wzorce z Mobbin i lista poprawek: [`docs/mobile/WZORCE-MOBBIN.md`](../mobile/WZORCE-MOBBIN.md).
> Ten plik jest jedynym źródłem prawdy o aplikacji mobilnej.

Przygotowanie: 08.11.2026, odczyt `origin/main` @ `279e2b4c` (po #480).
To osobny tor względem planu kompletnej aplikacji webowej (PR #485 nazywa
aplikacje w sklepach „osobnym torem po tym planie”).

---

## 0. Start sesji: checklista

1. `git fetch origin && git log --oneline -1 origin/main`. Gałąź etapu od
   świeżego `origin/main`: `claude/mobile-mN-<temat>`.
2. Przeczytaj sekcje 1 do 5 tego planu, cały `docs/mobile/ZASADY-DESIGNU.md`
   i etap z „Następny krok”.
3. Zmiany w `app/`, `lib/`, `components/` idą według protokołu naprawy
   z `AGENTS.md` (najpierw test, potem kod). Kod w `mobile/` ma własne
   sprawdzenia (sekcja 4.4).
4. **Mac ma 16 GB.** Symulator iOS zajmuje kilka GB. Przy włączonym
   symulatorze nie uruchamiasz `pnpm build`, pełnego Vitest ani Supabase
   w Colimie. Przed ciężkim krokiem `memory_pressure | tail -1`.
5. **Strona i PWA się nie zmieniają.** Wygląd aplikacji webowej na Macu jest
   zamrożony; ten plan buduje osobnego klienta.
6. Scalanie i wdrożenie tylko na polecenie Bartosza (`AGENTS.md`).
7. Po etapie: wiersz w dzienniku, nowy „Następny krok”, raport (status,
   tabela weryfikacji ze zrzutami z symulatora, numer PR, co dalej) i STOP.

---

## 1. Cel i miara

**Cel.** Aplikacja w App Store i Google Play, która w ręce wygląda i działa
jak aplikacje fintech z dużym budżetem: płynna, uporządkowana, przewidywalna.
Robi kilka rzeczy z telefonu perfekcyjnie; resztę klient robi na komputerze.

**Miara „gotowe do sklepu”**
- Każdy ekran przechodzi checklistę z `ZASADY-DESIGNU.md`, sekcja 12.
- Bartosz używa aplikacji na swoim iPhonie przez tydzień i nie zgłasza
  „dziwnego” zachowania.
- Kilku prawdziwych klientów w becie TestFlight; zero błędów blokujących
  wystawienie faktury.

**Czego nie obiecujemy:** poziomu nagród designu Apple. To wymaga zespołu
projektantów przez lata. Celem jest najlepsza aplikacja do faktur w Polsce
i poziom porządnych aplikacji fintech.

---

## 2. Decyzje

| Nr | Decyzja | Stan |
|---|---|---|
| D1 | **Technologia:** Expo (React Native), nowa aplikacja natywna; nie opakowane PWA (ryzyko odrzucenia z wytycznej 4.2 i ten sam „dziwny” wygląd), nie osobno Swift i Kotlin (dwie aplikacje to za dużo dla zespołu) | przyjęta 08.11.2026 (start etapu M1) |
| D2 | **Gdzie kod:** folder `mobile/` w tym repo, żeby aplikacja i jej API zmieniały się w jednym PR i agenci widzieli oba końce. Koszt: wyłączenia w konfiguracji (sekcja 4.4) | przyjęta 08.11.2026 (Bartosz: start M2) |
| D3 | **Zakres: pełna zgodność ze stroną.** Na telefonie są wszystkie funkcje i karty aplikacji webowej, natywnie i płynnie (wygląd: D12), bez „okrojonej” wersji. Powód (Bartosz): klienci inFaktu złoszczą się, że płacą abonament, a na telefonie mają tylko część. Pierwotne „sześć zadań” z sekcji 3 to teraz kolejność budowy, nie granica zakresu. Wyjątki: zakup abonamentu (D5) i Flo (D13) | zmieniona 09.11.2026 (Bartosz) |
| D4 | **Konta deweloperskie:** Apple (99 USD rocznie) i Google Play (25 USD jednorazowo) zakładamy jako firma, po założeniu spółki. Konto Apple dla JDG pokazuje w sklepie imię i nazwisko; nowe konto osobiste Google wymaga zamkniętego testu z 12 testerami przez 14 dni | do decyzji Bartosza |
| D5 | **Płatności:** v1 nie sprzedaje abonamentu w aplikacji. Brak cen i przycisku „kup”, zakup na faktway.pl. Przed zgłoszeniem sprawdzić aktualne wytyczne Apple 3.1 | rekomendacja |
| D6 | **Projektant iOS:** na zlecenie, raz: system (kolor, typografia, ikona aplikacji) i 8 do 10 kluczowych ekranów w Figmie na zestawie Apple. Bez projektanta: Claude daje 2 do 3 wariantów ekranu wzorcowego, Bartosz wybiera | do decyzji Bartosza |
| D7 | **Miejsce „Nowa faktura”:** szeroki bloczek (przycisk Liquid Glass na całą szerokość) u góry listy faktur, pod sumą „Do zapłaty”; nie plus w pasku i nie pasek nad zakładkami | przyjęta 09.11.2026 (Bartosz: „u góry w bloczku, nie w krzyżyku”) |
| D8 | **Kolejność platform:** najpierw iOS do poziomu „wzorzec”, potem dopasowanie Androida z tego samego kodu przed betą Google Play | rekomendacja |
| D9 | **Powiadomienia:** z workera pg-boss bezpośrednio do APNs i FCM albo przez usługę push Expo (nowy podmiot przetwarzający, serwery poza UE). W obu przypadkach treść bez kwot i danych kontrahenta | otwarta, rozstrzygnąć w M11 |
| D10 | **Identyfikator aplikacji:** `pl.faktway.app` na iOS (bundle ID) i Androidzie (package). Po publikacji nie do zmiany | przyjęta 08.11.2026 |
| D12 | **Wygląd: FaktWay, nie „produkt Apple”.** Treść ekranów mówi językiem wersji na komputer (plan Finora, D2): czcionka Outfit, liczby, numery i daty w IBM Plex Mono, kolory presetu Modern Minimal z `app/globals.css` (niebieski `#2463EF`), płaskie karty z cienką obwódką i nagłówkiem w środku, okrągłe ikony Remix na jasnoniebieskim tle, statusy jak `components/invoices/status-badge.tsx`, wykresy w odcieniach niebieskiego. Natywne zostaje to, co daje płynność: stos ekranów, pasek zakładek, arkusze, gesty, wibracje, menu i podgląd przy przytrzymaniu | przyjęta 10.11.2026 (Bartosz: „wygląda dosłownie jak produkt Apple, zrób bardziej pod FaktWay”); karty, liczby i gradient zmienione 12.11.2026 przez D15 |
| D13 | **Bez Flo.** Na telefonie nie ma ekranu Flo, ustawień Flo, „Twój rok w liczbach” (na stronie `flo/wrapped`) ani podpowiedzi „Mogę wypełnić to za Ciebie” | przyjęta 10.11.2026 (Bartosz: „na razie zrezygnowaliśmy”) |
| D11 | **Zakładki (5):** Pulpit, Faktury, Koszty (wydatki i skrzynka KSeF), Księgowość (Ten miesiąc, KPiR, ewidencja, VAT, eksport), Więcej (kontrahenci, import, wszystkie ustawienia). Pięć to granica paska zakładek iOS; reszta strony siedzi w Więcej | zmieniona 09.11.2026 (M4, po zmianie D3) |
| D14 | **Wzór układu: Copilot i Revolut Business** (przegląd Mobbin, [`WZORCE-MOBBIN.md`](../mobile/WZORCE-MOBBIN.md)). Szkielet całej aplikacji (Pulpit, listy po dniach, Koszty, Księgowość) według Copilota, moduł faktur (lista, kreator, szczegół, potwierdzenie) według Revolut Business, oba w jasnym motywie FaktWay; z Rocket Money kalendarz terminów. Bierzemy układ, hierarchię i przepływ. Zmiany zasad wyglądu, które ten wzór wymaga: D15 | przyjęta 12.11.2026 (Bartosz: „Copilot + Revolut”) |
| D15 | **Wygląd jak Copilot** (zmienia D12 w pięciu punktach; czcionka Outfit, niebieski `#2463EF`, ikony Remix, statusy, natywne zachowanie i 5 zakładek zostają). (1) Miękki gradient w odcieniach niebieskiego pod nagłówkiem ekranów zakładek i szczegółów. (2) Karty zaokrąglone (18 pt) bez obwódki, z delikatnym cieniem, na chłodnoszarym tle. (3) Kolorowe plakietki kategorii kosztów. (4) Grosze w indeksie górnym w dużych kwotach. (5) Liczby, kwoty i numery w Outfit z cyframi tabelarycznymi zamiast IBM Plex Mono. Szczegóły w `ZASADY-DESIGNU.md` (wersja 3), makieta pięciu ekranów u Bartosza | przyjęta 12.11.2026 (Bartosz po makiecie: „Wszystko jak Copilot”) |
| D16 | **Logowanie hasłem z telefonu przez nasze API**, nie wprost do GoTrue (M5b) i nie przez Turnstile w aplikacji. `POST /api/mobile/v1/logowanie` loguje w GoTrue kluczem serwisowym, który GoTrue z captchą przepuszcza bez tokenu (sprawdzone 13.11.2026 na lokalnym GoTrue z captchą, wynik w 4.2), za naszymi limitami prób (adres IP, e-mail i wspólny ze stroną; bez Redisa odmowa) i z wpisem w audycie. Kod 2FA, odświeżanie sesji i wylogowanie telefon robi dalej sam w GoTrue, bo captchy nie wymagają. Powód: krok 2 runbooka `docs/runbooks/captcha-w-gotrue.md` włącza captchę w GoTrue i wtedy `signInWithPassword` z aplikacji bez tokenu Turnstile zostaje odrzucone; natywny ekran bez okienka Cloudflare | przyjęta 13.11.2026 (Bartosz) |

---

## 3. Zakres: wszystko, co na stronie (D3 od 09.11.2026)

Tabela niżej to pierwsze zadania (kolejność budowy). Pełny spis funkcji
strony i ich odpowiedników na telefonie leży w sekcji 3a.

| Zadanie | Co klient robi | Element natywny | Skąd dane i akcje dziś |
|---|---|---|---|
| Skrzynka KSeF | widzi nowe faktury kosztowe, otwiera, oznacza do opisania | lista, odświeżanie pociągnięciem, powiadomienie | odczyt z bazy (RLS); `requestInboxCheckAction` w `app/actions/ksef-inbox.ts` |
| Szybka faktura | wystawia fakturę dla ostatniego kontrahenta albo z kopii, wysyła do KSeF, widzi status | arkusz z formularzem, wibracja „przyjęta” | `saveAndSendInvoiceAction` w `components/invoices/actions.ts` (reeksport w `app/(dashboard)/invoices/new/actions.ts`), generator FA(3) w `lib/xml/` |
| Wydatek ze zdjęcia | skanuje paragon albo fakturę, sprawdza odczyt, zapisuje | systemowy skaner dokumentów, aparat | `uploadExpensePhotoAction`, `getOcrJobStatusAction`, `reviewExpenseAction` w `app/actions/expenses.ts` |
| Należności | widzi, kto nie zapłacił, oznacza zapłatę, wysyła przypomnienie | gest przesunięcia wiersza, menu kontekstowe | `markInvoicePaidAction`, `undoInvoicePaidAction` w `app/actions/invoice-payments.ts`; `app/actions/reminders.ts` |
| Podgląd i PDF | otwiera fakturę, udostępnia PDF mailem albo komunikatorem | systemowy arkusz udostępniania | `app/api/invoices/[id]/pdf/route.ts` |
| Ten miesiąc | widzi, ile podatku, ZUS i VAT zapłacić i do kiedy | lista z kwotami, przypomnienie | `app/actions/ksiegowosc-ten-miesiac.ts`, moduł `lib/ksiegowosc/` (za wyłącznikiem `ksiegowosc`) |

~~Zostaje na komputerze~~: nieaktualne od zmiany D3 (09.11.2026). Na komputerze
zostaje tylko panel administratora FaktWay (`/admin`) i zakup abonamentu (D5).

## 3a. Mapa: strona na telefonie (M4, 09.11.2026)

Każda sekcja panelu strony ma odpowiednik w aplikacji (`mobile/src/app/`).
Od M7 na prawdziwym koncie z bazy są: firma i konto (`GET /konto`), faktury
wystawione (lista, szczegół) i skrzynka KSeF (lista, szczegół). Reszta ekranów
zostaje na danych przykładowych do M8 (wystawienie), M9 (wydatki ze zdjęcia)
i M10 (pozostałe); stopka w Więcej mówi o tym klientowi.

| Strona (`app/(dashboard)/`) | Telefon | Trasy |
|---|---|---|
| `dashboard` (pulpit, wykresy, należności, najlepsi klienci) | zakładka Pulpit | `(pulpit)/index` |
| `przeplywy` | Pulpit → Przepływy | `(pulpit)/przeplywy` |
| `analizy` (sprzedaż, koszty) | Pulpit → Analizy (przełącznik, wykres kołowy, kalendarz) | `(pulpit)/analizy` |
| `(faktury)`, `invoices` (lista, Wystawione, Cykliczne, Po terminie, filtry) | zakładka Faktury, bloczek „Nowa faktura” (D7) | `faktury/index` |
| `invoices/[id]` (status, UPO, zapłata, PDF, XML, korekta, duplikat, cykliczna, e-mail) | szczegół faktury, menu akcji, Popraw i Edytuj dla szkicu i odrzuconej | `faktury/[id]`, `faktury/email` |
| `invoices/new` (zwykła, korygująca, zaliczkowa, rozliczająca) | arkusz: wybór rodzaju, formularz | `faktury/nowa/index`, `faktury/nowa/[rodzaj]` |
| `invoices/recurring` | arkusz faktury cyklicznej | `faktury/cykliczna` |
| przypomnienia o zapłacie | arkusz przypomnienia z faktury | `faktury/przypomnienie` |
| `(koszty)`, `expenses` (wydatki, skrzynka KSeF, OCR, opis) | zakładka Koszty, „Dodaj wydatek”, opis i akceptacja | `koszty/index`, `koszty/dodaj`, `koszty/[id]` |
| `reports` (Ten miesiąc, KPiR, ewidencja, VAT i JPK, eksport) | zakładka Księgowość | `ksiegowosc/*` |
| ustawienia podatkowe | Księgowość → Ustawienia podatkowe | `ksiegowosc/ustawienia-podatkowe` |
| `contractors` | Więcej → Kontrahenci | `wiecej/kontrahenci/*` |
| `import-danych` | Więcej → Import danych | `wiecej/import` |
| `settings` (firma, bezpieczeństwo, powiadomienia, KSeF, przypomnienia, księgowa, zespół, abonament, dziennik, konto; bez Flo, D13) | Więcej → Ustawienia, ekran na kartę | `wiecej/ustawienia/*` |

Symulowane na danych przykładowych: przyjęcie w KSeF (2,5 s), odczyt OCR,
wysyłka e-maili i JPK, pliki PDF i XML (arkusz udostępniania z opisem),
pobieranie historii KSeF. Abonament tylko do odczytu (D5). Znane
uproszczenie do M7: stawki zw, oo i np zapisują się jako 0%, bo model
przykładowy trzyma stawkę jako liczbę.

---

## 4. Architektura

### 4.1 Klient
- Expo (aktualne SDK; w listopadzie 2026 to 58 lub nowsze, sprawdź przy M2),
  Expo Router: `expo-router/native-tabs` (zakładki systemowe, Liquid Glass na
  iOS) i natywny stos.
- Elementy SwiftUI przez Expo UI tam, gdzie React Native nie ma odpowiednika.
- Testujemy na **development build**, nie w Expo Go (natywne zakładki, Expo UI
  i efekt szkła nie działają tam pewnie).
- Typy bazy z `types/` i schematy Zod współdzielone ze stroną. M2 ustalił:
  do M6 aplikacja ma małą kopię formatowania (`mobile/src/lib/format.ts`),
  a sposób współdzielenia typów i schematów Zod (import przez Metro czy
  wspólny pakiet) rozstrzyga M6 razem z API. **M6 rozstrzygnął:** kontrakt
  API (nagłówki, kody błędów, kształty odpowiedzi) leży w
  `lib/api/mobile/kontrakt.ts` bez żadnych importów (pilnuje
  `tests/unit/mobile-api-kontrakt.test.ts`), bez wspólnego pakietu. M7
  podłącza go w aplikacji importem przez Metro; gdyby Metro z `mobile/` nie
  widziało pliku spoza folderu, kopia w `mobile/` z testem zgodności. Schematy
  Zod treści żądań (od M8) potrzebują importu `zod`, więc dostaną osobny plik.
- Listy krótkie i stałe (ustawienia, szczegóły) można składać z `@expo/ui`
  (prawdziwe SwiftUI i Compose); listy danych o nieznanej długości z FlatList
  albo FlashList. Wybór sprawdza M3 na ekranie wzorcowym.

### 4.2 Logowanie
- `@supabase/supabase-js` z sesją w `expo-secure-store`. E-mail i hasło,
  Google, 2FA (TOTP, jak na stronie).
- **„Zaloguj przez Apple” obowiązkowe na iOS** (wytyczna 4.8), bo jest
  logowanie Google. Wymaga płatnego konta Apple; GoTrue ma dostawcę Apple.
- Odblokowanie Face ID albo odciskiem palca (`expo-local-authentication`).
- Usuwanie konta dostępne w aplikacji (wymóg Apple); prowadzi do istniejącej
  ścieżki RODO z 14 dniami na rezygnację (`docs/adr/0006-gdpr-14d-cooling-off.md`).
- **Hasło przez nasze API (D16, M6b).** Telefon wysyła e-mail i hasło na
  `POST /api/mobile/v1/logowanie` (`lib/api/mobile/logowanie.ts`), dostaje
  sesję GoTrue i `wymagaKodu`, a sesję wkłada do klienta przez
  `supabase.auth.setSession`. Trasa loguje kluczem serwisowym, limity prób:
  20 na adres IP i 10 na e-mail w 15 minut oraz limit strony (5 na adres i
  e-mail, ten sam kubełek). Bez Redisa odmawia (503 `login_unavailable`,
  „Zaloguj się na faktway.pl albo spróbuj za kilka minut”). Wpisy:
  `auth.login` jak na stronie (zaraz po haśle) i `auth.login_failed` bez
  konta i adresu e-mail. Google zostaje wprost w GoTrue (PKCE).
- **Captcha w GoTrue, sprawdzenie 13.11.2026** (lokalny GoTrue v2.197.0,
  `[auth.captcha]` z sekretem testowym Cloudflare „zawsze odrzuca”). Odmowa
  bez tokenu: logowanie hasłem kluczem anon, `/recover`, `/signup`, `/otp`.
  Przechodzą bez tokenu: logowanie hasłem z kluczem serwisowym w
  `Authorization` (JWT albo `sb_secret_` w `apikey`; sesja wychodzi zwykła,
  rola `authenticated`, AAL1), `refresh_token`, `pkce` (Google), `id_token`
  (Apple), `/factors` (włączenie, `challenge`, `verify`) i `/logout`.
  „Nie pamiętasz hasła?” w aplikacji otwiera stronę (tam jest Turnstile).
  Na GoTrue z captchą test `tests/rls-mobile-logowanie.test.ts` uruchamia się
  z `RLS_TEST_GOTRUE_CAPTCHA=on`; w CI GoTrue nie ma captchy.

### 4.3 Serwer: API dla aplikacji
Logika siedzi dziś w akcjach serwera (`app/actions/*`, `components/invoices/*-actions.ts`),
a te czytają sesję z ciasteczek. Aplikacja natywna ich nie wywoła. Dlatego:
- **Odczyty** prosto z Supabase klientem aplikacji; chroni je RLS.
- **Zapisy i operacje serwerowe** (wysyłka do KSeF, PDF, OCR, przypomnienia)
  przez nowe trasy `app/api/mobile/v1/*` z nagłówkiem `Authorization: Bearer`
  (token sesji Supabase). Trasa buduje klienta Supabase z tego tokenu, więc
  RLS działa jak na stronie.
- Trasy wołają te same funkcje z `lib/` co akcje serwera. Gdzie logika siedzi
  w samej akcji, najpierw wydzielamy ją do `lib/` (bez zmiany zachowania,
  z testem), dopiero potem dokładamy trasę.
- `lib/supabase/middleware.ts` przepuszcza `/api/` tylko z listy
  `PUBLIC_API_PREFIXES`; prefiks `/api/mobile` trzeba tam dopisać, a każda
  trasa sama odrzuca żądanie bez ważnego tokenu (test na brak i zły token).
- Limity prób jak na stronie (`lib/rate-limit`), wpis w `audit_logs` dla akcji
  istotnych, jak na stronie.
- Tokeny push urządzeń: nowa tabela z `tenant_id` i RLS (migracja z rejestru
  w `CLAUDE-DO-CODEXA.md`, w M11).

**Stan po M6 (13.11.2026).** Szkielet w `lib/api/mobile/`, trasy w
`app/api/mobile/v1/`:
- Proxy: `/api/mobile` jest na liście ścieżek bez sesji (`isMobileApiPath`
  w `lib/supabase/middleware.ts`, obok `/api/v1`), a nie w `PUBLIC_API_PREFIXES`.
  Proxy nie buduje tu klienta z ciasteczek, więc sesja przeglądarki niczego
  w tym API nie otwiera (bez CSRF), a przerwę techniczną sprawdza trasa.
- Każde żądanie: `Authorization: Bearer <access_token>`; trasy z danymi firmy
  także `X-Active-Org: <uuid>` (członkostwo sprawdzone tokenem klienta, potem
  ten sam nagłówek idzie do PostgREST jak ze strony). Bramka w
  `authenticateMobileRequest`: przerwa techniczna, limit na adres (300 na
  minutę, także bez tokenu), kształt tokenu, GoTrue (`getVerifiedMfaStateForToken`,
  ta sama reguła 2FA co strona), limit na osobę (120 na minutę), firma.
- Odpowiedzi: JSON, `Cache-Control: no-store`, `X-Request-Id`; błąd
  `{ error: { code, message } }` z kodem z kontraktu. Dla aplikacji: 401
  (`missing_token`, `invalid_token`) to odświeżenie sesji i jedno ponowienie
  (wygasły token dostępu co godzinę), a koniec sesji w telefonie dopiero po
  nieudanym odświeżeniu; 403
  `mfa_required` prosi o kod, 400 `missing_org` i 403 `no_active_org` odświeżają
  wybór firmy, 429 i 503 (`maintenance`, `session_verification_failed`,
  `service_unavailable`) to „ponów”, nigdy wylogowanie: awaria GoTrue daje 503,
  nie 401.
- `GET /api/mobile/v1/konto`: konto, 2FA (`wlaczone`, `poziom`), firmy z rolą
  i `aktywnaFirma` (ostatnio używana na stronie, gdy nadal jest dostęp).
- `POST /api/mobile/v1/sesja`: wpis `auth.login` (`method` z claimu `amr`,
  `session_id`, `client: 'mobile'`) raz na sesję i zlecenie maila o nowym
  urządzeniu, jak logowanie na stronie. Aplikacja woła ją po pełnym logowaniu
  (po kodzie 2FA). Bez niej logowanie z telefonu nie zostawia śladu w historii
  logowań ani maila.
- Testy: `tests/unit/mobile-api-trasy.test.ts` (prawdziwe trasy, atrapy HTTP),
  `tests/unit/mobile-api-proxy.test.ts`, `tests/rls-mobile-api.test.ts` (prawdziwy
  GoTrue i PostgREST w jobie CI „RLS isolation”).

**Stan po M7 (13.11.2026).** Aplikacja korzysta z API i bazy na prawdziwym koncie:
- Kontrakt strony importowany przez Metro (`mobile/metro.config.js`,
  `watchFolders` tylko na `lib/api/mobile`), bez kopii. Klient API w
  `mobile/src/lib/api/` (rdzeń bez React Native, testy
  `tests/unit/mobile-api-klient.test.ts`): każdy kod z kontraktu ma reakcję,
  401 to odświeżenie sesji i jedno ponowienie, brak sieci i 503 nie wylogowują.
  Adres serwera w `EXPO_PUBLIC_API_URL`.
- Odczyty wprost z bazy (`mobile/src/lib/dane/zapytania.ts`): faktury
  wystawione (200 ostatnich, z pozycjami) i skrzynka KSeF (200 najnowszych, ze
  statusem wydatku), zawsze z jawnym tokenem i `x-active-org`. Mapowanie
  kolumn jak na stronie (`mapowanie.ts`, testy `mobile-dane-mapowanie.test.ts`),
  także `failed` jako „Błąd wysyłki do KSeF” (nie „Odrzucona”), zapłata
  częściowa, waluta obca, stawki zw/np.
- Stan konta w `mobile/src/stan/dane.tsx`: `GET /konto` (karta konta, nazwa
  firmy w blokadzie, wybór firmy w Więcej zapisany na telefonie), dane z
  poprzedniego otwarcia od razu z plików (`Paths.cache/faktway-dane/`, klucz
  konto i firma), świeże w tle; `POST /sesja` raz na sesję po pełnym logowaniu.
  `mfa_required` prowadzi do ekranu kodu, `invalid_token` po nieudanym
  odświeżeniu kończy sesję.
- Start bez sieci z wygasłym tokenem: konto z sesji w pęku kluczy
  (`lib/logowanie/token.ts`, konto z 2FA bez kodu i tak do logowania), dane z
  poprzedniego otwarcia z notą „Bez internetu. Dane z …”; po powrocie sieci
  dane same się odświeżają (odświeżenie tokenu albo próba co 30 s).
- Wylogowanie, „Zaloguj się na inne konto” i koniec sesji z serwera czyszczą
  stan w pamięci i pliki danych (`pamiec.ts` z epoką: pobranie zaczęte przed
  wylogowaniem nic już nie zapisze; testy `mobile-dane-pamiec.test.ts`).
- Zapisy na prawdziwych fakturach (zapłata, wystawienie, wysyłka, e-mail, PDF,
  przypomnienia, cykliczne) jeszcze bez API: telefon ich nie udaje, tylko mówi,
  gdzie to zrobić, i otwiera fakturę na stronie (`komponenty/na-stronie.tsx`).

### 4.4 Repozytorium (folder `mobile/`, jeśli D2 przyjęte)
Dziś konfiguracja obejmuje całe repo, więc w M2 trzeba:
- `tsconfig.json` (`include: **/*.ts`): dodać `mobile` do `exclude`;
- `eslint.config.mjs`: `mobile/**` do `globalIgnores`;
- `.dockerignore`: `mobile`, żeby nie trafiał do obrazu produkcji;
- `knip.jsonc`: `mobile/**` do ignorowanych;
- pnpm: `mobile/` z własnym `package.json`; sposób instalacji (członek
  workspace czy osobny lockfile) ustala M2 tak, żeby `pnpm install` w root
  i obraz Dockera się nie zmieniły;
- CI: osobny job „Mobile” (typy, eslint, testy jednostkowe aplikacji),
  na start **niewymagany**, żeby nie zmieniać 11 wymaganych kontroli `main`;
- `tests/unit/nazwa-produktu.test.ts` skanuje tylko wybrane katalogi; dopisać
  `mobile`, żeby teksty aplikacji też mówiły „FaktWay”.

Budowanie: lokalnie przez Xcode (development build na symulator i kablem na
iPhone'a) do czasu płatnego konta; potem EAS Build w chmurze i EAS Submit.

---

## 5. Pętla jakości: jak Claude widzi to, co robi

| Narzędzie | Do czego | Stan 08.11.2026 |
|---|---|---|
| Xcode | budowanie i symulator | 27.2 zainstalowany |
| Symulator iOS | uruchomienie, zrzuty, klikanie i przewijanie przez narzędzie symulatora w aplikacji Claude | iOS 27.2; urządzenia od iPhone 17e do iPhone 18 Pro Max. Dostęp w panelu przyznany 08.11.2026 |
| iPhone Bartosza | ocena „w ręce”: płynność, wibracje, czytelność | bez płatnego konta: kablem z Xcode, darmowe Apple ID, instalacja ważna 7 dni |
| Skille Expo | kopie z github.com/expo/skills (MIT) w `.claude/skills/expo-*`: `expo-native-ui`, `expo-router`, `expo-ui`, `expo-animation`, `expo-design-system` | zrobione w M2 |
| Skill projektu | `.claude/skills/telefon-app/` odsyła do `ZASADY-DESIGNU.md` i checklisty; Codex czyta `mobile/AGENTS.md` i zasady z `docs/` | zrobione w M2 |
| Wzorce | Mobbin Pro przez serwer MCP w Claude Code (`search_screens`, `search_flows`, kolekcje); przegląd i lista poprawek w [`WZORCE-MOBBIN.md`](../mobile/WZORCE-MOBBIN.md), sposób pracy w jego sekcji 9 | od 12.11.2026 |

Zasada: żaden ekran nie idzie do PR bez zrzutów z checklisty i porównania
ze wzorcem. Wibracji i płynności Claude nie oceni; ocenia Bartosz na telefonie.

---

## 6. Po stronie Bartosza (poza kodem)

| Sprawa | Po co | Kiedy |
|---|---|---|
| Zgoda na dostęp w panelu symulatora | Claude klika i robi zrzuty sam | zrobione 08.11.2026 |
| Mobbin | wzorce dla ekranów | zrobione 12.11.2026 (Mobbin Pro, połączenie MCP) |
| Decyzja D6 (D2 i D3 przyjęte 08.11.2026) | sposób pracy nad wyglądem | przed M3 |
| Projektant iOS (jeśli D6 na tak) | system i ekrany kluczowe | najlepiej przed M3 |
| Spółka, D-U-N-S, konta Apple i Google (D4) | TestFlight, push, logowanie Apple, sklep | przed M11 |
| Dane usługodawcy w polityce prywatności | sklepy wymagają polityki i etykiet prywatności | przed M13 |

---

## 7. Etapy

Każdy etap: jeden PR, raport i STOP. Ocena Bartosza na telefonie jest
częścią „gotowe” od M3.

| Etap | Co | Gotowe, gdy |
|---|---|---|
| M1 | Plan i zasady designu (ten plik, `ZASADY-DESIGNU.md`, hasło w `AGENTS.md`) | PR otwarty |
| M2 | Fundament: Expo w `mobile/`, wyłączenia z 4.4, natywne zakładki i stos, kolory semantyczne i tryb ciemny, skille Expo i `telefon-app`, dane przykładowe | aplikacja startuje w symulatorze, zrzuty jasny i ciemny, CI strony bez zmian |
| M3 | **Ekran wzorcowy** na danych przykładowych: lista faktur i szczegół, dopracowane do checklisty; warianty D7 | Bartosz na swoim iPhonie mówi „to jest to”. Bez tego nie ma kolejnych ekranów |
| M4 | **Pełny zakres na danych przykładowych** (D3): wszystkie sekcje strony według mapy 3a, pięć zakładek (D11), bloczek „Nowa faktura” (D7) | każdy ekran z 3a otwiera się w symulatorze, jasny, ciemny i duży tekst bez ucięć; przegląd kodu |
| M4b | **Wygląd FaktWay** (D12) i usunięcie Flo (D13) na tych samych ekranach | zrzuty jasne i ciemne obok wersji M4; duży tekst bez ucięć; przegląd kodu |
| M4c | **Wykończenie Copilota w fundamencie** (D15): tokeny (tło `#F2F4F7`, karta 18 pt bez obwódki z cieniem, kolory kategorii z testem kontrastu), Outfit z cyframi tabelarycznymi zamiast IBM Plex Mono, komponenty gradientu pod nagłówkiem, kwoty z groszami w indeksie, plakietki kategorii, pigułki i przycisku tonalnego. Najpierw próba: duży tytuł natywnego paska na gradiencie (pułapka iOS 27 z `mobile/AGENTS.md`) | wszystkie ekrany M4b w nowym wykończeniu, układ bez zmian; zrzuty jasne i ciemne obok M4b; duży tekst bez ucięć; przegląd kodu |
| M4d | **Układ Copilota na zakładkach** (D14): Pulpit (karta wyniku z wykresem, „Do przejrzenia”, „Nadchodzące”), Faktury („Do zapłaty”, pigułki, grupy), Koszty (lista po dniach z kategoriami); pozycje 1 i 2 z `WZORCE-MOBBIN.md` | treść nad zgięciem na trzech zakładkach; zgodność z makietą; Bartosz ocenia na iPhonie |
| M4e | **Faktury jak Revolut Business** (D14): formularz z kart z przypiętymi „Podgląd” i „Wyślij do KSeF”, potwierdzenie „Przyjęta w KSeF”, szczegół z rzędem akcji i historią; pozycje 4 i 6 | przepływ od bloczka „Nowa faktura” do szczegółu na danych przykładowych, jasny, ciemny, duży tekst |
| M4f | **Księgowość, Więcej i stany ekranu**: terminy na górze z kalendarzem (wzór Rocket Money), nagłówek konta w Więcej, wspólne stany (szkielet, błąd, pusty z akcją, „Cofnij”, potwierdzenia w arkuszu akcji); pozycje 3, 5 i 8 | cztery stany na każdej liście; przegląd kodu |
| M5a | **Przepływ logowania na danych przykładowych** (`WZORCE-MOBBIN.md` 7): logowanie e-mailem i hasłem albo przez Google, kod 2FA, propozycja Face ID, blokada przy powrocie, zasłona w przełączniku aplikacji, „Wyloguj się”, usuwanie konta z Google; warstwa `stan/sesja.tsx` z interfejsem dla M5b | cały przepływ w symulatorze, jasny, ciemny i duży tekst; przegląd kodu |
| M5b | **Logowanie na prawdziwym koncie:** `@supabase/supabase-js` z sesją w `expo-secure-store`, `mfa.verify`, Google przez `openAuthSessionAsync`, Face ID przez `expo-local-authentication`, „Wklej” kod (`expo-clipboard`), ekran startu z logo do odczytu sesji; nowy build w Xcode. Sprawdzić, czy GoTrue wymaga tokenu sprawdzenia bota (na stronie `bot_check_failed`). Z przeglądu M5a: usunięcie konta z Google bez 2FA potwierdza Face ID (zrobione); czyszczenie danych poprzedniego konta przy wylogowaniu przechodzi do M7, kiedy w pamięci będą prawdziwe dane | logowanie na konto testowe z lokalnej bazy działa w symulatorze |
| M6 | API `app/api/mobile/v1` (szkielet, token, limity, audyt) i pierwsze trasy | testy tras na brak i zły token, RLS na bazie |
| M6b | **Logowanie hasłem przez API** (D16): trasa `POST /api/mobile/v1/logowanie` (limity, audyt, odmowa bez Redisa), w aplikacji `zaloguj` przez trasę i `setSession`; najpierw sprawdzenie na lokalnym GoTrue z captchą, czego captcha wymaga | test trasy na prawdziwym GoTrue z captchą; logowanie z symulatora na lokalnej bazie z captchą: hasło, kod 2FA, Pulpit |
| M7 | Faktury i skrzynka KSeF na prawdziwych danych; wylogowanie i „Zaloguj się na inne konto” czyszczą dane poprzedniego konta w pamięci; start bez internetu z wygasłym tokenem pokazuje dane z poprzedniego otwarcia zamiast logowania (przegląd M5b) | lista i szczegół z bazy, odświeżanie, stany ekranu |
| M8 | Szybka faktura z wysyłką do KSeF (środowisko TEST) | faktura przyjęta przez KSeF TEST z telefonu |
| M9 | Wydatek ze zdjęcia: skaner, OCR, sprawdzenie | wydatek zapisany ze skanu |
| M10 | Pozostałe ekrany z 3a na prawdziwych danych (należności, przypomnienia, PDF, księgowość, ustawienia); usuwanie konta przez API, z 2FA i metodą logowania z serwera, nie z przełącznika przykładowego (przegląd M5b) | każdy ekran z 3a czyta i zapisuje bazę |
| M11 | Powiadomienia push (D9), logowanie Apple; wymaga płatnego konta | powiadomienie o nowej fakturze na telefonie |
| M12 | Android: dopasowanie konwencji (sekcja 10 zasad) | checklista na emulatorze Androida |
| M13 | Sklep: ikona, zrzuty, opisy, polityka i etykiety prywatności, konto dla recenzenta, beta TestFlight i zamknięty test Google | aplikacja zgłoszona do przeglądu |

---

## 8. Ryzyka

| Ryzyko | Co robimy |
|---|---|
| Odrzucenie przez Apple za „stronę w ramce” (4.2) | aplikacja natywna z funkcjami telefonu: skaner, Face ID, powiadomienia, udostępnianie |
| Brak logowania Apple przy logowaniu Google (4.8) | M11, przed zgłoszeniem |
| Brak spółki blokuje konta firmowe | M1 do M10 nie potrzebują płatnych kont |
| Pamięć Maca | sekcja 0, punkt 4 |
| Rozjazd logiki strony i aplikacji | trasy API wołają te same funkcje z `lib/`, schematy Zod wspólne |
| „Ładne, ale nijakie” | wzorce, ekran wzorcowy z akceptacją Bartosza (M3), projektant (D6) |

---

## 9. Dziennik

**Następny krok:** M8, szybka faktura z wysyłką do KSeF (środowisko TEST).
Na start M8: trasa zapisu w `app/api/mobile/v1` (wystawienie i wysyłka tymi
samymi funkcjami z `lib/` co `saveAndSendInvoiceAction`; logikę z akcji
najpierw wydzielić do `lib/` z testem, plan 4.3), schematy Zod treści żądania w
osobnym pliku obok kontraktu (decyzja 4.1: jak trafią do aplikacji), klucz
idempotencji żądania (protokół naprawy, punkt 5). W aplikacji formularz z M4e
zamiast `EkranTylkoNaStronie` w `faktury/nowa/*` i `dodajFakture`/`wyslijDoKsef`
w `stan/dane.tsx` przez API zamiast `naStronie`. „Stan po M7” w 4.3.
**Stos nie jest w `main`:** M7 stoi na M6 (#668), M6 na scaleniu M4e do M5b
(#669), a do `main` przenosi je #670; PR M7 (#671) ma bazę
`claude/mobile-scalenie-m6`, po scaleniu #670 bazę trzeba przestawić na `main`.
**Przed logowaniem z telefonu na produkcji:** adres powrotu `faktway://**` w
GoTrue (Google). Logowanie hasłem idzie od M6b przez `POST
/api/mobile/v1/logowanie` (D16), więc krok 2 runbooka `captcha-w-gotrue.md`
nie blokuje aplikacji z M6b; wymaga działającego Redisa (bez niego trasa
odmawia). Z M6b zostaje: limity GoTrue na adres widzą przy logowaniu hasłem
tylko adres app-1 (tak samo strona; plan skalowania, sesja 25), kod 2FA z
telefonu idzie wprost do GoTrue bez naszego limitu prób i wpisu
`auth.mfa_challenge_*` (strona ma oba). Z M7 zostaje: wybór firmy na telefonie nie zmienia
`last_active_tenant_id` (strona zaczyna od swojej firmy; trasa w M10, jeśli
ma być wspólny), Pulpit, Wydatki, Księgowość i ustawienia na danych
przykładowych do M9 i M10, „Sprawdź teraz” w skrzynce KSeF czeka na trasę
API (M10), ścieżka `mfa_required` w trakcie sesji sprawdzona testem, nie w
symulatorze. Otwarte: 3.9 („Nowa faktura” jednym dotknięciem), kopiowanie
jednym dotknięciem (5.2), D4, D6.

| Data | Etap | Co zrobiono | PR |
|---|---|---|---|
| 08.11.2026 | przygotowanie | Xcode 27.2 i symulator iOS 27.2 na Macu Bartosza; test zrzutu z iPhone 18 Pro | (bez PR) |
| 08.11.2026 | M1 | plan, `docs/mobile/ZASADY-DESIGNU.md`, hasło w `AGENTS.md`; decyzje D2, D3, D10, D11 | #489 |
| 09.11.2026 | M2 | Expo SDK 58 w `mobile/` (własny workspace pnpm), 4 natywne zakładki, stos w każdej, lista i szczegół faktury, arkusz „Nowa faktura”, Koszty, Ten miesiąc, Konto na danych przykładowych; kolory semantyczne, style tekstu z Dynamic Type, skala odstępów; wyłączenia `mobile/` w tsconfig, eslint, Docker, knip; job CI „Mobile”; skille Expo i `telefon-app`; pierwszy build w Xcode na iPhone 18 Pro, zrzuty w `docs/mobile/zrzuty/m2/`. Strona: `pnpm run ci` i `pnpm build` zielone | #493 |
| 09.11.2026 | M3 | ekran wzorcowy na danych przykładowych: podsumowanie „Do zapłaty”, natywny przełącznik Wszystkie/Do zapłaty, wiersz z podglądem i menu przy przytrzymaniu oraz przesunięciem „Zapłacona” (wibracje), szczegół z przyciskiem Liquid Glass, wspólny stan zapłaty, szczegół kosztu, warianty D7 A/B/C, bez atrap (alertów „w etapie”); Dynamic Type do AX5 (układ pionowy), iPhone 17e i 18 Pro Max, tryb ciemny; poprawki z porównania z Ustawieniami iOS 27; zrzuty `docs/mobile/zrzuty/m3/` | #502 |
| 09.11.2026 | M4 | pełny zakres strony na telefonie (D3): 5 zakładek (Pulpit, Faktury, Koszty, Księgowość, Więcej), mapa 3a; Pulpit z wykresami (Swift Charts), przepływami, analizami i „Twój rok”; faktury: widoki Wystawione, Cykliczne, Po terminie, filtry, formularze zwykłej, korygującej, zaliczkowej i rozliczającej, edycja szkicu i poprawka odrzuconej, cykliczne, przypomnienia, e-mail; koszty: dodawanie (symulowany OCR), skrzynka KSeF, opis; księgowość: Ten miesiąc, KPiR, ewidencja, VAT i JPK, eksport, ustawienia podatkowe; Więcej: kontrahenci, import, Flo, 11 ekranów ustawień; D7 = bloczek pod sumą; formularze i kafle w układzie pionowym przy dużym tekście; 10 poprawek z przeglądu kodu; zrzuty `docs/mobile/zrzuty/m4/` | #534 |
| 10.11.2026 | M4b | wygląd FaktWay zamiast „produktu Apple” (D12): Outfit i IBM Plex Mono wbudowane w aplikację, paleta strony (jasna i ciemna), płaskie karty z obwódką i nagłówkiem w środku, ikony Remix ze strony (także w pasku zakładek i przyciskach paska), plakietki statusów jak na stronie, przyciski i pola jak na stronie z płynną animacją, zakładki sekcji z kreską, wykresy w SVG (słupki składane, linia z polem, pierścień, wiek należności) z animacją wejścia i dymkiem, Pulpit z logo FaktWay; bez Flo (D13): usunięte ekran Flo, ustawienia Flo, „Twój rok w liczbach” i podpowiedź w formularzu; `ZASADY-DESIGNU.md` w wersji 2; 7 uwag z przeglądu kodu (5 poprawionych); zrzuty `docs/mobile/zrzuty/m4b/` | #576 |
| 12.11.2026 | wzorce | Mobbin Pro przez MCP: przegląd ekranów i lista 12 poprawek (`docs/mobile/WZORCE-MOBBIN.md`); porównanie pięciu wzorów całej aplikacji (Copilot, Revolut Business, Mercury, Rocket Money, Remote), wybór D14; makieta pięciu ekranów z przełącznikami zasad wyglądu, decyzja D15 („Wszystko jak Copilot”); `ZASADY-DESIGNU.md` w wersji 3; etapy M4c do M4f | (bez PR, dokumenty niezacommitowane) |
| 12.11.2026 | M4c | wykończenie Copilota (D15) w komponentach: paleta w `paleta.ts` z testem kontrastu (`tests/unit/mobile-kontrast.test.ts`, 41 par), tło `#F2F4F7`, karty 18 pt bez obwódki z cieniem, nagłówki sekcji wersalikami nad kartą, wiersze bez linii (poza KPiR i ewidencją), gradient pod nagłówkiem z natywnym dużym tytułem w bieli (próba w symulatorze udana), pasek marki Pulpitu na gradiencie z białym logo, kwota z groszami w indeksie, kolorowe kategorie kosztów, przyciski 16 pt i wariant tonalny, Outfit z cyframi tabelarycznymi zamiast IBM Plex Mono (pliki usunięte); 2 uwagi z przeglądu kodu poprawione; zrzuty `docs/mobile/zrzuty/m4c/` | #663 |
| 12.11.2026 | M4d | po uwadze Bartosza („za dużo ikon, strony za długie, miało być jak w makiecie”) układ z makiety w tym samym PR: Pulpit z kartą wyniku (wykres miesiąca wobec średniej, trzy liczby), „Do przejrzenia”, „Nadchodzące”, reszta kart na nowym ekranie Finanse; Faktury z kartą „Do zapłaty” i paskiem, pigułkami z licznikami, grupą „Do dokończenia”, sumami miesięcy, plakietką tylko przy wyjątkach; Koszty z kartą trzech liczb, listą po dniach i kropką „do opisania”; pigułki zamiast zakładek z kreską wszędzie; ikony w wierszach i kaflach tylko przy stanie; pasek marki Pulpitu poprawiony w trybie ciemnym | #663 |
| 13.11.2026 | M4e | faktury jak Revolut Business (D14; WZORCE-MOBBIN.md 3.2, 3.3, 3.5, 3.7, 8.4): formularz w kolejności Nabywca, Pozycje, Szczegóły, Płatność; znany kontrahent i wypełniona pozycja zwinięte do wiersza, numer i daty jako wiersze z wartościami; przypięte „Podgląd” (podgląd bez pól z „zmienisz tylko korektą”) i „Wyślij do KSeF” z kwotą; po wysłaniu szczegół z kartą „Wysyłamy do KSeF” → „Przyjęta w KSeF” (numer KSeF, e-mail, udostępnij, Gotowe); szczegół: rząd akcji (Zapłacona, E-mail, PDF, Przypomnij), historia jako oś, kolejność Nabywca, Pozycje i VAT, Płatność, Dokument, Sprzedawca; jedna nazwa „Przyjęta w KSeF”. Bez 3.6 (wybór kontrahenta z wyszukiwaniem) i 3.9 | #664 |
| 13.11.2026 | M4f | Księgowość: terminy na górze pogrupowane po dniu („Zapłacono 1 z 4”), arkusz „Dane do przelewu” (zaznaczanie, Udostępnij, Oznacz jako zapłacone), zapłaty we wspólnym stanie, przychód i koszty w jednej karcie, formularz zapłat spoza wyliczenia po dotknięciu; Więcej: karta konta z plakietkami KSeF i planu, pięć małych grup ze stanem po prawej, wyszukiwarka po słowach kluczowych; stany: `StanPusty` z akcją, odświeżanie pociągnięciem (Faktury, Koszty), pasek „Cofnij” po zmianie zapłaty, `potwierdz()` na arkuszu akcji w 8 miejscach (WZORCE-MOBBIN.md 5.1, 5.2, 6.1, 8.2, 8.3, 8.5, 8.6). Bez szkieletu ładowania (8.1, przy M7) i kopiowania jednym dotknięciem (nowy build) | #665 |
| 13.11.2026 | M5a | logowanie na danych przykładowych (WZORCE-MOBBIN.md 7, wzory Mercury, Kraken, Revolut Business): zakładki przeniesione do grupy `(zakladki)`, korzeń `Slot` z przekierowaniami w układach (stos w korzeniu psuł pasek stanu na gradiencie); ekran logowania (gradient, karta z e-mailem i hasłem z okiem i podpowiedziami pęku kluczy, „Nie pamiętasz hasła?”, Google, miejsce na Apple za flagą), kod 2FA w jednym polu z wysyłką po 6 cyfrach i błędami jak na stronie, propozycja Face ID raz po logowaniu, blokada nad całą aplikacją (`FullWindowOverlay`, powitanie, firma, „Odblokuj przez Face ID”, „Zaloguj się na inne konto”) przy starcie i po 3 minutach w tle, zasłona z logo w przełączniku aplikacji, „Wyloguj się” w Więcej, przełącznik blokady w Bezpieczeństwie ze wspólnej sesji, usuwanie konta z Google kodem 2FA; przycisk w wariantach `karta` i `naGradiencie` ze stanem „trwa”; zrzuty `docs/mobile/zrzuty/m5/` | #666 |
| 13.11.2026 | M5b | logowanie na prawdziwym koncie: `@supabase/supabase-js` z sesją w pęku kluczy (`expo-secure-store`, zapis w kawałkach), zaplecze logowania w dwóch wersjach (`lib/logowanie/`: Supabase albo dane przykładowe, gdy brak `EXPO_PUBLIC_SUPABASE_URL`), kod 2FA przez `mfa.challengeAndVerify` (poziom `aal2` jak na stronie), Google przez `openAuthSessionAsync` i wymianę kodu (PKCE), Face ID przez `expo-local-authentication` (samo przy blokadzie, włączenie blokady potwierdza twarz), „Wklej” w kodzie jako systemowy `UIPasteControl` (bez pytania o schowek), ekran startowy trzymany do odczytu sesji, wylogowanie kończy sesję telefonu na serwerze, odmowa captchy GoTrue z komunikatem. Sprawdzone w symulatorze na lokalnej bazie: konto z TOTP (hasło, wklejony kod, Pulpit), sesja po ponownym uruchomieniu, blokada z systemowym Face ID (rozpoznana, nierozpoznana, anulowana), wylogowanie, konto bez 2FA z propozycją Face ID. Nowy build w Xcode | #667 |
| 13.11.2026 | M6 | API aplikacji `app/api/mobile/v1` (4.3, „Stan po M6”): bramka `authenticateMobileRequest` w `lib/api/mobile/` (token sesji z `Authorization: Bearer`, ta sama reguła 2FA co strona przez wydzielone `getVerifiedMfaStateForToken`, klient bazy z tokenu i `x-active-org`, limity na adres i osobę, przerwa techniczna, awaria GoTrue jako 503, nie 401), `/api/mobile` bez klienta z ciasteczek w proxy (`isMobileApiPath`); trasy `GET /konto` (konto, 2FA, firmy, `aktywnaFirma`) i `POST /sesja` (wpis `auth.login` z `client: 'mobile'` raz na sesję, mail o nowym urządzeniu); kontrakt bez importów `lib/api/mobile/kontrakt.ts` (decyzja 4.1). Testy: trasy na brak, zły i podrobiony token, ciasteczko zamiast tokenu, AAL1 konta z TOTP, awarię GoTrue, limity, firmę; RLS na prawdziwym GoTrue i PostgREST. Trasa logowania (captcha) czeka na decyzję Bartosza | #668 |
| 13.11.2026 | M7 | faktury i skrzynka KSeF z bazy na prawdziwym koncie (4.3, „Stan po M7”): klient `/api/mobile/v1` z kontraktem strony przez Metro (bez kopii), 401 to odświeżenie sesji i jedno ponowienie, 503 i brak sieci nie wylogowują, limit 15 s na żądanie; `GET /konto` (karta konta, firma w blokadzie, wybór firmy w Więcej), `POST /sesja` raz na sesję (sprawdzone: jeden wpis `auth.login` z `client: mobile` na logowanie); lista i szczegół faktur z bazy (błąd wysyłki osobno od odrzuconej, zapłata częściowa, waluta obca, stawki zw/np), skrzynka KSeF ze statusem wydatku i nowy ekran faktury kosztowej; szkielet, błąd z „Spróbuj ponownie”, nota „Bez internetu. Dane z …”; dane z poprzedniego otwarcia w plikach, start bez sieci z wygasłym tokenem pokazuje je w 3 s zamiast logowania (przegląd M5b; sprawdzone z tokenem 150 s i zatrzymaną bramką), po powrocie sieci odświeżenie samo; wylogowanie i koniec sesji czyszczą pamięć i pliki (sprawdzone w kontenerze aplikacji); zapisy na prawdziwych fakturach odsyłają na stronę; przy dużym tekście kwoty z przecinkiem zamiast groszy w indeksie (poprawka M4c). Testy `tests/unit/mobile-{api-klient,dane-mapowanie,dane-pamiec,sesja-offline}.test.ts`; 6 uwag z przeglądu kodu (3 poprawione); zrzuty `docs/mobile/zrzuty/m7/` | #671 |
| 13.11.2026 | M6b | logowanie hasłem przez nasze API (D16): sprawdzenie na lokalnym GoTrue z captchą (4.2: klucz serwisowy pomija captchę, `refresh_token`, `/factors`, `/logout`, PKCE jej nie wymagają); trasa `POST /api/mobile/v1/logowanie` (`lib/api/mobile/logowanie.ts`) z limitami na adres IP, e-mail i wspólnym ze stroną, odmową bez Redisa (503 `login_unavailable`), wpisem `auth.login` jak na stronie i `auth.login_failed` bez konta i adresu; aplikacja: `zaloguj` przez trasę i `setSession`, komunikaty z M5b. Testy: trasa z atrapą GoTrue z captchą, prawdziwy GoTrue z captchą (`RLS_TEST_GOTRUE_CAPTCHA=on`), rdzeń aplikacji. Symulator na stosie z captchą: złe hasło, odmowa bez Redisa, hasło, kod 2FA, Pulpit; zrzuty `docs/mobile/zrzuty/m6b/`. Dwie uwagi z przeglądu kodu poprawione | #673 (serwer), #674 (aplikacja, do `main` przez #679) |
