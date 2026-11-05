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

## Co zrobić, gdy bieg jest czerwony

1. Sprawdź [Latarnię](https://api-latarnia.ksef.mf.gov.pl/status) i okno serwisowe TEST (16:00-18:00). Przerwa po stronie MF to nie jest błąd aplikacji: uruchom bieg ponownie.
2. Inny kod w scenariuszu 2 albo 3 oznacza, że klasyfikacja błędów w `lib/ksef/send-error-classes.ts` może nie pasować do odpowiedzi KSeF.
3. Inny wynik w scenariuszu 13 albo 13b oznacza zmianę zachowania KSeF. Wstrzymaj prace nad terminem dosłania i wróć do założeń z karty B1 w planie.

Dane TEST są współdzielone między integratorami. Nigdy nie wysyłaj tu prawdziwych danych.
