# KSeF TEST: tygodniowy test wysyłki

Plan „zero zgubionych faktur”, sesja H1a. Skrypt `scripts/test-ksef-wysylka.ts` wysyła prawdziwe faktury na KSeF TEST tą samą drogą co worker od XML do KSeF, bez bazy i magazynu plików.

- **Uruchomienie lokalne:** `pnpm ksef:test-wysylka`
- **Uruchomienie w GitHubie:** workflow „KSeF TEST (wysyłka)”, poniedziałek rano albo ręcznie. Wynik jest w podsumowaniu joba.
- **Sekrety:** nie są potrzebne. Fikcyjny NIP i certyfikat samopodpisany powstają przy każdym uruchomieniu.
- **Produkcja:** przy `KSEF_ENV=production` skrypt odmawia startu.

## Co sprawdza

| Scenariusz | Oczekiwana odpowiedź KSeF | Po co |
|---|---|---|
| 1. P_1 = dziś | kod 200, tryb `Online`, numer KSeF | podstawowa ścieżka; UPO jest tylko raportowane |
| 2. Ten sam plik drugi raz | kod 440, wskazany numer oryginału | klasyfikacja duplikatu w runnerze |
| 3. P_1 = jutro | kod 450 | klasyfikacja odrzucenia semantycznego |
| 13. P_1 = wczoraj | kod 200, tryb `Offline` | założenie B1: KSeF sam nadaje tryb offline (art. 106nda ust. 16) |
| 13b. P_1 = 5 dni temu | kod 200, tryb `Offline` | KSeF nie pilnuje terminu dosłania, więc musi to robić aplikacja (B2) |
| 17. Pauza firmy po 429 (L1a) | jednorazowa firma A z `onlineSession` 1/s i 1/min: druga wysyłka dostaje 429 z `Retry-After`, trzecia nie wychodzi z aplikacji, firma B wysyła bez czekania, po pauzie limity wracają do domyślnych | bramka L1a i pomiar, czy MF po 429 blokuje samą grupę, czy cały kontekst |

## Scenariusz 17: limity API na TEST

Plan „zero zgubionych faktur”, karta L1a. MF liczy limity na parę (NIP, adres IP) i po 429 blokuje kolejne żądania na `Retry-After`, a nie opisuje, czy samej grupy, czy całego kontekstu. Domyślne limity TEST są w źródłach MF sprzeczne, więc scenariusz ustawia je sam.

1. Świeża firma A (losowy fikcyjny NIP), `GET /rate-limits`. Domyślne `onlineSession` i `invoiceStatus` trafiają do kolumny faktów.
2. `POST /testdata/rate-limits` (tylko TEST, zmienia limity kontekstu firmy A): 13 grup z odczytu, `onlineSession` 1/s i 1/min, godzina bez zmian.
3. Faktura a1 firmy A, przyjęta.
4. Druga wysyłka A: prawdziwy 429 od MF na otwarciu sesji, z `Retry-After`.
5. Trzecia wysyłka A od razu: lokalna pauza, zero żądań do MF (skrypt odcina sieć na ten krok), koniec pauzy w aplikacji = chwila 429 + `Retry-After`.
6. Po jednej sondzie poza kolejką firmy: `GET /rate-limits` (grupa `other`) i status a1 (grupa `invoiceStatus`). Wynik w faktach: `grupa` (obie przeszły), `kontekst` (obie 429), `mieszane`.
7. Firma B (firma z wierszy wyżej) wysyła w trakcie pauzy A, bez czekania.
8. Czekanie na koniec blokady, najwyżej 5 min, potem `DELETE /testdata/rate-limits` i odczyt z powrotem do domyślnych.

Zasady: dokładnie jeden wyzwolony 429, najwyżej jedna sonda na grupę, nigdy drugie uderzenie w otwarcie sesji w czasie pauzy, bez hamulca wysyłki (429 dostaje tylko firma A, hamulec wymaga 5 firm). UPO w czasie pauzy sprawdza test lokalny `tests/unit/ksef-pauza-429.test.ts`, nie ten scenariusz. Bieg trwa do kilku minut dłużej niż przed L1a, stąd `timeout-minutes: 25` w workflow.

## Co zrobić, gdy bieg jest czerwony

1. Sprawdź [Latarnię](https://api-latarnia.ksef.mf.gov.pl/status) i okno serwisowe TEST (16:00-18:00). Przerwa po stronie MF to nie jest błąd aplikacji: uruchom bieg ponownie.
2. Inny kod w scenariuszu 2 albo 3 oznacza, że klasyfikacja błędów w `lib/ksef/send-error-classes.ts` może nie pasować do odpowiedzi KSeF.
3. Inny wynik w scenariuszu 13 albo 13b oznacza zmianę zachowania KSeF. Wstrzymaj prace nad terminem dosłania i wróć do założeń z karty B1 w planie.
4. Scenariusz 17, według faktów:
   - druga wysyłka A „przyjęta, bez 429”: MF nie zastosował limitu albo pierwsza wysyłka trwała dłużej niż minuta (czas jest w faktach). Uruchom ponownie; powtarzalny wynik zgłoś Bartoszowi;
   - trzecia wysyłka A z żądaniem do MF albo pauza w aplikacji inna niż `Retry-After`: bramka L1a w `lib/ksef/client.ts` albo zapis pauzy w `lib/ksef/rate-limit-pause.ts` nie działa. Skrypt zatrzymał to żądanie, ale worker na produkcji by go nie zatrzymał;
   - firma B z 429: MF blokuje cały adres IP, czyli wszystkie firmy naraz. Zgłoś Bartoszowi przed kolejnym wydaniem;
   - „blokada … dłużej niż 5 min”: MF podał długi `Retry-After`. Skrypt nie czekał i nie przywrócił limitów, które zostają na jednorazowym fikcyjnym NIP (nikt go więcej nie użyje);
   - zasięg `grupa` to nie błąd, tylko wynik pomiaru: wtedy według karty L1a można zawęzić pauzę do grupy (osobna decyzja). `kontekst` potwierdza dzisiejszą pauzę całej firmy.

Dane TEST są współdzielone między integratorami. Nigdy nie wysyłaj tu prawdziwych danych.
