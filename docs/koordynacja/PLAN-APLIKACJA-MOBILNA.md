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
| D16 | **Logowanie hasłem z telefonu przez nasze API**, nie wprost do GoTrue (M5b) i nie przez Turnstile w aplikacji. `POST /api/mobile/v1/logowanie` loguje w GoTrue kluczem serwisowym, który GoTrue z captchą przepuszcza bez tokenu (sprawdzone 13.11.2026 na lokalnym GoTrue z captchą, wynik w 4.2), za naszymi limitami prób (adres IP, e-mail i wspólny ze stroną; bez Redisa odmowa) i z wpisem w audycie. Kod 2FA, odświeżanie sesji i wylogowanie telefon robi dalej sam w GoTrue, bo captchy nie wymagają (kod 2FA od M6c jednak przez `POST /api/mobile/v1/kod`, dla limitu prób i audytu, 4.2). Powód: krok 2 runbooka `docs/runbooks/captcha-w-gotrue.md` włącza captchę w GoTrue i wtedy `signInWithPassword` z aplikacji bez tokenu Turnstile zostaje odrzucone; natywny ekran bez okienka Cloudflare | przyjęta 13.11.2026 (Bartosz) |

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
wystawione (lista, szczegół) i skrzynka KSeF (lista, szczegół); od M8 także
wystawienie zwykłej faktury VAT (szkic albo wysyłka do KSeF) i wysyłka szkicu;
od M9 wydatki (lista z bazy) i wydatek ze zdjęcia (skaner, odczyt, sprawdzenie
odczytu i zapis); od M10a należności („Po terminie”), zapłata i jej cofnięcie, przypomnienie
o zapłacie (podgląd, zgoda, wstrzymanie), PDF faktury i „Sprawdź teraz” w
skrzynce KSeF; od M10b księgowość („Ten miesiąc”: terminy, kwoty, dane do
przelewu, zatwierdzenie miesiąca, zapłata), ustawienia Firma, KSeF,
Przypomnienia i Bezpieczeństwo (odczyt, zmiany na faktway.pl), wybór firmy
wspólny ze stroną i usunięcie konta. Na danych przykładowych zostają
Kontrahenci, Przepływy, Analizy i Import danych; karty
ustawień bez API (Księgowa, Powiadomienia, Zespół, Abonament, Dziennik)
otwierają stronę. Stopka w Więcej mówi o tym klientowi.

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
  **M8 rozstrzygnął:** schematy leżą w `lib/api/mobile/schematy.ts` i do
  aplikacji nie trafiają (aplikacja nie ma `zod`). Telefon dostaje z kontraktu
  typy treści (`FakturaTelefonu`, równe wyjściu schematu, pilnuje test), robi
  szybkie sprawdzenie przed wysłaniem, a serwer sprawdza każde żądanie tym
  samym schematem formularza co strona i odsyła błąd z polem (`invoice_invalid`,
  `field`), który telefon pokazuje pod polem.
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
- **Kod 2FA przez nasze API (M6c).** Telefon wysyła kod na
  `POST /api/mobile/v1/kod` z tokenem sesji AAL1 (`lib/api/mobile/kod.ts`),
  dostaje sesję AAL2 tej samej sesji GoTrue i wkłada ją przez `setSession`.
  Trasa robi to, co `verifyMfaChallengeAction` strony: kod spoza sześciu
  cyfr odrzuca bez zużycia próby, potem limit `checkMfaRateLimit` (5 prób na
  5 minut na konto, wspólny ze stroną; bez Redisa odmowa 503 „Nie możemy
  teraz sprawdzić kodu”), wyzwanie i kod w GoTrue tokenem klienta i kluczem
  anon, sprawdzenie nowego tokenu (AAL2, to samo konto) i wpisy
  `auth.mfa_challenge_failed` / `auth.mfa_challenge_succeeded` z
  `client: 'mobile'`. Bramka w wariancie `mfa: 'challenge'` przepuszcza tylko
  sesję AAL1 konta z 2FA (inna dostaje 409 `mfa_not_required` i telefon
  zostaje na obecnej sesji); pozostałe trasy dalej dają 403 `mfa_required`.
  Granica: GoTrue nadal przyjmuje `/factors/{id}/verify` wprost od każdego z
  sesją AAL1 i kluczem anon (tak samo przy stronie), więc dla kogoś, kto
  omija aplikację, zaporą zostaje limit GoTrue.
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

**Stan po M8 (13.11.2026).** Szybka faktura z telefonu do KSeF:
- Logika wystawienia i wysyłki szkicu wydzielona z akcji strony do
  `lib/invoices/issue-regular.ts` (`saveRegularDraft`, `saveAndSendRegularInvoice`,
  `parseRegularInvoiceForm`, `readTenantSnapshot`) i `lib/invoices/send-draft.ts`
  (`sendRegularDraft`); akcje strony wołają je bez zmiany zachowania (test
  zgodności `tests/unit/wystawienie-faktury-lib.test.ts`).
- Kolejka KSeF z sesji tokenu: `tokenSession` w `enqueueKsefSubmitAfterDraft`
  bierze 2FA z tokenu (`assertSensitiveMfa`) i czyta znacznik weryfikacji KSeF
  klientem z tokenem. Bez tego telefon dostawałby odmowę 2FA przy włączonej
  fladze `requireMfaForSensitive` i „zweryfikuj certyfikat” zawsze.
- Trasy: `POST /faktury` (szkic albo „Wyślij do KSeF”, nagłówek
  `Idempotency-Key` z UUID na jedno wypełnienie formularza, tabela
  `mobile_idempotency_keys` z 00201: ponowienie oddaje tę samą fakturę i nie
  zleca drugiej wysyłki, inna treść z tym kluczem to 409), `POST
  /faktury/{id}/wysylka` (szkic do KSeF; już zlecona daje 200 z `juzZlecona`),
  `GET /faktury/podpowiedz` (numer, dziś, zwolnienie z VAT jak pusty formularz
  strony). Kody `invoice_invalid`, `idempotency_conflict`, `not_found`,
  `not_draft`, `ksef_send_refused`, `missing_idempotency_key`.
- Telefon: na prawdziwym koncie zwykła faktura VAT przez API (nabywcy z
  ostatnich faktur, numer z podpowiedzi, rachunek z ostatniej faktury z
  rachunkiem, stawki zw/oo/np tekstem), szkic przez API, „Wyślij do KSeF” przy
  szkicu w szczególe; po wysyłce status z bazy co 3 s aż do przyjęcia albo
  odrzucenia (wibracja). Korekta, zaliczka, rozliczenie, zmiana szkicu i
  ponowna wysyłka odrzuconej zostają na stronie do M10; nabywca z UE, PESEL i
  dane z GUS też.
- Po niezależnym przeglądzie #716 (13.11.2026): nabywca z UE, osoba z PESEL
  albo dokumentem i stawki spoza telefonu (np. „np II”) nie trafiają do
  formularza (lista nabywców pomija je, „Duplikuj” takiej faktury otwiera
  stronę), zapis idzie do firmy, w której otwarto formularz (zmiana firmy w
  trakcie to odmowa z instrukcją), kwoty pozycji liczone jak na serwerze
  (cena do 4 miejsc, netto i VAT zaokrąglane w pozycji), numer z serii
  (`numberSeriesId` i `numberPreview` z podpowiedzi), klucz żądania także
  jako `numberRequestKey` (00199), więc ponowienie po przerwie między szkicem
  a kluczem w 00201 oddaje ten sam szkic; wyjątek po zapisie szkicu to 201 ze
  szkicem i informacją, że wysyłka nie wyszła; telefon bez odpowiedzi mówi
  „Nie wiemy, czy faktura się zapisała”.

**Stan po M9 (13.11.2026).** Wydatek ze zdjęcia z telefonu:
- Logika `reviewExpenseAction` i `getOcrJobStatusAction` wydzielona do
  `lib/expenses/review.ts` (`reviewExpense`, z powodem odmowy dla telefonu
  i opcją `refuseKsef`) i `lib/expenses/ocr-status.ts` (`readOcrJobStatus`);
  akcje strony wołają je bez zmiany zachowania (test zgodności
  `tests/unit/wydatki-lib-zgodnosc.test.ts`, zielony także na starej akcji).
  Wgranie było w `lib/expenses/accept-upload.ts` od sesji 31 planu
  skalowania; doszedł krok `onJobCreated` (klucz telefonu przed plikiem i kolejką).
- Trasy (`lib/api/mobile/wydatki.ts`): `POST /wydatki/zdjecie` (multipart, pole
  `plik`, poza proxy jak `/api/uploads/*`, ta sama bramka wgrań: rozmiar,
  odczyt ciała, limit 30 wgrań na 10 minut, budżet bajtów; nagłówek
  `Idempotency-Key` na jedno zdjęcie, 00202 `mobile_idempotency_keys.ocr_job_id`:
  ponowienie oddaje to samo zadanie odczytu, inny plik z tym kluczem 409,
  zadanie porzucone po kluczu czyści się po 5 minutach), `GET
  /wydatki/odczyt/{id}` (stan odczytu; 503 to „pytaj dalej”, nie „wgraj
  drugi raz”), `POST /wydatki/{id}/zatwierdzenie` (te same zasady co formularz
  kosztu strony; koszt z KSeF odsyła na stronę). Kody `file_invalid`,
  `upload_incomplete`, `expense_invalid`.
- Telefon: systemowy skaner dokumentów (VisionKit, moduł lokalny
  `mobile/modules/skaner-dokumentow`, jedna strona JPG, kilka PDF), galeria
  (`expo-image-picker`), czekanie na odczyt co 2 s do 90 s, ekran „Sprawdź
  odczyt” ze zdjęciem nad polami, VAT jako osobne pole, przełącznik „Kwoty są
  w złotych” przy dokumencie w walucie bez kursu; lista Kosztów z bazy
  (200 najnowszych według daty dokumentu, waluta kwot jak na stronie, kopia
  reguły z testem zgodności). Wpis ręczny, usunięcie i opis kosztu z KSeF
  zostają na stronie do M10.

**Stan po M10a (13.11.2026).** Należności, przypomnienia, PDF i „Sprawdź teraz”:
- Logika strony wydzielona do `lib/` bez zmiany zachowania (testy strony bez
  zmian zielone przed i po): zapłata i cofnięcie `lib/invoices/mark-paid.ts`,
  lista „Po terminie” `lib/overdue/load-overdue.ts` (strona `/payments/overdue`
  tylko ją rysuje), podgląd przypomnienia `lib/reminders/prepare-preview.ts`,
  wstrzymanie `lib/reminders/pause.ts`, zatwierdzenie propozycji
  `lib/flo/approve-proposal.ts` (żeton zgody przed wykonaniem, opcja
  `onlyKind`), „Sprawdź teraz” `lib/ksef/inbox-check.ts`.
- Trasy (`lib/api/mobile/naleznosci.ts`): `GET /naleznosci` (ta sama lista co
  strona, stan przypomnień, `mozeOznaczac`, `mozeZatwierdzac`), `POST
  /faktury/{id}/zaplata` i `/zaplata/cofnij` (RPC 00158, ponowienie daje
  `juzBylo`), `POST /faktury/{id}/przypomnienie` (podgląd, nic nie wychodzi),
  `POST /przypomnienia/{id}/zatwierdz` (właściciel albo administrator, tylko
  `payment.chase`), `POST /faktury/{id}/wstrzymanie`, `GET /faktury/{id}/pdf`
  (ten sam PDF co strona, w Base64 w JSON, firma z bramki, bo PDF czyta kluczem
  serwisowym), `POST /skrzynka/sprawdz`. Kody `forbidden`, `payment_refused`,
  `reminder_refused`, `pdf_unavailable`. Treść opcjonalna (`lib/api/mobile/tresc.ts`).
- Telefon: zapłata od razu w wierszu, pasek „Cofnij” po odpowiedzi serwera, odmowa
  przywraca stan i mówi dlaczego („Ponów” albo „OK”); „Po terminie” z serwera ze
  stanem przypomnień (wspólny magazyn `stan/naleznosci.tsx`), ekran przypomnienia
  jak okno strony (ta sama reguła, kiedy wolno przygotować), PDF w systemowym
  arkuszu udostępniania z „Podglądem” (plik w `Paths.cache/faktway-dane/pdf/`,
  czyszczony przy wylogowaniu), „Sprawdź teraz” pod kartą Kosztów. Kwoty z API są
  w złotych, ekrany przeliczają je na grosze modelu (`grosze()`).
- Przypomnienie: telefon nie pokazuje tekstów Flo w pierwszej osobie (D13);
  porażka wykonania po zgodzie daje zdanie „Nie zleciliśmy wysyłki…” z tym, co zrobić.

**Stan po M10b (14.11.2026).** Księgowość, ustawienia, wybór firmy, usunięcie konta:
- Logika strony w `lib/` bez zmiany zachowania (testy strony zielone przed i po):
  zapis „Ten miesiąc” `lib/ksiegowosc/ten-miesiac-zapis.ts` (zatwierdzenie i
  zapłata), dane do przelewu `lib/ksiegowosc/przelew.ts`, żądanie i anulowanie
  usunięcia konta `lib/gdpr/account-deletion.ts`, sprawdzenie hasła
  `lib/auth/password-check.ts` (wspólny limit prób), ostatnia firma
  `lib/organizations/last-active.ts`, model ustawień przypomnień
  `lib/reminders/settings-model.ts` (formularz strony i telefon).
- Trasy: `POST /firma` (wybór firmy w `users.last_active_tenant_id`, ta sama
  funkcja co przełącznik strony), `GET /ksiegowosc?miesiac=` (wyliczenie strony,
  wyłącznik `ten_miesiac`, dane do przelewu, stan wersji i zapłat, skróty
  pozycji), `POST /ksiegowosc/zatwierdz` i `/ksiegowosc/rozliczenia/{id}/zaplata`
  (właściciel albo administrator; odmowa `settlement_refused` ze zdaniem
  strony), `GET /ustawienia` (Firma, KSeF, Przypomnienia do odczytu),
  `GET` i `POST /konto/usuniecie`, `POST /konto/usuniecie/anuluj`. Kody
  `reauth_required`, `deletion_blocked`, `deletion_in_progress`, `settlement_refused`.
- Decyzje M10b (podjęte w sesji według planu, zasad designu i `AGENTS.md`):
  (1) usunięcie konta: 2FA wymusza bramka, konto z hasłem potwierdza hasłem
  (GoTrue, klient z kluczem serwisowym jak `POST /logowanie`, D16), konto tylko
  z Google świeżym logowaniem w tej sesji, najwyżej 10 minut (claim `amr`);
  metoda z `app_metadata.providers`, nigdy z telefonu. Strona nie ma drogi dla
  konta bez hasła, a Apple wymaga usuwania konta w aplikacji.
  (2) Księgowość z telefonu: „Ten miesiąc” z zatwierdzeniem i zapłatą; nadwyżki
  VAT telefon nie wpisuje (liczy jak strona bez wpisu: z MF albo z poprzedniej
  wersji); KPiR, ewidencja, VAT i JPK, eksport i zapłaty spoza wyliczenia
  otwierają stronę. (3) Ustawienia do odczytu: zapis danych firmy, VAT i daty
  rozpoczęcia zmienia faktury i rozliczenia, certyfikat KSeF wymaga plików i 2FA,
  a formularz przypomnień ma granice i podgląd; te zmiany zostają przy
  formularzach strony („Zmień na faktway.pl”, po powrocie ekran wczytuje dane od
  nowa). Stan KSeF liczy serwer (`hasConfiguredKsefProof`), bo telefon nie zna
  środowiska aplikacji; przypomnienia widzi tylko właściciel, jak zakładka strony.
  (4) Wybór firmy w telefonie zapisuje się też dla strony
  (`last_active_tenant_id`), więc po następnym logowaniu otwiera się ta sama firma.
- Telefon: zapis zawsze w firmie danych na ekranie (`firmaEkranu`); magazyny
  należności, księgowości i ustawień czyszczone przy końcu sesji
  (`stan/czyszczenie.ts`); wiersze Więcej według roli jak zakładki strony.
- Obchód w symulatorze (18 Pro, własny stos z migracjami gałęzi) znalazł i
  naprawił: zimny start linkiem prosto w zakładkę pytał API przed ustawieniem
  wybranej firmy („Nie masz już dostępu do tej firmy”; ref firmy teraz w efekcie
  układu), ekran konta wymagał wybranej firmy (trasy konta idą `bezFirmy`), złe
  hasło dawało „Coś poszło nie tak” (kod `invalid_credentials` niesie zdanie
  serwera), nagłówek Księgowości mówił „Nic do zapłaty”, gdy żadnej kwoty nie
  dało się policzyć (stawki 2026 czekają na sprawdzenie, jak na stronie).

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
| M6c | **Kod 2FA przez API** (z przeglądu M6b; decyzja Bartosza 13.11.2026: osobny etap przed M8): trasa `POST /api/mobile/v1/kod` (limit prób kodu wspólny ze stroną, odmowa bez Redisa, wpisy `auth.mfa_challenge_*`, sesja AAL2 dla `setSession`), w aplikacji `potwierdzKod` przez trasę | test trasy na prawdziwym GoTrue; w symulatorze na lokalnej bazie: hasło, zły kod, dobry kod, Pulpit; wpisy audytu |
| M7 | Faktury i skrzynka KSeF na prawdziwych danych; wylogowanie i „Zaloguj się na inne konto” czyszczą dane poprzedniego konta w pamięci; start bez internetu z wygasłym tokenem pokazuje dane z poprzedniego otwarcia zamiast logowania (przegląd M5b) | lista i szczegół z bazy, odświeżanie, stany ekranu |
| M8 | Szybka faktura z wysyłką do KSeF (środowisko TEST) | faktura przyjęta przez KSeF TEST z telefonu |
| M9 | Wydatek ze zdjęcia: skaner, OCR, sprawdzenie | wydatek zapisany ze skanu |
| M10 | Pozostałe ekrany z 3a na prawdziwych danych (należności, przypomnienia, PDF, księgowość, ustawienia); usuwanie konta przez API, z 2FA i metodą logowania z serwera, nie z przełącznika przykładowego (przegląd M5b) | każdy ekran z 3a czyta i zapisuje bazę |
| M11 | Powiadomienia push (D9), logowanie Apple; wymaga płatnego konta | powiadomienie o nowej fakturze na telefonie |
| M12a | Android w kodzie, bez emulatora: konwencje z sekcji 10 zasad (pasek Material, wstecz, fala, menu w polach wyboru), `app.json` (pakiet, ikona, uprawnienia), decyzje dla funkcji tylko z iOS | pakiet JS i `expo prebuild` dla Androida bez błędów, test `mobile-android` czerwony przed zmianą, iOS bez zmian |
| M12b | Android na emulatorze: build w Android Studio i checklista z sekcji 7a; wymaga instalacji Android Studio, SDK i obrazu emulatora (około 10 GB, decyzja Bartosza) | każdy punkt 7a sprawdzony ze zrzutem albo poprawiony |
| M13 | Sklep: ikona, zrzuty, opisy, polityka i etykiety prywatności, konto dla recenzenta, beta TestFlight i zamknięty test Google | aplikacja zgłoszona do przeglądu |

### 7a. M12b: checklista na emulatorze Androida

Do sprawdzenia po zainstalowaniu Android Studio (emulator z Google Play,
Android 15 albo nowszy; drugi obraz z Androidem 12 do punktu 13). Zrzuty do
`docs/mobile/zrzuty/m12/`, jasny i ciemny motyw, największy tekst.

1. **Build.** `pnpm run android` w `mobile/` buduje się bez błędów (Kotlin,
   Compose z `@expo/ui`, moduły Expo). Moduł skanera ma tylko część iOS, więc
   Android go pomija (`requireOptionalNativeModule`).
2. **Start i pasek stanu.** Ekran startowy z logo (jasny i ciemny), potem
   logowanie na gradiencie z jasnymi ikonami paska stanu. Po Pulpicie (jasny
   pasek stanu) przejście na Finanse, Ustawienia, KPiR: ciemne ikony w jasnym
   motywie, jasne w ciemnym.
3. **Zakładki.** Pasek Material na dole: pięć zakładek z ikonami Remix, napisy
   w Outfit, licznik przy Kosztach, kolor marki przy wybranej, bez nachodzenia
   na pasek nawigacji systemu (gesty i trzy przyciski).
4. **Górny pasek.** Faktury, Koszty, Księgowość, Więcej, Kontrahenci: pasek w
   kolorze góry gradientu bez szwu z gradientem w treści, biały tytuł w Outfit
   po lewej. Szczegół faktury, wydatku, faktury z KSeF i kontrahenta: to samo
   ze strzałką wstecz. Ekrany bez gradientu: szary pasek, ciemny tytuł.
5. **Ikony i menu w pasku.** Filtr, kalendarz, udostępnij, więcej: białe na
   okręgu 20% bieli na niebieskim pasku, ciemne na zwykłym, bez kwadratu za
   ikoną. Menu: biała karta, ciemny tekst, ptaszek przy wybranej pozycji; w
   filtrach faktur podmenu „Status KSeF”, „Płatność”, „Rodzaj”; „Usuń” na
   czerwono.
6. **Wyszukiwarka w pasku.** Lupa biała na niebieskim pasku; po dotknięciu pole
   z białym tekstem i podpowiedzią; strzałka zamyka wyszukiwanie.
7. **Przyciski z napisem.** Nowa faktura (X zamyka arkusz, „Szkic” po prawej),
   faktura otwarta z „Duplikuj” (X), cykliczna (X, „Zapisz”), e-mail (X,
   „Wyślij”), przypomnienie (X), kontrahent („Edytuj”, „Gotowe” białe),
   ekrany „Tylko na stronie” (X). Odstępy od krawędzi i tytułu, cel dotyku 48 dp.
8. **Systemowy wstecz.** Cofa stos w każdej zakładce; zamyka arkusz (dane do
   przelewu, dodaj wydatek, e-mail); w formularzu faktury ze zmianami pyta
   „Odrzucić zmiany?”, bez zmian zamyka od razu; gest przewidywanego powrotu
   (Android 14 i nowszy) pokazuje poprzedni ekran; przy blokadzie chowa
   aplikację i nie cofa ekranów pod blokadą; na korzeniu zakładki wychodzi.
9. **Fala.** Przycisk główny (jasna fala na niebieskim), tonalny, biały
   z cieniem, pigułki pod nagłówkiem, rząd akcji szczegółu, kafle, wiersze kart
   (rogi przycina karta), wiersz faktury, pole wyboru, „Wszystkie ›” przy
   nagłówku, „Cofnij”, „Wklej”, oko hasła, awatar Pulpitu. Fala nie wychodzi
   rogami poza zaokrąglenie, cień przycisku i kafla zostaje.
10. **Pola formularza.** Bez kreski Material pod tekstem, kursor i zaznaczenie
    w kolorze marki, obwódka przechodzi w niebieski przy pisaniu; pole wyboru
    otwiera menu Material pod polem (wybrana w kolorze marki); data otwiera
    systemowy kalendarz; przełącznik z białym kciukiem na niebieskim torze;
    klawiatura nie zasłania aktywnego pola (formularz faktury, wydatek,
    logowanie, kod 2FA).
11. **Gesty i listy.** Przesunięcie wiersza faktury („Zapłacona”, „Cofnij”) z
    wibracją; odświeżanie pociągnięciem z kółkiem w kolorze marki; przy
    przytrzymaniu wiersza nie ma podglądu ani menu (`Link.Menu` działa tylko na
    iOS), akcje są w szczególe; do oceny, czy dodać menu Material.
12. **Logowanie i blokada.** Logowanie hasłem, kod 2FA z „Wklej” (Android
    pokazuje komunikat o odczycie schowka), Google przez kartę przeglądarki
    i powrót `faktway://`, propozycja odcisku palca, blokada z systemowym oknem
    biometrii (odcisk rozpoznany, nierozpoznany, anulowany, kod telefonu),
    zasłona w przełączniku aplikacji bez kwot.
13. **Zdjęcie wydatku.** „Zrób zdjęcie” otwiera aparat systemowy (pytanie
    o dostęp, odmowa z komunikatem), „Wybierz z galerii” otwiera systemowy
    wybór zdjęć (także na Androidzie 12, bez uprawnienia do plików), odczyt
    i sprawdzenie odczytu jak na iOS.
14. **PDF i udostępnianie.** PDF faktury w arkuszu udostępniania Androida,
    „Dane do przelewu” udostępniają tekst.
15. **Tryb ciemny i duży tekst.** Każdy ekran z punktów 2 do 14 w ciemnym
    motywie i przy największym rozmiarze czcionki: nic się nie ucina, tło przy
    przejściach nie miga bielą, tytuły w pasku mieszczą się albo skracają.
16. **TalkBack.** Etykiety ikon w pasku (X: „Anuluj” albo „Zamknij”), stan
    pigułek, pole wyboru „rozwinięte”, kwoty z groszami czytane w całości.
17. **Z przeglądu kodu M12a (do sprawdzenia, a gdy się potwierdzi, do
    naprawy):** (a) zasłona w przełączniku aplikacji opiera się na stanie
    `inactive`, którego Android nie ma, więc miniatura w ostatnich aplikacjach
    pokaże kwoty; odpowiednik to `FLAG_SECURE` (np. `expo-screen-capture`,
    nowa paczka natywna); (b) blokada to na Androidzie zwykły widok w
    korzeniu: sprawdzić, czy otwarty arkusz (dane do przelewu, dodaj wydatek)
    nie zostaje nad nią po powrocie z tła; (c) aparat: gdy system ubije
    aplikację w trakcie zdjęcia, wynik ginie (`getPendingResultAsync` nie jest
    czytane); (d) aktywny filtr na niebieskim pasku ma tę samą białą ikonę co
    nieaktywny (do rozważenia znacznik z liczbą).
18. **Decyzja po M12b:** skaner dokumentów ML Kit (kod w Kotlinie, dane
    o użyciu wysyłane do Google, wpis w formularzu bezpieczeństwa danych
    Google Play) albo zostaje aparat systemowy.

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

**Następny krok:** M12b (Android na emulatorze, checklista w sekcji 7a), gdy
Bartosz zainstaluje Android Studio, SDK i obraz emulatora (około 10 GB). M11
(powiadomienia push, logowanie Apple) i M13 (sklep) czekają na płatne konto
Apple. M8, M9 i M10 są w `main` i na produkcji od 14.11.2026 (#716, #740, #738,
#752; migracje 00201 i 00202).
**Z M12a zostaje:** wszystko, czego nie widać bez emulatora (sekcja 7a), w tym
cztery ryzyka z przeglądu kodu (7a, punkt 17: zasłona w ostatnich aplikacjach,
blokada a arkusz, zdjęcie po ubiciu aplikacji, znacznik filtra); menu
przy przytrzymaniu wiersza faktury na Androidzie (dziś go nie ma, akcje są w
szczególe); decyzja o skanerze ML Kit (7a, punkt 18).
**Z M9 zostaje:** obchód M9 w symulatorze iPhone 17 (wymaga zgody w panelu symulatora; build ze skanerem zainstalowany, drogę serwera sprawdzono przez API na osobnym stosie), zrzuty do `docs/mobile/zrzuty/m9/`. Osobno: błąd z `main`, enum `categorization_method` bez `rule_global_keyword` i `rule_global_nip` (paragon ze stacji, hotelu, Allegro nie zapisuje się po OCR, 3 płatne odczyty na próbę), osobna gałąź i PR.
**Z M10b zostaje:** (1) zapisy ustawień (dane firmy, VAT, data rozpoczęcia,
certyfikat KSeF, przypomnienia, hasło, 2FA, klucze dostępu) i karty Księgowa,
Powiadomienia, Zespół, Abonament, Dziennik są na stronie; API dla nich to
osobny etap, gdy Bartosz zdecyduje, które mają być w telefonie. (2) KPiR,
ewidencja, VAT i JPK, eksport, nadwyżka VAT i zapłaty spoza wyliczenia na
stronie. (3) Kontrahenci, Przepływy, Analizy i Import danych na danych
przykładowych. (4) Formularz przypomnień strony pokazuje „włączone”, gdy firma
nie zapisała jeszcze ustawień, a scheduler bez zapisu niczego nie przygotowuje
(telefon mówi „Nie ustawione”); do osobnej naprawy po stronie strony.
(5) Konto z dostawcą `email` bez ustawionego hasła (np. z zaproszenia) nie
potwierdzi usunięcia z telefonu; ścieżka: ustawić hasło na stronie.
**Z M10a zostaje:** (1) ustalenie do osobnej naprawy: `assertDeliveryDeadline`
(`lib/reminders/delivery-consent.ts`) porównuje `created_at` żetonu zgody (zegar
bazy, domyślne `now()`) z `consumed_at` (zegar Node w `lib/flo/approval.ts`) i
odrzuca zgodę, gdy zegar aplikacji spóźnia się względem bazy bardziej niż odstęp
między zapisem a zużyciem żetonu; lokalnie (Colima) zatwierdzenie z telefonu
skończyło się „Termin wysyłki minął” (strona woła tę samą funkcję); na produkcji
app-1 i db-1 to różne serwery. (2) Pełnoekranowy podgląd PDF w aplikacji (Quick Look) wymaga
paczki natywnej; dziś PDF otwiera arkusz udostępniania z miniaturą i „Podglądem”.
(3) Załącznik podglądu przypomnienia sprawdzony testem trasy, nie w symulatorze
(firma testowa bez wezwania PDF).
**Przed scaleniem M8:** migracja 00201 (przed wdrożeniem; 00199 z #643 już
na produkcji). Numeracja z #643 jest w `lib/invoices/issue-regular.ts`;
telefon wysyła serię i podgląd numeru z podpowiedzi oraz klucz zapisu jako
`numberRequestKey`. #711 i #713 są w `main`, gałąź M8 je zawiera.
**Przed logowaniem z telefonu na produkcji (bez zmian od M6b):** adres
powrotu `faktway://**` w GoTrue (Google); logowanie hasłem przez `POST
/api/mobile/v1/logowanie` (D16) wymaga działającego Redisa. Z M6b zostaje:
limity GoTrue na adres widzą przy logowaniu hasłem tylko adres app-1, kod 2FA
z telefonu od M6c przez `POST /api/mobile/v1/kod`, z limitem prób i wpisami
`auth.mfa_challenge_*` jak na stronie.
**Z M8 zostaje:** zmiana szkicu, korekta, zaliczka, rozliczenie, ponowna
wysyłka odrzuconej, nabywca z UE i z PESEL, dane z GUS po NIP, pole uwag z
polskimi znakami nie było sprawdzone wpisywaniem z Maca (symulator nie
przyjmuje wklejenia). Z przeglądu #716: (8) `mobile/` zostaje poza mapą
ryzyka żelaznego filtra (decyzja Bartosza, bez zmiany
`filtr/mapa-ryzyka.json`); (9) ustalenie M8-9, odziedziczone ze strony, nie
naprawione: `sendRegularDraft` (`lib/invoices/send-draft.ts`, odczyt szkicu
z `error || !row`) zwraca „nie znaleziono” także przy błędzie bazy, więc
chwilowy błąd odczytu wygląda jak usunięta faktura (strona i telefon tak
samo); naprawa osobnym PR według protokołu. Wcześniejsze otwarte
(z M7): wybór firmy nie zmienia `last_active_tenant_id`, Pulpit, Wydatki,
Księgowość i ustawienia na danych przykładowych, ścieżka `mfa_required` w trakcie sesji sprawdzona testem, nie w
symulatorze, 3.9 („Nowa faktura” jednym dotknięciem), kopiowanie jednym
dotknięciem (5.2), D4, D6.

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
| 13.11.2026 | M6c | kod 2FA z telefonu przez nasze API (z przeglądu M6b, decyzja Bartosza: osobny etap przed M8; 4.2): trasa `POST /api/mobile/v1/kod` (`lib/api/mobile/kod.ts`) jak `verifyMfaChallengeAction` strony: kod spoza 6 cyfr i konto bez TOTP bez zużycia próby, `checkMfaRateLimit` wspólny ze stroną (bez Redisa 503 „Nie możemy teraz sprawdzić kodu”), wyzwanie i kod w GoTrue tokenem klienta i kluczem anon, sprawdzenie nowego tokenu (AAL2, to samo konto), wpisy `auth.mfa_challenge_failed` i `auth.mfa_challenge_succeeded` z `client: 'mobile'`, sesja AAL2 dla `setSession`; bramka w wariancie `mfa: 'challenge'` (inna sesja: 409 `mfa_not_required`, pozostałe trasy bez zmian); aplikacja: `potwierdzKod` przez trasę. Testy: trasa z atrapami (20), rdzeń aplikacji (16), prawdziwy GoTrue (`tests/rls-mobile-kod.test.ts`). Sprawdzone na osobnym stosie z migracjami i Redisem dev: limit 5 prób (6. próba 429), wpisy audytu; symulator: hasło, zły kod, dobry kod, Pulpit; zrzuty `docs/mobile/zrzuty/m6c/`. Z przeglądu kodu 4 uwagi poprawione. Zostaje: GoTrue przyjmuje `/factors/{id}/verify` wprost z kluczem anon (jak przy stronie), więc dla omijającego aplikację zaporą jest limit GoTrue | #711 |
| 13.11.2026 | M8 | szybka faktura z telefonu do KSeF (4.3, „Stan po M8”): logika „Wystaw i wyślij”, szkicu i wysyłki szkicu wydzielona do `lib/invoices/{issue-regular,send-draft}.ts` (test zgodności ze stroną), kolejka KSeF z sesji tokenu (`tokenSession`: 2FA i znacznik KSeF bez ciasteczek), trasy `POST /faktury` z kluczem idempotencji (00201 `mobile_idempotency_keys`), `POST /faktury/{id}/wysylka`, `GET /faktury/podpowiedz`; w aplikacji formularz zwykłej faktury przez API (nabywcy z ostatnich faktur, numer z serwera, błąd serwera pod polem), szkic i „Wyślij do KSeF” przy szkicu, status co 3 s do przyjęcia; zdania serwera bez długich myślników, pola i przycisk zawijają się przy dużym tekście. Sprawdzone w symulatorze 17e na osobnym stosie z prawdziwym KSeF TEST (4 faktury przyjęte, fikcyjny NIP, certyfikat samopodpisany); 7 uwag z przeglądu (6 poprawionych); scalenie z #713 (numeracja #643 przeniesiona do `lib/`); zrzuty `docs/mobile/zrzuty/m8/` | #716 |
| 13.11.2026 | M8, przegląd | niezależny przegląd #716 (9 uwag) i odpowiedzi: (1) nabywca z UE i osoba z PESEL nie stają się osobą prywatną, stawki spoza telefonu nie stają się 0%, „Duplikuj” takiej faktury otwiera stronę; (2) zapis do firmy formularza; (3) kwoty pozycji jak `calculateLineItem` (cena do 4 miejsc, 3 × 33,3333 = 123,00 zł), cena pokazywana z 4 miejscami; (4) seria numeracji z podpowiedzi; (5) klucz żądania jako `numberRequestKey` (00199) i ponowienie po przerwie; (6) wyjątek po szkicu to 201 ze szkicem, telefon bez odpowiedzi mówi „nie wiemy”; (7) wyścig przy ponowieniu i stan `failed`; (8) bez zmian, decyzja Bartosza; (9) zapisane jako ustalenie M8-9. Sprawdzone w symulatorze: nabywcy bez firmy z UE, duplikat faktury z UE na stronie, duplikat z ceną 33,3333 przyjęty w KSeF TEST (123,00 zł, `number_request_key` zapisany); zrzuty 13 do 18 w `docs/mobile/zrzuty/m8/` | #716 |
| 13.11.2026 | M10a | należności, przypomnienia, PDF i „Sprawdź teraz” z telefonu (4.3, „Stan po M10a”): logika strony wydzielona do `lib/` bez zmian zachowania (zapłata `lib/invoices/mark-paid.ts`, lista „Po terminie” `lib/overdue/load-overdue.ts`, podgląd i wstrzymanie przypomnienia, zatwierdzenie propozycji `lib/flo/approve-proposal.ts`, „Sprawdź teraz”), 8 tras w `app/api/mobile/v1` (lista, zapłata i cofnięcie, podgląd, zgoda tylko właściciela i administratora, wstrzymanie, PDF z firmą z bramki, skrzynka); w aplikacji zapłata z „Cofnij”, „Po terminie” z serwera, ekran przypomnienia jak okno strony, PDF w arkuszu udostępniania z „Podglądem”, „Sprawdź teraz” w Kosztach, nagłówek sekcji przy dużym tekście. Testy: trasy (48, czerwone przed zmianą), baza (`rls-mobile-naleznosci`, 5), testy strony bez zmian zielone. Sprawdzone w symulatorze 18 Pro na własnym stosie (zapłata i cofnięcie w bazie, podgląd i odmowy, wstrzymanie, PDF, limit 5 minut); 7 uwag z przeglądu poprawionych; ustalenie o zegarach w `assertDeliveryDeadline` do osobnej naprawy; zrzuty `docs/mobile/zrzuty/m10/` | #752 (zastąpił #739) |
| 14.11.2026 | M9 | wydatek ze zdjęcia (4.3, „Stan po M9”): `lib/expenses/{review,ocr-status}.ts` (test zgodności także na starej akcji), trasy `/wydatki/zdjecie` (poza proxy, klucz 00202), `/wydatki/odczyt/{id}`, `/wydatki/{id}/zatwierdzenie`; skaner VisionKit (moduł lokalny), galeria, sprawdzenie odczytu, wydatki z bazy. Sprawdzone przez API na osobnym stosie z prawdziwym OCR: wgranie, ponowienie (to samo zadanie), wydatek w bazie, zatwierdzenie. Obchód w symulatorze czeka na zgodę | #738 |
| 14.11.2026 | M10b | księgowość, ustawienia, wybór firmy i usunięcie konta z telefonu (4.3, „Stan po M10b”): logika strony wydzielona do `lib/` bez zmian zachowania (zapis „Ten miesiąc”, dane do przelewu, usunięcie konta RODO, sprawdzenie hasła, ostatnia firma, model ustawień przypomnień), 8 tras w `app/api/mobile/v1` (`firma`, `ksiegowosc` z zatwierdzeniem i zapłatą, `ustawienia`, `konto/usuniecie` z anulowaniem); w aplikacji „Ten miesiąc” z zatwierdzeniem i danymi do przelewu, Firma, KSeF, Przypomnienia i Bezpieczeństwo z konta (zmiany na faktway.pl), wybór firmy zapisany też dla strony, usunięcie konta hasłem albo świeżym logowaniem Google. Decyzje sesji w 4.3. Testy tras (konto i firma 13, księgowość 9, ustawienia 9; czerwone przed zmianą albo mutacją), testy strony bez zmian zielone; 6 uwag z przeglądu i 4 z obchodu poprawione; zrzuty `docs/mobile/zrzuty/m10/m10b-*` | #752 (zastąpił #751 po trafieniu gitleaks na testowe hasło) |
| 14.11.2026 | M12a | Android w kodzie, bez emulatora (sekcja 10 zasad, rozpisana w tabeli): pasek Material z tytułem po lewej, na ekranach z gradientem w kolorze góry gradientu z białym tytułem i ikonami, gradient w treści od koloru paska (`wyglad/pasek-android.ts`, kontrast białego tekstu sprawdzony testem); styl paska stanu na każdym ekranie (po Pulpicie zostawał biały na jasnym); przyciski z napisem w pasku przez `PrzyciskPaska` (na Androidzie `Stack.Toolbar.Button` bez ikony nic nie rysował: nie dało się zapisać szkicu ani wysłać e-maila; teraz X po lewej i napis po prawej); menu Compose na białej karcie, grupy filtrów jako podmenu; wyszukiwarka biała na niebieskim pasku; pole wyboru: nasze pole z menu Material (było systemowe pole w naszej ramce); fala przycięta do zaokrągleń w `Dotyk`, pigułkach, wierszach, polach i przyciskach tekstowych; bez kreski Material pod polami; kciuk przełącznika w kolorach marki; wstecz przy blokadzie chowa aplikację; `app.json`: kolor marki, zablokowane uprawnienia (okno nad innymi, zapis i odczyt plików, mikrofon), pakiet i ikona adaptacyjna bez zmian. Decyzje: skaner na Androidzie to aparat systemowy i galeria (ML Kit wymaga Kotlina, którego nie zbudujemy bez Android Studio, i wysyła Google dane o użyciu; do decyzji po M12b), „Wklej” zwykłym przyciskiem (Android nie pyta o zgodę), biometria przez systemowe okno z nazwą „odcisk palca”. Sprawdzone: `expo export` Android i iOS, `expo prebuild --platform android` (manifest, uprawnienia, ikona, czcionki Outfit), `pnpm run sprawdz`, test `mobile-android` (9, czerwone przed zmianą), testy telefonu (487), filtr. Checklista M12b w sekcji 7a | #PR_M12A |
