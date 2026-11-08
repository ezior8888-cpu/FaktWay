# Plan: aplikacja FaktWay na iPhone'a i Androida

> **„Kontynuuj plan aplikacji mobilnej”**: sesja czyta ten plik od góry, robi
> checklistę startową (sekcja 0) i pracuje od wiersza „Następny krok”
> w dzienniku (sekcja 9). Robi tylko ten jeden etap, dopisuje wiersz
> w dzienniku z numerem PR, aktualizuje „Następny krok”, składa raport i STOP.
>
> Zasady wyglądu: [`docs/mobile/ZASADY-DESIGNU.md`](../mobile/ZASADY-DESIGNU.md).
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
| D3 | **Zakres v1:** sześć zadań z sekcji 3 | przyjęta 08.11.2026 |
| D4 | **Konta deweloperskie:** Apple (99 USD rocznie) i Google Play (25 USD jednorazowo) zakładamy jako firma, po założeniu spółki. Konto Apple dla JDG pokazuje w sklepie imię i nazwisko; nowe konto osobiste Google wymaga zamkniętego testu z 12 testerami przez 14 dni | do decyzji Bartosza |
| D5 | **Płatności:** v1 nie sprzedaje abonamentu w aplikacji. Brak cen i przycisku „kup”, zakup na faktway.pl. Przed zgłoszeniem sprawdzić aktualne wytyczne Apple 3.1 | rekomendacja |
| D6 | **Projektant iOS:** na zlecenie, raz: system (kolor, typografia, ikona aplikacji) i 8 do 10 kluczowych ekranów w Figmie na zestawie Apple. Bez projektanta: Claude daje 2 do 3 wariantów ekranu wzorcowego, Bartosz wybiera | do decyzji Bartosza |
| D7 | **Miejsce „Nowa faktura”:** przycisk w pasku ekranu Faktury albo osobny okrągły przycisk obok paska zakładek (w PWA Bartosz wybrał plus na dolnym pasku). Decyzja po obejrzeniu obu wariantów w symulatorze w etapie M3 | otwarta |
| D8 | **Kolejność platform:** najpierw iOS do poziomu „wzorzec”, potem dopasowanie Androida z tego samego kodu przed betą Google Play | rekomendacja |
| D9 | **Powiadomienia:** z workera pg-boss bezpośrednio do APNs i FCM albo przez usługę push Expo (nowy podmiot przetwarzający, serwery poza UE). W obu przypadkach treść bez kwot i danych kontrahenta | otwarta, rozstrzygnąć w M10 |
| D10 | **Identyfikator aplikacji:** `pl.faktway.app` na iOS (bundle ID) i Androidzie (package). Po publikacji nie do zmiany | przyjęta 08.11.2026 |
| D11 | **Zakładki:** Faktury (z filtrem „Do zapłaty”), Koszty (skrzynka KSeF i wydatki), Ten miesiąc, Konto | przyjęta 08.11.2026, do korekty w M3 |

---

## 3. Zakres v1: sześć zadań z telefonu

| Zadanie | Co klient robi | Element natywny | Skąd dane i akcje dziś |
|---|---|---|---|
| Skrzynka KSeF | widzi nowe faktury kosztowe, otwiera, oznacza do opisania | lista, odświeżanie pociągnięciem, powiadomienie | odczyt z bazy (RLS); `requestInboxCheckAction` w `app/actions/ksef-inbox.ts` |
| Szybka faktura | wystawia fakturę dla ostatniego kontrahenta albo z kopii, wysyła do KSeF, widzi status | arkusz z formularzem, wibracja „przyjęta” | `saveAndSendInvoiceAction` w `components/invoices/actions.ts` (reeksport w `app/(dashboard)/invoices/new/actions.ts`), generator FA(3) w `lib/xml/` |
| Wydatek ze zdjęcia | skanuje paragon albo fakturę, sprawdza odczyt, zapisuje | systemowy skaner dokumentów, aparat | `uploadExpensePhotoAction`, `getOcrJobStatusAction`, `reviewExpenseAction` w `app/actions/expenses.ts` |
| Należności | widzi, kto nie zapłacił, oznacza zapłatę, wysyła przypomnienie | gest przesunięcia wiersza, menu kontekstowe | `markInvoicePaidAction`, `undoInvoicePaidAction` w `app/actions/invoice-payments.ts`; `app/actions/reminders.ts` |
| Podgląd i PDF | otwiera fakturę, udostępnia PDF mailem albo komunikatorem | systemowy arkusz udostępniania | `app/api/invoices/[id]/pdf/route.ts` |
| Ten miesiąc | widzi, ile podatku, ZUS i VAT zapłacić i do kiedy | lista z kwotami, przypomnienie | `app/actions/ksiegowosc-ten-miesiac.ts`, moduł `lib/ksiegowosc/` (za wyłącznikiem `ksiegowosc`) |

**Zostaje na komputerze (v1):** ustawienia firmy i KSeF (certyfikat, kreator),
import danych, eksporty, panel księgowej, faktury cykliczne, korekty i zaliczki,
pełna księgowość (KPiR, JPK), FLO, admin. W aplikacji te miejsca kończą się
zdaniem „Zrobisz to na faktway.pl” i linkiem.

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
  do M5 aplikacja ma małą kopię formatowania (`mobile/src/lib/format.ts`),
  a sposób współdzielenia typów i schematów Zod (import przez Metro czy
  wspólny pakiet) rozstrzyga M5 razem z API.
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
  w `CLAUDE-DO-CODEXA.md`, w M10).

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
| Wzorce | Mobbin i własne zrzuty w `.agents/mobile-wzorce/` (poza gitem) | czeka na Bartosza |

Zasada: żaden ekran nie idzie do PR bez zrzutów z checklisty i porównania
ze wzorcem. Wibracji i płynności Claude nie oceni; ocenia Bartosz na telefonie.

---

## 6. Po stronie Bartosza (poza kodem)

| Sprawa | Po co | Kiedy |
|---|---|---|
| Zgoda na dostęp w panelu symulatora | Claude klika i robi zrzuty sam | zrobione 08.11.2026 |
| Mobbin i 3 do 4 aplikacji wzorcowych (zrzuty do `.agents/mobile-wzorce/`) | wzorce dla ekranów | przed M3 |
| Decyzja D6 (D2 i D3 przyjęte 08.11.2026) | sposób pracy nad wyglądem | przed M3 |
| Projektant iOS (jeśli D6 na tak) | system i ekrany kluczowe | najlepiej przed M3 |
| Spółka, D-U-N-S, konta Apple i Google (D4) | TestFlight, push, logowanie Apple, sklep | przed M10 |
| Dane usługodawcy w polityce prywatności | sklepy wymagają polityki i etykiet prywatności | przed M12 |

---

## 7. Etapy

Każdy etap: jeden PR, raport i STOP. Ocena Bartosza na telefonie jest
częścią „gotowe” od M3.

| Etap | Co | Gotowe, gdy |
|---|---|---|
| M1 | Plan i zasady designu (ten plik, `ZASADY-DESIGNU.md`, hasło w `AGENTS.md`) | PR otwarty |
| M2 | Fundament: Expo w `mobile/`, wyłączenia z 4.4, natywne zakładki i stos, kolory semantyczne i tryb ciemny, skille Expo i `telefon-app`, dane przykładowe | aplikacja startuje w symulatorze, zrzuty jasny i ciemny, CI strony bez zmian |
| M3 | **Ekran wzorcowy** na danych przykładowych: lista faktur i szczegół, dopracowane do checklisty; warianty D7 | Bartosz na swoim iPhonie mówi „to jest to”. Bez tego nie ma kolejnych ekranów |
| M4 | Logowanie: e-mail i hasło, Google, 2FA, Face ID | logowanie na konto testowe z lokalnej bazy działa w symulatorze |
| M5 | API `app/api/mobile/v1` (szkielet, token, limity, audyt) i pierwsze trasy | testy tras na brak i zły token, RLS na bazie |
| M6 | Faktury i skrzynka KSeF na prawdziwych danych | lista i szczegół z bazy, odświeżanie, stany ekranu |
| M7 | Szybka faktura z wysyłką do KSeF (środowisko TEST) | faktura przyjęta przez KSeF TEST z telefonu |
| M8 | Wydatek ze zdjęcia: skaner, OCR, sprawdzenie | wydatek zapisany ze skanu |
| M9 | Należności, przypomnienia, PDF i udostępnianie, „Ten miesiąc” | zadania 4 do 6 z sekcji 3 działają |
| M10 | Powiadomienia push (D9), logowanie Apple; wymaga płatnego konta | powiadomienie o nowej fakturze na telefonie |
| M11 | Android: dopasowanie konwencji (sekcja 10 zasad) | checklista na emulatorze Androida |
| M12 | Sklep: ikona, zrzuty, opisy, polityka i etykiety prywatności, konto dla recenzenta, beta TestFlight i zamknięty test Google | aplikacja zgłoszona do przeglądu |

---

## 8. Ryzyka

| Ryzyko | Co robimy |
|---|---|
| Odrzucenie przez Apple za „stronę w ramce” (4.2) | aplikacja natywna z funkcjami telefonu: skaner, Face ID, powiadomienia, udostępnianie |
| Brak logowania Apple przy logowaniu Google (4.8) | M10, przed zgłoszeniem |
| Brak spółki blokuje konta firmowe | M1 do M9 nie potrzebują płatnych kont |
| Pamięć Maca | sekcja 0, punkt 4 |
| Rozjazd logiki strony i aplikacji | trasy API wołają te same funkcje z `lib/`, schematy Zod wspólne |
| „Ładne, ale nijakie” | wzorce, ekran wzorcowy z akceptacją Bartosza (M3), projektant (D6) |

---

## 9. Dziennik

**Następny krok:** M3 (ekran wzorcowy: lista faktur i szczegół na danych
przykładowych, warianty D7). D6 (projektant) czeka na Bartosza.

| Data | Etap | Co zrobiono | PR |
|---|---|---|---|
| 08.11.2026 | przygotowanie | Xcode 27.2 i symulator iOS 27.2 na Macu Bartosza; test zrzutu z iPhone 18 Pro | (bez PR) |
| 08.11.2026 | M1 | plan, `docs/mobile/ZASADY-DESIGNU.md`, hasło w `AGENTS.md`; decyzje D2, D3, D10, D11 | #489 |
| 09.11.2026 | M2 | Expo SDK 58 w `mobile/` (własny workspace pnpm), 4 natywne zakładki, stos w każdej, lista i szczegół faktury, arkusz „Nowa faktura”, Koszty, Ten miesiąc, Konto na danych przykładowych; kolory semantyczne, style tekstu z Dynamic Type, skala odstępów; wyłączenia `mobile/` w tsconfig, eslint, Docker, knip; job CI „Mobile”; skille Expo i `telefon-app`; pierwszy build w Xcode na iPhone 18 Pro, zrzuty w `docs/mobile/zrzuty/m2/`. Strona: `pnpm run ci` i `pnpm build` zielone | #493 |
