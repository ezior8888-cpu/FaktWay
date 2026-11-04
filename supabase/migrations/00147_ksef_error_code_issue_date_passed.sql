-- 00147_ksef_error_code_issue_date_passed.sql
--
-- A4b, decyzja Bartosza 06.10.2026 (krytyka projektu A4b PR2, B1): dokument
-- specjalny (KOR, ZAL, ROZ) nie wychodzi do KSeF z datą wystawienia inną niż
-- dziś (Europe/Warsaw). Sprawdzenie przy zleceniu nie wystarcza: ponowienia
-- pg-boss (do ok. 1 h 20 min) i oczekiwanie na przejęcie wysyłki potrafią
-- przenieść POST za północ, a w KSeF dokument wystawia się w dniu wysyłki
-- (art. 106na ust. 1) — z wcześniejszą datą byłby fakturą offline bez
-- oznaczeń. Worker odmawia z nowym kodem katalogu przed wysyłką i drugi raz
-- tuż przed plikiem (hak otwarcia sesji — uwierzytelnienie trwa do kilkudziesięciu sekund).
--
-- Nowy kod `ISSUE_DATE_PASSED`, klasa `terminal`, bez automatu: bez dowodu
-- kontaktu dokument wraca do szkicu (klient albo operator), a ponieważ
-- szkicu dokumentu specjalnego nie da się wysłać, klient usuwa go i wystawia
-- od nowa z dzisiejszą datą. Z dowodem kontaktu dokument specjalny nie ma
-- dziś wyjścia w panelu (jak przy innych kodach; A4b PR2, B2). RPC z 00131 czytają klasę z katalogu
-- (`ksef_error_class`), więc `requeue_ksef_send` odmawia, a `reset_ksef_send`
-- dopuszcza powrót do szkicu bez zmian w funkcjach. Zwykła faktura bez
-- zmian (B1/B2). Do zdjęcia, gdy B2 obejmie wszystkie rodzaje.
--
-- PRZED wdrożeniem kodu (addytywna): jeden wiersz w tabeli referencyjnej,
-- bez UPDATE danych klientów, bez DROP. Stary kod go nie zapisuje; nowy kod
-- bez tego wiersza dostałby I4 (kod spoza katalogu). Wycofanie: DELETE tego
-- wiersza (za zgodą), gdy żadna faktura nie ma tego kodu.

BEGIN;

INSERT INTO public.ksef_error_codes (code, class, auto_requeue, client_message) VALUES
  ('ISSUE_DATE_PASSED', 'terminal', false,
   'Tego dokumentu nie wysłaliśmy: ma datę wystawienia sprzed dzisiaj, a w KSeF dokument wystawia się w dniu wysyłki. Wróć do szkicu, usuń go i wystaw dokument od nowa z dzisiejszą datą.')
ON CONFLICT (code) DO NOTHING;

COMMIT;
