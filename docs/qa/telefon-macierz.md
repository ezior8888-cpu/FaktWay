# Telefon: macierz ekranów

Obchód robi `e2e/tests/telefon-ekrany.spec.ts` (FaktWay 1.0, pkt 2): WebKit z Playwrighta,
profil iPhone 14, konto `dev@faktway.test` na lokalnej bazie, serwer deweloperski.
Test przechodzi po wszystkich trasach panelu z `lib/dashboard-nav-config.ts`, po zakładkach
i ustawieniach, po wszystkich rodzajach nowej faktury, po szczegółach faktury i wydatku
oraz po arkuszu „Więcej”. Na każdym ekranie sprawdza:

- poziome przewijanie: `scrollWidth <= innerWidth + 1`,
- przyciski ucięte przez `overflow: hidden` albo wypchnięte poza ekran,
- błędy strony (`pageerror`), ekran błędu, status HTTP od 400,
- przekierowanie na `/mobile`, `/login` albo `/onboarding`,
- cele dotykowe mniejsze niż 44x44: zbiera je do raportu, nie oblewają testu.

Ten sam obchód poszedł dwa razy: przy 390 px (iPhone 14) i przy 360 px (mały Android,
`TELEFON_SZEROKOSC=360`). Powtórzenie wybranych tras: `TELEFON_TRASY=/inbox,/settings`.
Uruchomienie: `e2e/README.md`, sekcja „Telefon”.

## Wynik

35 ekranów, **0 usterek** przy 390 px i **0 usterek** przy 360 px: żadnego poziomego
przewijania, żadnego uciętego przycisku, żadnego błędu strony. Pierwsze podejście (przed
poprawkami) padło na harnessie, nie na aplikacji: WebKit zabił kartę po kilkunastu ekranach
w jednej karcie, więc test otwiera teraz świeżą kartę na każdą trasę.

Prawdziwe usterki znalazł dopiero przegląd akcji (pkt 3), a nie obchód:

1. „Duplikuj” istniał tylko w menu ⋯ tabeli faktur, a tej telefon nie ma. Dodane w karcie
   Dokument na szczegółach faktury (ten sam warunek `canDuplicateInvoice` co w tabeli).
2. Trzy linki stopki (Regulamin, Polityka prywatności, Pomoc) miały 17 px wysokości na
   34 z 35 ekranów. Na telefonie mają teraz 44x44.
3. Przycisk Usuń na szczegółach wydatku jest na telefonie samą ikoną i nie miał nazwy.

## Ekrany

Kolumny 390 px i 360 px: wynik obchodu. „Cele < 44 px”: liczba elementów interaktywnych
mniejszych niż 44x44 w raporcie z przebiegu przy 360 px, po odjęciu trzech linków stopki
(poprawione po tym przebiegu i sprawdzone celowanym przebiegiem na Pulpicie i w Ustawieniach).

| Ekran | Trasa | 390 px | 360 px | Cele < 44 px | Co poprawiono |
|---|---|---|---|---|---|
| Logowanie | `/login` | OK | OK | n/d | Telefon wchodzi na /login bez przekierowania na /mobile (test jednostkowy i początek obchodu). |
| Pulpit | `/dashboard` | OK | OK | 0 | bez zmian |
| Przepływy (Miesiąc) | `/przeplywy` | OK | OK | 5 | bez zmian |
| Analizy: Sprzedaż | `/analizy/sprzedaz` | OK | OK | 3 | bez zmian |
| Analizy: Koszty | `/analizy/koszty` | OK | OK | 3 | bez zmian |
| Faktury, lista | `/invoices` | OK | OK | 7 | Wiersz to link do szczegółów, akcje są tam (zob. tabela akcji niżej). |
| Faktury cykliczne | `/invoices/recurring` | OK | OK | 3 | bez zmian |
| Faktury po terminie | `/payments/overdue` | OK | OK | 3 | bez zmian |
| Wystaw fakturę, kafel Wydatek | `/invoices/new` | OK | OK | 0 | bez zmian |
| Nowa faktura VAT | `/invoices/new/regular` | OK | OK | 8 | bez zmian |
| Nowa faktura zaliczkowa | `/invoices/new/advance` | OK | OK | 1 | bez zmian |
| Nowa korekta | `/invoices/new/correction` | OK | OK | 1 | bez zmian |
| Nowa faktura rozliczeniowa | `/invoices/new/final` | OK | OK | 1 | bez zmian |
| Szczegóły faktury (szkic) | `/invoices/<id>` | OK | OK | 0 | Dodano „Duplikuj” w karcie Dokument. Wcześniej był tylko w menu ⋯ tabeli, której telefon nie ma. |
| Kontrahenci | `/contractors` | OK | OK | 3 | bez zmian |
| Koszty, lista wydatków | `/expenses` | OK | OK | 7 | Pływający przycisk „Dodaj wydatek” już był, bez zmian. |
| Szczegóły wydatku | `/expenses/<id>` | OK | OK | 4 | Przycisk Usuń to na telefonie sama ikona. Dostał nazwę „Usuń wydatek” dla czytnika ekranu. |
| Skrzynka KSeF | `/inbox` | OK | OK | 4 | bez zmian |
| Raporty | `/reports` | OK | OK | 0 | Przekierowuje na Pulpit (tak jest zaprojektowane). |
| Księgowość: KPiR | `/reports/kpir` | OK | OK | 2 | bez zmian |
| Księgowość: Eksport | `/reports/exports` | OK | OK | 2 | bez zmian |
| Import danych | `/import-danych` | OK | OK | 0 | bez zmian |
| Flo | `/flo` | OK | OK | 0 | Przekierowuje na Pulpit (tak jest zaprojektowane). |
| Flo Wrapped | `/flo/wrapped` | OK | OK | 10 | bez zmian |
| Ustawienia | `/settings` | OK | OK | 2 | bez zmian |
| Ustawienia: Konto i dane (RODO) | `/settings/account` | OK | OK | 0 | bez zmian |
| Ustawienia: Księgowy | `/settings/accountant` | OK | OK | 7 | bez zmian |
| Ustawienia: Dziennik zdarzeń | `/settings/audit` | OK | OK | 0 | bez zmian |
| Ustawienia: Abonament | `/settings/billing` | OK | OK | 0 | bez zmian |
| Ustawienia: Flo | `/settings/flo` | OK | OK | 2 | bez zmian |
| Ustawienia: KSeF | `/settings/ksef` | OK | OK | 0 | bez zmian |
| Ustawienia: Powiadomienia | `/settings/notifications` | OK | OK | 3 | bez zmian |
| Ustawienia: Przypomnienia | `/settings/reminders` | OK | OK | 7 | bez zmian |
| Ustawienia: Bezpieczeństwo | `/settings/security` | OK | OK | 0 | bez zmian |
| Ustawienia: Zespół | `/settings/team` | OK | OK | 1 | bez zmian |
| Dolny pasek: arkusz Więcej | `/dashboard + Więcej` | OK | OK | 8 | Są w nim Ustawienia, Pomoc i Wyloguj. |
| Strona /mobile | `/mobile` | OK (zrzut ekranu) | n/d | n/d | Zamieniona na instrukcję: działa w przeglądarce, jak dodać do ekranu głównego (iPhone, Android). Bez odznak sklepów. |

## Akcje, które były tylko na komputerze

Przejrzane: `rg "hidden (sm|md|lg):"` oraz `max-(sm|md|lg):hidden` w `components` i
`app/(dashboard)`, razem z listami, szczegółami faktur i wydatków oraz ustawieniami.

| Akcja | Komputer | Telefon | Wynik |
|---|---|---|---|
| Wystaw i wyślij do KSeF | karta akcji w prawej kolumnie formularza (`max-lg:hidden`) | przyklejony pasek „Wyślij do KSeF”, ta sama funkcja | bez zmian |
| Zapisz szkic | karta akcji | przyklejony pasek „Zapisz” | bez zmian |
| Wyślij szkic, wyślij ponownie, wróć do szkicu | szczegóły faktury | te same szczegóły (wiersz listy jest linkiem) | bez zmian |
| Pobierz PDF jednej faktury | ikona w wierszu tabeli, karta Dokument | karta Dokument na szczegółach | bez zmian |
| Pobierz XML | menu ⋯ wiersza, karta Dokument | przesunięcie karty w lewo, karta Dokument | bez zmian |
| Wyślij e-mailem, Drukuj | karta Dokument | karta Dokument | bez zmian |
| Korekta | menu ⋯ wiersza, karta Dokument | karta Dokument, formularz korekty z paskiem akcji | bez zmian |
| **Duplikuj** | tylko menu ⋯ wiersza | **brak** | **dodane w karcie Dokument** |
| Ustaw jako cykliczną | menu ⋯ wiersza | karta Dokument | bez zmian |
| Usuń szkic | menu ⋯ wiersza, szczegóły szkicu | szczegóły szkicu | bez zmian |
| Dodaj wydatek | przycisk w pasku tabeli (`max-lg:hidden`) | pływający przycisk na Kosztach, kafel Wydatek pod plusem | bez zmian |
| Opisz i usuń wydatek | menu ⋯ wiersza | karta wydatku, formularz z Zapisz i Usuń | nazwa przycisku Usuń |
| Eksport (JPK, CSV) | Księgowość: Eksport | te same kroki, zwinięte pod „Zmień” | bez zmian |
| Filtr kolumny KPiR | lista w pasku (`max-lg:hidden`) | kafle sum ustawiają filtr, chip „Usuń filtr” | bez zmian |
| Szukaj | przycisk z podpowiedzią ⌘K | ikona lupy | bez zmian |
| Pomoc | pływający bąbelek (`hidden lg:flex`) | Pomoc w arkuszu „Więcej” i w stopce | bez zmian |
| Menu ustawień | lewa kolumna | przycisk menu w nagłówku (arkusz) | bez zmian |
| Rozmiar strony tabeli KPiR | lista w pasku | brak | widok, nie akcja; bez zmian |
| **Pobierz PDF zaznaczonych** | pasek nad tabelą po zaznaczeniu wierszy | **brak** (karty nie mają zaznaczania) | nie dodane, do decyzji |

## Cele dotykowe mniejsze niż 44 px

Korzeń strony ma 14 px, więc klasy Tailwinda `h-11`, `min-h-11` dają 38,5 px, a nie 44.
Tam, gdzie liczy się 44, są piksele (`min-h-[44px]`).

Najczęstsze, po poprawce stopki (przebieg 360 px):

| Element | Rozmiar | Razy | Decyzja |
|---|---|---|---|
| Przełącznik (Switch) | 32x18 | 13 | zostaje, do sprawdzenia, czy etykieta obok przyjmuje dotknięcie |
| Pole wyboru | 14x14 | 7 | zostaje, jw. |
| Zakładki sekcji: Wystawione, Cykliczne, Po terminie, Wydatki, Skrzynka KSeF, KPiR, Eksport | 47-99 x 34-35 | 17 | zostaje, wymaga zmiany wspólnego komponentu zakładek |
| Listy rozwijane (Wszystkie statusy, Wybierz miesiąc, rozmiar strony) | do 297 x 28 | 8 | zostaje, rozmiar z systemu projektu |
| Zakładki Analiz: Sprzedaż, Koszty | 50-64 x 21 | 4 | zostaje |
| Przełączniki zakresu: Tygodniowo, Miesięcznie | 73-77 x 21 | 2 | zostaje |
| Link „Sprawdź dane firmy” | 107 x 17 | 2 | zostaje |

Nic z tego nie jest uciętym ani nieosiągalnym przyciskiem. Zmiana rozmiaru Select, Tabs
i Switch dotyka też komputera i tabletu, więc to osobna decyzja o wyglądzie, nie poprawka.

## Do decyzji Bartosza

1. **Pobierz PDF zaznaczonych** zostaje tylko na komputerze. Na telefonie lista to karty
   z gestem, a zaznaczanie wielu wierszy wymagałoby zmiany układu listy. PDF jednej
   faktury jest na szczegółach. Jeśli zbiorcze pobieranie ma być na telefonie, to osobne zadanie.
2. **Baner zgody na analitykę** (dół ekranu) zasłania przycisk „Zaloguj się” na pierwszej
   wizycie na telefonie, dopóki się go nie zamknie. Test musiał go najpierw wyłączyć
   (`ff_analytics_consent`). Nie ruszałem go, bo to treść zgody; wystarczyłoby podnieść
   formularz logowania nad baner albo zamykać baner przed logowaniem.
3. Rozmiary Select, Tabs i Switch (tabela wyżej).

## Czego obchód nie sprawdza

- Prawdziwego iOS Safari ani Chrome na Androidzie: to WebKit i profil urządzenia z Playwrighta.
- Faktur w stanach innych niż szkic (lokalne konto ma 40 szkiców) i dodanej do ekranu
  głównego aplikacji w trybie `standalone`.
- Wypełnionych formularzy, okien dialogowych i arkuszy poza arkuszem „Więcej”, klawiatury
  ekranowej oraz orientacji poziomej.
