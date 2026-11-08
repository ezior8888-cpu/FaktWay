# Rejestr czynności przetwarzania (art. 30 RODO)

Wersja robocza z 15.10.2026 — do zatwierdzenia przez prawnika. Prowadzący:
usługodawca FaktWay (dane: `lib/legal/entity.ts`), kontakt `pomoc@faktway.pl`.
Inspektora ochrony danych nie wyznaczono (art. 37 RODO — brak obowiązku).

Rejestr obowiązuje także mikroprzedsiębiorcę, bo przetwarzanie nie jest
sporadyczne (art. 30 ust. 5 RODO). Aktualizuj go w tym samym PR, który
zmienia sposób przetwarzania (nowy cel, nowe dane, nowy dostawca).

Środki bezpieczeństwa dla wszystkich czynności: załącznik A umowy
powierzenia (`lib/legal/documents/umowa-powierzenia.ts`, sekcja `srodki`).
Odbiorcy i transfery do USA: `lib/legal/subprocessors.ts`.

## Część A — jako administrator (art. 30 ust. 1)

| # | Czynność i cel | Osoby | Dane | Podstawa | Odbiorcy | Usunięcie |
|---|---|---|---|---|---|---|
| A1 | Konta i świadczenie usług | użytkownicy (właściciele firm, pracownicy, księgowi) | imię i nazwisko, e-mail, skrót hasła, role, ustawienia, czynniki 2FA, dane z Google | 6.1.b; 6.1.f (osoby działające w imieniu klienta) | Hetzner, Cloudflare (Turnstile), Google (logowanie — odrębny administrator) | usunięcie konta: 14 dni na wycofanie, najpóźniej miesiąc od żądania |
| A2 | Rozliczenie subskrypcji, faktury za usługę | klienci, osoby do rozliczeń | dane firmy, e-mail, historia płatności | 6.1.b, 6.1.c (VAT, Ordynacja podatkowa) | Stripe, Hetzner, MF (KSeF) | 5 lat od końca roku, w którym minął termin płatności podatku |
| A3 | Bezpieczeństwo serwisu | użytkownicy, odwiedzający | IP, przeglądarka, dziennik zdarzeń, raporty błędów | 6.1.f (LIA niżej) | Hetzner, Sentry, Cloudflare | dziennik 12 mies. (anonimizacja po usunięciu konta), raporty błędów do 90 dni |
| A4 | Dowody akceptacji regulaminu i zgód | użytkownicy | wersje dokumentów i oświadczeń, data, sposób; IP w dzienniku | 6.1.c w zw. z 7.1; 6.1.f | Hetzner | przy koncie do jego usunięcia; dziennik 12 mies. (docelowo tabela do przedawnienia — lista kontrolna) |
| A5 | Obsługa żądań dotyczących danych | wnioskodawcy | e-mail, rodzaj i data żądania, IP, przeglądarka | 6.1.c w zw. z 5.2, 12; 6.1.f | Hetzner | 6 lat od realizacji |
| A6 | Pomoc techniczna (e-mail, czat AI, notatki) | użytkownicy, piszący | treść wiadomości i rozmów, e-mail, oceny | 6.1.b; 6.1.f | Anthropic (czat), Slack (alert z e-mailem przy prośbie o człowieka), Cloudflare (poczta przychodząca), skrzynka docelowa (lista kontrolna) | 24 mies. od ostatniej wiadomości |
| A7 | E-maile z poradami i ofertami | użytkownicy z zgodą | e-mail, imię, zapis zgody | 6.1.a; art. 398 PKE | Resend | do wycofania zgody |
| A8 | Newsletter | zapisani | e-mail, data zapisu | 6.1.a | Resend | do wypisania |
| A9 | Analityka w przeglądarce | odwiedzający z zgodą | pseudonimowy identyfikator, sekcje serwisu, typ urządzenia | 6.1.a; art. 399 PKE | PostHog (UE) | do wycofania zgody, ≤ 24 mies. |
| A10 | Statystyki serwerowe | użytkownicy, firmy | pseudonimowy identyfikator, zdarzenie z zamkniętej listy | 6.1.f (LIA niżej) | PostHog (UE) | ≤ 24 mies. |
| A11 | Powiadomienia push | użytkownicy | endpoint i klucze subskrypcji | 6.1.b | dostawcy push przeglądarek (treść zaszyfrowana) | do wyłączenia lub usunięcia konta |
| A12 | Dostarczalność poczty | adresaci, którzy odbili lub zgłosili spam | e-mail, rodzaj zdarzenia, data | 6.1.f | Hetzner | dopóki blokada potrzebna |
| A13 | Dochodzenie i obrona roszczeń | strony sporu | dane potrzebne do wykazania faktów | 6.1.f | sądy, pełnomocnicy | do przedawnienia |

### Test równowagi interesów (LIA) — skrót

| Czynność | Interes | Niezbędność | Wpływ na osobę | Wynik |
|---|---|---|---|---|
| A3 bezpieczeństwo | ochrona kont, danych klientów, wykrywanie nadużyć | bez IP i dziennika nie da się wykryć przejęcia konta | niski — dane techniczne, krótki okres, brak profilowania | dopuszczalne |
| A10 statystyki serwerowe | utrzymanie i rozwój usługi | zagregowane zdarzenia; bez treści dokumentów | niski — pseudonim, zamknięta lista pól; prawo sprzeciwu w polityce | dopuszczalne, z prawem sprzeciwu |
| A6 pomoc (osoby działające za klienta) | odpowiedź na zgłoszenie | konieczna treść i adres | niski | dopuszczalne |

## Część B — jako podmiot przetwarzający (art. 30 ust. 2)

**Administratorzy:** klienci FaktWay (każda organizacja w tabeli `tenants`;
lista w bazie — nie powielać tutaj). Umowa powierzenia: `/legal/umowa-powierzenia`.

| Kategoria przetwarzania na zlecenie klienta | Dalsi przetwarzający | Transfer poza EOG |
|---|---|---|
| przechowywanie faktur, kontrahentów, wydatków, zdjęć dokumentów | Hetzner | nie |
| wystawianie faktur i wysyłka do KSeF, pobieranie z KSeF | — (KSeF to odbiorca na polecenie klienta) | nie |
| odczyt dokumentów kosztowych (OCR) i podpowiedź KPiR | Anthropic | tak (USA) |
| wysyłka faktur i przypomnień do kontrahentów klienta | Resend | tak (USA, możliwe) |
| pobieranie danych z rejestrów publicznych (GUS, biała lista, VIES) | — (odbiorcy na polecenie klienta) | nie |
| eksporty, paczki dla księgowej, portal księgowego | Hetzner, Resend | jw. |
| kopie zapasowe, monitorowanie błędów | Hetzner, Sentry (UE) | możliwy dostęp z USA (Sentry) |

Środki bezpieczeństwa: załącznik A umowy powierzenia.
