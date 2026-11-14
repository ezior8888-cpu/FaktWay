# Aplikacja mobilna FaktWay (Expo)

Natywna aplikacja FaktWay na iPhone'a i Androida. Obowiązuje główny
[`AGENTS.md`](../AGENTS.md) (scalanie, protokół naprawy, PR) oraz:

- plan i etapy: [`docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md`](../docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md),
- wygląd: [`docs/mobile/ZASADY-DESIGNU.md`](../docs/mobile/ZASADY-DESIGNU.md), czytasz w całości przed każdym ekranem,
- wzorce z Mobbin i lista poprawek: [`docs/mobile/WZORCE-MOBBIN.md`](../docs/mobile/WZORCE-MOBBIN.md), sekcja ekranu, nad którym pracujesz.

## Polecenia (w tym katalogu)

```bash
pnpm install                # własny workspace pnpm, główny lockfile się nie zmienia
pnpm run sprawdz            # typy i eslint; przed każdym PR
npx expo install <paczka>   # zawsze zamiast pnpm add: wersje zgodne z SDK
pnpm run ios                # development build w Xcode i uruchomienie w symulatorze
pnpm start                  # sam serwer Metro, gdy build już jest w symulatorze
```

Na Macu z 16 GB budowanie w Xcode, `pnpm build` strony i Supabase w Colimie
uruchamiasz po kolei, nigdy razem.

## Układ

| Katalog | Co |
|---|---|
| `src/app/` | trasy Expo Router: `_layout.tsx` to korzeń (`Slot`, dostawcy, blokada), `(zakladki)/_layout.tsx` zakładki systemowe, każdy folder zakładki ma własny `Stack`; `logowanie/` to stos logowania. Bez sesji układ zakładek przekierowuje na `/logowanie`, po zalogowaniu układ logowania na `/` |
| `src/komponenty/` | wygląd FaktWay (plan D12, od 12.11 z wykończeniem Copilota, D15): `Tekst`, `EkranListy`, `Sekcja` (karta), `Wiersz`, `WierszFaktury` (gesty, podgląd, menu), `PrzyciskGlowny`, `Dotyk` (animacja wciśnięcia), `Ikona` i `KoloIkony` (Remix), `Znacznik` (plakietka statusu), `NaglowekKwoty`, `Kafle`, `Wykres` (SVG: słupki, linia, pierścień), `Kubelki`, `Kalendarz`, `LogoFaktWay` (też białe na niebieskim), `PasekMarki`, pola formularza (`formularz.tsx`); od M4c (D15) `Karta` (18 pt, cień), `GradientNaglowka`, `KwotaZGroszami`, `Kategoria`, `KartaWyniku`, `RzadLiczb`, `RzadAkcji`, `OsStatusu`, `PotwierdzenieKsef`, `PasekCofnij`, pomocnik `potwierdz()` (arkusz akcji zamiast `Alert.alert`); `Segmenty` to pigułki; `StanPusty` z opcjonalną akcją; `EkranListy onOdswiez` (pociągnięcie w dół); od M5a `EkranLogowania` (nagłówek na gradiencie w treści), `PoleKodu` (kod TOTP), `Blokada` i `Zaslona` (nad całą aplikacją), `PrzyciskGlowny` z wariantami `karta` i `naGradiencie` i stanem `trwa`; ekrany składasz tylko z nich i z komponentów systemowych |
| `src/stan/` | stan wspólny dla ekranów: `faktury.tsx` (dane przykładowe: faktury, cykliczne, wydatki, przełączniki; `dane` mówi, skąd są dane i w jakim są stanie, `dzis` to dzień do terminów); `sesja.tsx` (od M5a): logowanie, kod 2FA, blokada Face ID, czyszczenie danych przy końcu sesji; `dane.tsx` (od M7): prawdziwe konto z `GET /konto`, wybór firmy, faktury i skrzynka KSeF z bazy podmienione w stanie ekranów (`PodmienStan`) |
| `src/wyglad/` | paleta (`paleta.ts`, bez React Native, kontrast sprawdza `tests/unit/mobile-kontrast.test.ts`; `kolory.ts` wybiera jasną albo ciemną), czcionki i skala tekstu, odstępy i kształty, opcje pasków (`naglowki.ts`), ikony paska (`ikony-paska.ts`); jedyne miejsce na wartości wyglądu |
| `assets/fonts/`, `assets/zakladki/`, `assets/pasek/` | Outfit (OFL, `LICENCJE.txt`; IBM Plex Mono usunięty w M4c, D15); ikony Remix zakładek i paska jako obrazy szablonowe |
| `scripts/ikony-remix.cjs` | generuje `src/komponenty/ikony-remix.ts` z pakietu `@remixicon/react` strony; nową ikonę dopisz tam |
| `src/lib/` | formatowanie i logika bez interfejsu; `api/` (od M7): kontrakt API strony (reeksport, `metro.config.js`), klient z ponowieniem po 401 (`rdzen.ts`, bez React Native), podpięcie pod sesję (`polaczenie.ts`); `dane/`: mapowanie wierszy bazy na model ekranów, zapytania do bazy, dane z poprzedniego otwarcia w plikach; `faktura/` (od M8): formularz faktury na treść `POST /faktury`, pole błędu serwera, nabywcy z ostatnich faktur, klucz zapisu; `wydatek/` (od M9): formularz sprawdzenia odczytu na treść `POST /wydatki/{id}/zatwierdzenie`, czekanie na odczyt; `skaner.ts` (od M9): skaner dokumentów. Pliki bez React Native (`api/rdzen.ts`, `api/bledy.ts`, `dane/mapowanie.ts`, `dane/pamiec.ts`, `faktura/wystawienie.ts`, `wydatek/zatwierdzenie.ts`, `logowanie/token.ts`, `status-faktury.ts`) importują względnie, bo czytają je testy strony (`tests/unit/mobile-*.test.ts`) |
| `src/dane-przykladowe/` | dane do etapów M2 do M4 (zmyślone firmy, NIP testowy) |
| `modules/` | lokalne moduły natywne Expo (autolinking z `./modules`, bez paczki z npm): od M9 `skaner-dokumentow` (VisionKit `VNDocumentCameraViewController`, tylko iOS; nakładka JS w `src/lib/skaner.ts`). Zmiana w Swift wymaga nowego buildu |

## Expo zmienia się z każdym SDK: nie ufaj pamięci

1. Sprawdź wersję `expo` w `package.json` (dziś SDK 58).
2. API sprawdzaj w typach w `node_modules` albo w dokumentacji dla tej wersji:
   `https://docs.expo.dev/versions/v58.0.0/`, indeks: https://docs.expo.dev/llms.txt
3. Skille Expo (kopie z github.com/expo/skills, MIT) leżą w `../.claude/skills/expo-*`.

## Zasady techniczne

- Trasy tylko w `src/app/`; reszta kodu poza nim.
- Katalogi `ios/` i `android/` są generowane (Continuous Native Generation) i nie
  trafiają do gita. Ustawienia natywne tylko w `app.json` i pluginach.
- Po dodaniu biblioteki z kodem natywnym potrzebny jest nowy build (`pnpm run ios`);
  Expo Go nie pokazuje natywnych zakładek ani efektu szkła, więc go nie używamy.
- Teksty po polsku, nazwa produktu tylko „FaktWay” (pilnuje `tests/unit/nazwa-produktu.test.ts`).
- `src/` jest na mapie żelaznego filtra (`filtr/mapa-ryzyka.json`, obszary `mobile.*`).
  - **R1:** formularz faktury, `lib/faktura/`, `lib/dane/mapowanie.ts`, `stan/dane.tsx` i Koszty.
  - **R2:** Pulpit, Księgowość i dane przykładowe.
  - **R3:** reszta.

  Zmiana w R1 albo R2 to karta w opisie PR i drugi czytelnik (`AGENTS.md` w katalogu głównym, „Żelazny filtr”). Kwoty i dni liczy serwer. `Math.round` na kwocie albo dzień z lokalnego `getDate` w R1 to nowe naruszenie (`node scripts/filtr/reguly.mjs --sprawdz`). Gdy telefon musi coś odtworzyć do podglądu, piszesz wyjątek `// filtr-wyjatek: <reguła> <powód>`, a Bartosz nadaje etykietę `zgoda:wyjatek-filtra`.

## Pułapki (sprawdzone w symulatorze)

- `Link` z `asChild` spłaszcza style dziecka (`StyleSheet.flatten`), więc styl
  w postaci funkcji (`({ pressed }) => ...`) ginie. Stan wciśnięcia trzymaj w
  `useState` (`onPressIn`, `onPressOut`), jak w `komponenty/wiersz-faktury.tsx`.
- `Stack.Toolbar placement="bottom"` chowa się pod paskiem zakładek. Główna
  akcja ekranu idzie do treści (`komponenty/przycisk-glowny`).
- Ekran otwierany też jako podgląd (`Link.Preview`) nie może ustawiać paska:
  `Stack.Screen` i `Stack.Toolbar` tylko gdy `!useIsPreview()`.
- Typy tras (`/koszty/[id]`) generuje Metro przy starcie: po dodaniu trasy
  uruchom `pnpm start`, zanim `tsc` przestanie zgłaszać błąd.
- Zmiana pliku ze stanem (`src/stan/`) przy szybkim odświeżaniu zeruje stan
  aplikacji; to nie błąd.
- Ekran zakładki otwarty linkiem (`faktway://...`) ma pod spodem listę tylko
  dzięki `unstable_settings = { anchor: 'index' }` w `_layout.tsx` stosu.
  Formularz faktury otwierany z innego stosu (Popraw, Korekta, Duplikuj, karta
  kontrahenta) nie ma pod sobą wyboru rodzaju: przekaż `wprost: '1'`, wtedy
  formularz pokazuje „Anuluj”. Stanu nawigacji (`getState()`) nie czytaj przy
  rysowaniu: przy pierwszym rysowaniu bywa nieaktualny.
- Parametr trasy czytany w `useState(...)` nie zmienia się, gdy ekran już
  jest otwarty. Gdy link ma przełączyć widok, porównuj z poprzednim
  parametrem (wzór w `app/faktury/index.tsx`).
- Timery w ekranach arkuszy czyść przy zamknięciu (`useEffect` ze sprzątaniem):
  arkusz zamknięty gestem nie może potem nawigować ani zapisywać.
- Pole formularza ma etykietę zawsze nad polem (jak na stronie), więc nie
  łamie słów przy długich wartościach i dużym tekście. Pola mają własne
  odstępy (`pole = true` na komponencie), karta nie rysuje między nimi linii.
- Obchód w symulatorze: linki otwieraj narzędziem symulatora (`open_url`), nie
  `xcrun simctl openurl`, który pokazuje systemowe pytanie „Otworzyć w
  FaktWay?”.
- Pasek nawigacji bez `headerStyle`/`headerLargeStyle` z kolorem tła: na iOS 27
  chowa wtedy duży tytuł. Opcje pasków tylko z `wyglad/naglowki.ts`.
- Własna czcionka: wagę wybiera plik (`czcionka('semibold')`), nie
  `fontWeight` (na Androidzie wraca wtedy czcionka systemowa).
- Wartości Reanimated w zdarzeniach i efektach zapisuj przez `.set()`, nie
  `.value =`: lint React Compiler (`react-hooks/immutability`) odrzuca przypisanie.
- `borderStyle: 'dashed'` z obwódką z jednej strony nie działa w React Native;
  przerywane linie rysuj w SVG (`Line strokeDasharray`).
- Linki z innej zakładki nie przejdą, gdy na wierzchu jest arkusz (np. „Nowa
  faktura”): przy obchodzie zamknij arkusz albo uruchom aplikację od nowa.
- Gradient pod nagłówkiem leży w przewijanej treści (`EkranListy gradient`);
  duży tytuł na nim biały (`useOpcjeGradientu`), mały tytuł szczegółu przez
  `useTytulNaGradiencie`. Na gradiencie stoi tylko tytuł, logo i pierwsza
  karta: nagłówek sekcji wyżej niż koniec gradientu traci kontrast.
- Cień karty (`boxShadow`) ucina `overflow: 'hidden'` na tym samym widoku,
  dlatego `Karta` ma dwa widoki: zewnętrzny z cieniem, wewnętrzny przycina.
- Port 8081 i iPhone 18 Pro bywają zajęte przez inną sesję. Drugi symulator
  bez przebudowy: zainstaluj gotowy `FaktWay.app` z DerivedData, uruchom
  Metro na innym porcie (`pnpm exec expo start --port 8082`) i aplikację z
  argumentem `xcrun simctl launch <udid> pl.faktway.app -RCT_jsLocation localhost:8082`
  (wpis w ustawieniach aplikacja nadpisuje przy starcie).
- Zmiana rozmiaru tekstu w ustawieniach przy działającej aplikacji nie
  przelicza układu kafli (`fontScale`): przed zrzutem z dużym tekstem uruchom
  aplikację od nowa.
- Korzeń aplikacji to `Slot`, nie `Stack` z `Stack.Protected`: stos nad
  zakładkami przejmuje styl paska stanu i na gradiencie Pulpitu robi się
  ciemny napis (sprawdzone w M5a). Ochronę tras robią `Redirect` w układach
  `(zakladki)` i `logowanie`.
- Warstwa nad całą aplikacją, także nad otwartym arkuszem (blokada, zasłona):
  `FullWindowOverlay` z `react-native-screens`, nie widok w korzeniu, bo
  arkusz natywny leży nad korzeniem.
- `onSubmitEditing` bywa o znak w tyle za stanem, gdy klawisz „Zaloguj” pada
  tuż po ostatniej literze: `PoleTekstowe onZatwierdz` dostaje tekst wprost z
  pola, używaj go zamiast stanu.
- Narzędzie symulatora robi zrzut przed narysowaniem ostatnich zmian po
  wpisaniu tekstu; przed oceną zrzutu odczekaj sekundę albo zrób drugi.
- Systemowy przełącznik (`Switch`) na iOS 27 nie reaguje na samo dotknięcie
  z narzędzia symulatora: przeciągnij go (`swipe` o 35 pt w bok).
- `pod install` (też w `expo prebuild`) pada na kodowaniu bez UTF-8 w
  powłoce: najpierw `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`.

## Dane z bazy i API (od M7)

- Odczyty idą z telefonu wprost do bazy (RLS), z tokenem sesji i nagłówkiem
  `x-active-org` przy każdym zapytaniu (`lib/dane/zapytania.ts`). Token
  podajemy jawnie: bez niego `supabase-js` wysłałby klucz publiczny, a RLS
  oddałby pustą listę zamiast błędu.
- API strony (`/api/mobile/v1`) przez `zapytajApi` z `lib/api/polaczenie.ts`:
  `Authorization: Bearer`, `X-Active-Org` przy trasach z danymi firmy, po 401
  odświeżenie sesji i jedno ponowienie, brak sieci i 503 nigdy nie wylogowują.
  Adres serwera w `EXPO_PUBLIC_API_URL` (`mobile/.env.local`; lokalnie
  `http://localhost:3000`, czyli `pnpm dev` w katalogu głównym).
- Kontrakt (`lib/api/mobile/kontrakt.ts` strony) importuje `src/lib/api/kontrakt.ts`;
  Metro widzi ten jeden katalog dzięki `watchFolders` w `metro.config.js`.
  Po zmianie `metro.config.js` uruchom Metro od nowa.
- Dane z poprzedniego otwarcia (konto, faktury, skrzynka jednej firmy) leżą w
  `Paths.cache/faktway-dane/`, z kontem i firmą w każdym zapisie. Wylogowanie,
  „Zaloguj się na inne konto” i koniec sesji z serwera czyszczą je razem ze
  stanem w pamięci (`sesja.tsx`, `wyczyscDane`).
- Od M8 wystawienie zwykłej faktury VAT (szkic albo „Wyślij do KSeF”) i
  wysyłka szkicu idą przez API (`stan/dane.tsx`: `dodajFakture`, `wyslijDoKsef`;
  treść żądania z formularza w `lib/faktura/wystawienie.ts`, bez React
  Native, testy `tests/unit/mobile-faktura-wystawienie.test.ts`). Każdy zapis
  niesie `klucz` (UUID jednego wypełnienia formularza, nagłówek
  `Idempotency-Key`): ponowienie po zerwanym połączeniu oddaje tę samą
  fakturę. Zasady faktury sprawdza serwer schematem strony; odmowa
  `invoice_invalid` ma `field`, a `poleFormularza` kładzie zdanie pod polem.
  Zdania serwera idą przez `bezDlugichMyslnikow` (strona je ma, aplikacja nie).
- Pozostałe zapisy na prawdziwych fakturach (zapłata, zmiana szkicu, korekta,
  zaliczka, rozliczenie, ponowna wysyłka odrzuconej, e-mail, PDF) nie mają
  jeszcze API: telefon mówi, gdzie to zrobić, i otwiera stronę
  (`komponenty/na-stronie.tsx`). Nie udawaj zapisu w pamięci.
- Od M9 wydatki: lista z bazy (`pobierzWydatki`, 200 najnowszych według daty
  dokumentu, ze śladu odczytu tylko klucze waluty), wydatek ze zdjęcia
  (`wgrajDokument` z kluczem na zdjęcie, `stanOdczytu`, `zatwierdzKoszt` w
  `stan/dane.tsx`). Waluta kwot to kopia reguły strony (`walutaKwotWydatku`,
  zgodność sprawdza `tests/unit/mobile-wydatki.test.ts`). Wpis ręczny,
  usunięcie i opis kosztu z KSeF odsyłają na stronę (`wydatekNaStronie`).
- Ekrany poza Fakturami, skrzynką KSeF i Wydatkami (Pulpit, Księgowość,
  Więcej) zostają na danych przykładowych do M10; stopka w Więcej mówi o tym klientowi.
- `supabase.auth.onAuthStateChange` woła słuchacza wewnątrz blokady
  `supabase-js`: wywołanie klienta w słuchaczu czeka na samo siebie. Odłóż je
  (`setTimeout(…, 0)`), jak w `stan/dane.tsx`.
- Brak internetu w symulatorze: zatrzymaj bramkę lokalnego Supabase
  (`docker stop supabase_kong_<projekt>`) i `next dev`; telefon dostaje wtedy
  błąd sieci jak w trybie samolotowym. Wygasły token bez czekania godziny:
  `jwt_expiry` w `supabase/config.toml` tylko lokalnie, bez commitu.

## Logowanie na lokalnej bazie (od M5b)

- Bez `mobile/.env.local` aplikacja loguje na danych przykładowych (M5a).
  Z plikiem loguje się do Supabase:
  `EXPO_PUBLIC_SUPABASE_URL` i `EXPO_PUBLIC_SUPABASE_ANON_KEY` z
  `supabase status -o env` (`pnpm db:local` w katalogu głównym), od M7 też
  `EXPO_PUBLIC_API_URL=http://localhost:3000`. Plik jest
  poza gitem; tylko lokalna baza, nigdy `db-1`. Po zmianie pliku uruchom
  Metro od nowa.
- Logowanie hasłem idzie od M6b przez stronę (`POST /api/mobile/v1/logowanie`,
  plan D16), więc wymaga działającego `pnpm dev` pod `EXPO_PUBLIC_API_URL`
  i Redisa w `.env.local` strony (bez Redisa trasa odmawia: „Logowanie w
  aplikacji jest chwilowo niedostępne”). Chmurowy Redis dev bywa wolniejszy
  niż limit 500 ms; wtedy ta sama odmowa, ponów. Kod 2FA od M6c też przez
  stronę (`POST /api/mobile/v1/kod`, limit prób w Redisie; bez niego „Nie
  możemy teraz sprawdzić kodu”). Google i odświeżanie idą wprost do GoTrue.
  Próba z captchą w GoTrue: osobny stos z `[auth.captcha]` (plan 4.2) i
  `.env.local` strony wskazujący ten stos.
- Konto testowe `dev@faktway.test` (bez 2FA) zakłada `scripts/dev/baza-lokalna.sh`.
  Do kodu 2FA załóż drugie konto z TOTP przez API GoTrue (`auth.admin.createUser`,
  potem `mfa.enroll` i `mfa.challengeAndVerify`); konta dev nie ruszaj, bo
  używa go strona.
- Face ID w symulatorze: zapis twarzy
  `xcrun simctl spawn <udid> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`
  i `... notifyutil -p com.apple.BiometricKit.enrollmentChanged`; rozpoznana
  twarz `... notifyutil -p com.apple.BiometricKit_Sim.pearl.match`,
  nierozpoznana `... pearl.nomatch`. Kod do schowka symulatora:
  `xcrun simctl pbcopy <udid>`.
- Pytanie systemu o Face ID robi aplikację „nieaktywną” jak przełącznik
  aplikacji; zasłona (`Zaslona`) pomija je przez `pytanieSystemu` z sesji.

## Wysyłka do KSeF TEST z symulatora (od M8)

- Pełna droga potrzebuje strony (`next dev`), workera pg-boss i bazy z
  migracjami gałęzi. Migracji z niescalonej gałęzi nie wgrywaj na wspólną bazę
  dev: osobny stos Supabase (`--workdir`, porty 573xx, pamięć projektu
  „rls-lokalnie-osobny-stos”).
- Firma z fikcyjnym NIP z poprawną sumą kontrolną (`1234567890` jej nie ma, a
  KSeF TEST sprawdza NIP) i certyfikat samopodpisany jak w
  `scripts/test-ksef-wysylka.ts` (`makeSelfSignedCertificate`,
  `prepareKsefCredentials`, `encryptCredentials`), plus `ksef_verified_at` i
  `ksef_verified_environment = 'test'`.
- `pnpm worker:dev` nie czyta `.env.local` (Next czyta): bez
  `node --env-file=.env.local --import ./lib/jobs/server-only-hook.mjs --import tsx lib/jobs/worker.ts`
  worker nie odszyfruje certyfikatu („KSEF_CREDENTIALS_ENCRYPTION_KEY nie jest
  ustawione”). Zmienne powłoki mają pierwszeństwo przed plikiem.
- Worker wgrywa XML do S3 przed wysyłką; lokalnie bez `R2_*` wystarczy
  atrapa S3 w stylu ścieżek (`R2_ENDPOINT`, `R2_FORCE_PATH_STYLE=true`).
- Metro uruchomione z `CI=1` nie przeładowuje zmian w kodzie: po edycji
  uruchom je od nowa bez `CI`.
- Narzędzie symulatora nie wpisze polskich znaków (wkleja, a symulator nie
  przyjmuje wklejenia z Maca); w obchodzie pisz bez nich albo dotknij
  podpowiedzi klawiatury.

## Wydatek ze zdjęcia w symulatorze (od M9)

- Symulator nie ma aparatu: `skanerDostepny()` daje `false`. Na prawdziwym
  koncie „Skanuj dokument” proponuje galerię; na danych przykładowych daje
  przykładowy paragon. Zdjęcie do galerii symulatora:
  `xcrun simctl addmedia <udid> paragon.jpg` (dane zmyślone, nigdy prawdziwy
  paragon firmy). Skaner sprawdza się tylko na iPhonie z aparatem.
- Pełna droga potrzebuje strony (`next dev`), workera (odczyt OCR to zdarzenie
  `ocr/process-photo`) i bazy z migracjami gałęzi (00202). Worker uruchamiasz
  jak przy KSeF (wyżej), a odczyt woła model z `ANTHROPIC_API_KEY` z
  `.env.local` strony; bez klucza zostaje `E2E_MOCK_ANTHROPIC=1` (stała
  odpowiedź modelu, nie odczyt zdjęcia).
- Plik zdjęcia idzie do magazynu S3 (`R2_*`): lokalnie atrapa w stylu
  ścieżek (`R2_ENDPOINT=http://127.0.0.1:<port>`, `R2_FORCE_PATH_STYLE=true`,
  dowolne `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`) w zmiennych powłoki strony i workera. Nie wgrywaj zdjęć
  do magazynu z `.env.local`, póki nie wiesz, dokąd wskazuje.
- `POST /wydatki/zdjecie` jest poza proxy (`proxy.ts`); w dzienniku `next dev`
  nie ma więc wpisu proxy dla tego żądania, tylko trasy.
